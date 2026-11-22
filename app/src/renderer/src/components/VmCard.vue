<script setup lang="ts">
import { computed } from 'vue'
import type { VmConfig } from '@shared/types'
import { state, healthCounts, visibleServices, openVm } from '../store'
import { CONN_COLOR, CONN_LABEL, fmtBytes, fmtDuration, fmtPct, fmtRate, pctColor, HEALTH_COLOR } from '../util'
import { osIcon } from '../icons'
import Sparkline from './Sparkline.vue'
import ServiceIcon from './ServiceIcon.vue'

const props = defineProps<{ vm: VmConfig }>()
const emit = defineEmits<{ edit: []; remove: [] }>()

const st = computed(() => state.statuses[props.vm.id])
const m = computed(() => state.metrics[props.vm.id])
const info = computed(() => state.infos[props.vm.id])
const hist = computed(() => state.history[props.vm.id] || [])
const online = computed(() => st.value?.state === 'connected')
const counts = computed(() => healthCounts(props.vm.id))
const svcs = computed(() => visibleServices(props.vm.id))
const rootDisk = computed(() => {
  const d = m.value?.disks || []
  return d.find((x) => x.mount === '/') || d[0]
})
const maxDisk = computed(() => Math.max(0, ...(m.value?.disks || []).map((d) => d.percent)))
const bad = computed(() => svcs.value.filter((s) => s.health === 'down' || s.health === 'degraded'))
const topIcons = computed(() => [...bad.value, ...svcs.value.filter((s) => !bad.value.includes(s))].slice(0, 9))
const osI = computed(() => osIcon(info.value?.os))
</script>

<template>
  <div class="vmcard card" :class="{ offline: !online, alert: bad.length > 0 }" @click="openVm(vm.id)">
    <div class="head">
      <span class="os" :style="{ color: osI.color }"><svg viewBox="0 0 24 24" width="20" height="20"><path :d="osI.path" fill="currentColor" /></svg></span>
      <div class="grow">
        <div class="name ellipsis">{{ vm.name }} <span v-if="vm.kind === 'demo'" class="badge demo">演示</span></div>
        <div class="sub ellipsis mono">{{ vm.kind === 'demo' ? 'demo' : `${vm.username}@${vm.host}` }}<template v-if="vm.gcpZone"> · {{ vm.gcpZone }}</template></div>
      </div>
      <span class="badge" :style="{ color: CONN_COLOR[st?.state || 'disconnected'] }">
        <i class="dot" :class="{ pulse: online }" :style="{ background: CONN_COLOR[st?.state || 'disconnected'] }" />
        {{ CONN_LABEL[st?.state || 'disconnected'] }}
      </span>
      <div class="menu" @click.stop>
        <button class="ghost icon sm" title="编辑" @click="emit('edit')">✎</button>
        <button class="ghost icon sm" title="删除" @click="emit('remove')">🗑</button>
      </div>
    </div>

    <template v-if="online && m">
      <div class="spark-wrap">
        <div class="spark-label"><span>CPU</span><b :style="{ color: pctColor(m.cpu.percent) }">{{ fmtPct(m.cpu.percent) }}</b></div>
        <Sparkline :values="hist.map((h) => h.cpu)" :max="100" color="#3b82f6" :height="42" />
      </div>
      <div class="meters">
        <div>
          <div class="ml"><span>内存</span><span>{{ fmtBytes(m.mem.used) }} / {{ fmtBytes(m.mem.total) }}</span></div>
          <div class="bar"><i :style="{ width: m.mem.percent + '%', background: pctColor(m.mem.percent) }" /></div>
        </div>
        <div>
          <div class="ml"><span>磁盘 {{ rootDisk?.mount }}</span><span :style="{ color: maxDisk >= 85 ? 'var(--yellow)' : '' }">{{ fmtPct(rootDisk?.percent) }}</span></div>
          <div class="bar"><i :style="{ width: (rootDisk?.percent || 0) + '%', background: pctColor(rootDisk?.percent) }" /></div>
        </div>
      </div>
      <div class="stats">
        <span title="下行">↓ {{ fmtRate(m.net.rx_bps) }}</span>
        <span title="上行">↑ {{ fmtRate(m.net.tx_bps) }}</span>
        <span title="负载">⚖ {{ m.load[0].toFixed(2) }}</span>
        <span title="运行时间">⏱ {{ fmtDuration(m.uptime) }}</span>
      </div>
    </template>
    <div v-else class="offline-msg">
      <span v-if="st?.state === 'connecting'" class="spin">◌</span>
      {{ st?.message || CONN_LABEL[st?.state || 'disconnected'] }}
    </div>

    <div class="svcs">
      <div class="icons">
        <span v-for="s in topIcons" :key="s.id" class="si" :title="`${s.display_name} · ${s.health}`">
          <ServiceIcon :kind="s.kind" :category="s.category" :name="s.display_name" :size="26" />
          <i class="dot" :style="{ background: HEALTH_COLOR[s.health] }" />
        </span>
        <span v-if="svcs.length > topIcons.length" class="more">+{{ svcs.length - topIcons.length }}</span>
        <span v-if="!svcs.length" class="dim" style="font-size: 12px">暂无服务数据</span>
      </div>
      <div class="hc">
        <span v-if="counts.healthy" style="color: var(--green)">● {{ counts.healthy }}</span>
        <span v-if="counts.degraded" style="color: var(--yellow)">● {{ counts.degraded }}</span>
        <span v-if="counts.down" style="color: var(--red)">● {{ counts.down }}</span>
        <span v-if="counts.stopped" style="color: var(--gray)">● {{ counts.stopped }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.vmcard { padding: 14px 16px; cursor: pointer; display: flex; flex-direction: column; gap: 12px; transition: border-color .2s, transform .2s, box-shadow .2s; position: relative; }
.vmcard:hover { border-color: #33507f; transform: translateY(-2px); box-shadow: 0 12px 30px #0006; }
.vmcard.alert { border-color: #5b2a1a; }
.vmcard.offline { opacity: .85; }
.head { display: flex; align-items: center; gap: 10px; }
.os { width: 36px; height: 36px; border-radius: 10px; background: #0b1222; border: 1px solid var(--border); display: flex; align-items: center; justify-content: center; flex: none; }
.name { font-weight: 600; font-size: 15px; }
.sub { color: var(--muted); font-size: 12px; margin-top: 2px; }
.badge.demo { font-size: 10px; padding: 0 6px; color: var(--purple); border-color: #4c2a7a; vertical-align: 2px; }
.menu { display: flex; opacity: 0; transition: opacity .15s; }
.vmcard:hover .menu { opacity: 1; }
.spark-wrap { position: relative; background: #0b1222; border-radius: 8px; padding: 6px 8px 0; border: 1px solid #16213a; }
.spark-label { display: flex; justify-content: space-between; font-size: 12px; color: var(--muted); }
.spark-label b { font-size: 13px; }
.meters { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.ml { display: flex; justify-content: space-between; font-size: 11.5px; color: var(--muted); margin-bottom: 5px; }
.stats { display: flex; justify-content: space-between; font-size: 12px; color: var(--muted); }
.offline-msg { min-height: 112px; display: flex; align-items: center; justify-content: center; gap: 6px; text-align: center; color: var(--muted); font-size: 13px; padding: 0 10px; background: #0b1222; border-radius: 8px; border: 1px dashed var(--border); }
.svcs { display: flex; align-items: center; gap: 8px; border-top: 1px solid var(--border); padding-top: 10px; }
.icons { flex: 1; display: flex; gap: 6px; align-items: center; min-width: 0; overflow: hidden; }
.si { position: relative; display: inline-flex; }
.si .dot { position: absolute; right: -2px; bottom: -2px; width: 8px; height: 8px; border: 2px solid var(--panel); box-sizing: content-box; }
.more { font-size: 12px; color: var(--muted); }
.hc { display: flex; gap: 8px; font-size: 12px; }
</style>
