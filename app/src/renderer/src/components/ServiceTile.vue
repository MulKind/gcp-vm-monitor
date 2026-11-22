<script setup lang="ts">
import type { Service } from '@shared/types'
import ServiceIcon from './ServiceIcon.vue'
import { HEALTH_COLOR, HEALTH_LABEL, SOURCE_LABEL, fmtBytes, fmtPct } from '../util'

defineProps<{ svc: Service; selected?: boolean }>()
const emit = defineEmits<{ open: []; details: [] }>()
</script>

<template>
  <div class="tile" :class="[svc.health, { selected, noweb: !svc.web }]" :title="svc.web ? '点击在内置浏览器中打开后台' : '无 Web 后台，点击查看详情'" @click="svc.web ? emit('open') : emit('details')">
    <div class="ic">
      <ServiceIcon :kind="svc.kind" :category="svc.category" :name="svc.display_name" :size="44" />
      <i class="hdot" :style="{ background: HEALTH_COLOR[svc.health] }" />
    </div>
    <div class="nm ellipsis">{{ svc.display_name }}</div>
    <div class="meta ellipsis">
      <span>{{ SOURCE_LABEL[svc.source] || svc.source }}</span>
      <span v-if="svc.ports.length" class="mono">:{{ svc.ports.map((p) => p.host_port || p.port).slice(0, 3).join(',') }}</span>
    </div>
    <div class="st" :style="{ color: HEALTH_COLOR[svc.health] }">
      {{ HEALTH_LABEL[svc.health] }}
      <span v-if="svc.check?.latency_ms != null && svc.status === 'running'" class="dim">· {{ Math.round(svc.check.latency_ms) }}ms</span>
    </div>
    <div v-if="svc.container && svc.container.cpu_percent != null" class="res dim">
      CPU {{ fmtPct(svc.container.cpu_percent) }} · {{ fmtBytes(svc.container.mem_bytes) }}
    </div>
    <button class="ghost icon sm det" title="详情 / 日志 / 设置" @click.stop="emit('details')">ⓘ</button>
    <span v-if="svc.web" class="go">↗</span>
  </div>
</template>

<style scoped>
.tile { position: relative; background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 16px 10px 12px; display: flex; flex-direction: column; align-items: center; gap: 4px; cursor: pointer; transition: all .18s; text-align: center; min-width: 0; }
.tile:hover { border-color: #3a5a8f; background: #132042; transform: translateY(-2px); box-shadow: 0 10px 24px #0006; }
.tile.selected { border-color: var(--blue); box-shadow: 0 0 0 1px var(--blue) inset; }
.tile.down { border-color: #5a1f27; background: linear-gradient(180deg, #2a121a 0%, var(--panel) 60%); }
.tile.degraded { border-color: #5a3d12; }
.tile.stopped { opacity: .6; }
.ic { position: relative; margin-bottom: 6px; }
.hdot { position: absolute; right: -3px; bottom: -3px; width: 11px; height: 11px; border-radius: 50%; border: 2.5px solid var(--panel); }
.tile.down .hdot { animation: blink 1.2s infinite; }
@keyframes blink { 50% { opacity: .3; } }
.nm { font-weight: 600; font-size: 13.5px; max-width: 100%; }
.meta { font-size: 11.5px; color: var(--muted); display: flex; gap: 6px; justify-content: center; max-width: 100%; }
.st { font-size: 12px; }
.res { font-size: 11px; }
.det { position: absolute; top: 4px; right: 4px; opacity: 0; color: var(--muted); }
.tile:hover .det { opacity: 1; }
.go { position: absolute; top: 7px; left: 10px; font-size: 12px; color: var(--blue); opacity: 0; }
.tile:hover .go { opacity: 1; }
</style>
