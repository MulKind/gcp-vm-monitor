<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch, nextTick } from 'vue'
import type { ServiceOverride } from '@shared/types'
import { state, vmById, openServiceTab, errMsg, toast } from '../store'
import ServiceIcon from './ServiceIcon.vue'
import { CATEGORY_LABEL, HEALTH_COLOR, HEALTH_LABEL, SOURCE_LABEL, fmtBytes, fmtDuration, fmtPct } from '../util'

const props = withDefaults(defineProps<{ vmId: string; svcId: string; compact?: boolean; hideOpen?: boolean }>(), { compact: false, hideOpen: false })
const emit = defineEmits<{ close: [] }>()

const svc = computed(() => (state.services[props.vmId] || []).find((s) => s.id === props.svcId))
const vm = computed(() => vmById(props.vmId))
const tab = ref<'info' | 'logs' | 'settings'>('info')
const busy = ref('')
const logs = ref<string[]>([])
const logBox = ref<HTMLDivElement>()
const autoLogs = ref(false)
let logTimer: ReturnType<typeof setInterval> | null = null

const ov = reactive<ServiceOverride>({})
function resetOv(): void {
  const o = vm.value?.serviceOverrides?.[props.svcId] || {}
  Object.keys(ov).forEach((k) => delete (ov as Record<string, unknown>)[k])
  Object.assign(ov, { openMode: 'tunnel', ...o })
}
resetOv()
watch(() => props.svcId, () => {
  resetOv()
  logs.value = []
  if (tab.value === 'logs') void loadLogs()
})

async function act(a: 'start' | 'stop' | 'restart'): Promise<void> {
  const label = { start: '启动', stop: '停止', restart: '重启' }[a]
  if (a !== 'start' && !confirm(`确定要${label}「${svc.value?.display_name}」吗？`)) return
  busy.value = a
  try {
    const r = await window.api.action(props.vmId, props.svcId, a)
    toast(r.ok ? `${label}成功` : `${label}失败: ${r.output}`, r.ok ? 'ok' : 'error')
  } catch (e) {
    toast(`${label}失败: ${errMsg(e)}`, 'error')
  } finally {
    busy.value = ''
  }
}

async function loadLogs(): Promise<void> {
  try {
    logs.value = await window.api.logs(props.vmId, props.svcId, 300)
    await nextTick()
    if (logBox.value) logBox.value.scrollTop = logBox.value.scrollHeight
  } catch (e) {
    logs.value = ['加载日志失败: ' + errMsg(e)]
  }
}

watch(tab, (t) => {
  if (t === 'logs') void loadLogs()
})
watch(autoLogs, (on) => {
  if (logTimer) clearInterval(logTimer)
  logTimer = on ? setInterval(() => void loadLogs(), 3000) : null
})
onBeforeUnmount(() => logTimer && clearInterval(logTimer))

async function saveOv(): Promise<void> {
  const clean: ServiceOverride = {}
  for (const [k, v] of Object.entries(ov)) if (v !== '' && v != null) (clean as Record<string, unknown>)[k] = v
  try {
    await window.api.setOverride(props.vmId, props.svcId, clean)
    toast('已保存', 'ok')
  } catch (e) {
    toast(errMsg(e), 'error')
  }
}

async function resetOverride(): Promise<void> {
  await window.api.setOverride(props.vmId, props.svcId, null)
  Object.keys(ov).forEach((k) => delete (ov as Record<string, unknown>)[k])
  ov.openMode = 'tunnel'
  toast('已恢复默认', 'ok')
}

const canControl = computed(() => svc.value && (svc.value.source === 'docker' || svc.value.source === 'systemd'))
</script>

<template>
  <div class="panel" :class="{ compact }">
    <template v-if="svc">
      <div class="ph">
        <ServiceIcon :kind="svc.kind" :category="svc.category" :name="svc.display_name" :size="40" />
        <div class="grow">
          <div class="t ellipsis">{{ svc.display_name }}</div>
          <div class="row" style="gap: 6px; margin-top: 3px">
            <span class="badge" :style="{ color: HEALTH_COLOR[svc.health] }"><i class="dot" :style="{ background: HEALTH_COLOR[svc.health] }" />{{ HEALTH_LABEL[svc.health] }}</span>
            <span class="badge">{{ SOURCE_LABEL[svc.source] }}</span>
            <span class="badge">{{ CATEGORY_LABEL[svc.category] || svc.category }}</span>
          </div>
        </div>
        <button v-if="!compact" class="ghost icon" @click="emit('close')">✕</button>
      </div>

      <div class="actions">
        <button v-if="svc.web && !hideOpen" class="primary sm" @click="openServiceTab(vmId, svc)">↗ 打开后台</button>
        <template v-if="canControl">
          <button class="sm" :disabled="!!busy || svc.status === 'running'" @click="act('start')">▶ 启动</button>
          <button class="sm" :disabled="!!busy" @click="act('restart')"><span :class="{ spin: busy === 'restart' }">⟳</span> 重启</button>
          <button class="sm danger" :disabled="!!busy || svc.status === 'stopped'" @click="act('stop')">■ 停止</button>
        </template>
      </div>

      <div class="seg tabs">
        <button :class="{ on: tab === 'info' }" @click="tab = 'info'">详情</button>
        <button :class="{ on: tab === 'logs' }" @click="tab = 'logs'">日志</button>
        <button :class="{ on: tab === 'settings' }" @click="tab = 'settings'">设置</button>
      </div>

      <div v-if="tab === 'info'" class="kv">
        <div><span>状态</span><b>{{ svc.status }}</b></div>
        <div><span>名称</span><b class="mono">{{ svc.name }}</b></div>
        <div><span>类型</span><b>{{ svc.kind }}</b></div>
        <div v-if="svc.uptime != null"><span>运行时长</span><b>{{ fmtDuration(svc.uptime) }}</b></div>
        <div v-if="svc.web"><span>后台地址</span><b class="mono">{{ svc.web.scheme }}://127.0.0.1:{{ svc.web.port }}{{ svc.web.path }}</b></div>
        <div v-if="svc.ports.length"><span>端口</span><b class="mono">{{ svc.ports.map((p) => `${p.bind}:${p.host_port || p.port}/${p.proto}`).join('  ') }}</b></div>
        <div v-if="svc.check">
          <span>健康检查</span>
          <b :style="{ color: svc.check.ok ? 'var(--green)' : 'var(--red)' }">
            {{ svc.check.ok ? '通过' : '失败' }}<template v-if="svc.check.code"> · HTTP {{ svc.check.code }}</template><template v-if="svc.check.latency_ms != null"> · {{ svc.check.latency_ms.toFixed(0) }} ms</template>
            <template v-if="svc.check.error"> · {{ svc.check.error }}</template>
          </b>
        </div>
        <template v-if="svc.container">
          <div><span>镜像</span><b class="mono">{{ svc.container.image }}</b></div>
          <div><span>容器 ID</span><b class="mono">{{ svc.container.id.slice(0, 12) }}</b></div>
          <div v-if="svc.container.compose_project"><span>Compose</span><b>{{ svc.container.compose_project }}</b></div>
          <div><span>容器状态</span><b>{{ svc.container.state }}<template v-if="svc.container.health"> ({{ svc.container.health }})</template></b></div>
          <div><span>重启次数</span><b :style="{ color: svc.container.restarts > 3 ? 'var(--red)' : '' }">{{ svc.container.restarts }}</b></div>
          <div v-if="svc.container.cpu_percent != null"><span>CPU / 内存</span><b>{{ fmtPct(svc.container.cpu_percent) }} · {{ fmtBytes(svc.container.mem_bytes) }}<template v-if="svc.container.mem_limit"> / {{ fmtBytes(svc.container.mem_limit) }}</template></b></div>
        </template>
        <template v-if="svc.systemd">
          <div><span>Unit</span><b class="mono">{{ svc.systemd.unit }}</b></div>
          <div><span>systemd</span><b>{{ svc.systemd.active }} / {{ svc.systemd.sub }}</b></div>
        </template>
        <template v-if="svc.process">
          <div><span>PID</span><b class="mono">{{ svc.process.pid }}</b></div>
          <div v-if="svc.process.cpu_percent != null"><span>CPU / 内存</span><b>{{ fmtPct(svc.process.cpu_percent) }} · {{ fmtBytes(svc.process.mem_bytes) }}</b></div>
          <div><span>命令</span><b class="mono cmd">{{ svc.process.cmdline }}</b></div>
        </template>
      </div>

      <div v-else-if="tab === 'logs'" class="logs-wrap">
        <div class="row" style="margin-bottom: 6px">
          <button class="sm" @click="loadLogs">⟳ 刷新</button>
          <label class="row" style="margin: 0; cursor: pointer"><input v-model="autoLogs" type="checkbox" style="width: auto" /> 自动刷新</label>
          <span class="grow" />
          <span class="dim" style="font-size: 12px">{{ logs.length }} 行</span>
        </div>
        <div ref="logBox" class="logs mono">
          <div v-for="(l, i) in logs" :key="i" :class="{ err: /error|fatal|panic/i.test(l), warn: /warn/i.test(l) }">{{ l }}</div>
          <div v-if="!logs.length" class="dim">暂无日志（进程类服务不支持读取日志）</div>
        </div>
      </div>

      <div v-else class="settings">
        <div>
          <label>显示名称</label>
          <input v-model="ov.displayName" :placeholder="svc.display_name" />
        </div>
        <div>
          <label>后台打开方式</label>
          <div class="seg">
            <button :class="{ on: ov.openMode !== 'url' }" @click="ov.openMode = 'tunnel'">SSH 隧道</button>
            <button :class="{ on: ov.openMode === 'url' }" @click="ov.openMode = 'url'">外部 URL / 域名</button>
          </div>
        </div>
        <template v-if="ov.openMode !== 'url'">
          <div class="grid3">
            <div>
              <label>协议</label>
              <select v-model="ov.scheme"><option :value="undefined">自动 ({{ svc.web?.scheme || 'http' }})</option><option value="http">http</option><option value="https">https</option></select>
            </div>
            <div>
              <label>VM 端口</label>
              <input v-model.number="ov.port" type="number" :placeholder="String(svc.web?.port || svc.ports[0]?.host_port || svc.ports[0]?.port || '')" />
            </div>
            <div>
              <label>路径</label>
              <input v-model="ov.path" :placeholder="svc.web?.path || '/'" class="mono" />
            </div>
          </div>
          <div class="dim hint">例如宝塔面板的安全入口：路径填 <span class="mono">/xxxxxxxx</span></div>
        </template>
        <div v-else>
          <label>外部 URL</label>
          <input v-model="ov.externalUrl" placeholder="https://panel.example.com" class="mono" />
          <div class="dim hint">内置浏览器访问外部地址时会走代理（可在设置中关闭）</div>
        </div>
        <label class="row" style="cursor: pointer; color: var(--text)"><input v-model="ov.hidden" type="checkbox" style="width: auto" /> 隐藏此服务</label>
        <div class="row">
          <button class="primary sm" @click="saveOv">保存</button>
          <button class="sm" @click="resetOverride">恢复默认</button>
        </div>
      </div>
    </template>
    <div v-else class="dim" style="padding: 20px">服务已不存在（可能已被删除）</div>
  </div>
</template>

<style scoped>
.panel { display: flex; flex-direction: column; gap: 12px; padding: 16px; height: 100%; min-height: 0; }
.ph { display: flex; gap: 12px; align-items: center; }
.t { font-weight: 600; font-size: 16px; }
.actions { display: flex; gap: 6px; flex-wrap: wrap; }
.tabs { align-self: flex-start; }
.kv { display: grid; gap: 0; font-size: 12.5px; overflow: auto; }
.kv > div { display: grid; grid-template-columns: 84px 1fr; gap: 10px; padding: 7px 0; border-bottom: 1px solid #172238; }
.kv span { color: var(--muted); }
.kv b { font-weight: 500; word-break: break-all; }
.cmd { font-size: 11.5px; color: #93c5fd; }
.logs-wrap { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.logs { flex: 1; min-height: 200px; overflow: auto; background: #060b16; border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; font-size: 11.5px; line-height: 1.55; white-space: pre-wrap; word-break: break-all; }
.logs .err { color: #fca5a5; }
.logs .warn { color: #fcd34d; }
.settings { display: grid; gap: 12px; }
.grid3 { display: grid; grid-template-columns: 1.2fr 1fr 1.4fr; gap: 8px; }
.hint { font-size: 12px; margin-top: 4px; }
</style>
