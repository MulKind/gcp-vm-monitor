import { app, safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'fs'
import { join } from 'path'
import type { GcpBillingConfig, GcpBillingSummary, Settings, VmConfig } from '@shared/types'

interface StoreData {
  version: 1
  settings: Settings
  vms: VmConfig[]
  /** stable local tunnel ports per service key so browser origins (and logins) persist */
  tunnelPorts: Record<string, number>
  billing: GcpBillingConfig
  billingSummary?: GcpBillingSummary | null
}

const SECRET_FIELDS = ['password', 'passphrase', 'agentToken'] as const

function defaultProxy(): Settings['proxy'] {
  const env = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy
  if (env) {
    try {
      const u = new URL(env)
      const type = u.protocol.startsWith('socks') ? 'socks5' : 'http'
      return { type, host: u.hostname, port: Number(u.port) || 10808 }
    } catch {
      /* ignore */
    }
  }
  return { type: 'http', host: '127.0.0.1', port: 10808 }
}

function defaults(): StoreData {
  return {
    version: 1,
    settings: {
      proxy: defaultProxy(),
      browserUseProxy: true,
      closeToTray: true,
      metricsIntervalMs: 1000,
      servicesIntervalMs: 5000
    },
    vms: [],
    tunnelPorts: {},
    billing: {
      mode: 'unconfigured',
      projectId: '',
      datasetId: 'billing_export',
      currency: 'USD',
      creditGrants: [
        {
          id: 'default-trial',
          name: 'GCP Free Trial 试用赠金',
          totalAmount: 300
        }
      ],
      autoRefreshMinutes: 30
    },
    billingSummary: null
  }
}

function encrypt(v: string): string {
  if (!v) return v
  if (safeStorage.isEncryptionAvailable()) return 'enc:' + safeStorage.encryptString(v).toString('base64')
  return v
}

function decrypt(v: string | undefined): string | undefined {
  if (!v || !v.startsWith('enc:')) return v
  try {
    return safeStorage.decryptString(Buffer.from(v.slice(4), 'base64'))
  } catch {
    return undefined
  }
}

export function sanitizeVmHost(vm: VmConfig): VmConfig {
  if (!vm.host) return vm
  let h = vm.host.trim().replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '')
  const slash = h.indexOf('/')
  if (slash >= 0) h = h.slice(0, slash)
  const at = h.lastIndexOf('@')
  if (at >= 0) {
    if (!vm.username) vm.username = h.slice(0, at)
    h = h.slice(at + 1)
  }
  const colon = h.match(/^([^:]+):(\d+)$/)
  if (colon) {
    h = colon[1]
    if (!vm.port || vm.port === 22) vm.port = Number(colon[2])
  }
  vm.host = h.trim()
  return vm
}

class Store {
  private file = ''
  private data: StoreData = defaults()

  load(): void {
    const dir = app.getPath('userData')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    this.file = join(dir, 'vmmon-config.json')
    if (existsSync(this.file)) {
      try {
        const raw = JSON.parse(readFileSync(this.file, 'utf8')) as StoreData
        const d = defaults()
        this.data = {
          ...d,
          ...raw,
          settings: { ...d.settings, ...raw.settings, proxy: { ...d.settings.proxy, ...raw.settings?.proxy } },
          vms: (raw.vms || []).map((vm) => {
            const out: VmConfig = sanitizeVmHost({ ...vm })
            for (const f of SECRET_FIELDS) out[f] = decrypt(vm[f])
            return out
          }),
          tunnelPorts: raw.tunnelPorts || {},
          billing: {
            ...d.billing,
            ...(raw.billing || {}),
            serviceAccountJson: decrypt(raw.billing?.serviceAccountJson),
            creditGrants: raw.billing?.creditGrants?.length ? raw.billing.creditGrants : d.billing.creditGrants
          },
          billingSummary: raw.billingSummary || null
        }
      } catch (e) {
        console.error('[store] failed to read config, using defaults', e)
      }
    }
  }

  private save(): void {
    const out: StoreData = {
      ...this.data,
      vms: this.data.vms.map((vm) => {
        const c: VmConfig = { ...vm }
        for (const f of SECRET_FIELDS) if (c[f]) c[f] = encrypt(c[f] as string)
        return c
      }),
      billing: {
        ...this.data.billing,
        serviceAccountJson: this.data.billing.serviceAccountJson
          ? encrypt(this.data.billing.serviceAccountJson)
          : undefined
      }
    }
    const tmp = this.file + '.tmp'
    writeFileSync(tmp, JSON.stringify(out, null, 2), 'utf8')
    renameSync(tmp, this.file)
  }

  get settings(): Settings {
    return this.data.settings
  }

  setSettings(s: Settings): void {
    this.data.settings = s
    this.save()
  }

  get vms(): VmConfig[] {
    return this.data.vms
  }

  getVm(id: string): VmConfig | undefined {
    return this.data.vms.find((v) => v.id === id)
  }

  upsertVm(vm: VmConfig): void {
    sanitizeVmHost(vm)
    const i = this.data.vms.findIndex((v) => v.id === vm.id)
    if (i >= 0) this.data.vms[i] = vm
    else this.data.vms.push(vm)
    this.save()
  }

  patchVm(id: string, patch: Partial<VmConfig>): VmConfig | undefined {
    const vm = this.getVm(id)
    if (!vm) return undefined
    Object.assign(vm, patch)
    this.save()
    return vm
  }

  deleteVm(id: string): void {
    this.data.vms = this.data.vms.filter((v) => v.id !== id)
    for (const k of Object.keys(this.data.tunnelPorts)) if (k.startsWith(id + '|')) delete this.data.tunnelPorts[k]
    this.save()
  }

  getTunnelPort(key: string): number | undefined {
    return this.data.tunnelPorts[key]
  }

  setTunnelPort(key: string, port: number): void {
    this.data.tunnelPorts[key] = port
    this.save()
  }

  usedTunnelPorts(): Set<number> {
    return new Set(Object.values(this.data.tunnelPorts))
  }

  get billing(): GcpBillingConfig {
    return this.data.billing
  }

  setBilling(cfg: GcpBillingConfig): void {
    this.data.billing = cfg
    this.save()
  }

  get billingSummary(): GcpBillingSummary | null {
    return this.data.billingSummary || null
  }

  setBillingSummary(summary: GcpBillingSummary | null): void {
    this.data.billingSummary = summary
    this.save()
  }
}

export const store = new Store()
