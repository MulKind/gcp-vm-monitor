import { createHash, randomUUID } from 'crypto'
import type { CreditGrant, GcpBillingConfig, VmConfig } from '../shared/types'

// ---------- Host & URL Sanitization ----------

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

export function isSafeHttpUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

export function buildSafeKeyFilename(username: string, uuid = randomUUID()): string {
  const safeSlug = (username || 'user').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 24) || 'user'
  return `vmmon_ed25519_${safeSlug}_${uuid.slice(0, 8)}`
}

// ---------- SSH Host Key TOFU Verification ----------

export function computeHostFingerprint(key: Buffer): string {
  return 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '')
}

export function verifyOrPinHostKey(
  pinned: string | undefined,
  presentedKey: Buffer
): { ok: boolean; fingerprint: string; shouldPin: boolean } {
  const fingerprint = computeHostFingerprint(presentedKey)
  if (!pinned) return { ok: true, fingerprint, shouldPin: true }
  return { ok: pinned === fingerprint, fingerprint, shouldPin: false }
}

// ---------- Credential DTO Redaction & Merging ----------

export function redactVm(vm: VmConfig): VmConfig {
  return {
    ...vm,
    password: undefined,
    passphrase: undefined,
    agentToken: undefined,
    hasPassword: Boolean(vm.password),
    hasPassphrase: Boolean(vm.passphrase),
    hasAgentToken: Boolean(vm.agentToken)
  }
}

export function redactBilling(cfg: GcpBillingConfig): GcpBillingConfig {
  return {
    ...cfg,
    serviceAccountJson: undefined,
    hasServiceAccountKey: Boolean(cfg.serviceAccountJson)
  }
}

export function mergeVmSecrets(incoming: VmConfig, existing?: VmConfig): VmConfig {
  const merged: VmConfig = sanitizeVmHost({ ...incoming })
  if (existing) {
    if (!merged.password && !merged.clearPassword) merged.password = existing.password
    if (!merged.passphrase && !merged.clearPassphrase) merged.passphrase = existing.passphrase
    if (!merged.agentToken && !merged.clearAgentToken) merged.agentToken = existing.agentToken

    const endpointChanged = existing.host !== merged.host || (existing.port || 22) !== (merged.port || 22)
    if (merged.hostFingerprint === '') {
      merged.hostFingerprint = undefined
    } else if (endpointChanged && merged.hostFingerprint === existing.hostFingerprint) {
      merged.hostFingerprint = undefined
    } else if (merged.hostFingerprint === undefined) {
      merged.hostFingerprint = existing.hostFingerprint
    }
  } else if (merged.hostFingerprint === '') {
    merged.hostFingerprint = undefined
  }
  delete merged.hasPassword
  delete merged.hasPassphrase
  delete merged.hasAgentToken
  delete merged.clearPassword
  delete merged.clearPassphrase
  delete merged.clearAgentToken
  return merged
}

export function mergeBillingSecrets(incoming: GcpBillingConfig, existing?: GcpBillingConfig): GcpBillingConfig {
  const merged: GcpBillingConfig = { ...incoming }
  if (!merged.serviceAccountJson && !merged.clearServiceAccountKey && existing?.serviceAccountJson) {
    merged.serviceAccountJson = existing.serviceAccountJson
    if (!merged.serviceAccountEmail) merged.serviceAccountEmail = existing.serviceAccountEmail
  }
  delete merged.hasServiceAccountKey
  delete merged.clearServiceAccountKey
  return merged
}

// ---------- Strict Billing Account & Export Table Matching ----------

export function extractAccountIdFromTable(tableId: string): string | undefined {
  const m = /_([0-9A-F]{6}_[0-9A-F]{6}_[0-9A-F]{6})$/i.exec(tableId.trim())
  return m ? m[1].toUpperCase().replace(/_/g, '-') : undefined
}

export function selectBillingExportTable(
  tables: string[],
  explicitTableId?: string,
  preferredBillingId?: string
): string {
  const explicit = explicitTableId?.trim() || ''
  const preferred = preferredBillingId?.trim().toUpperCase() || ''

  if (explicit) {
    const inferred = extractAccountIdFromTable(explicit)
    if (preferred && inferred && inferred !== preferred) {
      throw new Error(
        `指定的账单表 "${explicit}" 属于结算账户 ${inferred}，与配置的结算账户 ID "${preferred}" 冲突`
      )
    }
    return explicit
  }

  const stdTables = tables.filter((t) => /^gcp_billing_export_v1_/i.test(t))
  const resTables = tables.filter((t) => /^gcp_billing_export_resource_v1_/i.test(t))
  const candidates = [...stdTables, ...resTables]

  if (candidates.length === 0) {
    throw new Error(
      '数据集中尚未生成 gcp_billing_export_v1_* 账单表（刚开启导出后通常需等待数小时由 Google 自动建表）'
    )
  }

  if (preferred) {
    const normPreferred = preferred.replace(/-/g, '_')
    const matched = candidates.find((t) => t.toUpperCase().endsWith(normPreferred))
    if (!matched) {
      throw new Error(
        `数据集中未找到与结算账户 "${preferred}" 匹配的账单导出表（现有表: ${candidates.join(', ')}）`
      )
    }
    return matched
  }

  // No preferredBillingId specified: ensure dataset doesn't have ambiguous tables from multiple accounts
  const distinctAccounts = new Set<string>()
  for (const t of candidates) {
    const acct = extractAccountIdFromTable(t)
    if (acct) distinctAccounts.add(acct)
  }
  if (distinctAccounts.size > 1) {
    throw new Error(
      `数据集中存在多个不同结算账户的导出表（${[...distinctAccounts].join(', ')}），请在设置中明确指定账单表名或结算账户 ID 以避免账单错配`
    )
  }

  return candidates[0]
}

// ---------- Waterfall Credit Allocation (No Double Counting) ----------

export interface PromoUsageSlice {
  creditName: string
  usageDate: string
  appliedAmount: number
}

export interface GrantBreakdownItem {
  id: string
  name: string
  total: number
  used: number
  remaining: number
  expiresAt?: string
}

export function allocateCreditsWaterfall(
  grants: CreditGrant[],
  promoSlices: PromoUsageSlice[],
  todayIso: string
): GrantBreakdownItem[] {
  if (!grants.length) return []

  // Clone slices into a mutable chronological pool so each cent of promo deduction is consumed at most once
  const pool = promoSlices
    .filter((s) => s.appliedAmount > 0)
    .map((s) => ({ ...s, remainingPool: s.appliedAmount }))
    .sort((a, b) => a.usageDate.localeCompare(b.usageDate))

  // Process grants with specific creditFilter first, then by earliest expiry date, preserving original order on ties
  const indexed = grants.map((g, idx) => ({ g, idx }))
  indexed.sort((a, b) => {
    const aHasFilter = Boolean(a.g.creditFilter?.trim()) ? 0 : 1
    const bHasFilter = Boolean(b.g.creditFilter?.trim()) ? 0 : 1
    if (aHasFilter !== bHasFilter) return aHasFilter - bHasFilter
    const aExp = a.g.expiresAt || '9999-12-31'
    const bExp = b.g.expiresAt || '9999-12-31'
    if (aExp !== bExp) return aExp.localeCompare(bExp)
    return a.idx - b.idx
  })

  const results = new Array<GrantBreakdownItem>(grants.length)

  for (const { g, idx } of indexed) {
    const total = Math.max(0, Number(g.totalAmount) || 0)
    const filter = (g.creditFilter || '').trim().toLowerCase()
    const baseDate = (g.baselineDate || '').trim()
    const isExpired = Boolean(g.expiresAt && g.expiresAt < todayIso)

    let used = 0
    let capacity = total

    for (const slice of pool) {
      if (capacity <= 0) break
      if (slice.remainingPool <= 0) continue
      if (baseDate && slice.usageDate < baseDate) continue
      if (g.expiresAt && slice.usageDate > g.expiresAt) continue
      if (filter && !slice.creditName.toLowerCase().includes(filter)) continue

      const take = Math.min(capacity, slice.remainingPool)
      slice.remainingPool -= take
      used += take
      capacity -= take
    }

    results[idx] = {
      id: g.id,
      name: g.name || '赠金',
      total,
      used: isExpired ? total : Number(used.toFixed(6)),
      remaining: isExpired ? 0 : Number(Math.max(0, total - used).toFixed(6)),
      expiresAt: g.expiresAt || undefined
    }
  }

  return results
}
