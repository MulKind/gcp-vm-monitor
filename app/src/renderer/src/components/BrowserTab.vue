<script setup lang="ts">
import { onMounted, ref } from 'vue'
import type { Tab } from '../store'
import { openVm } from '../store'
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
}

const wv = ref<WebviewEl>()
const addr = ref(props.tab.url)
const loading = ref(true)
const canBack = ref(false)
const canFwd = ref(false)
const errText = ref('')
const showSide = ref(true)

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
      <button class="ghost sm" title="返回该 VM 详情" @click="openVm(tab.vmId)">🖥️ VM</button>
      <form class="urlbar" @submit.prevent="go">
        <span class="lock" :title="addr.startsWith('http://127.0.0.1') || addr.startsWith('https://127.0.0.1') ? '通过 SSH 本地隧道安全转发' : ''">
          {{ addr.includes('127.0.0.1') ? '🔒 SSH隧道' : '🌐' }}
        </span>
        <input v-model="addr" class="mono" spellcheck="false" />
      </form>
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
