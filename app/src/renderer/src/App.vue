<script setup lang="ts">
import { computed, ref } from 'vue'
import { state, closeTab, goHome, openBilling, vmById } from './store'
import Overview from './views/Overview.vue'
import VmDetail from './views/VmDetail.vue'
import BillingView from './views/BillingView.vue'
import BrowserTab from './components/BrowserTab.vue'
import ServiceIcon from './components/ServiceIcon.vue'
import SettingsDialog from './components/SettingsDialog.vue'

const showSettings = ref(false)
const homeTitle = computed(() => (state.view === 'vm' && state.selectedVm ? vmById(state.selectedVm)?.name || '虚拟机' : '虚拟机'))

function clickVmNav(): void {
  state.activeTab = 'home'
  if (state.view === 'billing') state.view = 'overview'
}

function middleClose(e: MouseEvent, id: string): void {
  if (e.button === 1) closeTab(id)
}
</script>

<template>
  <div class="shell">
    <nav class="tabbar">
      <div class="brand" title="VMMon">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><rect x="2" y="3" width="20" height="14" rx="3" stroke="#3b82f6" stroke-width="2" /><path d="M6 12l3-3 3 3 4-5 2 2" stroke="#22d3ee" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" /><path d="M8 21h8M12 17v4" stroke="#3b82f6" stroke-width="2" stroke-linecap="round" /></svg>
        <b>VMMon</b>
      </div>
      <div class="tabs">
        <div
          class="tab"
          :class="{ on: state.activeTab === 'home' && state.view !== 'billing' }"
          @click="clickVmNav"
          @dblclick="goHome"
        >
          <span class="ti">🖥️</span><span class="ellipsis">{{ homeTitle }}</span>
        </div>
        <div
          class="tab"
          :class="{ on: state.activeTab === 'home' && state.view === 'billing' }"
          @click="openBilling"
        >
          <span class="ti">💳</span>
          <span class="ellipsis">
            账单与赠金
            <template v-if="state.billingSummary">
              · {{ state.billingSummary.currency === 'USD' ? '$' : state.billingSummary.currency + ' ' }}{{ state.billingSummary.totalCreditRemaining.toFixed(0) }}
            </template>
          </span>
        </div>
        <div
          v-for="t in state.tabs"
          :key="t.id"
          class="tab"
          :class="{ on: state.activeTab === t.id }"
          :title="t.title + '\n' + t.url"
          @click="state.activeTab = t.id"
          @mousedown="middleClose($event, t.id)"
        >
          <ServiceIcon :kind="t.kind" category="app" :name="t.title" :size="16" />
          <span class="ellipsis">{{ t.title }}</span>
          <button class="ghost x" @click.stop="closeTab(t.id)">✕</button>
        </div>
      </div>
      <button class="ghost icon" title="设置" @click="showSettings = true">⚙</button>
    </nav>

    <main class="content">
      <section v-show="state.activeTab === 'home'" class="home">
        <Overview v-if="state.view === 'overview'" />
        <BillingView v-else-if="state.view === 'billing'" />
        <VmDetail v-else-if="state.selectedVm" :key="state.selectedVm" :vm-id="state.selectedVm" />
      </section>
      <BrowserTab v-for="t in state.tabs" v-show="state.activeTab === t.id" :key="t.id" :tab="t" :active="state.activeTab === t.id" />
    </main>

    <div class="toasts">
      <div v-for="t in state.toasts" :key="t.id" class="toast" :class="t.type">{{ t.text }}</div>
    </div>
    <SettingsDialog v-if="showSettings" @close="showSettings = false" />
  </div>
</template>

<style scoped>
.shell { display: flex; flex-direction: column; height: 100%; }
.tabbar { height: 42px; flex: none; display: flex; align-items: flex-end; gap: 8px; padding: 0 8px; background: #070c18; border-bottom: 1px solid var(--border); }
.brand { display: flex; align-items: center; gap: 8px; height: 42px; padding: 0 10px 0 4px; font-size: 14px; letter-spacing: .5px; }
.tabs { flex: 1; display: flex; gap: 2px; overflow-x: auto; overflow-y: hidden; min-width: 0; height: 36px; }
.tabs::-webkit-scrollbar { height: 0; }
.tab { display: flex; align-items: center; gap: 7px; height: 36px; padding: 0 8px 0 12px; min-width: 120px; max-width: 220px; border-radius: 9px 9px 0 0; color: var(--muted); cursor: pointer; user-select: none; border: 1px solid transparent; border-bottom: 0; font-size: 13px; }
.tab:hover { background: #0e1629; color: var(--text); }
.tab.on { background: var(--bg); color: var(--text); border-color: var(--border); position: relative; top: 1px; }
.tab .ti { font-size: 13px; }
.tab .x { margin-left: auto; padding: 1px 5px; font-size: 11px; color: var(--muted); }
.tabbar > button { margin-bottom: 4px; font-size: 16px; }
.content { flex: 1; min-height: 0; position: relative; }
.home { height: 100%; overflow: auto; }
.toasts { position: fixed; right: 18px; bottom: 18px; display: grid; gap: 8px; z-index: 200; }
.toast { padding: 10px 14px; border-radius: 10px; background: #1e293b; border: 1px solid var(--border2); box-shadow: 0 10px 30px #0008; max-width: 420px; font-size: 13px; }
.toast.error { border-color: #7f1d1d; background: #2a1218; color: #fecaca; }
.toast.ok { border-color: #14532d; background: #0f2418; color: #bbf7d0; }
</style>
