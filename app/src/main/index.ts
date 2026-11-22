import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  session,
  shell,
  Tray,
  type MenuItemConstructorOptions,
  type WebContents
} from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { randomUUID } from 'crypto'
import { deflateSync } from 'zlib'
import { utils as sshUtils } from 'ssh2'
import { store } from './store'
import { manager } from './manager'
import type { AppSnapshot, GeneratedKey, ServiceOverride, Settings, VmConfig } from '@shared/types'

let win: BrowserWindow | null = null
let tray: Tray | null = null
let isQuitting = false
let shownTrayHint = false

function send(channel: string, ...args: unknown[]): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args)
}

// ---------- Programmatic 32x32 PNG icon for window & system tray ----------

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0)
  }
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const t = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0)
  return Buffer.concat([len, t, data, crc])
}

function createAppIcon(): Electron.NativeImage {
  const W = 32
  const H = 32
  const raw = Buffer.alloc(H * (1 + W * 4))
  // Pulse waveform control points across x = 6..25
  const waveY = (x: number): number => {
    if (x < 7 || x > 24) return 15
    if (x <= 11) return 15 - (x - 7) * 1.5
    if (x <= 15) return 9 + (x - 11) * 2.5
    if (x <= 19) return 19 - (x - 15) * 3.0
    if (x <= 22) return 7 + (x - 19) * 2.7
    return 15
  }

  for (let y = 0; y < H; y++) {
    const row = y * (1 + W * 4)
    raw[row] = 0 // PNG filter: None
    for (let x = 0; x < W; x++) {
      const p = row + 1 + x * 4
      // Rounded square mask (radius 6)
      const dx = Math.max(0, 6 - x, x - 25)
      const dy = Math.max(0, 6 - y, y - 25)
      if (dx * dx + dy * dy > 36) {
        raw[p + 3] = 0
        continue
      }
      // Dark navy background
      let r = 13
      let g = 23
      let b = 44
      // Monitor frame (x: 4..27, y: 5..21) and stand (y: 22..26)
      const onFrame =
        ((y === 5 || y === 6 || y === 20 || y === 21) && x >= 4 && x <= 27) ||
        ((x === 4 || x === 5 || x === 26 || x === 27) && y >= 5 && y <= 21) ||
        ((x === 15 || x === 16) && y >= 22 && y <= 25) ||
        ((y === 25 || y === 26) && x >= 10 && x <= 21)
      if (onFrame) {
        r = 59
        g = 130
        b = 246 // #3b82f6
      }
      // Cyan pulse wave inside monitor
      if (x >= 7 && x <= 24 && y >= 7 && y <= 19) {
        const wy = waveY(x)
        if (Math.abs(y - wy) <= 1.25) {
          r = 34
          g = 211
          b = 238 // #22d3ee
        }
      }
      raw[p] = r
      raw[p + 1] = g
      raw[p + 2] = b
      raw[p + 3] = 255
    }
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(W, 0)
  ihdr.writeUInt32BE(H, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0))
  ])
  return nativeImage.createFromBuffer(png)
}

function showMainWindow(): void {
  if (!win || win.isDestroyed()) {
    createWindow()
    return
  }
  if (!win.isVisible()) win.show()
  if (win.isMinimized()) win.restore()
  win.focus()
}

function updateTrayMenu(): void {
  if (!tray) return
  const stMap = new Map(manager.statuses().map((s) => [s.vmId, s.state]))
  const stateLabel: Record<string, string> = {
    connected: '🟢 在线',
    connecting: '🔵 连接中',
    'no-agent': '🟡 未装Agent',
    error: '🔴 异常',
    disconnected: '⚪ 未连接'
  }
  const vmItems: MenuItemConstructorOptions[] = store.vms.map((vm) => ({
    label: `${vm.name}  (${stateLabel[stMap.get(vm.id) || 'disconnected'] || '未连接'})`,
    click: () => {
      showMainWindow()
    }
  }))

  const onlineCount = manager.statuses().filter((s) => s.state === 'connected').length
  tray.setToolTip(`VMMon · GCP 虚拟机监控 (${onlineCount}/${store.vms.length} 在线)`)

  const menu = Menu.buildFromTemplate([
    {
      label: '打开 VMMon 主界面',
      click: () => showMainWindow()
    },
    { type: 'separator' },
    ...(vmItems.length
      ? vmItems
      : [{ label: '暂无虚拟机', enabled: false } as MenuItemConstructorOptions]),
    { type: 'separator' },
    {
      label: '重新连接所有虚拟机',
      click: () => manager.restartAll()
    },
    {
      label: '彻底退出 VMMon',
      click: () => {
        isQuitting = true
        app.quit()
      }
    }
  ])
  tray.setContextMenu(menu)
}

function setupTray(icon: Electron.NativeImage): void {
  if (tray) return
  tray = new Tray(icon)
  updateTrayMenu()
  tray.on('click', () => showMainWindow())
  tray.on('double-click', () => showMainWindow())
  tray.on('balloon-click', () => showMainWindow())
}

function createWindow(): void {
  const icon = createAppIcon()
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    title: 'VMMon',
    icon,
    backgroundColor: '#0b1120',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true
    }
  })

  win.on('close', (e) => {
    if (!isQuitting && store.settings.closeToTray !== false) {
      e.preventDefault()
      win?.hide()
      if (!shownTrayHint && tray) {
        shownTrayHint = true
        try {
          tray.displayBalloon({
            iconType: 'info',
            title: 'VMMon 已收进系统托盘',
            content: '后台监控与 SSH 隧道仍在运行。单击托盘图标可恢复窗口，右键可彻底退出。'
          })
        } catch {
          /* ignore on platforms without balloon */
        }
      }
    }
  })

  win.on('closed', () => (win = null))
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))

  setupTray(icon)
}

// ---------- embedded browser (webview) hardening & proxy ----------

const proxiedSessions = new WeakSet<Electron.Session>()

function proxyConfig(s: Settings): Electron.ProxyConfig {
  const p = s.proxy
  if (!s.browserUseProxy || p.type === 'none') return { mode: 'direct' }
  const scheme = p.type === 'socks5' ? 'socks5' : 'http'
  return {
    proxyRules: `${scheme}://${p.host}:${p.port}`,
    // never route local tunnels through the proxy (NO_PROXY=localhost,127.0.0.1,::1,.local)
    proxyBypassRules: '<local>;localhost;127.0.0.1;::1;*.local'
  }
}

async function applyProxy(ses: Electron.Session, force = false): Promise<void> {
  if (proxiedSessions.has(ses) && !force) return
  proxiedSessions.add(ses)
  await ses.setProxy(proxyConfig(store.settings))
}

const knownPartitions = new Set<string>()

app.on('web-contents-created', (_e, contents: WebContents) => {
  contents.on('will-attach-webview', (_ev, webPreferences, params) => {
    delete webPreferences.preload
    webPreferences.nodeIntegration = false
    webPreferences.contextIsolation = true
    webPreferences.sandbox = true
    if (params.partition) knownPartitions.add(params.partition)
  })
  if (contents.getType() === 'webview') {
    void applyProxy(contents.session)
    contents.setWindowOpenHandler(({ url }) => {
      send('webview:new-window', { webContentsId: contents.id, url })
      return { action: 'deny' }
    })
  }
})

app.on('certificate-error', (event, _wc, url, _err, _cert, callback) => {
  try {
    const u = new URL(url)
    if (manager.trustedOrigins.has(`${u.hostname}:${u.port || (u.protocol === 'https:' ? '443' : '80')}`)) {
      event.preventDefault()
      callback(true)
      return
    }
  } catch {
    /* ignore */
  }
  callback(false)
})

// ---------- IPC ----------

function registerIpc(): void {
  ipcMain.handle('app:snapshot', (): AppSnapshot => ({
    vms: store.vms,
    settings: store.settings,
    statuses: manager.statuses(),
    infos: manager.infos(),
    services: manager.servicesAll()
  }))

  ipcMain.handle('vm:save', (_e, vm: VmConfig) => {
    if (!vm.id) vm.id = randomUUID()
    manager.saveVm(vm)
    updateTrayMenu()
    return vm
  })
  ipcMain.handle('vm:delete', (_e, id: string) => {
    manager.deleteVm(id)
    updateTrayMenu()
  })
  ipcMain.handle('vm:reconnect', (_e, id: string) => manager.reconnect(id))
  ipcMain.handle('vm:top', (_e, id: string) => manager.top(id))
  ipcMain.handle('vm:install', async (_e, id: string) => {
    try {
      await manager.installAgent(id, (line) => send('install:log', { vmId: id, line }))
      send('install:log', { vmId: id, line: '✓ 完成', done: true, ok: true })
      return true
    } catch (err) {
      send('install:log', { vmId: id, line: '✗ ' + (err as Error).message, done: true, ok: false })
      return false
    }
  })

  ipcMain.handle('svc:open', (_e, vmId: string, svcId: string) => manager.openService(vmId, svcId))
  ipcMain.handle('svc:logs', (_e, vmId: string, svcId: string, lines?: number) => manager.logs(vmId, svcId, lines))
  ipcMain.handle('svc:action', (_e, vmId: string, svcId: string, action: 'start' | 'stop' | 'restart') =>
    manager.action(vmId, svcId, action)
  )
  ipcMain.handle('svc:override', (_e, vmId: string, svcId: string, ov: ServiceOverride | null) => {
    const vm = store.getVm(vmId)
    if (!vm) throw new Error('VM 不存在')
    const overrides = { ...(vm.serviceOverrides || {}) }
    if (ov) overrides[svcId] = ov
    else delete overrides[svcId]
    const updated = store.patchVm(vmId, { serviceOverrides: overrides })!
    manager.rt(vmId).vm = updated
    send('vm:config', updated)
    return updated
  })

  ipcMain.handle('settings:save', async (_e, s: Settings) => {
    const old = store.settings
    store.setSettings(s)
    for (const p of knownPartitions) await applyProxy(session.fromPartition(p), true)
    if (JSON.stringify(old.proxy) !== JSON.stringify(s.proxy) || old.metricsIntervalMs !== s.metricsIntervalMs || old.servicesIntervalMs !== s.servicesIntervalMs)
      manager.restartAll()
    return s
  })

  ipcMain.handle('dialog:pickKey', async () => {
    const r = await dialog.showOpenDialog(win!, {
      title: '选择 SSH 私钥',
      defaultPath: join(app.getPath('home'), '.ssh'),
      properties: ['openFile', 'showHiddenFiles']
    })
    return r.canceled ? null : r.filePaths[0]
  })

  ipcMain.handle('key:generate', (_e, username: string): GeneratedKey => {
    const dir = join(app.getPath('userData'), 'keys')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const base = join(dir, `vmmon_ed25519_${username || 'user'}`)
    const kp = sshUtils.generateKeyPairSync('ed25519', { comment: username })
    writeFileSync(base, kp.private, { mode: 0o600 })
    writeFileSync(base + '.pub', kp.public + '\n')
    return { privateKeyPath: base, publicKey: kp.public.trim() }
  })

  ipcMain.handle('shell:open', (_e, url: string) => {
    if (/^https?:\/\//i.test(url)) return shell.openExternal(url)
    return undefined
  })

  manager.on('status', (s) => {
    send('vm:status', s)
    updateTrayMenu()
  })
  manager.on('info', (id, info) => send('vm:info', id, info))
  manager.on('metrics', (id, m) => send('vm:metrics', id, m))
  manager.on('services', (id, list) => send('vm:services', id, list))
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    showMainWindow()
  })

  app.on('before-quit', () => {
    isQuitting = true
  })

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null)
    store.load()
    registerIpc()
    createWindow()
    manager.init()
    app.on('activate', () => {
      showMainWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin' && (isQuitting || store.settings.closeToTray === false)) {
      app.quit()
    }
  })
}
