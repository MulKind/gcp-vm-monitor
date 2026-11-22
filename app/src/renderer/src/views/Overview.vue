<script setup lang="ts">
import { computed, ref } from 'vue'
import type { VmConfig } from '@shared/types'
import { state, healthCounts, refreshVms, errMsg, toast } from '../store'
import VmCard from '../components/VmCard.vue'
import VmDialog from '../components/VmDialog.vue'

const editing = ref<VmConfig | null>(null)
const adding = ref(false)
const filter = ref('')

const vms = computed(() => {
  const q = filter.value.toLowerCase()
  return state.vms.filter((v) => !q || v.name.toLowerCase().includes(q) || v.host.includes(q))
})

const summary = computed(() => {
  let online = 0
  let svc = 0
  let bad = 0
  for (const v of state.vms) {
    if (state.statuses[v.id]?.state === 'connected') online++
    const c = healthCounts(v.id)
    svc += Object.values(c).reduce((a, b) => a + b, 0)
    bad += c.down + c.degraded
  }
  return { total: state.vms.length, online, svc, bad }
})

async function remove(vm: VmConfig): Promise<void> {
  if (!confirm(`确定删除「${vm.name}」吗？（不会影响 VM 本身和上面的 Agent）`)) return
  try {
    await window.api.deleteVm(vm.id)
    await refreshVms()
  } catch (e) {
    toast(errMsg(e), 'error')
  }
}

async function addDemo(): Promise<void> {
  const n = state.vms.filter((v) => v.kind === 'demo').length + 1
  const names = ['GCP-东京-1', 'GCP-新加坡', 'GCP-俄勒冈', 'GCP-台湾', 'GCP-法兰克福']
  await window.api.saveVm({
    id: '',
    name: names[(n - 1) % names.length] + (n > names.length ? `-${n}` : ''),
    kind: 'demo',
    host: '',
    port: 22,
    username: 'demo',
    authType: 'key',
    agentPort: 9527,
    gcpZone: ['asia-northeast1-b', 'asia-southeast1-a', 'us-west1-b', 'asia-east1-c', 'europe-west3-a'][(n - 1) % 5]
  })
  await refreshVms()
}
</script>

<template>
  <div class="overview">
    <header class="top">
      <div>
        <h1>虚拟机总览</h1>
        <div class="kpis">
          <span>共 <b>{{ summary.total }}</b> 台</span>
          <span><i class="dot" style="background: var(--green)" /> 在线 <b>{{ summary.online }}</b></span>
          <span>服务 <b>{{ summary.svc }}</b></span>
          <span v-if="summary.bad" style="color: var(--red)"><i class="dot" style="background: var(--red)" /> 异常 <b>{{ summary.bad }}</b></span>
        </div>
      </div>
      <div class="row">
        <input v-model="filter" placeholder="搜索名称 / IP" style="width: 200px" />
        <button @click="addDemo">＋ 演示 VM</button>
        <button class="primary" @click="adding = true">＋ 添加虚拟机</button>
      </div>
    </header>

    <div v-if="!state.vms.length" class="empty card">
      <div class="big">🖥️</div>
      <h2>还没有虚拟机</h2>
      <p class="muted">通过 SSH 添加你的 GCP 虚拟机。软件会经过 V2RayN 代理连接，并在 VM 上安装轻量 Agent 来采集指标和发现服务。</p>
      <div class="row" style="justify-content: center">
        <button class="primary" @click="adding = true">＋ 添加虚拟机</button>
        <button @click="addDemo">先用演示数据体验</button>
      </div>
    </div>

    <div v-else class="grid">
      <VmCard v-for="vm in vms" :key="vm.id" :vm="vm" @edit="editing = vm" @remove="remove(vm)" />
    </div>

    <VmDialog v-if="adding" @close="adding = false" />
    <VmDialog v-if="editing" :vm="editing" @close="editing = null" />
  </div>
</template>

<style scoped>
.overview { padding: 22px 26px 40px; max-width: 1800px; margin: 0 auto; }
.top { display: flex; align-items: flex-end; justify-content: space-between; margin-bottom: 20px; gap: 16px; flex-wrap: wrap; }
h1 { margin: 0 0 8px; font-size: 22px; font-weight: 600; }
.kpis { display: flex; gap: 18px; color: var(--muted); font-size: 13px; align-items: center; }
.kpis span { display: inline-flex; align-items: center; gap: 6px; }
.kpis b { color: var(--text); }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 16px; }
.empty { padding: 60px 20px; text-align: center; max-width: 620px; margin: 60px auto; }
.empty .big { font-size: 48px; }
.empty h2 { margin: 10px 0 6px; font-weight: 600; }
.empty p { line-height: 1.7; margin: 0 0 20px; }
</style>
