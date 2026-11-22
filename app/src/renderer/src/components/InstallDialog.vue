<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'

const props = defineProps<{ vmId: string; vmName: string }>()
const emit = defineEmits<{ close: [] }>()

const lines = ref<string[]>([])
const done = ref(false)
const ok = ref(false)
const box = ref<HTMLDivElement>()
let off: (() => void) | null = null

onMounted(() => {
  off = window.api.onInstallLog(async (l) => {
    if (l.vmId !== props.vmId) return
    lines.value.push(l.line)
    if (l.done) {
      done.value = true
      ok.value = !!l.ok
    }
    await nextTick()
    if (box.value) box.value.scrollTop = box.value.scrollHeight
  })
  void window.api.installAgent(props.vmId)
})
onBeforeUnmount(() => off?.())
</script>

<template>
  <div class="modal-mask">
    <div class="modal" style="width: 680px">
      <header>
        在「{{ vmName }}」上安装 VMMon Agent
        <span class="grow" />
        <span v-if="!done" class="spin">◌</span>
        <span v-else :style="{ color: ok ? 'var(--green)' : 'var(--red)' }">{{ ok ? '✓ 成功' : '✗ 失败' }}</span>
      </header>
      <div class="body">
        <div class="muted" style="font-size: 12.5px; line-height: 1.6">
          通过 SSH 上传 <span class="mono">vmmon_agent.py</span> 到 <span class="mono">/opt/vmmon-agent/</span>，并注册为 systemd 服务。Agent 只监听
          <span class="mono">127.0.0.1:9527</span>，不对公网开放端口；只依赖 python3 标准库。
        </div>
        <div ref="box" class="log mono">
          <div v-for="(l, i) in lines" :key="i">{{ l }}</div>
        </div>
      </div>
      <footer>
        <button :disabled="!done" class="primary" @click="emit('close')">关闭</button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.log { height: 320px; overflow: auto; background: #060b16; border: 1px solid var(--border); border-radius: 8px; padding: 10px; font-size: 12px; line-height: 1.6; white-space: pre-wrap; }
</style>
