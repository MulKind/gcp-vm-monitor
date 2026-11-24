import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type {
  AgentInfo,
  AppSnapshot,
  GcpBillingConfig,
  GcpBillingSummary,
  GeneratedKey,
  InstallLog,
  Metrics,
  OpenServiceResult,
  Service,
  ServiceOverride,
  Settings,
  TopProc,
  VmConfig,
  VmStatus
} from '../shared/types'

function on<T extends unknown[]>(channel: string, cb: (...args: T) => void): () => void {
  const h = (_e: IpcRendererEvent, ...args: unknown[]): void => cb(...(args as T))
  ipcRenderer.on(channel, h)
  return () => ipcRenderer.removeListener(channel, h)
}

const api = {
  snapshot: (): Promise<AppSnapshot> => ipcRenderer.invoke('app:snapshot'),
  saveVm: (vm: VmConfig): Promise<VmConfig> => ipcRenderer.invoke('vm:save', vm),
  deleteVm: (id: string): Promise<void> => ipcRenderer.invoke('vm:delete', id),
  reconnect: (id: string): Promise<void> => ipcRenderer.invoke('vm:reconnect', id),
  installAgent: (id: string): Promise<boolean> => ipcRenderer.invoke('vm:install', id),
  top: (id: string): Promise<TopProc[]> => ipcRenderer.invoke('vm:top', id),
  openService: (vmId: string, svcId: string): Promise<OpenServiceResult> => ipcRenderer.invoke('svc:open', vmId, svcId),
  logs: (vmId: string, svcId: string, lines?: number): Promise<string[]> => ipcRenderer.invoke('svc:logs', vmId, svcId, lines),
  action: (vmId: string, svcId: string, action: 'start' | 'stop' | 'restart'): Promise<{ ok: boolean; output: string }> =>
    ipcRenderer.invoke('svc:action', vmId, svcId, action),
  setOverride: (vmId: string, svcId: string, ov: ServiceOverride | null): Promise<VmConfig> =>
    ipcRenderer.invoke('svc:override', vmId, svcId, ov),
  saveSettings: (s: Settings): Promise<Settings> => ipcRenderer.invoke('settings:save', s),
  pickKey: (): Promise<string | null> => ipcRenderer.invoke('dialog:pickKey'),
  pickJson: (): Promise<{ path: string; content: string } | null> => ipcRenderer.invoke('dialog:pickJson'),
  generateKey: (username: string): Promise<GeneratedKey> => ipcRenderer.invoke('key:generate', username),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('shell:open', url),

  saveBilling: (cfg: GcpBillingConfig): Promise<{ config: GcpBillingConfig; summary: GcpBillingSummary | null }> =>
    ipcRenderer.invoke('billing:save', cfg),
  refreshBilling: (): Promise<GcpBillingSummary> => ipcRenderer.invoke('billing:refresh'),

  onStatus: (cb: (s: VmStatus) => void) => on<[VmStatus]>('vm:status', cb),
  onInfo: (cb: (id: string, info: AgentInfo) => void) => on<[string, AgentInfo]>('vm:info', cb),
  onMetrics: (cb: (id: string, m: Metrics) => void) => on<[string, Metrics]>('vm:metrics', cb),
  onServices: (cb: (id: string, list: Service[]) => void) => on<[string, Service[]]>('vm:services', cb),
  onVmConfig: (cb: (vm: VmConfig) => void) => on<[VmConfig]>('vm:config', cb),
  onInstallLog: (cb: (l: InstallLog) => void) => on<[InstallLog]>('install:log', cb),
  onBillingSummary: (cb: (s: GcpBillingSummary | null) => void) => on<[GcpBillingSummary | null]>('billing:summary', cb),
  onNavBilling: (cb: () => void) => on<[]>('nav:billing', cb),
  onWebviewNewWindow: (cb: (p: { webContentsId: number; url: string }) => void) =>
    on<[{ webContentsId: number; url: string }]>('webview:new-window', cb)
}

export type Api = typeof api

contextBridge.exposeInMainWorld('api', api)
