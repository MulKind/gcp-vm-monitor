<script setup lang="ts">
import { reactive, ref } from 'vue'
import type { Settings } from '@shared/types'
import { state, errMsg, toast } from '../store'

const emit = defineEmits<{ close: [] }>()

const f = reactive<Settings>(
  JSON.parse(
    JSON.stringify(
      state.settings || {
        proxy: { type: 'http', host: '127.0.0.1', port: 10808 },
        browserUseProxy: true,
        closeToTray: true,
        metricsIntervalMs: 1000,
        servicesIntervalMs: 5000
      }
    )
  )
)
const saving = ref(false)

async function save(): Promise<void> {
  saving.value = true
  try {
    state.settings = await window.api.saveSettings(JSON.parse(JSON.stringify(f)))
    toast('设置已保存', 'ok')
    emit('close')
  } catch (e) {
    toast(errMsg(e), 'error')
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="modal-mask" @mousedown.self="emit('close')">
    <div class="modal">
      <header>软件设置</header>
      <div class="body">
        <div>
          <label>SSH 与网络代理（V2RayN）</label>
          <div class="seg">
            <button :class="{ on: f.proxy.type === 'http' }" @click="f.proxy.type = 'http'">HTTP 代理</button>
            <button :class="{ on: f.proxy.type === 'socks5' }" @click="f.proxy.type = 'socks5'">SOCKS5 代理</button>
            <button :class="{ on: f.proxy.type === 'none' }" @click="f.proxy.type = 'none'">直连（无代理）</button>
          </div>
        </div>

        <div v-if="f.proxy.type !== 'none'" class="grid2" style="grid-template-columns: 2fr 1fr">
          <div>
            <label>代理主机</label>
            <input v-model.trim="f.proxy.host" class="mono" placeholder="127.0.0.1" />
          </div>
          <div>
            <label>代理端口</label>
            <input v-model.number="f.proxy.port" type="number" class="mono" placeholder="10808" />
          </div>
        </div>

        <label class="row" style="cursor: pointer; color: var(--text)">
          <input v-model="f.browserUseProxy" type="checkbox" style="width: auto" />
          内置浏览器打开外部域名时也走此代理（本地 SSH 隧道 <span class="mono">127.0.0.1 / localhost</span> 始终直连）
        </label>

        <label class="row" style="cursor: pointer; color: var(--text)">
          <input v-model="f.closeToTray" type="checkbox" style="width: auto" />
          点击窗口关闭按钮（✕）时收进右下角系统托盘，保持后台连接与监控
        </label>

        <div class="grid2">
          <div>
            <label>主机指标刷新间隔（毫秒）</label>
            <input v-model.number="f.metricsIntervalMs" type="number" min="500" step="500" />
          </div>
          <div>
            <label>服务状态刷新间隔（毫秒）</label>
            <input v-model.number="f.servicesIntervalMs" type="number" min="2000" step="1000" />
          </div>
        </div>
      </div>
      <footer>
        <button @click="emit('close')">取消</button>
        <button class="primary" :disabled="saving" @click="save">{{ saving ? '保存中…' : '保存' }}</button>
      </footer>
    </div>
  </div>
</template>
