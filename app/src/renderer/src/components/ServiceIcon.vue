<script setup lang="ts">
import { computed } from 'vue'
import { iconFor } from '../icons'

const props = withDefaults(defineProps<{ kind: string; category?: string; name?: string; size?: number; plain?: boolean }>(), {
  category: 'app',
  name: '',
  size: 36,
  plain: false
})
const ic = computed(() => iconFor(props.kind, props.category, props.name))
</script>

<template>
  <span
    class="sicon"
    :class="{ plain }"
    :style="{ width: size + 'px', height: size + 'px', '--c': ic.color, borderRadius: size * 0.26 + 'px' }"
  >
    <svg v-if="ic.path" viewBox="0 0 24 24" :width="size * 0.6" :height="size * 0.6"><path :d="ic.path" fill="currentColor" /></svg>
    <b v-else :style="{ fontSize: size * (ic.text && ic.text.length > 2 ? 0.3 : 0.4) + 'px' }">{{ ic.text }}</b>
  </span>
</template>

<style scoped>
.sicon { display: inline-flex; align-items: center; justify-content: center; flex: none; color: var(--c); background: color-mix(in srgb, var(--c) 14%, #0b1222); border: 1px solid color-mix(in srgb, var(--c) 30%, transparent); }
.sicon.plain { background: transparent; border: 0; }
b { font-weight: 700; line-height: 1; font-family: 'Segoe UI', 'Microsoft YaHei UI', sans-serif; }
</style>
