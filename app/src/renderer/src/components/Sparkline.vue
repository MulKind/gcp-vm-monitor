<script setup lang="ts">
import { computed } from 'vue'

const props = withDefaults(defineProps<{ values: number[]; max?: number; color?: string; height?: number; width?: number }>(), {
  color: '#3b82f6',
  height: 36,
  width: 200
})

const pts = computed(() => {
  const v = props.values.slice(-60)
  if (v.length < 2) return { line: '', area: '' }
  const max = props.max ?? Math.max(1, ...v) * 1.15
  const step = props.width / (60 - 1)
  const x0 = props.width - (v.length - 1) * step
  const coords = v.map((y, i) => [x0 + i * step, props.height - (Math.min(y, max) / max) * (props.height - 2) - 1])
  const line = coords.map((c, i) => (i ? 'L' : 'M') + c[0].toFixed(1) + ',' + c[1].toFixed(1)).join('')
  const area = line + `L${props.width},${props.height}L${x0.toFixed(1)},${props.height}Z`
  return { line, area }
})
const gid = 'g' + Math.random().toString(36).slice(2, 8)
</script>

<template>
  <svg :viewBox="`0 0 ${width} ${height}`" preserveAspectRatio="none" class="spark" :style="{ height: height + 'px' }">
    <defs>
      <linearGradient :id="gid" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" :stop-color="color" stop-opacity="0.35" />
        <stop offset="100%" :stop-color="color" stop-opacity="0" />
      </linearGradient>
    </defs>
    <path :d="pts.area" :fill="`url(#${gid})`" />
    <path :d="pts.line" :stroke="color" stroke-width="1.5" fill="none" vector-effect="non-scaling-stroke" />
  </svg>
</template>

<style scoped>
.spark { width: 100%; display: block; }
</style>
