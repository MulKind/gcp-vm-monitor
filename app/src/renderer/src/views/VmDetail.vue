<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { Service, TopProc } from '@shared/types'
import { state, vmById, goHome, openServiceTab, visibleServices, healthCounts, errMsg, toast } from '../store'
import {
  CATEGORY_LABEL,
  CONN_COLOR,
  CONN_LABEL,
  HEALTH_LABEL,
  fmtBytes,
  fmtDuration,
  fmtPct,
  fmtRate,
  pctColor
} from '../util'
import { osIcon } from '../icons'
import MetricChart from '../components/MetricChart.vue'
import ServiceTile from '../components/ServiceTile.vue'
import ServicePanel from '../components/ServicePanel.vue'
import InstallDialog from '../components/InstallDialog.vue'
import VmDialog from '../components/VmDialog.vue'

const props = defineProps<{ vmId: string }>()

const vm = computed(() => vmById(props.vmId))
const st = computed(() => state.statuses[props.vmId])
const info = computed(() => state.infos[props.vmId])
const m = computed(() => state.metrics[props.vmId])
const hist = computed(() => state.history[props.vmId] || [])
const online = computed(() => st.value?.state === 'connected')
const osI = computed(() => osIcon(info.value?.os))

const search = ref('')
const catFilter = ref('all')
const healthFilter = ref('all')
const showHidden = ref(false)
const activeSvcId = ref<string | null>(null)
const installing = ref(false)
const editing = ref(false)
const showTop = ref(false)
const topProcs = ref<TopProc[]>([])
const loadingTop = ref(false)

watch(
  () => props.vmId,
  () => {
    activeSvcId.value = null
  }
)

const rawServices = computed(() => state.services[props.vmId] || [])
const allVisible = computed(() => (showHidden.value ? rawServices.value : visibleServices(props.vmId)))
const counts = computed(() => healthCounts(props.vmId))

const categories = computed(() => {
  const s = new Set<string>()
  for (const x of allVisible.value) s.add(x.category)
  return ['all', ...s]
})

const filteredServices = computed(() => {
  const q = search.value.trim().toLowerCase()
  return allVisible.value.filter((s) => {
    if (catFilter.value !== 'all' && s.category !== catFilter.value) return false
    if (healthFilter.value !== 'all' && s.health !== healthFilter.value) return false
    if (q) {
      const ports = s.ports.map((p) => String(p.host_port || p.port)).join(' ')
      const hit =
        s.display_name.toLowerCase().includes(q) ||
        s.name.toLowerCase().includes(q) ||
        s.kind.toLowerCase().includes(q) ||
        ports.includes(q)
      if (!hit) return false
    }
    return true
  })
})

const hiddenCount = computed(() => rawServices.value.length - visibleServices(props.vmId).length)

async function reconnect(): Promise<void> {
  try {
    await window.api.reconnect(props.vmId)
    toast('正在重新连接…', 'info')
  } catch (e) {
    toast(errMsg(e), 'error')
  }
}

async function openTop(): Promise<void> {
  showTop.value = true
  loadingTop.value = true
  try {
    topProcs.value = await window.api.top(props.vmId)
  } catch (e) {
    toast('获取进程列表失败: ' + errMsg(e), 'error')
  } finally {
    loadingTop.value = false
  }
}

function handleOpen(s: Service): void {
  void openServiceTab(props.vmId, s)
}
</script>

<template>
  <div v-if="vm" class="detail">
    <!-- Top header & breadcrumb -->
    <header class="bar-top">
      <button class="ghost" @click="goHome">← 返回总览</button>
      <span class="os" :style="{ color: osI.color }">
        <svg viewBox="0 0 24 24" width="18" height="18"><path :d="osI.path" fill="currentColor" /></svg>
      </span>
      <div class="title">
        <h2>
          {{ vm.name }}
          <span v-if="vm.kind === 'demo'" class="badge demo">演示</span>
        </h2>
        <div class="sub mono">
          {{ vm.kind === 'demo' ? 'demo-host' : `${vm.username}@${vm.host}:${vm.port}` }}
          <template v-if="info"> · {{ info.os }} · {{ info.cpu_model }} ({{ info.cpu_count }} 核)</template>
        </div>
      </div>
      <span class="badge" :style="{ color: CONN_COLOR[st?.state || 'disconnected'] }">
        <i class="dot" :class="{ pulse: online }" :style="{ background: CONN_COLOR[st?.state || 'disconnected'] }" />
        {{ CONN_LABEL[st?.state || 'disconnected'] }}
      </span>
      <div class="grow" />
      <button v-if="online" @click="openTop">进程 Top</button>
      <button v-if="vm.kind === 'ssh'" @click="installing = true">
        {{ st?.state === 'no-agent' ? '⚡ 一键安装 Agent' : '重装 Agent' }}
      </button>
      <button @click="reconnect">⟳ 重连</button>
      <button @click="editing = true">✎ 编辑</button>
    </header>

    <!-- No-agent / error banner -->
    <div v-if="st?.state === 'no-agent'" class="banner warn card">
      <div>
        <b>该虚拟机尚未运行 VMMon Agent</b>
        <p class="muted">
          SSH 已连接成功！点击右侧「一键安装 Agent」，软件会自动上传单文件 Python Agent（仅使用标准库，只监听
          <span class="mono">127.0.0.1:9527</span>）并启动 systemd 服务。
        </p>
      </div>
      <button class="primary" @click="installing = true">⚡ 一键安装 Agent</button>
    </div>

    <div v-else-if="st?.state === 'error'" class="banner err card">
      <div>
        <b>连接异常</b>
        <p class="muted">{{ st.message }}</p>
      </div>
      <button @click="reconnect">⟳ 立即重试</button>
    </div>

    <div class="workspace">
      <div class="main-col">
        <!-- Real-time host metrics -->
        <section v-if="m" class="metrics-sec">
          <div class="kpi-strip">
            <div class="kpi card">
              <div class="kl"><span>CPU</span><b :style="{ color: pctColor(m.cpu.percent) }">{{ fmtPct(m.cpu.percent) }}</b></div>
              <div class="bar"><i :style="{ width: m.cpu.percent + '%', background: pctColor(m.cpu.percent) }" /></div>
              <div class="ks muted">
                负载 {{ m.load.map((x) => x.toFixed(2)).join(' / ') }} · IO等待 {{ fmtPct(m.cpu.iowait) }}
              </div>
            </div>
            <div class="kpi card">
              <div class="kl"><span>内存</span><b :style="{ color: pctColor(m.mem.percent) }">{{ fmtPct(m.mem.percent) }}</b></div>
              <div class="bar"><i :style="{ width: m.mem.percent + '%', background: pctColor(m.mem.percent) }" /></div>
              <div class="ks muted">
                {{ fmtBytes(m.mem.used) }} / {{ fmtBytes(m.mem.total) }}
                <template v-if="m.mem.swap_total"> · Swap {{ fmtBytes(m.mem.swap_used) }}</template>
              </div>
            </div>
            <div class="kpi card">
              <div class="kl"><span>网络吞吐</span><b style="color: var(--cyan)">↓ {{ fmtRate(m.net.rx_bps) }}</b></div>
              <div class="ks muted" style="margin-top: 6px">
                ↑ {{ fmtRate(m.net.tx_bps) }} · 累计 ↓{{ fmtBytes(m.net.rx_total) }} / ↑{{ fmtBytes(m.net.tx_total) }}
              </div>
              <div class="ks muted">
                TCP 连接 {{ m.tcp.established }} · 监听 {{ m.tcp.listen }} · 进程 {{ m.procs }}
              </div>
            </div>
            <div class="kpi card">
              <div class="kl">
                <span>磁盘 ({{ m.disks[0]?.mount || '/' }})</span>
                <b :style="{ color: pctColor(m.disks[0]?.percent) }">{{ fmtPct(m.disks[0]?.percent) }}</b>
              </div>
              <div class="bar"><i :style="{ width: (m.disks[0]?.percent || 0) + '%', background: pctColor(m.disks[0]?.percent) }" /></div>
              <div class="ks muted">
                {{ fmtBytes(m.disks[0]?.used) }} / {{ fmtBytes(m.disks[0]?.total) }} · 读 {{ fmtRate(m.disk_io.read_bps) }} 写 {{ fmtRate(m.disk_io.write_bps) }}
              </div>
            </div>
          </div>

          <div class="charts-grid">
            <div class="chart-box card">
              <div class="ct">CPU & 内存使用率 (实时)</div>
              <div class="cb">
                <MetricChart
                  :samples="hist"
                  unit="pct"
                  :max="100"
                  :series="[
                    { key: 'cpu', name: 'CPU %', color: '#3b82f6' },
                    { key: 'mem', name: '内存 %', color: '#a855f7' }
                  ]"
                />
              </div>
            </div>
            <div class="chart-box card">
              <div class="ct">网络上下行速率</div>
              <div class="cb">
                <MetricChart
                  :samples="hist"
                  unit="rate"
                  :series="[
                    { key: 'rx', name: '下行 RX', color: '#22d3ee' },
                    { key: 'tx', name: '上行 TX', color: '#3b82f6' }
                  ]"
                />
              </div>
            </div>
            <div class="chart-box card">
              <div class="ct">磁盘读写速率 & 系统负载 ({{ fmtDuration(m.uptime) }})</div>
              <div class="cb">
                <MetricChart
                  :samples="hist"
                  unit="rate"
                  :series="[
                    { key: 'dr', name: '磁盘读', color: '#22c55e' },
                    { key: 'dw', name: '磁盘写', color: '#f59e0b' }
                  ]"
                />
              </div>
            </div>
          </div>

          <!-- Extra mount points if > 1 -->
          <div v-if="m.disks.length > 1" class="disks-row">
            <div v-for="d in m.disks" :key="d.mount" class="disk-pill card">
              <span class="mono">{{ d.mount }}</span>
              <span class="dim">({{ d.fs }})</span>
              <div class="bar" style="width: 90px"><i :style="{ width: d.percent + '%', background: pctColor(d.percent) }" /></div>
              <b :style="{ color: pctColor(d.percent) }">{{ fmtPct(d.percent) }}</b>
              <span class="muted">{{ fmtBytes(d.used) }} / {{ fmtBytes(d.total) }}</span>
            </div>
          </div>
        </section>

        <!-- Level 2: Service Icon Wall -->
        <section class="services-sec">
          <div class="svc-toolbar">
            <div class="row" style="gap: 12px">
              <h3 style="margin: 0; font-size: 16px">部署的云服务 ({{ filteredServices.length }})</h3>
              <span class="hint muted">点击有 ↗ 标记的服务图标即可在软件内置浏览器中打开后台，点击右上角 ⓘ 查看日志与控制</span>
            </div>
            <div class="row" style="flex-wrap: wrap">
              <div class="seg">
                <button :class="{ on: healthFilter === 'all' }" @click="healthFilter = 'all'">全部</button>
                <button :class="{ on: healthFilter === 'healthy' }" @click="healthFilter = 'healthy'">
                  🟢 正常 ({{ counts.healthy || 0 }})
                </button>
                <button v-if="counts.degraded" :class="{ on: healthFilter === 'degraded' }" @click="healthFilter = 'degraded'">
                  🟡 缓慢 ({{ counts.degraded }})
                </button>
                <button v-if="counts.down" :class="{ on: healthFilter === 'down' }" @click="healthFilter = 'down'">
                  🔴 宕机 ({{ counts.down }})
                </button>
                <button v-if="counts.stopped" :class="{ on: healthFilter === 'stopped' }" @click="healthFilter = 'stopped'">
                  ⚪ 已停止 ({{ counts.stopped }})
                </button>
              </div>
              <select v-model="catFilter" style="width: 130px">
                <option v-for="c in categories" :key="c" :value="c">
                  {{ c === 'all' ? '所有分类' : CATEGORY_LABEL[c] || c }}
                </option>
              </select>
              <input v-model="search" placeholder="筛选服务名称 / 端口…" style="width: 190px" />
              <label v-if="hiddenCount > 0" class="row" style="margin: 0; cursor: pointer; font-size: 12px">
                <input v-model="showHidden" type="checkbox" style="width: auto" /> 显示已隐藏 ({{ hiddenCount }})
              </label>
            </div>
          </div>

          <div v-if="filteredServices.length" class="wall">
            <ServiceTile
              v-for="s in filteredServices"
              :key="s.id"
              :svc="s"
              :selected="activeSvcId === s.id"
              @open="handleOpen(s)"
              @details="activeSvcId = activeSvcId === s.id ? null : s.id"
            />
          </div>
          <div v-else class="empty-svc card muted">
            {{ online ? '没有匹配的服务' : '连接并安装 Agent 后将自动发现 Docker 容器、systemd 服务和监听端口' }}
          </div>
        </section>
      </div>

      <!-- Right drawer for selected service details / logs / actions -->
      <aside v-if="activeSvcId" class="drawer card">
        <ServicePanel :vm-id="vmId" :svc-id="activeSvcId" @close="activeSvcId = null" />
      </aside>
    </div>

    <!-- Top processes modal -->
    <div v-if="showTop" class="modal-mask" @mousedown.self="showTop = false">
      <div class="modal" style="width: 720px">
        <header>
          进程资源占用 Top 15 · {{ vm.name }}
          <span class="grow" />
          <button class="sm" :disabled="loadingTop" @click="openTop">⟳ 刷新</button>
        </header>
        <div class="body">
          <table class="tbl">
            <thead>
              <tr>
                <th>PID</th>
                <th>进程</th>
                <th>用户</th>
                <th>CPU</th>
                <th>内存</th>
                <th>命令行</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="p in topProcs" :key="p.pid">
                <td class="mono">{{ p.pid }}</td>
                <td><b>{{ p.name }}</b></td>
                <td class="muted">{{ p.user }}</td>
                <td :style="{ color: pctColor(p.cpu_percent) }">{{ fmtPct(p.cpu_percent) }}</td>
                <td>{{ fmtBytes(p.mem_bytes) }}</td>
                <td class="mono muted ellipsis" style="max-width: 280px" :title="p.cmdline">{{ p.cmdline }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <footer>
          <button @click="showTop = false">关闭</button>
        </footer>
      </div>
    </div>

    <InstallDialog v-if="installing" :vm-id="vmId" :vm-name="vm.name" @close="installing = false" />
    <VmDialog v-if="editing" :vm="vm" @close="editing = false" />
  </div>
</template>

<style scoped>
.detail { display: flex; flex-direction: column; height: 100%; padding: 14px 20px 20px; gap: 14px; overflow: hidden; }
.bar-top { display: flex; align-items: center; gap: 10px; flex: none; flex-wrap: wrap; }
.os { width: 34px; height: 34px; border-radius: 9px; background: var(--panel); border: 1px solid var(--border); display: flex; align-items: center; justify-content: center; }
.title h2 { margin: 0; font-size: 17px; font-weight: 600; }
.title .sub { font-size: 12px; color: var(--muted); }
.badge.demo { font-size: 10px; padding: 0 6px; color: var(--purple); border-color: #4c2a7a; }
.banner { padding: 14px 18px; display: flex; align-items: center; justify-content: space-between; gap: 16px; flex: none; }
.banner.warn { border-color: #854d0e; background: #1c1608; }
.banner.err { border-color: #7f1d1d; background: #220f14; }
.banner p { margin: 4px 0 0; font-size: 12.5px; }

.workspace { flex: 1; min-height: 0; display: flex; gap: 14px; }
.main-col { flex: 1; min-width: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 16px; padding-right: 4px; }
.drawer { width: 400px; flex: none; height: 100%; overflow: hidden; }

.metrics-sec { display: flex; flex-direction: column; gap: 12px; }
.kpi-strip { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
.kpi { padding: 11px 14px; display: flex; flex-direction: column; gap: 6px; }
.kl { display: flex; justify-content: space-between; align-items: baseline; font-size: 12.5px; color: var(--muted); }
.kl b { font-size: 16px; color: var(--text); }
.ks { font-size: 11.5px; }

.charts-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
.chart-box { padding: 10px 12px; display: flex; flex-direction: column; height: 185px; }
.ct { font-size: 12px; color: var(--muted); font-weight: 600; }
.cb { flex: 1; min-height: 0; }

.disks-row { display: flex; gap: 10px; flex-wrap: wrap; }
.disk-pill { padding: 6px 12px; display: inline-flex; align-items: center; gap: 8px; font-size: 12px; }

.services-sec { display: flex; flex-direction: column; gap: 12px; }
.svc-toolbar { display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap; }
.hint { font-size: 12px; }
.wall { display: grid; grid-template-columns: repeat(auto-fill, minmax(158px, 1fr)); gap: 12px; }
.empty-svc { padding: 36px; text-align: center; }
</style>
