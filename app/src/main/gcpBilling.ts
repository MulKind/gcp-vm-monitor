import https from 'https'
import tls from 'tls'
import { createSign } from 'crypto'
import { EventEmitter } from 'events'
import { proxySocket } from './ssh'
import { store } from './store'
import type {
  CreditGrant,
  GcpBillingAccountInfo,
  GcpBillingConfig,
  GcpBillingSummary,
  ProxySettings
} from '@shared/types'

interface ServiceAccountKey {
  type?: string
  project_id?: string
  private_key_id?: string
  private_key: string
  client_email: string
  token_uri?: string
}

interface HttpResponse {
  status: number
  text: string
  json: unknown
}

function rawHttpsRequest(
  urlStr: string,
  opts: { method?: 'GET' | 'POST'; headers?: Record<string, string>; body?: string; timeoutMs?: number },
  proxy: ProxySettings
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr)
    const port = Number(u.port) || 443
    const timeoutMs = opts.timeoutMs ?? 25000

    const agent = new https.Agent({ keepAlive: false })
    ;(agent as unknown as { createConnection: unknown }).createConnection = (
      _options: unknown,
      cb: (err: Error | null, sock?: tls.TLSSocket) => void
    ): void => {
      proxySocket(proxy, u.hostname, port, timeoutMs)
        .then((rawSock) => {
          const tlsSock = tls.connect({
            socket: rawSock,
            servername: u.hostname
          })
          tlsSock.once('secureConnect', () => cb(null, tlsSock))
          tlsSock.once('error', (e) => {
            rawSock.destroy()
            cb(e)
          })
        })
        .catch((e) => cb(e as Error))
    }

    const bodyBuf = opts.body ? Buffer.from(opts.body, 'utf8') : undefined
    const req = https.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port,
        path: u.pathname + u.search,
        method: opts.method || 'GET',
        agent,
        headers: {
          Accept: 'application/json',
          ...(bodyBuf ? { 'Content-Length': String(bodyBuf.length) } : {}),
          ...(opts.headers || {})
        },
        timeout: timeoutMs
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let json: unknown = null
          try {
            json = text ? JSON.parse(text) : null
          } catch {
            /* non-json */
          }
          resolve({ status: res.statusCode || 0, text, json })
        })
      }
    )

    req.on('timeout', () => req.destroy(new Error(`请求超时: ${u.hostname}${u.pathname}`)))
    req.on('error', reject)
    if (bodyBuf) req.write(bodyBuf)
    req.end()
  })
}

async function httpsWithFallback(
  urlStr: string,
  opts: { method?: 'GET' | 'POST'; headers?: Record<string, string>; body?: string; timeoutMs?: number }
): Promise<HttpResponse> {
  const proxy = store.settings.proxy
  const attempts: ProxySettings[] = proxy.type !== 'none' ? [proxy, { ...proxy, type: 'none' }] : [proxy]
  let lastErr: Error | null = null
  for (const p of attempts) {
    try {
      return await rawHttpsRequest(urlStr, opts, p)
    } catch (e) {
      lastErr = e as Error
    }
  }
  throw lastErr || new Error('网络请求失败')
}

export function parseServiceAccount(rawJson: string): ServiceAccountKey {
  let parsed: Partial<ServiceAccountKey>
  try {
    parsed = JSON.parse(rawJson) as Partial<ServiceAccountKey>
  } catch {
    throw new Error('服务账号密钥不是合法的 JSON 格式')
  }
  if (!parsed.client_email || !parsed.private_key) {
    throw new Error('JSON 中缺少 client_email 或 private_key 字段，请确认上传的是 GCP 服务账号密钥文件')
  }
  return parsed as ServiceAccountKey
}

// ---------- OAuth2 JWT Token Cache ----------

const tokenCache = new Map<string, { token: string; expiresAt: number }>()

async function getAccessToken(sa: ServiceAccountKey): Promise<string> {
  const cached = tokenCache.get(sa.client_email)
  if (cached && Date.now() < cached.expiresAt - 120_000) {
    return cached.token
  }

  const now = Math.floor(Date.now() / 1000)
  const tokenUri = sa.token_uri || 'https://oauth2.googleapis.com/token'
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(
    JSON.stringify({
      iss: sa.client_email,
      scope: [
        'https://www.googleapis.com/auth/cloud-billing.readonly',
        'https://www.googleapis.com/auth/bigquery.readonly'
      ].join(' '),
      aud: tokenUri,
      iat: now,
      exp: now + 3600
    })
  ).toString('base64url')

  const unsigned = `${header}.${payload}`
  const signer = createSign('RSA-SHA256')
  signer.update(unsigned)
  const sig = signer.sign(sa.private_key, 'base64url')
  const assertion = `${unsigned}.${sig}`

  const body = `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${encodeURIComponent(assertion)}`
  const res = await httpsWithFallback(tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  })

  if (res.status >= 400 || !res.json) {
    const desc = (res.json as { error_description?: string; error?: string } | null)?.error_description || res.text.slice(0, 200)
    throw new Error(`GCP OAuth2 鉴权失败 (${res.status}): ${desc}`)
  }

  const data = res.json as { access_token: string; expires_in?: number }
  tokenCache.set(sa.client_email, {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in || 3600) * 1000
  })
  return data.access_token
}

// ---------- Cloud Billing API ----------

async function fetchBillingAccounts(token: string, warnings: string[]): Promise<GcpBillingAccountInfo[]> {
  try {
    const res = await httpsWithFallback('https://cloudbilling.googleapis.com/v1/billingAccounts', {
      headers: { Authorization: `Bearer ${token}` }
    })
    if (res.status >= 400) {
      const msg = (res.json as { error?: { message?: string } } | null)?.error?.message || `HTTP ${res.status}`
      warnings.push(`Cloud Billing API 未返回账户列表（${msg}），已仅通过 BigQuery 账单导出表统计。`)
      return []
    }
    const list = (res.json as { billingAccounts?: { name: string; displayName: string; open: boolean }[] } | null)?.billingAccounts || []
    return list.map((a) => ({
      name: a.name,
      displayName: a.displayName || a.name,
      open: Boolean(a.open),
      billingAccountId: a.name.replace(/^billingAccounts\//, '')
    }))
  } catch (e) {
    warnings.push(`读取结算账户信息失败: ${(e as Error).message}`)
    return []
  }
}

// ---------- BigQuery Helpers ----------

interface BqField {
  name: string
  type: string
  mode?: string
  fields?: BqField[]
}

interface BqTableMeta {
  tableId: string
  hasCreditType: boolean
  inferredAccountId?: string
}

async function discoverBillingTable(
  token: string,
  projectId: string,
  datasetId: string,
  explicitTableId?: string,
  preferredBillingId?: string
): Promise<BqTableMeta> {
  let tableId = explicitTableId?.trim() || ''

  if (!tableId) {
    const listUrl = `https://bigquery.googleapis.com/bigquery/v2/projects/${encodeURIComponent(projectId)}/datasets/${encodeURIComponent(datasetId)}/tables?maxResults=200`
    const res = await httpsWithFallback(listUrl, { headers: { Authorization: `Bearer ${token}` } })
    if (res.status === 404) {
      throw new Error(`未找到 BigQuery 数据集 "${projectId}.${datasetId}"，请确认已在 GCP 结算导出中创建该数据集`)
    }
    if (res.status >= 400) {
      const msg = (res.json as { error?: { message?: string } } | null)?.error?.message || res.text.slice(0, 200)
      throw new Error(`访问 BigQuery 数据集失败 (${res.status}): ${msg}`)
    }
    const tables =
      (res.json as { tables?: { tableReference: { tableId: string } }[] } | null)?.tables?.map(
        (t) => t.tableReference.tableId
      ) || []

    const normPreferred = preferredBillingId ? preferredBillingId.replace(/-/g, '_').toUpperCase() : ''
    const stdTables = tables.filter((t) => /^gcp_billing_export_v1_/i.test(t))
    const resTables = tables.filter((t) => /^gcp_billing_export_resource_v1_/i.test(t))
    const candidates = [...stdTables, ...resTables]

    if (normPreferred) {
      tableId = candidates.find((t) => t.toUpperCase().includes(normPreferred)) || ''
    }
    if (!tableId) {
      tableId = candidates[0] || ''
    }
    if (!tableId) {
      throw new Error(
        `数据集 "${datasetId}" 中尚未生成 gcp_billing_export_v1_* 账单表（刚开启导出后通常需等待数小时由 Google 自动建表）`
      )
    }
  }

  // Fetch table schema to verify credits.type existence
  const metaUrl = `https://bigquery.googleapis.com/bigquery/v2/projects/${encodeURIComponent(projectId)}/datasets/${encodeURIComponent(datasetId)}/tables/${encodeURIComponent(tableId)}`
  const metaRes = await httpsWithFallback(metaUrl, { headers: { Authorization: `Bearer ${token}` } })
  if (metaRes.status >= 400) {
    const msg = (metaRes.json as { error?: { message?: string } } | null)?.error?.message || metaRes.text.slice(0, 200)
    throw new Error(`无法读取账单表 "${tableId}" 元数据 (${metaRes.status}): ${msg}`)
  }

  const schemaFields = (metaRes.json as { schema?: { fields?: BqField[] } } | null)?.schema?.fields || []
  const creditsField = schemaFields.find((f) => f.name === 'credits')
  const hasCreditType = Boolean(creditsField?.fields?.some((sub) => sub.name === 'type'))

  const m = /_([0-9A-F]{6}_[0-9A-F]{6}_[0-9A-F]{6})$/i.exec(tableId)
  const inferredAccountId = m ? m[1].toUpperCase().replace(/_/g, '-') : undefined

  return { tableId, hasCreditType, inferredAccountId }
}

interface BqQueryResponse {
  jobComplete?: boolean
  schema?: { fields: BqField[] }
  rows?: { f: { v: unknown }[] }[]
  error?: { message?: string }
}

async function runBqQuery(token: string, projectId: string, sql: string): Promise<Record<string, unknown>[]> {
  const url = `https://bigquery.googleapis.com/bigquery/v2/projects/${encodeURIComponent(projectId)}/queries`
  const res = await httpsWithFallback(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      query: sql,
      useLegacySql: false,
      timeoutMs: 22000
    }),
    timeoutMs: 28000
  })

  const data = res.json as BqQueryResponse | null
  if (res.status >= 400 || data?.error) {
    const msg = data?.error?.message || res.text.slice(0, 240) || `HTTP ${res.status}`
    throw new Error(`BigQuery 查询失败: ${msg}`)
  }
  if (!data?.rows || !data.schema?.fields) return []

  const fields = data.schema.fields
  return data.rows.map((row) => {
    const obj: Record<string, unknown> = {}
    fields.forEach((f, idx) => {
      obj[f.name] = row.f[idx]?.v ?? null
    })
    return obj
  })
}

function num(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

function str(v: unknown, fallback = ''): string {
  return v == null ? fallback : String(v)
}

function currentYearMonth(): string {
  const d = new Date()
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`
}

function prevYearMonth(ym: string): string {
  const y = Number(ym.slice(0, 4))
  const m = Number(ym.slice(4, 6))
  if (m <= 1) return `${y - 1}12`
  return `${y}${String(m - 1).padStart(2, '0')}`
}

async function fetchBigQueryBillingSummary(cfg: GcpBillingConfig): Promise<GcpBillingSummary> {
  if (!cfg.serviceAccountJson) throw new Error('尚未配置 GCP 服务账号密钥 JSON')
  const sa = parseServiceAccount(cfg.serviceAccountJson)
  const projectId = (cfg.projectId || sa.project_id || '').trim()
  const datasetId = (cfg.datasetId || '').trim()
  if (!projectId) throw new Error('请填写 BigQuery 所在的 GCP Project ID')
  if (!datasetId) throw new Error('请填写 BigQuery 账单导出的 Dataset 名称')

  const warnings: string[] = []
  const token = await getAccessToken(sa)
  const [accounts, tableMeta] = await Promise.all([
    fetchBillingAccounts(token, warnings),
    discoverBillingTable(token, projectId, datasetId, cfg.tableId, cfg.billingAccountId)
  ])

  const safeProject = projectId.replace(/[^a-zA-Z0-9._:-]/g, '')
  const safeDataset = datasetId.replace(/[^a-zA-Z0-9_]/g, '')
  const safeTable = tableMeta.tableId.replace(/[^a-zA-Z0-9_]/g, '')
  const fullTable = `\`${safeProject}.${safeDataset}.${safeTable}\``

  const isPromoExpr = tableMeta.hasCreditType
    ? `c.type IN ('PROMOTION', 'CREDIT_TYPE_UNSPECIFIED')`
    : `(LOWER(IFNULL(c.name, '')) NOT LIKE '%free tier%' AND LOWER(IFNULL(c.name, '')) NOT LIKE '%sustained%' AND LOWER(IFNULL(c.name, '')) NOT LIKE '%committed%')`
  const creditTypeExpr = tableMeta.hasCreditType ? `IFNULL(c.type, 'UNKNOWN')` : `'PROMOTION'`

  // Query 1: Recent 65 days multi-facet summary (month, 30d daily trend, current month services, projects, top SKUs)
  const sqlRecent = `
WITH base AS (
  SELECT
    invoice.month AS inv_month,
    DATE(usage_start_time) AS usage_date,
    IFNULL(currency, '') AS currency_code,
    IFNULL(service.description, 'Other') AS service_desc,
    IFNULL(sku.description, 'Other') AS sku_desc,
    COALESCE(project.name, project.id, '(未关联项目)') AS project_name,
    IFNULL(usage.amount, 0) AS usage_amt,
    IFNULL(usage.unit, '') AS usage_unit,
    IFNULL(cost, 0) AS gross_cost,
    IFNULL((SELECT SUM(c.amount) FROM UNNEST(credits) c WHERE ${isPromoExpr}), 0) AS promo_amt,
    IFNULL((SELECT SUM(c.amount) FROM UNNEST(credits) c WHERE NOT (${isPromoExpr})), 0) AS other_amt,
    IFNULL((SELECT SUM(c.amount) FROM UNNEST(credits) c), 0) AS total_cred_amt
  FROM ${fullTable}
  WHERE usage_start_time >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 65 DAY)
),
latest_m AS (
  SELECT COALESCE(MAX(inv_month), FORMAT_DATE('%Y%m', CURRENT_DATE())) AS cur_month FROM base
),
sku_agg AS (
  SELECT service_desc, sku_desc, usage_unit,
         SUM(gross_cost) AS gross_sum, SUM(usage_amt) AS usage_sum, SUM(gross_cost + total_cred_amt) AS net_sum
  FROM base, latest_m
  WHERE inv_month = latest_m.cur_month
  GROUP BY service_desc, sku_desc, usage_unit
  QUALIFY ROW_NUMBER() OVER (ORDER BY SUM(gross_cost) DESC) <= 15
)
SELECT 'month' AS kind, inv_month AS k1, MAX(currency_code) AS k2, '' AS k3,
       SUM(gross_cost) AS v1, SUM(-promo_amt) AS v2, SUM(-other_amt) AS v3, SUM(gross_cost + total_cred_amt) AS v4
FROM base GROUP BY inv_month
UNION ALL
SELECT 'day' AS kind, CAST(usage_date AS STRING) AS k1, '' AS k2, '' AS k3,
       SUM(gross_cost) AS v1, SUM(-promo_amt) AS v2, 0 AS v3, SUM(gross_cost + total_cred_amt) AS v4
FROM base WHERE usage_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 29 DAY)
GROUP BY usage_date
UNION ALL
SELECT 'service' AS kind, service_desc AS k1, '' AS k2, '' AS k3,
       SUM(gross_cost) AS v1, SUM(-total_cred_amt) AS v2, 0 AS v3, SUM(gross_cost + total_cred_amt) AS v4
FROM base, latest_m WHERE inv_month = latest_m.cur_month
GROUP BY service_desc
UNION ALL
SELECT 'project' AS kind, project_name AS k1, '' AS k2, '' AS k3,
       SUM(gross_cost) AS v1, SUM(-total_cred_amt) AS v2, 0 AS v3, SUM(gross_cost + total_cred_amt) AS v4
FROM base, latest_m WHERE inv_month = latest_m.cur_month
GROUP BY project_name
UNION ALL
SELECT 'sku' AS kind, service_desc AS k1, sku_desc AS k2, usage_unit AS k3,
       gross_sum AS v1, usage_sum AS v2, 0 AS v3, net_sum AS v4
FROM sku_agg
`

  // Query 2: All-time credits ledger by credit name/type & date (lightweight columnar scan on credits only)
  const sqlCredits = `
SELECT
  IFNULL(c.name, 'Credit') AS credit_name,
  ${creditTypeExpr} AS credit_type,
  CAST(DATE(usage_start_time) AS STRING) AS usage_date,
  invoice.month AS inv_month,
  CASE WHEN ${isPromoExpr} THEN 1 ELSE 0 END AS is_promo,
  SUM(-c.amount) AS applied_amount
FROM ${fullTable}, UNNEST(credits) AS c
GROUP BY credit_name, credit_type, usage_date, inv_month, is_promo
`

  const [recentRows, creditRows] = await Promise.all([
    runBqQuery(token, projectId, sqlRecent),
    runBqQuery(token, projectId, sqlCredits)
  ])

  const tableEmpty = recentRows.length === 0 && creditRows.length === 0
  if (tableEmpty) {
    warnings.push('BigQuery 账单导出表已连接成功，但表内暂时还没有账单记录（首次开启导出后通常需等待数小时写入数据）。')
  }

  const monthRows = recentRows.filter((r) => r.kind === 'month')
  const sortedMonths = monthRows.map((r) => str(r.k1)).filter(Boolean).sort()
  const invoiceMonth = sortedMonths[sortedMonths.length - 1] || currentYearMonth()
  const prevMonth = prevYearMonth(invoiceMonth)

  const curM = monthRows.find((r) => str(r.k1) === invoiceMonth)
  const prevM = monthRows.find((r) => str(r.k1) === prevMonth)

  const currency = str(curM?.k2 || monthRows[0]?.k2 || cfg.currency || 'USD').toUpperCase()
  const monthGrossCost = Math.max(0, num(curM?.v1))
  const monthPromoDeduction = Math.max(0, num(curM?.v2))
  const monthOtherDiscounts = Math.max(0, num(curM?.v3))
  const monthNetCost = num(curM?.v4)

  const prevMonthGrossCost = Math.max(0, num(prevM?.v1))
  const prevMonthNetCost = num(prevM?.v4)

  const dailyTrend = recentRows
    .filter((r) => r.kind === 'day')
    .map((r) => ({
      date: str(r.k1),
      gross: Math.max(0, num(r.v1)),
      promo: Math.max(0, num(r.v2)),
      net: num(r.v4)
    }))
    .sort((a, b) => a.date.localeCompare(b.date))

  // Compute 7-day average daily gross burn rate
  const last7 = dailyTrend.slice(-7)
  const dailyBurnRate7d = last7.length > 0 ? last7.reduce((s, d) => s + d.gross, 0) / last7.length : 0

  const byService = recentRows
    .filter((r) => r.kind === 'service')
    .map((r) => ({
      service: str(r.k1),
      gross: Math.max(0, num(r.v1)),
      credits: num(r.v2),
      net: num(r.v4)
    }))
    .sort((a, b) => b.gross - a.gross)

  const byProject = recentRows
    .filter((r) => r.kind === 'project')
    .map((r) => ({
      project: str(r.k1),
      gross: Math.max(0, num(r.v1)),
      credits: num(r.v2),
      net: num(r.v4)
    }))
    .sort((a, b) => b.gross - a.gross)

  const topSkus = recentRows
    .filter((r) => r.kind === 'sku')
    .map((r) => ({
      service: str(r.k1),
      sku: str(r.k2),
      usageUnit: str(r.k3),
      gross: Math.max(0, num(r.v1)),
      usageAmount: num(r.v2),
      net: num(r.v4)
    }))
    .sort((a, b) => b.gross - a.gross)

  // Aggregate discovered credits
  const credMap = new Map<string, { name: string; type: string; allTimeApplied: number; monthApplied: number }>()
  for (const r of creditRows) {
    const name = str(r.credit_name, 'Credit')
    const type = str(r.credit_type, 'UNKNOWN')
    const key = `${type}|${name}`
    const applied = num(r.applied_amount)
    const entry = credMap.get(key) || { name, type, allTimeApplied: 0, monthApplied: 0 }
    entry.allTimeApplied += applied
    if (str(r.inv_month) === invoiceMonth) entry.monthApplied += applied
    credMap.set(key, entry)
  }
  const discoveredCredits = [...credMap.values()].sort((a, b) => b.allTimeApplied - a.allTimeApplied)

  // Match configured CreditGrants against promo credit rows
  const todayIso = new Date().toISOString().slice(0, 10)
  const promoRows = creditRows.filter((r) => Number(r.is_promo) === 1 && num(r.applied_amount) > 0)
  const grants = cfg.creditGrants || []
  const grantsBreakdown = grants.map((g: CreditGrant) => {
    const filter = (g.creditFilter || '').trim().toLowerCase()
    const baseDate = (g.baselineDate || '').trim()
    let used = 0
    for (const r of promoRows) {
      if (baseDate && str(r.usage_date) < baseDate) continue
      if (filter && !str(r.credit_name).toLowerCase().includes(filter)) continue
      used += num(r.applied_amount)
    }
    const total = Math.max(0, Number(g.totalAmount) || 0)
    const isExpired = Boolean(g.expiresAt && g.expiresAt < todayIso)
    const remaining = isExpired ? 0 : Math.max(0, total - used)
    return {
      id: g.id,
      name: g.name || '赠金',
      total,
      used: isExpired ? total : used,
      remaining,
      expiresAt: g.expiresAt || undefined
    }
  })

  const totalCreditGranted = grantsBreakdown.reduce((s, g) => s + g.total, 0)
  const totalCreditUsed =
    grantsBreakdown.length > 0
      ? grantsBreakdown.reduce((s, g) => s + Math.min(g.total, g.used), 0)
      : promoRows.reduce((s, r) => s + num(r.applied_amount), 0)
  const totalCreditRemaining = Math.max(0, totalCreditGranted - totalCreditUsed)

  if (monthNetCost > 0.05 && monthPromoDeduction < 0.01 && totalCreditRemaining > 0) {
    warnings.push('检测到本月账单已产生实际应付净额且未触发赠金抵扣，你配置的赠金可能已过期或用尽，建议点击右上角「内置浏览器查赠金页」一键同步核实。')
  }

  const expiries = grantsBreakdown
    .map((g) => g.expiresAt)
    .filter((d): d is string => Boolean(d))
    .sort()
  const earliestExpiry = expiries[0] || null
  const estimatedRunwayDays =
    dailyBurnRate7d > 0.005 && totalCreditRemaining > 0 ? Math.floor(totalCreditRemaining / dailyBurnRate7d) : null

  const wantedAcctId = (cfg.billingAccountId || tableMeta.inferredAccountId || '').toUpperCase()
  const matchedAcct =
    accounts.find((a) => a.billingAccountId.toUpperCase() === wantedAcctId) ||
    accounts[0] ||
    (wantedAcctId
      ? {
          name: `billingAccounts/${wantedAcctId}`,
          displayName: `结算账户 (${wantedAcctId})`,
          open: true,
          billingAccountId: wantedAcctId
        }
      : null)

  return {
    fetchedAt: Date.now(),
    mode: 'bigquery',
    currency,
    invoiceMonth,
    account: matchedAcct,
    accounts,
    tableUsed: `${projectId}.${datasetId}.${tableMeta.tableId}`,
    tableEmpty,
    consoleSyncedAt: cfg.consoleSyncedAt,
    monthGrossCost,
    monthPromoDeduction,
    monthOtherDiscounts,
    monthNetCost,
    prevMonthGrossCost,
    prevMonthNetCost,
    totalCreditGranted,
    totalCreditUsed,
    totalCreditRemaining,
    earliestExpiry,
    dailyBurnRate7d,
    estimatedRunwayDays,
    grantsBreakdown,
    discoveredCredits,
    dailyTrend,
    byService,
    byProject,
    topSkus,
    warnings
  }
}

// ---------- Demo Billing Summary ----------

export function buildDemoBillingSummary(cfg: GcpBillingConfig): GcpBillingSummary {
  const ym = currentYearMonth()
  const now = new Date()
  const dailyTrend: GcpBillingSummary['dailyTrend'] = []
  let monthGross = 0
  let monthPromo = 0

  for (let i = 29; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 86400_000)
    const ds = d.toISOString().slice(0, 10)
    const wave = 1.05 + Math.sin(i * 0.55) * 0.38 + (i % 5 === 0 ? 0.45 : 0)
    const gross = Number(wave.toFixed(2))
    const promo = gross
    dailyTrend.push({ date: ds, gross, promo, net: 0 })
    if (d.getMonth() === now.getMonth()) {
      monthGross += gross
      monthPromo += promo
    }
  }

  const grants = cfg.creditGrants?.length
    ? cfg.creditGrants
    : [{ id: 'demo-trial', name: 'GCP Free Trial 试用赠金', totalAmount: 300, expiresAt: '2027-02-15' }]

  const baseUsed = 46.85
  const grantsBreakdown = grants.map((g, idx) => {
    const total = Math.max(0, Number(g.totalAmount) || 300)
    const used = idx === 0 ? Math.min(total, baseUsed) : 0
    return {
      id: g.id,
      name: g.name || '试用赠金',
      total,
      used,
      remaining: Math.max(0, total - used),
      expiresAt: g.expiresAt || '2027-02-15'
    }
  })

  const totalCreditGranted = grantsBreakdown.reduce((s, g) => s + g.total, 0)
  const totalCreditUsed = grantsBreakdown.reduce((s, g) => s + g.used, 0)
  const totalCreditRemaining = Math.max(0, totalCreditGranted - totalCreditUsed)
  const last7 = dailyTrend.slice(-7)
  const dailyBurnRate7d = last7.reduce((s, d) => s + d.gross, 0) / last7.length

  const ceCost = Number((monthGross * 0.56).toFixed(2))
  const netEgressCost = Number((monthGross * 0.34).toFixed(2))
  const storageCost = Number((monthGross - ceCost - netEgressCost).toFixed(2))

  return {
    fetchedAt: Date.now(),
    mode: 'demo',
    currency: cfg.currency || 'USD',
    invoiceMonth: ym,
    account: {
      name: 'billingAccounts/01DEMO-8899AA-BBCCDD',
      displayName: '我的结算账户 (演示数据)',
      open: true,
      billingAccountId: '01DEMO-8899AA-BBCCDD'
    },
    accounts: [
      {
        name: 'billingAccounts/01DEMO-8899AA-BBCCDD',
        displayName: '我的结算账户 (演示数据)',
        open: true,
        billingAccountId: '01DEMO-8899AA-BBCCDD'
      }
    ],
    tableUsed: 'demo-project.billing_export.gcp_billing_export_v1_01DEMO_8899AA_BBCCDD',
    monthGrossCost: Number(monthGross.toFixed(2)),
    monthPromoDeduction: Number(monthPromo.toFixed(2)),
    monthOtherDiscounts: 1.85,
    monthNetCost: 0,
    prevMonthGrossCost: 21.4,
    prevMonthNetCost: 0,
    totalCreditGranted,
    totalCreditUsed,
    totalCreditRemaining,
    earliestExpiry: grantsBreakdown[0]?.expiresAt || '2027-02-15',
    dailyBurnRate7d,
    estimatedRunwayDays: dailyBurnRate7d > 0 ? Math.floor(totalCreditRemaining / dailyBurnRate7d) : null,
    grantsBreakdown,
    discoveredCredits: [
      { name: 'Free Trial', type: 'PROMOTION', allTimeApplied: totalCreditUsed, monthApplied: Number(monthPromo.toFixed(2)) },
      { name: 'Sustained Usage Discount', type: 'SUSTAINED_USAGE_DISCOUNT', allTimeApplied: 4.12, monthApplied: 1.85 }
    ],
    dailyTrend,
    byService: [
      { service: 'Compute Engine', gross: ceCost + netEgressCost, credits: ceCost + netEgressCost, net: 0 },
      { service: 'Cloud Storage', gross: storageCost, credits: storageCost, net: 0 }
    ],
    byProject: [
      { project: 'gemini-bot-prod', gross: Number((monthGross * 0.78).toFixed(2)), credits: Number((monthGross * 0.78).toFixed(2)), net: 0 },
      { project: 'personal-infra', gross: Number((monthGross * 0.22).toFixed(2)), credits: Number((monthGross * 0.22).toFixed(2)), net: 0 }
    ],
    topSkus: [
      { service: 'Compute Engine', sku: 'E2 Instance Core running in Asia Southeast', usageAmount: 540, usageUnit: 'hour', gross: Number((ceCost * 0.62).toFixed(2)), net: 0 },
      { service: 'Compute Engine', sku: 'Network Internet Egress from Asia Southeast to China', usageAmount: 38.4, usageUnit: 'gibibyte', gross: netEgressCost, net: 0 },
      { service: 'Compute Engine', sku: 'E2 Instance Ram running in Asia Southeast', usageAmount: 1080, usageUnit: 'gibibyte hour', gross: Number((ceCost * 0.28).toFixed(2)), net: 0 },
      { service: 'Compute Engine', sku: 'Balanced PD Capacity', usageAmount: 30, usageUnit: 'gibibyte month', gross: Number((ceCost * 0.1).toFixed(2)), net: 0 },
      { service: 'Cloud Storage', sku: 'Standard Storage Asia', usageAmount: 18.5, usageUnit: 'gibibyte month', gross: storageCost, net: 0 }
    ],
    warnings: ['当前为演示数据模式。配置 GCP 服务账号与 BigQuery 账单导出后即可自动拉取你的真实账单与赠金抵扣明细。']
  }
}

// ---------- Billing Manager ----------

class BillingManager extends EventEmitter {
  private timer: NodeJS.Timeout | null = null
  private inflight: Promise<GcpBillingSummary> | null = null

  init(): void {
    this.scheduleTimer()
    if (store.billing.mode === 'demo') {
      const s = buildDemoBillingSummary(store.billing)
      store.setBillingSummary(s)
    } else if (store.billing.mode === 'bigquery' && store.billing.serviceAccountJson) {
      void this.refresh().catch((e) => console.warn('[billing] background refresh failed:', (e as Error).message))
    }
  }

  private scheduleTimer(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    const cfg = store.billing
    if (cfg.mode === 'bigquery' && cfg.autoRefreshMinutes > 0) {
      const ms = Math.max(5, cfg.autoRefreshMinutes) * 60_000
      this.timer = setInterval(() => {
        void this.refresh().catch((e) => console.warn('[billing] auto refresh failed:', (e as Error).message))
      }, ms)
    }
  }

  async saveConfig(cfg: GcpBillingConfig): Promise<{ config: GcpBillingConfig; summary: GcpBillingSummary | null }> {
    if (cfg.serviceAccountJson) {
      const sa = parseServiceAccount(cfg.serviceAccountJson)
      cfg.serviceAccountEmail = sa.client_email
      if (!cfg.projectId && sa.project_id) cfg.projectId = sa.project_id
    } else {
      cfg.serviceAccountEmail = undefined
    }

    store.setBilling(cfg)
    this.scheduleTimer()

    if (cfg.mode === 'unconfigured') {
      store.setBillingSummary(null)
      this.emit('summary', null)
      return { config: cfg, summary: null }
    }

    const summary = await this.refresh()
    return { config: store.billing, summary }
  }

  async refresh(): Promise<GcpBillingSummary> {
    if (this.inflight) return this.inflight
    this.inflight = this.doRefresh().finally(() => {
      this.inflight = null
    })
    return this.inflight
  }

  private async doRefresh(): Promise<GcpBillingSummary> {
    const cfg = store.billing
    let summary: GcpBillingSummary
    if (cfg.mode === 'demo') {
      summary = buildDemoBillingSummary(cfg)
    } else if (cfg.mode === 'bigquery') {
      summary = await fetchBigQueryBillingSummary(cfg)
      if (summary.currency && summary.currency !== cfg.currency) {
        store.setBilling({ ...cfg, currency: summary.currency })
      }
      if (!cfg.billingAccountId && summary.account?.billingAccountId) {
        store.setBilling({ ...store.billing, billingAccountId: summary.account.billingAccountId })
      }
    } else {
      throw new Error('尚未配置账单数据源')
    }
    store.setBillingSummary(summary)
    this.emit('summary', summary)
    return summary
  }

  async syncConsoleCredits(payload: {
    grants: CreditGrant[]
    currency?: string
  }): Promise<{ config: GcpBillingConfig; summary: GcpBillingSummary | null }> {
    const now = Date.now()
    const curCfg = store.billing
    const updatedCfg: GcpBillingConfig = {
      ...curCfg,
      currency: (payload.currency || curCfg.currency || 'USD').toUpperCase(),
      creditGrants: payload.grants,
      consoleSyncedAt: now
    }
    store.setBilling(updatedCfg)

    if (updatedCfg.mode === 'bigquery' && updatedCfg.serviceAccountJson) {
      const summary = await this.refresh()
      return { config: store.billing, summary }
    }

    // Even if BigQuery is not configured yet, construct/update a summary snapshot so the UI reflects synced credits
    const prev = store.billingSummary
    const grantsBreakdown = payload.grants.map((g) => ({
      id: g.id,
      name: g.name,
      total: g.totalAmount,
      used: 0,
      remaining: g.totalAmount,
      expiresAt: g.expiresAt
    }))
    const totalRemaining = grantsBreakdown.reduce((s, g) => s + g.remaining, 0)
    const summary: GcpBillingSummary = prev
      ? {
          ...prev,
          currency: updatedCfg.currency,
          consoleSyncedAt: now,
          totalCreditGranted: totalRemaining,
          totalCreditUsed: 0,
          totalCreditRemaining: totalRemaining,
          grantsBreakdown
        }
      : {
          fetchedAt: now,
          mode: 'bigquery',
          currency: updatedCfg.currency,
          invoiceMonth: currentYearMonth(),
          account: updatedCfg.billingAccountId
            ? {
                name: `billingAccounts/${updatedCfg.billingAccountId}`,
                displayName: `结算账户 (${updatedCfg.billingAccountId})`,
                open: true,
                billingAccountId: updatedCfg.billingAccountId
              }
            : null,
          accounts: [],
          tableEmpty: true,
          consoleSyncedAt: now,
          monthGrossCost: 0,
          monthPromoDeduction: 0,
          monthOtherDiscounts: 0,
          monthNetCost: 0,
          prevMonthGrossCost: 0,
          prevMonthNetCost: 0,
          totalCreditGranted: totalRemaining,
          totalCreditUsed: 0,
          totalCreditRemaining: totalRemaining,
          earliestExpiry: grantsBreakdown[0]?.expiresAt || null,
          dailyBurnRate7d: 0,
          estimatedRunwayDays: null,
          grantsBreakdown,
          discoveredCredits: [],
          dailyTrend: [],
          byService: [],
          byProject: [],
          topSkus: [],
          warnings: ['赠金余额已从 GCP 控制台页面同步。配置 BigQuery 导出后可进一步查看每日账单与 SKU 明细。']
        }
    store.setBillingSummary(summary)
    this.emit('summary', summary)
    return { config: updatedCfg, summary }
  }
}

export const billingManager = new BillingManager()
