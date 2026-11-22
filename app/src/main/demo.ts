import http from 'http'
import type { AgentInfo, Metrics, Service, TopProc } from '@shared/types'

/** Synthetic data so the UI can be explored without real VMs. */

const GB = 1024 ** 3

interface DemoState {
  cpu: number
  mem: number
  rx: number
  tx: number
  rxTotal: number
  txTotal: number
  services: Service[]
  t0: number
}

const states = new Map<string, DemoState>()

function walk(v: number, min: number, max: number, step: number): number {
  return Math.min(max, Math.max(min, v + (Math.random() - 0.5) * step))
}

function svc(p: Partial<Service> & Pick<Service, 'id' | 'name' | 'display_name' | 'kind' | 'category' | 'source'>): Service {
  return {
    status: 'running',
    health: 'healthy',
    ports: [],
    web: null,
    check: { ok: true, code: 200, latency_ms: 5 + Math.random() * 40, ts: Date.now() / 1000, error: null },
    uptime: 3600 * 24 * 3,
    container: null,
    systemd: null,
    process: null,
    ...p
  }
}

function dockerInfo(image: string, project: string | null = null): Service['container'] {
  return {
    id: Math.random().toString(16).slice(2, 14),
    image,
    state: 'running',
    health: null,
    restarts: 0,
    cpu_percent: Math.random() * 5,
    mem_bytes: Math.floor(30e6 + Math.random() * 300e6),
    mem_limit: 0,
    compose_project: project
  }
}

function makeServices(seed: number): Service[] {
  const base: Service[] = [
    svc({ id: 'systemd:nginx', name: 'nginx', display_name: 'Nginx', kind: 'nginx', category: 'proxy', source: 'systemd',
      ports: [{ port: 80, proto: 'tcp', bind: '0.0.0.0' }, { port: 443, proto: 'tcp', bind: '0.0.0.0' }],
      web: { port: 80, scheme: 'http', path: '/' }, systemd: { unit: 'nginx.service', active: 'active', sub: 'running', pid: 812 } }),
    svc({ id: 'docker:portainer', name: 'portainer', display_name: 'Portainer', kind: 'portainer', category: 'panel', source: 'docker',
      ports: [{ port: 9443, proto: 'tcp', bind: '0.0.0.0', host_port: 9443 }], web: { port: 9443, scheme: 'https', path: '/' },
      container: dockerInfo('portainer/portainer-ce:latest', 'portainer') }),
    svc({ id: 'docker:grafana', name: 'grafana', display_name: 'Grafana', kind: 'grafana', category: 'monitoring', source: 'docker',
      ports: [{ port: 3000, proto: 'tcp', bind: '127.0.0.1', host_port: 3000 }], web: { port: 3000, scheme: 'http', path: '/' },
      container: dockerInfo('grafana/grafana:11', 'monitoring') }),
    svc({ id: 'docker:mysql', name: 'mysql', display_name: 'MySQL', kind: 'mysql', category: 'database', source: 'docker',
      ports: [{ port: 3306, proto: 'tcp', bind: '127.0.0.1', host_port: 3306 }], check: { ok: true, code: null, latency_ms: 1.2, ts: Date.now() / 1000, error: null },
      container: dockerInfo('mysql:8.4', 'app') }),
    svc({ id: 'docker:redis', name: 'redis', display_name: 'Redis', kind: 'redis', category: 'cache', source: 'docker',
      ports: [{ port: 6379, proto: 'tcp', bind: '127.0.0.1', host_port: 6379 }], check: { ok: true, code: null, latency_ms: 0.6, ts: Date.now() / 1000, error: null },
      container: dockerInfo('redis:7-alpine', 'app') }),
    svc({ id: 'process:bt', name: 'BT-Panel', display_name: '宝塔面板', kind: 'bt', category: 'panel', source: 'process',
      ports: [{ port: 8888, proto: 'tcp', bind: '0.0.0.0' }], web: { port: 8888, scheme: 'http', path: '/abc123' },
      process: { pid: 1520, name: 'BT-Panel', cmdline: '/www/server/panel/pyenv/bin/python3 BT-Panel', cpu_percent: 0.4, mem_bytes: 85e6 } }),
    svc({ id: 'docker:uptime-kuma', name: 'uptime-kuma', display_name: 'Uptime Kuma', kind: 'uptime-kuma', category: 'monitoring', source: 'docker',
      ports: [{ port: 3001, proto: 'tcp', bind: '0.0.0.0', host_port: 3001 }], web: { port: 3001, scheme: 'http', path: '/' },
      health: 'degraded', check: { ok: true, code: 200, latency_ms: 1820, ts: Date.now() / 1000, error: null },
      container: dockerInfo('louislam/uptime-kuma:1') }),
    svc({ id: 'docker:n8n', name: 'n8n', display_name: 'n8n', kind: 'n8n', category: 'app', source: 'docker',
      ports: [{ port: 5678, proto: 'tcp', bind: '127.0.0.1', host_port: 5678 }], web: { port: 5678, scheme: 'http', path: '/' },
      status: 'restarting', health: 'down', check: { ok: false, code: null, latency_ms: null, ts: Date.now() / 1000, error: 'connection refused' },
      container: { ...dockerInfo('n8nio/n8n:latest')!, state: 'restarting', restarts: 7 } }),
    svc({ id: 'systemd:x-ui', name: 'x-ui', display_name: '3X-UI', kind: 'x-ui', category: 'proxy-tool', source: 'systemd',
      ports: [{ port: 2053, proto: 'tcp', bind: '0.0.0.0' }], web: { port: 2053, scheme: 'http', path: '/' },
      systemd: { unit: 'x-ui.service', active: 'active', sub: 'running', pid: 990 } }),
    svc({ id: 'process:node', name: 'node', display_name: 'Node.js App', kind: 'nodejs', category: 'app', source: 'process',
      ports: [{ port: 8080, proto: 'tcp', bind: '0.0.0.0' }], web: { port: 8080, scheme: 'http', path: '/' },
      process: { pid: 2211, name: 'node', cmdline: 'node /srv/app/server.js', cpu_percent: 2.1, mem_bytes: 140e6 } }),
    svc({ id: 'docker:alist', name: 'alist', display_name: 'Alist', kind: 'alist', category: 'storage', source: 'docker',
      status: 'stopped', health: 'stopped', check: null, uptime: null, ports: [], web: { port: 5244, scheme: 'http', path: '/' },
      container: { ...dockerInfo('xhofe/alist:latest')!, state: 'exited', cpu_percent: null, mem_bytes: null } })
  ]
  // vary by seed so different demo VMs look different
  return base.filter((_, i) => (i + seed) % 4 !== 0 || i < 2)
}

function state(vmId: string): DemoState {
  let s = states.get(vmId)
  if (!s) {
    const seed = [...vmId].reduce((a, c) => a + c.charCodeAt(0), 0)
    s = { cpu: 10 + (seed % 30), mem: 30 + (seed % 40), rx: 2e5, tx: 1e5, rxTotal: 5e10, txTotal: 2e10, services: makeServices(seed), t0: Date.now() / 1000 - 86400 * 5 }
    states.set(vmId, s)
  }
  return s
}

export function demoInfo(vmId: string, name: string): AgentInfo {
  const s = state(vmId)
  return {
    agent_version: '0.1.0-demo',
    hostname: name.toLowerCase().replace(/\s+/g, '-'),
    os: 'Debian GNU/Linux 12 (bookworm)',
    kernel: '6.1.0-28-cloud-amd64',
    arch: 'x86_64',
    cpu_model: 'AMD EPYC 7B12',
    cpu_count: 2,
    mem_total: 4 * GB,
    boot_time: s.t0,
    docker: true,
    systemd: true
  }
}

export function demoMetrics(vmId: string): Metrics {
  const s = state(vmId)
  s.cpu = walk(s.cpu, 2, 98, 12)
  s.mem = walk(s.mem, 15, 95, 3)
  s.rx = walk(s.rx, 1e3, 8e6, 6e5)
  s.tx = walk(s.tx, 1e3, 4e6, 3e5)
  s.rxTotal += s.rx
  s.txTotal += s.tx
  const total = 4 * GB
  const used = (total * s.mem) / 100
  return {
    ts: Date.now() / 1000,
    uptime: Date.now() / 1000 - s.t0,
    cpu: { percent: s.cpu, per_core: [walk(s.cpu, 0, 100, 20), walk(s.cpu, 0, 100, 20)], iowait: Math.random() * 2, steal: Math.random() * 0.5 },
    load: [s.cpu / 50, s.cpu / 55, s.cpu / 60],
    mem: { total, used, available: total - used, percent: s.mem, buffers: 1e8, cached: 8e8, swap_total: 0, swap_used: 0 },
    disks: [
      { mount: '/', device: '/dev/sda1', fs: 'ext4', total: 30 * GB, used: 13.4 * GB, free: 16.6 * GB, percent: 44.7 },
      { mount: '/data', device: '/dev/sdb', fs: 'ext4', total: 100 * GB, used: 87 * GB, free: 13 * GB, percent: 87 }
    ],
    disk_io: { read_bps: Math.random() * 2e6, write_bps: Math.random() * 4e6, read_iops: Math.random() * 50, write_iops: Math.random() * 120 },
    net: {
      rx_bps: s.rx,
      tx_bps: s.tx,
      rx_total: s.rxTotal,
      tx_total: s.txTotal,
      interfaces: [{ name: 'ens4', rx_bps: s.rx, tx_bps: s.tx, rx_total: s.rxTotal, tx_total: s.txTotal }]
    },
    procs: 140 + Math.floor(Math.random() * 10),
    tcp: { established: 20 + Math.floor(Math.random() * 30), listen: 12, time_wait: Math.floor(Math.random() * 10) }
  }
}

export function demoServices(vmId: string): Service[] {
  const s = state(vmId)
  for (const x of s.services) {
    if (x.check && x.status === 'running' && x.health === 'healthy') {
      x.check = { ...x.check, latency_ms: 5 + Math.random() * 40, ts: Date.now() / 1000 }
    }
    if (x.container && x.container.cpu_percent != null) x.container.cpu_percent = walk(x.container.cpu_percent, 0, 40, 3)
  }
  return s.services
}

export function demoAction(vmId: string, svcId: string, action: string): void {
  const s = state(vmId).services.find((x) => x.id === svcId)
  if (!s) throw new Error('service not found')
  if (action === 'stop') Object.assign(s, { status: 'stopped', health: 'stopped', check: null })
  else Object.assign(s, { status: 'running', health: 'healthy', check: { ok: true, code: 200, latency_ms: 10, ts: Date.now() / 1000, error: null } })
  if (s.container) s.container.state = s.status === 'running' ? 'running' : 'exited'
}

export function demoLogs(svcId: string): string[] {
  const now = Date.now()
  return Array.from({ length: 60 }, (_, i) => {
    const t = new Date(now - (60 - i) * 7000).toISOString()
    const lvl = i % 17 === 0 ? 'WARN' : i % 29 === 0 ? 'ERROR' : 'INFO'
    return `${t} ${lvl} [${svcId}] demo log line #${i + 1}: request handled in ${Math.floor(Math.random() * 90)}ms`
  })
}

export function demoTop(): TopProc[] {
  const names = ['dockerd', 'mysqld', 'node', 'nginx', 'grafana', 'redis-server', 'containerd', 'python3', 'BT-Panel', 'x-ui']
  return names.map((n, i) => ({
    pid: 400 + i * 37,
    name: n,
    user: i % 3 ? 'root' : 'www-data',
    cpu_percent: Math.max(0, 15 - i * 1.4 + Math.random() * 3),
    mem_bytes: Math.floor((300 - i * 25) * 1e6),
    cmdline: `/usr/bin/${n} --demo`
  }))
}

// ---------- fake service admin pages ----------

let demoServer: http.Server | null = null
let demoPort = 0

export async function ensureDemoServer(): Promise<number> {
  if (demoServer) return demoPort
  demoServer = http.createServer((req, res) => {
    const parts = decodeURIComponent(req.url || '/').split('/').filter(Boolean)
    const title = parts[1] || 'Demo'
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(`<!doctype html><html><head><title>${title} (Demo)</title><style>
      body{margin:0;font-family:system-ui,'Microsoft YaHei';background:linear-gradient(135deg,#1e293b,#0f172a);color:#e2e8f0;display:flex;align-items:center;justify-content:center;height:100vh}
      .c{background:#1e293bcc;border:1px solid #334155;border-radius:16px;padding:40px 56px;text-align:center;box-shadow:0 20px 60px #0008}
      h1{margin:0 0 8px;font-size:32px} p{color:#94a3b8} code{background:#0f172a;padding:2px 8px;border-radius:6px;color:#38bdf8}
      input{display:block;margin:10px auto;padding:10px 14px;width:240px;border-radius:8px;border:1px solid #475569;background:#0f172a;color:#fff}
      button{margin-top:10px;padding:10px 36px;border-radius:8px;border:0;background:#3b82f6;color:#fff;font-size:15px;cursor:pointer}
    </style></head><body><div class="c"><h1>${title}</h1><p>这是演示模式下的模拟服务后台</p>
    <p>真实环境中，这里会通过 SSH 隧道打开 VM 上的 <code>${title}</code> 管理界面</p>
    <input placeholder="用户名"><input placeholder="密码" type="password"><button onclick="this.textContent='已登录 ✓'">登录</button>
    <p style="font-size:12px;margin-top:24px">URL: <code>${req.url}</code></p></div></body></html>`)
  })
  await new Promise<void>((r) => demoServer!.listen(0, '127.0.0.1', () => r()))
  demoPort = (demoServer.address() as { port: number }).port
  return demoPort
}
