<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { CreditGrant } from '@shared/types'
import type { Tab } from '../store'
import { state, openVm, openBilling, errMsg, toast } from '../store'
import ServicePanel from './ServicePanel.vue'

const props = defineProps<{ tab: Tab; active: boolean }>()

interface WebviewEl extends HTMLElement {
  src: string
  canGoBack(): boolean
  canGoForward(): boolean
  goBack(): void
  goForward(): void
  reload(): void
  loadURL(url: string): Promise<void>
  getURL(): string
  getTitle(): string
  getWebContentsId(): number
  openDevTools(): void
  executeJavaScript<T = unknown>(code: string): Promise<T>
}

const wv = ref<WebviewEl>()
const addr = ref(props.tab.url)
const loading = ref(true)
const canBack = ref(false)
const canFwd = ref(false)
const errText = ref('')
const showSide = ref(true)
const syncingCredits = ref(false)

const isGcpBillingPage = computed(() => /^https:\/\/console\.cloud\.google\.com\/billing/i.test(addr.value))

async function syncGcpCredits(): Promise<void> {
  const el = wv.value
  if (!el) return
  const curUrl = el.getURL() || addr.value
  if (!/^https:\/\/console\.cloud\.google\.com\/billing/i.test(curUrl)) {
    toast('请先登录并停留在 Google Cloud 结算页面后再点击同步', 'error')
    return
  }
  if (!/\/credits(\b|\/|\?|$)/i.test(curUrl)) {
    const m = /\/billing\/([0-9A-F]{6}-[0-9A-F]{6}-[0-9A-F]{6})/i.exec(curUrl)
    const acctId = m?.[1] || state.billingConfig?.billingAccountId
    if (acctId && !acctId.includes('DEMO')) {
      void el.loadURL(`https://console.cloud.google.com/billing/${acctId}/credits`)
      toast('已为你跳转到「赠金 (Credits)」明细页，等页面加载完毕后再点一次即可同步', 'info')
    } else {
      toast('请先在左侧菜单点击进入某个结算账户的「赠金 (Credits)」页面后再点同步', 'info')
    }
    return
  }

  syncingCredits.value = true
  try {
    interface ParsedPage {
      ready: boolean
      noCreditsText: boolean
      currency: string
      expiredCount: number
      grants: { name: string; remaining: number; expiresAt?: string }[]
    }

    const parsed = await el.executeJavaScript<ParsedPage>(`(() => {
      const bodyText = (document.body?.innerText || '').trim();
      if (!bodyText || bodyText.length < 30) return { ready: false, noCreditsText: false, currency: '', expiredCount: 0, grants: [] };

      const noCredRe = /没有赠金|没有任何赠金|目前没有赠金|找不到.*赠金|无可用赠金|no credits|don't have any credits|no promotional credits/i;
      const inactiveRe = /已过期|已用完|已用尽|已耗尽|已失效|已取消|不可用|expired|exhausted|depleted|canceled|cancelled|inactive/i;

      function parseMoney(s) {
        if (!s) return null;
        let cur = '';
        if (/HK\\$/i.test(s)) cur = 'HKD';
        else if (/NT\\$/i.test(s)) cur = 'TWD';
        else if (/CN¥|RMB/i.test(s)) cur = 'CNY';
        else if (/€/.test(s)) cur = 'EUR';
        else if (/£/.test(s)) cur = 'GBP';
        else if (/US\\$|\\$/.test(s)) cur = 'USD';
        const m = s.replace(/,/g, '').match(/-?\\d+(?:\\.\\d+)?/);
        if (!m) return null;
        return { amount: parseFloat(m[0]), cur };
      }

      function parseDate(s) {
        if (!s) return undefined;
        const zh = s.match(/(20\\d{2})\\s*年\\s*(\\d{1,2})\\s*月\\s*(\\d{1,2})/);
        if (zh) return zh[1] + '-' + zh[2].padStart(2, '0') + '-' + zh[3].padStart(2, '0');
        const iso = s.match(/(20\\d{2})[-/](\\d{1,2})[-/](\\d{1,2})/);
        if (iso) return iso[1] + '-' + iso[2].padStart(2, '0') + '-' + iso[3].padStart(2, '0');
        const d = new Date(s);
        if (!isNaN(d.getTime()) && d.getFullYear() >= 2020 && d.getFullYear() <= 2040) {
          return d.toISOString().slice(0, 10);
        }
        return undefined;
      }

      let detectedCur = '';
      let expiredCount = 0;
      const grants = [];

      const grids = Array.from(document.querySelectorAll('table, [role="grid"], [role="table"]'));
      for (const grid of grids) {
        const rows = Array.from(grid.querySelectorAll('tr, [role="row"]'));
        if (rows.length < 2) continue;
        const headerCells = Array.from(rows[0].querySelectorAll('th, td, [role="columnheader"]')).map(c => (c.innerText || '').trim());
        const remIdx = headerCells.findIndex(h => /剩余|余额|可用金|remaining|balance/i.test(h));
        const statusIdx = headerCells.findIndex(h => /状态|status/i.test(h));
        const nameIdx = headerCells.findIndex(h => /赠金|名称|说明|credit|name|description/i.test(h));
        const expIdx = headerCells.findIndex(h => /到期|结束|有效|expir|end date/i.test(h));
        if (remIdx < 0) continue;

        for (let i = 1; i < rows.length; i++) {
          const cells = Array.from(rows[i].querySelectorAll('td, [role="gridcell"], [role="cell"]')).map(c => (c.innerText || '').trim());
          if (cells.length <= remIdx) continue;
          const statusStr = statusIdx >= 0 && cells[statusIdx] ? cells[statusIdx] : rows[i].innerText || '';
          const money = parseMoney(cells[remIdx]);
          if (money && money.cur && !detectedCur) detectedCur = money.cur;

          if (inactiveRe.test(statusStr) || !money || money.amount <= 0.005) {
            expiredCount++;
            continue;
          }
          const name = (nameIdx >= 0 && cells[nameIdx] ? cells[nameIdx].split('\\n')[0] : 'GCP 赠金').trim();
          const expStr = expIdx >= 0 ? cells[expIdx] : '';
          grants.push({
            name: name || 'GCP 赠金',
            remaining: money.amount,
            expiresAt: parseDate(expStr)
          });
        }
      }

      return {
        ready: true,
        noCreditsText: noCredRe.test(bodyText),
        currency: detectedCur,
        expiredCount,
        grants
      };
    })()`)

    if (!parsed.ready) {
      toast('页面仍在加载中，请稍候再试', 'info')
      return
    }

    const todayIso = new Date().toISOString().slice(0, 10)
    const grants: CreditGrant[] = parsed.grants.map((g, idx) => ({
      id: `sync-${Date.now()}-${idx}`,
      name: g.name,
      totalAmount: g.remaining,
      expiresAt: g.expiresAt,
      baselineDate: todayIso
    }))

    const res = await window.api.syncConsoleCredits({
      grants,
      currency: parsed.currency || undefined
    })
    state.billingConfig = res.config
    state.billingSummary = res.summary

    if (grants.length === 0) {
      const detail = parsed.expiredCount > 0 ? `（识别到 ${parsed.expiredCount} 项已过期/已用完赠金）` : ''
      toast(`已同步：当前账户可用赠金为 $0.00${detail}`, 'ok')
    } else {
      const sum = grants.reduce((s, g) => s + g.totalAmount, 0)
      toast(`已同步 ${grants.length} 项有效赠金，可用余额共 ${res.config.currency} ${sum.toFixed(2)}`, 'ok')
    }
  } catch (e) {
    toast('同步失败: ' + errMsg(e), 'error')
  } finally {
    syncingCredits.value = false
  }
}

function syncNav(): void {
  const el = wv.value
  if (!el) return
  try {
    addr.value = el.getURL() || addr.value
    canBack.value = el.canGoBack()
    canFwd.value = el.canGoForward()
  } catch {
    /* webview not ready yet */
  }
}

function go(): void {
  let u = addr.value.trim()
  if (!u) return
  if (!/^https?:\/\//i.test(u)) u = 'http://' + u
  errText.value = ''
  void wv.value?.loadURL(u)
}

function reload(): void {
  errText.value = ''
  wv.value?.reload()
}

function openExt(): void {
  void window.api.openExternal(addr.value)
}

onMounted(() => {
  const el = wv.value
  if (!el) return
  el.addEventListener('did-start-loading', () => {
    loading.value = true
    errText.value = ''
  })
  el.addEventListener('did-stop-loading', () => {
    loading.value = false
    syncNav()
  })
  el.addEventListener('did-navigate', syncNav)
  el.addEventListener('did-navigate-in-page', syncNav)
  el.addEventListener('dom-ready', () => {
    try {
      props.tab.wcId = el.getWebContentsId()
    } catch {
      /* ignore */
    }
    syncNav()
  })
  el.addEventListener('did-fail-load', (e: Event) => {
    const ev = e as unknown as { errorCode: number; errorDescription: string; isMainFrame: boolean }
    if (ev.errorCode === -3 || !ev.isMainFrame) return // -3 = ERR_ABORTED
    loading.value = false
    errText.value = `${ev.errorDescription} (${ev.errorCode})`
  })
})
</script>

<template>
  <div class="btab">
    <div class="nav">
      <button class="ghost icon" :disabled="!canBack" title="后退" @click="wv?.goBack()">←</button>
      <button class="ghost icon" :disabled="!canFwd" title="前进" @click="wv?.goForward()">→</button>
      <button class="ghost icon" title="刷新" @click="reload">
        <span :class="{ spin: loading }">⟳</span>
      </button>
      <button v-if="tab.vmId" class="ghost sm" title="返回该 VM 详情" @click="openVm(tab.vmId)">🖥️ VM</button>
      <form class="urlbar" @submit.prevent="go">
        <span class="lock" :title="addr.startsWith('http://127.0.0.1') || addr.startsWith('https://127.0.0.1') ? '通过 SSH 本地隧道安全转发' : ''">
          {{ addr.includes('127.0.0.1') ? '🔒 SSH隧道' : '🌐' }}
        </span>
        <input v-model="addr" class="mono" spellcheck="false" />
      </form>
      <button v-if="isGcpBillingPage" class="primary sm" :disabled="syncingCredits" @click="syncGcpCredits">
        📥 {{ syncingCredits ? '正在读取…' : '同步此页赠金余额' }}
      </button>
      <button v-if="isGcpBillingPage" class="ghost sm" @click="openBilling">💳 返回账单面板</button>
      <button class="ghost icon" title="在系统浏览器中打开" @click="openExt">↗</button>
      <button class="ghost icon" title="开发者工具 (DevTools)" @click="wv?.openDevTools()">🛠</button>
      <button v-if="tab.svcId" :class="{ primary: showSide }" class="sm" @click="showSide = !showSide">
        {{ showSide ? '隐藏侧栏' : '服务侧栏' }}
      </button>
    </div>

    <div class="stage">
      <div class="wv-wrap">
        <webview
          ref="wv"
          class="wv"
          :src="tab.url"
          :partition="tab.partition"
          allowpopups
        />
        <div v-if="errText" class="err-overlay">
          <div class="card err-card">
            <h3>页面加载失败</h3>
            <p class="mono muted">{{ errText }}</p>
            <p class="muted" style="font-size: 12.5px">
              请检查该服务在 VM 上是否正常运行、是否使用 HTTPS 协议（可在右侧「设置」中切换 http / https 或修改路径）。
            </p>
            <div class="row" style="justify-content: center">
              <button class="primary" @click="reload">重试</button>
              <button @click="openExt">在外部浏览器尝试</button>
            </div>
          </div>
        </div>
      </div>

      <aside v-if="tab.svcId && showSide" class="side">
        <ServicePanel :vm-id="tab.vmId" :svc-id="tab.svcId" compact hide-open />
      </aside>
    </div>
  </div>
</template>

<style scoped>
.btab { display: flex; flex-direction: column; height: 100%; }
.nav { height: 42px; flex: none; display: flex; align-items: center; gap: 6px; padding: 0 10px; background: var(--panel); border-bottom: 1px solid var(--border); }
.urlbar { flex: 1; display: flex; align-items: center; background: var(--bg2); border: 1px solid var(--border2); border-radius: 8px; padding: 0 8px; height: 30px; }
.urlbar:focus-within { border-color: var(--blue); }
.urlbar .lock { font-size: 11.5px; color: var(--green); margin-right: 8px; white-space: nowrap; }
.urlbar input { border: 0; background: transparent; padding: 0; font-size: 12.5px; height: 100%; box-shadow: none; }
.stage { flex: 1; min-height: 0; display: flex; }
.wv-wrap { flex: 1; position: relative; background: #fff; }
.wv { width: 100%; height: 100%; border: 0; display: inline-flex; }
.err-overlay { position: absolute; inset: 0; background: var(--bg); display: flex; align-items: center; justify-content: center; }
.err-card { padding: 28px 36px; text-align: center; max-width: 460px; }
.err-card h3 { margin: 0 0 8px; }
.side { width: 370px; flex: none; border-left: 1px solid var(--border); background: var(--panel); overflow: hidden; }
</style>
