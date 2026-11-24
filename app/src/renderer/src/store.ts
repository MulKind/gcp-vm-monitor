import { reactive, computed, markRaw } from 'vue'
import type {
  AgentInfo,
  GcpBillingConfig,
  GcpBillingSummary,
  Metrics,
  Service,
  Settings,
  VmConfig,
  VmStatus
} from '@shared/types'

export const HISTORY = 300 // points kept per VM (~5 min at 1s)

export interface Sample {
  t: number
  cpu: number
  mem: number
  rx: number
  tx: number
  dr: number
  dw: number
  load: number
}

export interface Tab {
  id: string
  vmId: string
  svcId: string | null
  title: string
  url: string
  partition: string
  kind: string
  wcId?: number
}

export const state = reactive({
  ready: false,
  vms: [] as VmConfig[],
  settings: null as Settings | null,
  statuses: {} as Record<string, VmStatus>,
  infos: {} as Record<string, AgentInfo>,
  metrics: {} as Record<string, Metrics>,
  history: {} as Record<string, Sample[]>,
  services: {} as Record<string, Service[]>,
  billingConfig: null as GcpBillingConfig | null,
  billingSummary: null as GcpBillingSummary | null,
  view: 'overview' as 'overview' | 'vm' | 'billing',
  selectedVm: null as string | null,
  tabs: [] as Tab[],
  activeTab: 'home' as string,
  toasts: [] as { id: number; text: string; type: 'info' | 'error' | 'ok' }[]
})

let toastId = 0
export function toast(text: string, type: 'info' | 'error' | 'ok' = 'info'): void {
  const id = ++toastId
  state.toasts.push({ id, text, type })
  setTimeout(() => {
    const i = state.toasts.findIndex((t) => t.id === id)
    if (i >= 0) state.toasts.splice(i, 1)
  }, type === 'error' ? 6000 : 3000)
}

export function vmById(id: string | null): VmConfig | undefined {
  return state.vms.find((v) => v.id === id)
}

export const selectedVm = computed(() => vmById(state.selectedVm))

export function visibleServices(vmId: string): Service[] {
  const vm = vmById(vmId)
  const ov = vm?.serviceOverrides || {}
  return (state.services[vmId] || [])
    .filter((s) => !ov[s.id]?.hidden)
    .map((s) => (ov[s.id]?.displayName ? { ...s, display_name: ov[s.id]!.displayName! } : s))
}

export function healthCounts(vmId: string): Record<string, number> {
  const c: Record<string, number> = { healthy: 0, degraded: 0, down: 0, stopped: 0, unknown: 0 }
  for (const s of visibleServices(vmId)) c[s.health] = (c[s.health] || 0) + 1
  return c
}

function pushSample(vmId: string, m: Metrics): void {
  // keep history arrays non-reactive-deep for perf; replace array ref to trigger updates
  const prev = state.history[vmId] || []
  const s: Sample = {
    t: m.ts * 1000,
    cpu: m.cpu.percent,
    mem: m.mem.percent,
    rx: m.net.rx_bps,
    tx: m.net.tx_bps,
    dr: m.disk_io.read_bps,
    dw: m.disk_io.write_bps,
    load: m.load[0]
  }
  const next = prev.length >= HISTORY ? prev.slice(prev.length - HISTORY + 1) : prev.slice()
  next.push(s)
  state.history[vmId] = markRaw(next)
}

export function openVm(id: string): void {
  state.selectedVm = id
  state.view = 'vm'
  state.activeTab = 'home'
}

export function goHome(): void {
  state.view = 'overview'
  state.activeTab = 'home'
}

export function openBilling(): void {
  state.view = 'billing'
  state.activeTab = 'home'
}

export function openGcpConsoleTab(url: string, title: string): void {
  const existing = state.tabs.find((t) => t.partition === 'persist:gcp-console' && t.url === url)
  if (existing) {
    state.activeTab = existing.id
    return
  }
  const tab: Tab = {
    id: `t${Date.now()}${Math.random().toString(16).slice(2, 6)}`,
    vmId: '',
    svcId: null,
    title,
    url,
    partition: 'persist:gcp-console',
    kind: 'googlecloud'
  }
  state.tabs.push(tab)
  state.activeTab = tab.id
}

export async function openServiceTab(vmId: string, svc: Service): Promise<void> {
  const existing = state.tabs.find((t) => t.vmId === vmId && t.svcId === svc.id)
  if (existing) {
    state.activeTab = existing.id
    return
  }
  try {
    const r = await window.api.openService(vmId, svc.id)
    const vm = vmById(vmId)
    const tab: Tab = {
      id: `t${Date.now()}${Math.random().toString(16).slice(2, 6)}`,
      vmId,
      svcId: svc.id,
      title: `${r.title} · ${vm?.name ?? ''}`,
      url: r.url,
      partition: r.partition,
      kind: svc.kind
    }
    state.tabs.push(tab)
    state.activeTab = tab.id
  } catch (e) {
    toast('打开失败: ' + errMsg(e), 'error')
  }
}

export function openUrlTab(from: Tab, url: string): void {
  const tab: Tab = { ...from, id: `t${Date.now()}`, url, title: url.replace(/^https?:\/\//, '').slice(0, 40), wcId: undefined }
  state.tabs.push(tab)
  state.activeTab = tab.id
}

export function closeTab(id: string): void {
  const i = state.tabs.findIndex((t) => t.id === id)
  if (i < 0) return
  state.tabs.splice(i, 1)
  if (state.activeTab === id) state.activeTab = state.tabs[Math.min(i, state.tabs.length - 1)]?.id || 'home'
}

export function errMsg(e: unknown): string {
  const m = (e as Error)?.message || String(e)
  return m.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

export async function initStore(): Promise<void> {
  const api = window.api
  const snap = await api.snapshot()
  state.vms = snap.vms
  state.settings = snap.settings
  for (const s of snap.statuses) state.statuses[s.vmId] = s
  state.infos = snap.infos
  state.services = snap.services
  state.billingConfig = snap.billingConfig
  state.billingSummary = snap.billingSummary
  api.onStatus((s) => (state.statuses[s.vmId] = s))
  api.onInfo((id, info) => (state.infos[id] = info))
  api.onMetrics((id, m) => {
    state.metrics[id] = m
    pushSample(id, m)
  })
  api.onServices((id, list) => (state.services[id] = list))
  api.onVmConfig((vm) => {
    const i = state.vms.findIndex((v) => v.id === vm.id)
    if (i >= 0) state.vms[i] = vm
  })
  api.onBillingSummary((s) => {
    state.billingSummary = s
  })
  api.onNavBilling(() => {
    openBilling()
  })
  api.onWebviewNewWindow(({ webContentsId, url }) => {
    const from = state.tabs.find((t) => t.wcId === webContentsId)
    if (from) openUrlTab(from, url)
    else void api.openExternal(url)
  })
  state.ready = true
}

export async function refreshVms(): Promise<void> {
  const snap = await window.api.snapshot()
  state.vms = snap.vms
  state.settings = snap.settings
}
