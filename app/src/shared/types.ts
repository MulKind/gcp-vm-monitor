// Types shared between main, preload and renderer.

export type ProxyType = 'none' | 'http' | 'socks5'

export interface ProxySettings {
  type: ProxyType
  host: string
  port: number
}

export interface Settings {
  proxy: ProxySettings
  /** Use the proxy for embedded browser when opening services via public URL/domain */
  browserUseProxy: boolean
  /** Minimize to system tray instead of quitting when clicking the window close button */
  closeToTray: boolean
  metricsIntervalMs: number
  servicesIntervalMs: number
}

export type AuthType = 'key' | 'password' | 'agent'

export interface VmConfig {
  id: string
  name: string
  kind: 'ssh' | 'demo'
  host: string
  port: number
  username: string
  authType: AuthType
  privateKeyPath?: string
  passphrase?: string
  password?: string
  /** Agent bearer token (filled after install) */
  agentToken?: string
  agentPort: number
  /** GCP meta (optional, informational for now) */
  gcpProject?: string
  gcpZone?: string
  tags?: string[]
  /** Per-service overrides keyed by service id */
  serviceOverrides?: Record<string, ServiceOverride>
}

export interface ServiceOverride {
  displayName?: string
  hidden?: boolean
  /** 'tunnel' = via SSH tunnel to 127.0.0.1:port on the VM; 'url' = open externalUrl directly */
  openMode?: 'tunnel' | 'url'
  scheme?: 'http' | 'https'
  port?: number
  path?: string
  externalUrl?: string
}

export type ConnState = 'disconnected' | 'connecting' | 'connected' | 'no-agent' | 'error'

export interface VmStatus {
  vmId: string
  state: ConnState
  message?: string
  since: number
}

// ---------- Agent API v1 (see docs/agent-api.md) ----------

export interface AgentInfo {
  agent_version: string
  hostname: string
  os: string
  kernel: string
  arch: string
  cpu_model: string
  cpu_count: number
  mem_total: number
  boot_time: number
  docker: boolean
  systemd: boolean
}

export interface DiskInfo {
  mount: string
  device: string
  fs: string
  total: number
  used: number
  free: number
  percent: number
}

export interface Metrics {
  ts: number
  uptime: number
  cpu: { percent: number; per_core: number[]; iowait: number; steal: number }
  load: [number, number, number]
  mem: {
    total: number
    used: number
    available: number
    percent: number
    buffers: number
    cached: number
    swap_total: number
    swap_used: number
  }
  disks: DiskInfo[]
  disk_io: { read_bps: number; write_bps: number; read_iops: number; write_iops: number }
  net: {
    rx_bps: number
    tx_bps: number
    rx_total: number
    tx_total: number
    interfaces: { name: string; rx_bps: number; tx_bps: number; rx_total: number; tx_total: number }[]
  }
  procs: number
  tcp: { established: number; listen: number; time_wait: number }
}

export type ServiceStatus = 'running' | 'stopped' | 'failed' | 'restarting' | 'unknown'
export type ServiceHealth = 'healthy' | 'degraded' | 'down' | 'stopped' | 'unknown'

export interface ServicePort {
  port: number
  proto: string
  bind: string
  host_port?: number
}

export interface Service {
  id: string
  name: string
  display_name: string
  kind: string
  category: string
  source: 'docker' | 'systemd' | 'process' | 'manual'
  status: ServiceStatus
  health: ServiceHealth
  ports: ServicePort[]
  web: { port: number; scheme: 'http' | 'https'; path: string } | null
  check: { ok: boolean; code: number | null; latency_ms: number | null; ts: number; error: string | null } | null
  uptime: number | null
  container?: {
    id: string
    image: string
    state: string
    health: string | null
    restarts: number
    cpu_percent: number | null
    mem_bytes: number | null
    mem_limit: number | null
    compose_project: string | null
  } | null
  systemd?: { unit: string; active: string; sub: string; pid: number | null } | null
  process?: { pid: number; name: string; cmdline: string; cpu_percent: number | null; mem_bytes: number | null } | null
}

export interface TopProc {
  pid: number
  name: string
  user: string
  cpu_percent: number
  mem_bytes: number
  cmdline: string
}

// ---------- IPC payloads ----------

export interface AppSnapshot {
  vms: VmConfig[]
  settings: Settings
  statuses: VmStatus[]
  infos: Record<string, AgentInfo>
  services: Record<string, Service[]>
}

export interface OpenServiceResult {
  url: string
  partition: string
  title: string
}

export interface InstallLog {
  vmId: string
  line: string
  done?: boolean
  ok?: boolean
}

export interface GeneratedKey {
  privateKeyPath: string
  publicKey: string
}
