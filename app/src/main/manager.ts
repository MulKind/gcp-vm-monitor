import { EventEmitter } from 'events'
import { app, session as electronSession } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import { SshSession } from './ssh'
import { AgentClient, AgentHttpError } from './agent'
import { redactVm, store } from './store'
import * as demo from './demo'
import type {
  AgentInfo,
  ConnState,
  Metrics,
  OpenServiceResult,
  Service,
  TopProc,
  VmConfig,
  VmStatus
} from '@shared/types'

const AGENT_FILES = ['vmmon_agent.py', 'install.sh', 'uninstall.sh', 'vmmon-agent.service']

export function agentDir(): string {
  const candidates = [
    join(process.resourcesPath || '', 'agent'),
    join(app.getAppPath(), '..', 'agent'),
    join(app.getAppPath(), '..', '..', 'agent')
  ]
  return candidates.find((d) => existsSync(join(d, 'vmmon_agent.py'))) || candidates[1]
}

function partitionFor(vmId: string, svcId: string): string {
  return 'persist:svc-' + (vmId + '-' + svcId).replace(/[^a-zA-Z0-9_-]/g, '_')
}

/** Live runtime for one VM. */
class VmRuntime {
  session: SshSession | null = null
  agent: AgentClient | null = null
  status: VmStatus
  info: AgentInfo | null = null
  services: Service[] = []
  private stopped = true
  private timers: NodeJS.Timeout[] = []
  private retry: NodeJS.Timeout | null = null
  private agentProbeTimer: NodeJS.Timeout | null = null
  private backoff = 3000
  private metricFails = 0
  private busy = { m: false, s: false, attach: false }

  constructor(
    public vm: VmConfig,
    private mgr: VmManager
  ) {
    this.status = { vmId: vm.id, state: 'disconnected', since: Date.now() }
  }

  setStatus(state: ConnState, message?: string): void {
    if (this.status.state === state && this.status.message === message) return
    this.status = { vmId: this.vm.id, state, message, since: Date.now() }
    this.mgr.emit('status', this.status)
  }

  start(): void {
    this.stopped = false
    void this.connect()
  }

  stop(): void {
    this.stopped = true
    this.clearTimers()
    if (this.retry) clearTimeout(this.retry)
    this.retry = null
    this.session?.end()
    this.session = null
    this.agent = null
    this.setStatus('disconnected')
  }

  private clearTimers(): void {
    this.timers.forEach((t) => clearInterval(t))
    this.timers = []
    if (this.agentProbeTimer) {
      clearInterval(this.agentProbeTimer)
      this.agentProbeTimer = null
    }
  }

  private scheduleAgentProbe(): void {
    if (this.stopped || this.agentProbeTimer) return
    this.agentProbeTimer = setInterval(() => {
      if (this.stopped || !this.session?.connected || this.status.state === 'connected') return
      void this.attachAgent()
    }, 15000)
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.retry) return
    const wait = this.backoff
    this.backoff = Math.min(this.backoff * 2, 60000)
    this.retry = setTimeout(() => {
      this.retry = null
      void this.connect()
    }, wait)
  }

  async connect(): Promise<void> {
    if (this.stopped) return
    this.clearTimers()
    this.session?.end()
    this.session = null
    this.agent = null

    if (this.vm.kind === 'demo') {
      this.setStatus('connecting')
      await new Promise((r) => setTimeout(r, 400))
      this.info = demo.demoInfo(this.vm.id, this.vm.name)
      this.mgr.emit('info', this.vm.id, this.info)
      this.setStatus('connected')
      this.startPolling()
      return
    }

    this.setStatus('connecting')
    const session = new SshSession(this.vm)
    try {
      await session.connect(store.settings.proxy, {
        allowDirectFallback: store.settings.allowDirectFallback,
        onPinFingerprint: (fp) => {
          const updated = store.patchVm(this.vm.id, { hostFingerprint: fp })
          if (updated) {
            this.vm = updated
            this.mgr.emit('vm-updated', redactVm(updated))
          }
        }
      })
    } catch (e) {
      this.setStatus('error', 'SSH 连接失败: ' + (e as Error).message)
      if (!/主机公钥指纹不匹配/i.test((e as Error).message)) {
        this.scheduleReconnect()
      }
      return
    }
    if (this.stopped) {
      session.end()
      return
    }
    this.session = session
    session.on('close', () => {
      if (this.session !== session) return
      this.clearTimers()
      this.agent = null
      this.session = null
      if (!this.stopped) {
        this.setStatus('error', 'SSH 连接已断开，正在重连…')
        this.scheduleReconnect()
      }
    })
    await this.attachAgent()
  }

  /** Open tunnel to the agent and verify it; sets no-agent state when missing. */
  async attachAgent(): Promise<void> {
    const session = this.session
    if (!session || this.busy.attach) return
    this.busy.attach = true
    try {
      if (!this.vm.agentToken) {
        const tok = await this.readRemoteToken()
        if (tok) this.vm = store.patchVm(this.vm.id, { agentToken: tok }) || this.vm
      }
      if (!this.vm.agentToken) {
        this.setStatus('no-agent', 'VM 上未检测到 VMMon Agent，请点击“安装 Agent”')
        this.scheduleAgentProbe()
        return
      }
      const t = await session.openTunnel('agent', '127.0.0.1', this.vm.agentPort || 9527)
      this.agent = new AgentClient(t.localPort, this.vm.agentToken)
      try {
        this.info = await this.agent.get<AgentInfo>('/api/v1/info')
      } catch (e) {
        if (e instanceof AgentHttpError && e.status === 401) {
          const tok = await this.readRemoteToken()
          if (tok && tok !== this.vm.agentToken) {
            this.vm = store.patchVm(this.vm.id, { agentToken: tok }) || this.vm
            this.agent = new AgentClient(t.localPort, tok)
            this.info = await this.agent.get<AgentInfo>('/api/v1/info')
          } else throw new Error('Agent Token 无效')
        } else throw e
      }
      this.mgr.emit('info', this.vm.id, this.info)
      this.backoff = 3000
      this.metricFails = 0
      this.setStatus('connected')
      this.startPolling()
    } catch (e) {
      const msg = (e as Error).message || String(e)
      const missing = /ECONNRESET|socket hang up|Connection refused|ECONNREFUSED|Channel open failure/i.test(msg)
      this.setStatus('no-agent', missing ? 'Agent 未运行（端口无响应），请安装或重启 Agent' : 'Agent 错误: ' + msg)
      this.scheduleAgentProbe()
    } finally {
      this.busy.attach = false
    }
  }

  private async readRemoteToken(): Promise<string | undefined> {
    if (!this.session) return undefined
    try {
      const r = await this.session.exec('sudo -n cat /etc/vmmon-agent/config.json 2>/dev/null || cat /etc/vmmon-agent/config.json 2>/dev/null', { timeoutMs: 10000 })
      const j = JSON.parse(r.stdout || '{}') as { token?: string }
      return j.token || undefined
    } catch {
      return undefined
    }
  }

  private startPolling(): void {
    this.clearTimers()
    const s = store.settings
    const mtick = (): void => void this.pollMetrics()
    const stick = (): void => void this.pollServices()
    mtick()
    stick()
    this.timers.push(setInterval(mtick, Math.max(500, s.metricsIntervalMs)))
    this.timers.push(setInterval(stick, Math.max(2000, s.servicesIntervalMs)))
  }

  private async pollMetrics(): Promise<void> {
    if (this.busy.m) return
    this.busy.m = true
    try {
      let m: Metrics
      if (this.vm.kind === 'demo') m = demo.demoMetrics(this.vm.id)
      else if (this.agent) m = await this.agent.get<Metrics>('/api/v1/metrics', 5000)
      else return
      this.metricFails = 0
      if (this.status.state !== 'connected') this.setStatus('connected')
      this.mgr.emit('metrics', this.vm.id, m)
    } catch (e) {
      this.metricFails++
      if (this.metricFails === 3) this.setStatus('error', '获取指标失败: ' + (e as Error).message)
      if (this.metricFails >= 6) {
        this.metricFails = 0
        this.session?.end() // triggers reconnect
      }
    } finally {
      this.busy.m = false
    }
  }

  async pollServices(): Promise<void> {
    if (this.busy.s) return
    this.busy.s = true
    try {
      let list: Service[]
      if (this.vm.kind === 'demo') list = demo.demoServices(this.vm.id).map((x) => ({ ...x }))
      else if (this.agent) list = (await this.agent.get<{ services: Service[] }>('/api/v1/services', 8000)).services || []
      else return
      this.services = list
      this.mgr.emit('services', this.vm.id, list)
    } catch (e) {
      console.warn(`[${this.vm.name}] services poll failed`, (e as Error).message)
    } finally {
      this.busy.s = false
    }
  }
}

export class VmManager extends EventEmitter {
  private rts = new Map<string, VmRuntime>()
  /** origins (host:port) for which TLS errors are accepted (our own tunnels to self-signed panels) */
  trustedOrigins = new Set<string>()

  init(): void {
    for (const vm of store.vms) this.ensure(vm).start()
  }

  private ensure(vm: VmConfig): VmRuntime {
    let rt = this.rts.get(vm.id)
    if (!rt) {
      rt = new VmRuntime(vm, this)
      this.rts.set(vm.id, rt)
    }
    return rt
  }

  rt(id: string): VmRuntime {
    const r = this.rts.get(id)
    if (!r) throw new Error('VM 不存在')
    return r
  }

  statuses(): VmStatus[] {
    return [...this.rts.values()].map((r) => r.status)
  }

  infos(): Record<string, AgentInfo> {
    const o: Record<string, AgentInfo> = {}
    for (const [id, r] of this.rts) if (r.info) o[id] = r.info
    return o
  }

  servicesAll(): Record<string, Service[]> {
    const o: Record<string, Service[]> = {}
    for (const [id, r] of this.rts) o[id] = r.services
    return o
  }

  saveVm(vm: VmConfig): VmConfig {
    const old = store.getVm(vm.id) ? { ...store.getVm(vm.id)! } : undefined
    const saved = store.upsertVm(vm)
    const rt = this.rts.get(saved.id)
    const connChanged =
      !old ||
      [
        'host',
        'port',
        'username',
        'authType',
        'privateKeyPath',
        'passphrase',
        'password',
        'hostFingerprint',
        'agentPort',
        'agentToken',
        'kind'
      ].some((k) => (old as unknown as Record<string, unknown>)[k] !== (saved as unknown as Record<string, unknown>)[k])
    if (rt) {
      rt.vm = saved
      if (connChanged) {
        rt.stop()
        rt.start()
      }
    } else this.ensure(saved).start()
    return redactVm(saved)
  }

  deleteVm(id: string): void {
    const rt = this.rts.get(id)
    const svcIds = new Set<string>([
      ...(rt?.services.map((s) => s.id) || []),
      ...Object.keys(rt?.vm.serviceOverrides || {})
    ])
    for (const p of store.tunnelPortsForVm(id)) {
      this.trustedOrigins.delete(`127.0.0.1:${p}`)
    }
    for (const svcId of svcIds) {
      const part = partitionFor(id, svcId)
      void electronSession.fromPartition(part).clearStorageData().catch(() => {})
    }
    rt?.stop()
    this.rts.delete(id)
    store.deleteVm(id)
  }

  reconnect(id: string): void {
    const rt = this.rt(id)
    rt.vm = store.getVm(id) || rt.vm
    rt.stop()
    rt.start()
  }

  restartAll(): void {
    for (const rt of this.rts.values()) {
      rt.stop()
      rt.start()
    }
  }

  async logs(vmId: string, svcId: string, lines = 200): Promise<string[]> {
    const rt = this.rt(vmId)
    if (rt.vm.kind === 'demo') return demo.demoLogs(svcId)
    if (!rt.agent) throw new Error('Agent 未连接')
    const r = await rt.agent.get<{ lines: string[] }>(`/api/v1/services/${encodeURIComponent(svcId)}/logs?lines=${lines}`, 15000)
    return r.lines || []
  }

  async action(vmId: string, svcId: string, action: 'start' | 'stop' | 'restart'): Promise<{ ok: boolean; output: string }> {
    const rt = this.rt(vmId)
    let res: { ok: boolean; output: string }
    if (rt.vm.kind === 'demo') {
      demo.demoAction(vmId, svcId, action)
      res = { ok: true, output: '' }
    } else {
      if (!rt.agent) throw new Error('Agent 未连接')
      res = await rt.agent.post(`/api/v1/services/${encodeURIComponent(svcId)}/action`, { action }, 60000)
    }
    setTimeout(() => void rt.pollServices(), 800)
    return res
  }

  async top(vmId: string): Promise<TopProc[]> {
    const rt = this.rt(vmId)
    if (rt.vm.kind === 'demo') return demo.demoTop()
    if (!rt.agent) throw new Error('Agent 未连接')
    return (await rt.agent.get<{ procs: TopProc[] }>('/api/v1/top?n=15')).procs || []
  }

  private allocPort(key: string): number {
    const known = store.getTunnelPort(key)
    if (known) return known
    const used = store.usedTunnelPorts()
    let p = 21000
    while (used.has(p)) p++
    store.setTunnelPort(key, p)
    return p
  }

  async openService(vmId: string, svcId: string): Promise<OpenServiceResult> {
    const rt = this.rt(vmId)
    const svc = rt.services.find((s) => s.id === svcId)
    if (!svc) throw new Error('服务不存在或已消失')
    const ov = rt.vm.serviceOverrides?.[svcId] || {}
    const title = ov.displayName || svc.display_name || svc.name
    const partition = partitionFor(vmId, svcId)

    if (ov.openMode === 'url' && ov.externalUrl) {
      let parsed: URL
      try {
        parsed = new URL(ov.externalUrl)
      } catch {
        throw new Error('外部 URL 格式不合法')
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('外部 URL 仅允许 http:// 或 https:// 协议')
      }
      return { url: parsed.toString(), partition, title }
    }

    const scheme = ov.scheme || svc.web?.scheme || 'http'
    const port = ov.port || svc.web?.port || svc.ports[0]?.host_port || svc.ports[0]?.port
    const path = ov.path ?? svc.web?.path ?? '/'
    if (!port) throw new Error('该服务没有可访问的 Web 端口，可在“服务设置”中手动指定')

    if (rt.vm.kind === 'demo') {
      const dp = await demo.ensureDemoServer()
      return { url: `http://127.0.0.1:${dp}/svc/${encodeURIComponent(title)}${path}`, partition, title }
    }

    if (!rt.session) throw new Error('SSH 未连接')
    const bind = svc.ports.find((p) => (p.host_port || p.port) === port)?.bind || '127.0.0.1'
    const remoteHost = ['0.0.0.0', '::', '*', '', '127.0.0.1', '::1', 'localhost'].includes(bind) ? '127.0.0.1' : bind
    const key = `${vmId}|${svcId}`
    const t = await rt.session.openTunnel(key, remoteHost, port, this.allocPort(key))
    if (t.localPort !== store.getTunnelPort(key)) store.setTunnelPort(key, t.localPort)
    this.trustedOrigins.add(`127.0.0.1:${t.localPort}`)
    const p = path.startsWith('/') ? path : '/' + path
    return { url: `${scheme}://127.0.0.1:${t.localPort}${p}`, partition, title }
  }

  async installAgent(vmId: string, log: (line: string) => void): Promise<void> {
    const rt = this.rt(vmId)
    if (rt.vm.kind === 'demo') {
      for (const l of ['[demo] 上传 agent…', '[demo] 安装 systemd 服务…', '[demo] 完成']) {
        log(l)
        await new Promise((r) => setTimeout(r, 400))
      }
      return
    }
    const s = rt.session
    if (!s?.connected) throw new Error('SSH 未连接，无法安装')
    const dir = agentDir()
    for (const f of AGENT_FILES) if (!existsSync(join(dir, f))) throw new Error(`缺少 Agent 文件: ${join(dir, f)}`)
    log(`本地 Agent 目录: ${dir}`)
    const mk = await s.exec('umask 077 && mktemp -d /tmp/vmmon.XXXXXXXXXX', { timeoutMs: 15000 })
    const tmpDir = mk.stdout.trim().split(/\r?\n/).pop()?.trim() || ''
    if (mk.code !== 0 || !/^\/tmp\/vmmon\.[A-Za-z0-9_-]{6,}$/.test(tmpDir)) {
      throw new Error(`无法在远端创建安全临时目录: ${mk.stderr || mk.stdout}`)
    }
    try {
      for (const f of AGENT_FILES) {
        log(`上传 ${f} …`)
        await s.upload(join(dir, f), `${tmpDir}/${f}`)
      }
      log('执行安装脚本（sudo）…')
      let token = ''
      const r = await s.exec(`sudo -n sh '${tmpDir}/install.sh' '${tmpDir}/vmmon_agent.py' 2>&1`, {
        timeoutMs: 180000,
        onLine: (l) => {
          const m = /^VMMON_TOKEN=([0-9a-fA-F]+)\s*$/.exec(l.trim())
          if (m) token = m[1]
          else if (l.trim()) log(l)
        }
      })
      if (r.code !== 0 || !token) {
        if (/password is required|a terminal is required/i.test(r.stdout + r.stderr))
          throw new Error('当前用户需要 sudo 密码。请使用有免密 sudo 的账号（GCP 默认账号均有），或手动执行 agent/install.sh')
        throw new Error(`安装失败（退出码 ${r.code}）`)
      }
      log('安装成功，Token 已保存')
      const updated = store.patchVm(vmId, { agentToken: token })
      if (updated) {
        rt.vm = updated
        this.emit('vm-updated', redactVm(updated))
      }
      await rt.attachAgent()
    } finally {
      await s.exec(`rm -rf '${tmpDir}'`, { timeoutMs: 10000 }).catch(() => {})
    }
  }
}

export const manager = new VmManager()
