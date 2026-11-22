<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch, shallowRef } from 'vue'
import * as echarts from 'echarts/core'
import { LineChart } from 'echarts/charts'
import { GridComponent, TooltipComponent, LegendComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import type { Sample } from '../store'
import { fmtRate } from '../util'

echarts.use([LineChart, GridComponent, TooltipComponent, LegendComponent, CanvasRenderer])

export interface SeriesDef {
  key: keyof Sample
  name: string
  color: string
}

const props = defineProps<{ samples: Sample[]; series: SeriesDef[]; unit: 'pct' | 'rate' | 'num'; max?: number }>()

const el = ref<HTMLDivElement>()
const chart = shallowRef<echarts.ECharts>()
let ro: ResizeObserver | null = null

function fmt(v: number): string {
  if (props.unit === 'pct') return v.toFixed(1) + '%'
  if (props.unit === 'rate') return fmtRate(v)
  return v.toFixed(2)
}

function axisFmt(v: number): string {
  if (props.unit === 'pct') return v + '%'
  if (props.unit === 'rate') return fmtRate(v).replace('.0 ', ' ')
  return String(v)
}

function render(): void {
  if (!chart.value) return
  chart.value.setOption(
    {
      animation: false,
      grid: { left: 8, right: 12, top: 28, bottom: 6, containLabel: true },
      legend: { top: 0, right: 0, itemWidth: 10, itemHeight: 3, textStyle: { color: '#7d8aa5', fontSize: 11 }, icon: 'rect' },
      tooltip: {
        trigger: 'axis',
        backgroundColor: '#0f172aee',
        borderColor: '#2a3a5c',
        textStyle: { color: '#e2e8f0', fontSize: 12 },
        valueFormatter: (v: unknown) => fmt(Number(v))
      },
      xAxis: {
        type: 'time',
        axisLine: { lineStyle: { color: '#1f2c47' } },
        axisLabel: { color: '#55627e', fontSize: 10, hideOverlap: true, formatter: '{HH}:{mm}:{ss}' },
        splitLine: { show: false }
      },
      yAxis: {
        type: 'value',
        min: 0,
        max: props.max,
        splitNumber: 3,
        axisLabel: { color: '#55627e', fontSize: 10, formatter: axisFmt },
        splitLine: { lineStyle: { color: '#16213a' } }
      },
      series: props.series.map((s) => ({
        name: s.name,
        type: 'line',
        showSymbol: false,
        smooth: 0.3,
        lineStyle: { width: 1.6, color: s.color },
        itemStyle: { color: s.color },
        areaStyle: {
          color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: s.color + '55' },
            { offset: 1, color: s.color + '00' }
          ])
        },
        data: props.samples.map((p) => [p.t, p[s.key]])
      }))
    },
    { replaceMerge: ['series'] }
  )
}

onMounted(() => {
  chart.value = echarts.init(el.value!, undefined, { renderer: 'canvas' })
  render()
  ro = new ResizeObserver(() => chart.value?.resize())
  ro.observe(el.value!)
})
onBeforeUnmount(() => {
  ro?.disconnect()
  chart.value?.dispose()
})
watch(() => props.samples, render)
</script>

<template>
  <div ref="el" class="chart" />
</template>

<style scoped>
.chart { width: 100%; height: 100%; min-height: 140px; }
</style>
