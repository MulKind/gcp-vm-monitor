<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch, nextTick } from 'vue'
import * as echarts from 'echarts/core'
import { BarChart, LineChart } from 'echarts/charts'
import { GridComponent, TooltipComponent, LegendComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import { state, goHome, openGcpConsoleTab, errMsg, toast } from '../store'
import BillingConfigDialog from '../components/BillingConfigDialog.vue'

echarts.use([BarChart, LineChart, GridComponent, TooltipComponent, LegendComponent, CanvasRenderer])

const showConfig = ref(false)
const refreshing = ref(false)
const chartEl = ref<HTMLDivElement>()
const chart = shallowRef<echarts.ECharts>()
let ro: ResizeObserver | null = null

const bs = computed(() => state.billingSummary)
const cfg = computed(() => state.billingConfig)

const CURRENCY_SYM: Record<string, string> = {
  USD: '$',
  CNY: '¥',
  JPY: '¥',
  EUR: '€',
  HKD: 'HK$',
  TWD: 'NT$',
  GBP: '£'
}

function money(val: number | null | undefined, cur?: string): string {
  if (val == null || isNaN(val)) return '—'
  const c = (cur || bs.value?.currency || cfg.value?.currency || 'USD').toUpperCase()
  const sym = CURRENCY_SYM[c] || c + ' '
  const sign = val < -0.004 ? '-' : ''
  return `${sign}${sym}${Math.abs(val).toFixed(2)}`
}

function fmtYm(ym: string | undefined): string {
  if (!ym || ym.length < 6) return ym || '本月'
  return `${ym.slice(0, 4)}年${ym.slice(4, 6)}月`
}

const creditPctRemaining = computed(() => {
  if (!bs.value || bs.value.totalCreditGranted <= 0) return 0
  return Math.min(100, Math.max(0, (bs.value.totalCreditRemaining / bs.value.totalCreditGranted) * 100))
})

const daysUntilExpiry = computed(() => {
  const exp = bs.value?.earliestExpiry
  if (!exp) return null
  const ms = new Date(exp + 'T23:59:59').getTime() - Date.now()
  return Math.ceil(ms / 86400_000)
})

const updatedTimeStr = computed(() => {
  if (!bs.value?.fetchedAt) return ''
  return new Date(bs.value.fetchedAt).toLocaleTimeString('zh-CN', { hour12: false })
})

async function refresh(): Promise<void> {
  refreshing.value = true
  try {
    state.billingSummary = await window.api.refreshBilling()
    toast('GCP 账单与赠金已刷新', 'ok')
  } catch (e) {
    toast('刷新失败: ' + errMsg(e), 'error')
  } finally {
    refreshing.value = false
  }
}

async function enableDemo(): Promise<void> {
  refreshing.value = true
  try {
    const base = state.billingConfig || {
      mode: 'demo' as const,
      projectId: '',
      datasetId: 'billing_export',
      currency: 'USD',
      creditGrants: [{ id: 'trial-1', name: 'GCP Free Trial 试用赠金', totalAmount: 300, expiresAt: '2027-02-15' }],
      autoRefreshMinutes: 30
    }
    const res = await window.api.saveBilling({ ...base, mode: 'demo' })
    state.billingConfig = res.config
    state.billingSummary = res.summary
  } catch (e) {
    toast(errMsg(e), 'error')
  } finally {
    refreshing.value = false
  }
}

function openConsoleBilling(): void {
  const acctId = bs.value?.account?.billingAccountId || cfg.value?.billingAccountId
  const url =
    acctId && !acctId.includes('DEMO')
      ? `https://console.cloud.google.com/billing/${acctId}`
      : 'https://console.cloud.google.com/billing'
  openGcpConsoleTab(url, 'GCP 结算总览')
}

function openConsoleCredits(): void {
  const acctId = bs.value?.account?.billingAccountId || cfg.value?.billingAccountId
  const url =
    acctId && !acctId.includes('DEMO')
      ? `https://console.cloud.google.com/billing/${acctId}/credits`
      : 'https://console.cloud.google.com/billing'
  openGcpConsoleTab(url, 'GCP 赠金明细 (Credits)')
}

function renderChart(): void {
  if (!chartEl.value) return
  if (!chart.value) {
    chart.value = echarts.init(chartEl.value, undefined, { renderer: 'canvas' })
    ro = new ResizeObserver(() => chart.value?.resize())
    ro.observe(chartEl.value)
  }
  const trend = bs.value?.dailyTrend || []
  const cur = bs.value?.currency || 'USD'
  chart.value.setOption(
    {
      animation: false,
      grid: { left: 10, right: 14, top: 32, bottom: 8, containLabel: true },
      legend: {
        top: 0,
        right: 0,
        itemWidth: 12,
        itemHeight: 8,
        textStyle: { color: '#7d8aa5', fontSize: 11.5 }
      },
      tooltip: {
        trigger: 'axis',
        backgroundColor: '#0f172aee',
        borderColor: '#2a3a5c',
        textStyle: { color: '#e2e8f0', fontSize: 12 },
        valueFormatter: (v: unknown) => money(Number(v), cur)
      },
      xAxis: {
        type: 'category',
        data: trend.map((d) => d.date.slice(5)),
        axisLine: { lineStyle: { color: '#1f2c47' } },
        axisLabel: { color: '#55627e', fontSize: 10.5 }
      },
      yAxis: {
        type: 'value',
        splitNumber: 4,
        axisLabel: { color: '#55627e', fontSize: 10.5, formatter: (v: number) => money(v, cur) },
        splitLine: { lineStyle: { color: '#16213a' } }
      },
      series: [
        {
          name: '原始消费',
          type: 'bar',
          barMaxWidth: 16,
          itemStyle: { color: '#3b82f6', borderRadius: [3, 3, 0, 0] },
          data: trend.map((d) => d.gross)
        },
        {
          name: '赠金抵扣',
          type: 'bar',
          barMaxWidth: 16,
          itemStyle: { color: '#22c55e', borderRadius: [3, 3, 0, 0] },
          data: trend.map((d) => d.promo)
        },
        {
          name: '实际应付净额',
          type: 'line',
          smooth: 0.25,
          symbolSize: 5,
          lineStyle: { width: 2, color: '#f59e0b' },
          itemStyle: { color: '#f59e0b' },
          data: trend.map((d) => d.net)
        }
      ]
    },
    { replaceMerge: ['series'] }
  )
}

onMounted(() => {
  if (bs.value) void nextTick(renderChart)
})

watch(
  () => bs.value,
  async (val) => {
    if (val) {
      await nextTick()
      renderChart()
    }
  }
)

onBeforeUnmount(() => {
  ro?.disconnect()
  chart.value?.dispose()
})
</script>

<template>
  <div class="billing-page">
    <header class="top-bar">
      <button class="ghost" @click="goHome">← 返回虚拟机总览</button>
      <div>
        <h1>
          GCP 账单与账户赠金
          <span v-if="bs?.mode === 'demo'" class="badge demo">演示模式</span>
        </h1>
        <div v-if="bs" class="sub muted">
          <template v-if="bs.account">
            <span>{{ bs.account.displayName }}</span>
            <span class="mono">({{ bs.account.billingAccountId }})</span>
            <span :style="{ color: bs.account.open ? 'var(--green)' : 'var(--red)' }">
              · {{ bs.account.open ? '● 账户有效' : '● 已关闭' }}
            </span>
          </template>
          <span v-if="updatedTimeStr"> · 更新于 {{ updatedTimeStr }}</span>
        </div>
      </div>

      <div class="grow" />

      <div class="row" style="flex-wrap: wrap">
        <button title="使用内置浏览器直接查看 Google Cloud 官方赠金余额页（走 V2RayN 代理）" @click="openConsoleCredits">
          🎁 内置浏览器查赠金页
        </button>
        <button title="使用内置浏览器打开 Google Cloud 结算控制台" @click="openConsoleBilling">
          🌐 打开 GCP 账单控制台
        </button>
        <button v-if="bs" :disabled="refreshing" @click="refresh">
          <span :class="{ spin: refreshing }">⟳</span> 刷新
        </button>
        <button class="primary" @click="showConfig = true">⚙ 账单与赠金设置</button>
      </div>
    </header>

    <!-- Onboarding when unconfigured -->
    <div v-if="!bs" class="empty card">
      <div class="big">💳</div>
      <h2>监控你的 GCP 账单、流量费与试用赠金余额</h2>
      <p class="muted">
        支持通过 <b>BigQuery 结算导出 + 只读服务账号</b> 自动统计本月原始消费、赠金抵扣（如 $300 Free Trial）、剩余赠金可用天数以及出站流量明细；
        也可以无需任何配置，直接在软件<b>内置浏览器</b>中打开 Google Cloud 官方结算与赠金页面。
      </p>
      <div class="row" style="justify-content: center; flex-wrap: wrap; gap: 10px">
        <button class="primary" @click="showConfig = true">⚙ 配置 BigQuery 自动账单</button>
        <button @click="openConsoleCredits">🎁 内置浏览器查看官方赠金余额</button>
        <button @click="enableDemo">👀 先看演示效果</button>
      </div>
    </div>

    <!-- Main Dashboard -->
    <template v-else>
      <div v-for="(w, i) in bs.warnings" :key="i" class="warn-strip card">
        <span>ℹ️ {{ w }}</span>
        <button v-if="bs.mode === 'demo'" class="sm primary" @click="showConfig = true">配置真实 GCP 账户</button>
      </div>

      <!-- 4 Top KPI Cards -->
      <div class="kpi-grid">
        <!-- Card 1: Remaining Promo / Trial Credit -->
        <div class="kpi card highlight">
          <div class="kl">
            <span>🎁 剩余可用赠金（含试用金）</span>
            <span v-if="daysUntilExpiry != null" class="badge" :style="{ color: daysUntilExpiry <= 14 ? 'var(--red)' : 'var(--cyan)' }">
              {{ daysUntilExpiry > 0 ? `剩余 ${daysUntilExpiry} 天到期` : '已到期' }}
            </span>
          </div>
          <div class="kv-big" :style="{ color: creditPctRemaining < 15 ? 'var(--red)' : 'var(--green)' }">
            {{ money(bs.totalCreditRemaining) }}
          </div>
          <div class="bar" style="height: 7px">
            <i
              :style="{
                width: creditPctRemaining + '%',
                background: creditPctRemaining < 15 ? 'var(--red)' : creditPctRemaining < 35 ? 'var(--yellow)' : 'var(--green)'
              }"
            />
          </div>
          <div class="ks muted">
            已用 {{ money(bs.totalCreditUsed) }} / 总额 {{ money(bs.totalCreditGranted) }}
            <template v-if="bs.estimatedRunwayDays != null">
              · 按近7日消耗可撑 <b style="color: var(--text)">~{{ bs.estimatedRunwayDays }} 天</b>
            </template>
          </div>
        </div>

        <!-- Card 2: Current Month Net Payable -->
        <div class="kpi card">
          <div class="kl">
            <span>🧾 {{ fmtYm(bs.invoiceMonth) }} 实际应付净额</span>
            <span class="badge" :style="{ color: bs.monthNetCost <= 0.01 ? 'var(--green)' : 'var(--yellow)' }">
              {{ bs.monthNetCost <= 0.01 ? '已被赠金全额抵扣' : '产生自付账单' }}
            </span>
          </div>
          <div class="kv-big" :style="{ color: bs.monthNetCost > 0.01 ? 'var(--yellow)' : 'var(--text)' }">
            {{ money(bs.monthNetCost) }}
          </div>
          <div class="ks muted">
            原始消费 {{ money(bs.monthGrossCost) }} − 抵扣 {{ money(bs.monthPromoDeduction + bs.monthOtherDiscounts) }}
          </div>
          <div class="ks dim">上月实际净额：{{ money(bs.prevMonthNetCost) }}（上月原始：{{ money(bs.prevMonthGrossCost) }}）</div>
        </div>

        <!-- Card 3: Current Month Gross Spend & Burn Rate -->
        <div class="kpi card">
          <div class="kl">
            <span>📊 {{ fmtYm(bs.invoiceMonth) }} 原始云资源消耗</span>
          </div>
          <div class="kv-big" style="color: #60a5fa">{{ money(bs.monthGrossCost) }}</div>
          <div class="ks muted">
            近 7 天日均消耗：<b style="color: var(--text)">{{ money(bs.dailyBurnRate7d) }} / 天</b>
          </div>
          <div class="ks dim">
            按当前速率折算月度消耗：约 {{ money(bs.dailyBurnRate7d * 30) }} / 月
          </div>
        </div>

        <!-- Card 4: Credits Applied This Month -->
        <div class="kpi card">
          <div class="kl">
            <span>🛡️ 本月赠金与折扣抵扣</span>
          </div>
          <div class="kv-big" style="color: var(--cyan)">
            -{{ money(bs.monthPromoDeduction + bs.monthOtherDiscounts) }}
          </div>
          <div class="ks muted">
            赠金抵扣 (<span class="mono">PROMOTION</span>)：<b style="color: var(--green)">-{{ money(bs.monthPromoDeduction) }}</b>
          </div>
          <div class="ks dim">免费层级 / 持续使用折扣：-{{ money(bs.monthOtherDiscounts) }}</div>
        </div>
      </div>

      <!-- Row 2: 30-day Trend Chart + Credit Grants Breakdown -->
      <div class="mid-grid">
        <div class="card panel-box">
          <div class="section-title">📈 近 30 天每日消费与赠金抵扣趋势</div>
          <div ref="chartEl" class="trend-chart" />
        </div>

        <div class="card panel-box">
          <div class="section-title">
            <span>🎁 赠金池明细 & 自动识别抵扣</span>
            <span class="grow" />
            <button class="ghost sm" @click="showConfig = true">校准额度</button>
          </div>

          <div class="grants-list">
            <div v-for="g in bs.grantsBreakdown" :key="g.id" class="grant-item">
              <div class="row">
                <b class="grow ellipsis">{{ g.name }}</b>
                <span style="color: var(--green); font-weight: 600">{{ money(g.remaining) }}</span>
              </div>
              <div class="bar" style="margin: 6px 0">
                <i
                  :style="{
                    width: (g.total > 0 ? Math.min(100, (g.remaining / g.total) * 100) : 0) + '%',
                    background: 'var(--green)'
                  }"
                />
              </div>
              <div class="row muted" style="font-size: 11.5px">
                <span class="grow">已抵扣 {{ money(g.used) }} / 总额 {{ money(g.total) }}</span>
                <span v-if="g.expiresAt">到期 {{ g.expiresAt }}</span>
              </div>
            </div>
          </div>

          <div v-if="bs.discoveredCredits.length" style="margin-top: 14px">
            <div class="dim" style="font-size: 11.5px; margin-bottom: 6px">BigQuery 账单表中识别到的抵扣项：</div>
            <table class="tbl">
              <thead>
                <tr>
                  <th>抵扣名称</th>
                  <th>本月</th>
                  <th>累计</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="c in bs.discoveredCredits" :key="c.type + c.name">
                  <td>
                    <div>{{ c.name }}</div>
                    <div class="dim mono" style="font-size: 10.5px">{{ c.type }}</div>
                  </td>
                  <td style="color: var(--green)">-{{ money(c.monthApplied) }}</td>
                  <td class="muted">-{{ money(c.allTimeApplied) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <!-- Row 3: Services / Projects + Top SKUs (Egress & Compute visibility) -->
      <div class="bot-grid">
        <div class="card panel-box">
          <div class="section-title">🧩 本月按云服务与项目构成</div>
          <div v-if="bs.byService.length" class="svc-bars">
            <div v-for="s in bs.byService" :key="s.service" class="svc-bar-item">
              <div class="row" style="font-size: 12.5px; margin-bottom: 4px">
                <b class="grow ellipsis">{{ s.service }}</b>
                <span>{{ money(s.gross) }}</span>
                <span class="dim" style="font-size: 11.5px">（净 {{ money(s.net) }}）</span>
              </div>
              <div class="bar">
                <i
                  :style="{
                    width: (bs.monthGrossCost > 0 ? Math.min(100, (s.gross / bs.monthGrossCost) * 100) : 0) + '%',
                    background: '#3b82f6'
                  }"
                />
              </div>
            </div>
          </div>
          <div v-else class="dim" style="font-size: 12.5px">本月暂无服务消费记录</div>

          <template v-if="bs.byProject.length">
            <div class="section-title" style="margin-top: 18px">📁 按 GCP 项目汇总</div>
            <table class="tbl">
              <thead>
                <tr>
                  <th>项目</th>
                  <th>原始消费</th>
                  <th>抵扣</th>
                  <th>实际净额</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="p in bs.byProject" :key="p.project">
                  <td class="mono">{{ p.project }}</td>
                  <td>{{ money(p.gross) }}</td>
                  <td style="color: var(--green)">-{{ money(p.credits) }}</td>
                  <td><b>{{ money(p.net) }}</b></td>
                </tr>
              </tbody>
            </table>
          </template>
        </div>

        <div class="card panel-box">
          <div class="section-title">🔍 本月高消费计费项 Top 15（实例 / 磁盘 / 出站流量 SKU）</div>
          <div style="overflow: auto">
            <table class="tbl">
              <thead>
                <tr>
                  <th>计费项 (SKU)</th>
                  <th>服务</th>
                  <th>用量</th>
                  <th>原始费用</th>
                  <th>净额</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(k, idx) in bs.topSkus" :key="idx">
                  <td>
                    <span :style="{ color: /egress|network/i.test(k.sku) ? '#38bdf8' : 'var(--text)' }">
                      {{ k.sku }}
                    </span>
                  </td>
                  <td class="muted">{{ k.service }}</td>
                  <td class="mono muted">
                    {{ k.usageAmount ? k.usageAmount.toFixed(1) + ' ' + k.usageUnit : '—' }}
                  </td>
                  <td><b>{{ money(k.gross) }}</b></td>
                  <td :style="{ color: k.net > 0.01 ? 'var(--yellow)' : 'var(--muted)' }">{{ money(k.net) }}</td>
                </tr>
                <tr v-if="!bs.topSkus.length">
                  <td colspan="5" class="dim" style="text-align: center; padding: 20px">本月暂无计费明细</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </template>

    <BillingConfigDialog v-if="showConfig" @close="showConfig = false" />
  </div>
</template>

<style scoped>
.billing-page { padding: 18px 24px 40px; max-width: 1800px; margin: 0 auto; display: flex; flex-direction: column; gap: 16px; }
.top-bar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.top-bar h1 { margin: 0; font-size: 20px; font-weight: 600; display: flex; align-items: center; gap: 8px; }
.top-bar .sub { font-size: 12px; margin-top: 3px; }
.badge.demo { font-size: 11px; color: var(--purple); border-color: #4c2a7a; }

.warn-strip { padding: 10px 14px; border-color: #1e3a5f; background: #0c172c; font-size: 12.5px; color: #93c5fd; display: flex; align-items: center; justify-content: space-between; gap: 12px; }

.empty { padding: 54px 28px; text-align: center; max-width: 680px; margin: 48px auto; }
.empty .big { font-size: 46px; }
.empty h2 { margin: 12px 0 8px; font-weight: 600; }
.empty p { line-height: 1.7; margin: 0 0 22px; }

.kpi-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; }
.kpi { padding: 14px 16px; display: flex; flex-direction: column; gap: 7px; }
.kpi.highlight { border-color: #1e4238; background: linear-gradient(180deg, #0d211f 0%, var(--panel) 75%); }
.kl { display: flex; justify-content: space-between; align-items: center; font-size: 12.5px; color: var(--muted); gap: 6px; }
.kv-big { font-size: 26px; font-weight: 700; letter-spacing: 0.3px; }
.ks { font-size: 12px; }

.mid-grid { display: grid; grid-template-columns: 1.8fr 1.2fr; gap: 14px; }
.bot-grid { display: grid; grid-template-columns: 1fr 1.5fr; gap: 14px; }
.panel-box { padding: 16px 18px; display: flex; flex-direction: column; }
.trend-chart { width: 100%; height: 250px; }

.grants-list { display: grid; gap: 10px; }
.grant-item { padding: 10px 12px; background: #0b1222; border: 1px solid var(--border); border-radius: 10px; }
.svc-bars { display: grid; gap: 10px; }

@media (max-width: 1200px) {
  .kpi-grid { grid-template-columns: repeat(2, 1fr); }
  .mid-grid, .bot-grid { grid-template-columns: 1fr; }
}
</style>
