import net from 'net'
import { EventEmitter } from 'events'
import { readFileSync } from 'fs'
import { Client, type ConnectConfig, type ClientChannel } from 'ssh2'
import type { ProxySettings, VmConfig } from '@shared/types'
import { computeHostFingerprint, sanitizeVmHost, verifyOrPinHostKey } from './coreLogic'

export { computeHostFingerprint, verifyOrPinHostKey }

/** Open a raw TCP socket to host:port through an HTTP CONNECT or SOCKS5 proxy (or directly). */
export function proxySocket(proxy: ProxySettings, host: string, port: number, timeoutMs = 15000): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    if (proxy.type === 'none') {
      const s = net.connect({ host, port })
      const t = setTimeout(() => {
        s.destroy()
        reject(new Error(`连接 ${host}:${port} 超时`))
      }, timeoutMs)
      s.once('connect', () => {
        clearTimeout(t)
        resolve(s)
      })
      s.once('error', (e) => {
        clearTimeout(t)
        reject(e)
      })
      return
    }

    const sock = net.connect({ host: proxy.host, port: proxy.port })
    let buf = Buffer.alloc(0)
    let stage = 0
    const timer = setTimeout(() => fail(new Error(`通过代理 ${proxy.host}:${proxy.port} 连接 ${host}:${port} 超时`)), timeoutMs)
    const fail = (e: Error): void => {
      clearTimeout(timer)
      sock.removeAllListeners('data')
      sock.destroy()
      reject(e)
    }
    const done = (rest: Buffer): void => {
      clearTimeout(timer)
      sock.removeListener('data', onData)
      sock.removeAllListeners('error')
      if (rest.length) sock.unshift(rest)
      resolve(sock)
    }

    const onData = (chunk: Buffer): void => {
      buf = Buffer.concat([buf, chunk])
      if (proxy.type === 'http') {
        const idx = buf.indexOf('\r\n\r\n')
        if (idx < 0) return
        const head = buf.subarray(0, idx).toString('latin1')
        const status = /^HTTP\/1\.[01] (\d{3})/.exec(head)
        if (!status || status[1] !== '200') return fail(new Error(`代理拒绝 CONNECT: ${head.split('\r\n')[0]}`))
        return done(buf.subarray(idx + 4))
      }
      // SOCKS5
      if (stage === 0) {
        if (buf.length < 2) return
        if (buf[0] !== 5 || buf[1] !== 0) return fail(new Error('SOCKS5 代理握手失败（需要无认证模式）'))
        buf = buf.subarray(2)
        stage = 1
        const hostBuf = Buffer.from(host)
        const req = Buffer.concat([
          Buffer.from([5, 1, 0, 3, hostBuf.length]),
          hostBuf,
          Buffer.from([(port >> 8) & 0xff, port & 0xff])
        ])
        sock.write(req)
      }
      if (stage === 1) {
        if (buf.length < 5) return
        if (buf[1] !== 0) return fail(new Error(`SOCKS5 连接失败，错误码 ${buf[1]}`))
        const atyp = buf[3]
        const len = atyp === 1 ? 10 : atyp === 4 ? 22 : 7 + buf[4]
        if (buf.length < len) return
        return done(buf.subarray(len))
      }
    }

    sock.on('data', onData)
    sock.once('error', (e) => fail(new Error(`无法连接代理 ${proxy.host}:${proxy.port}: ${e.message}`)))
    sock.once('connect', () => {
      if (proxy.type === 'http') {
        sock.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\nProxy-Connection: keep-alive\r\n\r\n`)
      } else {
        sock.write(Buffer.from([5, 1, 0]))
      }
    })
  })
}

function isLoopback(host: string): boolean {
  return host === 'localhost' || host === '::1' || host.startsWith('127.') || host.endsWith('.local')
}

export interface ExecResult {
  code: number
  stdout: string
  stderr: string
}

export interface Tunnel {
  key: string
  localPort: number
  remoteHost: string
  remotePort: number
  server: net.Server
}

/** One SSH connection to a VM, with exec/sftp/port-forward helpers. Emits 'close'. */
export class SshSession extends EventEmitter {
  client = new Client()
  connected = false
  private tunnels = new Map<string, Tunnel>()

  constructor(public vm: VmConfig) {
    super()
  }

  async connect(
    proxy: ProxySettings,
    opts: { allowDirectFallback?: boolean; onPinFingerprint?: (fp: string) => void } = {}
  ): Promise<void> {
    const vm = sanitizeVmHost(this.vm)
    const useProxy: ProxySettings = isLoopback(vm.host) ? { ...proxy, type: 'none' } : proxy
    const attempts: ProxySettings[] =
      useProxy.type !== 'none' && opts.allowDirectFallback ? [useProxy, { ...useProxy, type: 'none' }] : [useProxy]

    let lastErr: Error | null = null
    for (const p of attempts) {
      try {
        await this.connectWithProxy(vm, p, opts.onPinFingerprint)
        return
      } catch (e) {
        lastErr = e as Error
        // Never retry direct vs proxy on authentication failure or SSH host key mismatch
        if (/authentication methods failed|主机公钥指纹不匹配/i.test(lastErr.message)) break
        this.client = new Client()
      }
    }
    throw lastErr || new Error('SSH 连接失败')
  }

  private async connectWithProxy(
    vm: VmConfig,
    useProxy: ProxySettings,
    onPinFingerprint?: (fp: string) => void
  ): Promise<void> {
    const sock = await proxySocket(useProxy, vm.host, vm.port || 22)
    let mismatchError: Error | null = null
    let pendingPin: string | null = null

    const cfg: ConnectConfig = {
      sock,
      username: vm.username,
      readyTimeout: 20000,
      keepaliveInterval: 15000,
      keepaliveCountMax: 3,
      hostVerifier: ((key: Buffer | string) => {
        const keyBuf = Buffer.isBuffer(key) ? key : Buffer.from(key, 'hex')
        const check = verifyOrPinHostKey(vm.hostFingerprint, keyBuf)
        if (!check.ok) {
          mismatchError = new Error(
            `SSH 主机公钥指纹不匹配（服务器可能已重装或存在中间人风险）！预期 ${vm.hostFingerprint}，实际 ${check.fingerprint}。若确认重装，请在编辑虚拟机→高级选项中重置指纹`
          )
          return false
        }
        if (check.shouldPin) {
          pendingPin = check.fingerprint
        }
        return true
      }) as ConnectConfig['hostVerifier']
    }
    if (vm.authType === 'key') {
      if (!vm.privateKeyPath) throw new Error('未设置私钥文件')
      cfg.privateKey = readFileSync(vm.privateKeyPath)
      if (vm.passphrase) cfg.passphrase = vm.passphrase
    } else if (vm.authType === 'password') {
      cfg.password = vm.password
      cfg.tryKeyboard = true
    } else {
      cfg.agent = process.platform === 'win32' ? '\\\\.\\pipe\\openssh-ssh-agent' : process.env.SSH_AUTH_SOCK
    }

    await new Promise<void>((resolve, reject) => {
      const onErr = (e: Error): void => {
        sock.destroy()
        reject(mismatchError || e)
      }
      this.client.once('ready', () => {
        this.client.removeListener('error', onErr)
        this.connected = true
        if (pendingPin) {
          vm.hostFingerprint = pendingPin
          onPinFingerprint?.(pendingPin)
        }
        resolve()
      })
      this.client.once('error', onErr)
      if (vm.authType === 'password') {
        this.client.on('keyboard-interactive', (_n, _i, _l, prompts, finish) => finish(prompts.map(() => vm.password || '')))
      }
      this.client.connect(cfg)
    })

    this.client.on('error', (e) => console.warn(`[ssh ${vm.name}]`, e.message))
    this.client.on('close', () => {
      this.connected = false
      this.closeTunnels()
      this.emit('close')
    })
  }

  exec(cmd: string, opts: { timeoutMs?: number; onLine?: (l: string) => void } = {}): Promise<ExecResult> {
    return new Promise((resolve, reject) => {
      this.client.exec(cmd, (err, stream: ClientChannel) => {
        if (err) return reject(err)
        let stdout = ''
        let stderr = ''
        let partial = ''
        const timer = opts.timeoutMs
          ? setTimeout(() => {
              stream.close()
              reject(new Error(`命令超时: ${cmd}`))
            }, opts.timeoutMs)
          : null
        const feed = (s: string): void => {
          if (!opts.onLine) return
          partial += s
          const lines = partial.split(/\r?\n/)
          partial = lines.pop() || ''
          lines.forEach((l) => opts.onLine!(l))
        }
        stream.on('data', (d: Buffer) => {
          stdout += d.toString()
          feed(d.toString())
        })
        stream.stderr.on('data', (d: Buffer) => {
          stderr += d.toString()
          feed(d.toString())
        })
        stream.on('close', (code: number | null) => {
          if (timer) clearTimeout(timer)
          if (partial && opts.onLine) opts.onLine(partial)
          resolve({ code: code ?? -1, stdout, stderr })
        })
      })
    })
  }

  upload(localPath: string, remotePath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.client.sftp((err, sftp) => {
        if (err) return reject(err)
        sftp.fastPut(localPath, remotePath, (e) => {
          sftp.end()
          if (e) reject(e)
          else resolve()
        })
      })
    })
  }

  /**
   * Listen on 127.0.0.1:<localPort> and forward every connection to remoteHost:remotePort as seen from the VM.
   * If preferredPort is busy a random free port is used.
   */
  async openTunnel(key: string, remoteHost: string, remotePort: number, preferredPort?: number): Promise<Tunnel> {
    const existing = this.tunnels.get(key)
    if (existing && existing.remotePort === remotePort && existing.remoteHost === remoteHost) return existing
    if (existing) this.closeTunnel(key)

    const server = net.createServer((local) => {
      local.setNoDelay(true)
      this.client.forwardOut('127.0.0.1', local.remotePort || 0, remoteHost, remotePort, (err, remote) => {
        if (err) {
          local.destroy()
          return
        }
        local.pipe(remote).pipe(local)
        const kill = (): void => {
          local.destroy()
          remote.destroy()
        }
        local.on('error', kill)
        remote.on('error', kill)
        local.on('close', () => remote.destroy())
        remote.on('close', () => local.destroy())
      })
    })

    const listen = (p: number): Promise<number> =>
      new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(p, '127.0.0.1', () => {
          server.removeListener('error', reject)
          resolve((server.address() as net.AddressInfo).port)
        })
      })

    let localPort: number
    try {
      localPort = await listen(preferredPort || 0)
    } catch {
      localPort = await listen(0)
    }
    const t: Tunnel = { key, localPort, remoteHost, remotePort, server }
    this.tunnels.set(key, t)
    return t
  }

  closeTunnel(key: string): void {
    const t = this.tunnels.get(key)
    if (t) {
      t.server.close()
      this.tunnels.delete(key)
    }
  }

  closeTunnels(): void {
    for (const k of [...this.tunnels.keys()]) this.closeTunnel(k)
  }

  end(): void {
    this.closeTunnels()
    try {
      this.client.end()
    } catch {
      /* ignore */
    }
    this.connected = false
  }
}
