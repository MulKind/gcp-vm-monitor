import type { ConnState, ServiceHealth } from '@shared/types'

export function fmtBytes(n: number | null | undefined, digits = 1): string {
  if (n == null || isNaN(n)) return '—'
  const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
  let i = 0
  let v = Math.abs(n)
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(i === 0 ? 0 : digits)} ${u[i]}`
}

export function fmtRate(n: number | null | undefined): string {
  if (n == null || isNaN(n)) return '—'
  return fmtBytes(n) + '/s'
}

export function fmtPct(n: number | null | undefined, d = 1): string {
  if (n == null || isNaN(n)) return '—'
  return n.toFixed(d) + '%'
}

export function fmtDuration(sec: number | null | undefined): string {
  if (sec == null || isNaN(sec) || sec < 0) return '—'
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  if (d > 0) return `${d}天 ${h}时`
  if (h > 0) return `${h}时 ${m}分`
  if (m > 0) return `${m}分`
  return `${Math.floor(sec)}秒`
}

export function pctColor(p: number | null | undefined): string {
  if (p == null) return 'var(--muted)'
  if (p >= 90) return 'var(--red)'
  if (p >= 75) return 'var(--yellow)'
  return 'var(--green)'
}

export const HEALTH_LABEL: Record<ServiceHealth, string> = {
  healthy: '正常',
  degraded: '缓慢',
  down: '宕机',
  stopped: '已停止',
  unknown: '未知'
}

export const HEALTH_COLOR: Record<ServiceHealth, string> = {
  healthy: 'var(--green)',
  degraded: 'var(--yellow)',
  down: 'var(--red)',
  stopped: 'var(--gray)',
  unknown: 'var(--muted)'
}

export const CONN_LABEL: Record<ConnState, string> = {
  disconnected: '未连接',
  connecting: '连接中',
  connected: '在线',
  'no-agent': '未安装 Agent',
  error: '异常'
}

export const CONN_COLOR: Record<ConnState, string> = {
  disconnected: 'var(--gray)',
  connecting: 'var(--blue)',
  connected: 'var(--green)',
  'no-agent': 'var(--yellow)',
  error: 'var(--red)'
}

export const CATEGORY_LABEL: Record<string, string> = {
  panel: '管理面板',
  web: 'Web 应用',
  database: '数据库',
  cache: '缓存',
  proxy: '反向代理',
  monitoring: '监控',
  'proxy-tool': '代理工具',
  storage: '存储',
  app: '应用',
  system: '系统'
}

export const SOURCE_LABEL: Record<string, string> = {
  docker: 'Docker',
  systemd: 'systemd',
  process: '进程',
  manual: '手动'
}
