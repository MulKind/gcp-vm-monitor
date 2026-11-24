<script setup lang="ts">
import { reactive, ref } from 'vue'
import type { CreditGrant, GcpBillingConfig } from '@shared/types'
import { state, errMsg, toast } from '../store'

const emit = defineEmits<{ close: [] }>()

function cloneDefault(): GcpBillingConfig {
  const base: GcpBillingConfig = state.billingConfig
    ? JSON.parse(JSON.stringify(state.billingConfig))
    : {
        mode: 'bigquery',
        projectId: '',
        datasetId: 'billing_export',
        currency: 'USD',
        creditGrants: [{ id: 'trial-1', name: 'GCP Free Trial 试用赠金', totalAmount: 300 }],
        autoRefreshMinutes: 30
      }
  if (base.mode === 'unconfigured') base.mode = 'bigquery'
  if (!base.creditGrants?.length) {
    base.creditGrants = [{ id: 'trial-1', name: 'GCP Free Trial 试用赠金', totalAmount: 300 }]
  }
  return base
}

const f = reactive<GcpBillingConfig>(cloneDefault())
const saving = ref(false)
const showGuide = ref(false)
const showPasteJson = ref(false)

async function pickJsonFile(): Promise<void> {
  const picked = await window.api.pickJson()
  if (!picked) return
  applyJsonText(picked.content)
}

function applyJsonText(raw: string): void {
  try {
    const j = JSON.parse(raw) as { client_email?: string; project_id?: string; private_key?: string }
    if (!j.client_email || !j.private_key) {
      toast('该 JSON 不包含服务账号 client_email / private_key', 'error')
      return
    }
    f.serviceAccountJson = raw
    f.serviceAccountEmail = j.client_email
    if (!f.projectId && j.project_id) f.projectId = j.project_id
    toast(`已加载服务账号: ${j.client_email}`, 'ok')
  } catch {
    toast('JSON 解析失败，请检查文件内容', 'error')
  }
}

function addGrant(): void {
  const g: CreditGrant = {
    id: 'g-' + Date.now().toString(36),
    name: '活动赠金',
    totalAmount: 100
  }
  f.creditGrants.push(g)
}

function removeGrant(idx: number): void {
  f.creditGrants.splice(idx, 1)
}

async function save(): Promise<void> {
  if (f.mode === 'bigquery') {
    if (!f.serviceAccountJson) return toast('请先选择或粘贴 GCP 服务账号密钥 JSON', 'error')
    if (!f.projectId.trim()) return toast('请填写 BigQuery 所在的 Project ID', 'error')
    if (!f.datasetId.trim()) return toast('请填写 BigQuery 账单导出的 Dataset 名称', 'error')
  }
  saving.value = true
  try {
    const res = await window.api.saveBilling(JSON.parse(JSON.stringify(f)))
    state.billingConfig = res.config
    state.billingSummary = res.summary
    toast(f.mode === 'unconfigured' ? '已关闭账单自动获取' : '账单数据已更新', 'ok')
    emit('close')
  } catch (e) {
    toast('验证或拉取失败: ' + errMsg(e), 'error')
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="modal-mask" @mousedown.self="emit('close')">
    <div class="modal" style="width: 680px">
      <header>
        GCP 账单与赠金配置
        <span class="grow" />
        <button class="ghost sm" @click="showGuide = !showGuide">
          {{ showGuide ? '收起配置教程' : '📖 如何开启 GCP 账单导出？' }}
        </button>
      </header>

      <div class="body">
        <div v-if="showGuide" class="guide card">
          <b>为什么需要 BigQuery 账单导出？</b>
          <p class="muted">
            Google 官方的 Cloud Billing API 只返回账户开关状态，不返回账单金额与赠金明细；GCP 官方唯一支持程序化实时读取账单、流量细项与赠金抵扣的方式是
            <b>BigQuery 结算导出（免费层级每月含 1 TB 查询额度，本软件每次查询仅几 KB）</b>：
          </p>
          <ol class="muted">
            <li>
              打开 GCP 控制台 → <b>BigQuery</b> → 在你的项目下创建一个数据集，名称填 <code class="mono">billing_export</code>。
            </li>
            <li>
              进入 <b>结算 (Billing) → 结算导出 (Billing export)</b> → 开启 <b>标准使用费导出 (Standard usage cost)</b>，选择刚才的项目和
              <code class="mono">billing_export</code> 数据集。
            </li>
            <li>
              进入 <b>IAM 和管理 → 服务账号</b> → 创建服务账号并下载 JSON 密钥：
              <br />· 在项目 IAM 中授予 <code class="mono">BigQuery Data Viewer</code> 和 <code class="mono">BigQuery Job User</code>；
              <br />·（可选）在「结算 → 账户管理」右侧权限面板将该服务账号添加为 <code class="mono">Billing Account Viewer</code>。
            </li>
          </ol>
        </div>

        <div>
          <label>数据模式</label>
          <div class="seg">
            <button :class="{ on: f.mode === 'bigquery' }" @click="f.mode = 'bigquery'">BigQuery 真实账单</button>
            <button :class="{ on: f.mode === 'demo' }" @click="f.mode = 'demo'">演示数据预览</button>
            <button :class="{ on: f.mode === 'unconfigured' }" @click="f.mode = 'unconfigured'">关闭</button>
          </div>
        </div>

        <template v-if="f.mode === 'bigquery'">
          <div>
            <label>GCP 服务账号密钥 (Service Account JSON，使用系统加密存储)</label>
            <div class="row">
              <div class="sa-status grow mono ellipsis">
                <template v-if="f.serviceAccountEmail">
                  <span style="color: var(--green)">✓</span> {{ f.serviceAccountEmail }}
                </template>
                <span v-else class="muted">尚未加载服务账号 JSON 密钥</span>
              </div>
              <button @click="pickJsonFile">选择 JSON 文件…</button>
              <button class="ghost sm" @click="showPasteJson = !showPasteJson">
                {{ showPasteJson ? '收起粘贴' : '粘贴文本' }}
              </button>
            </div>
            <textarea
              v-if="showPasteJson"
              rows="4"
              class="mono"
              style="margin-top: 8px; font-size: 11.5px"
              placeholder='粘贴完整的 {"type": "service_account", ...} JSON 内容'
              :value="f.serviceAccountJson || ''"
              @change="applyJsonText(($event.target as HTMLTextAreaElement).value)"
            />
          </div>

          <div class="grid2">
            <div>
              <label>BigQuery 所在 Project ID</label>
              <input v-model.trim="f.projectId" class="mono" placeholder="my-gcp-project-123" />
            </div>
            <div>
              <label>BigQuery Dataset 名称</label>
              <input v-model.trim="f.datasetId" class="mono" placeholder="billing_export" />
            </div>
          </div>

          <div class="grid2">
            <div>
              <label>账单表名（可选，留空自动识别）</label>
              <input v-model.trim="f.tableId" class="mono" placeholder="gcp_billing_export_v1_XXXXXX" />
            </div>
            <div>
              <label>后台自动刷新间隔（分钟）</label>
              <input v-model.number="f.autoRefreshMinutes" type="number" min="0" step="5" />
            </div>
          </div>
        </template>

        <template v-if="f.mode !== 'unconfigured'">
          <div class="grants-box">
            <div class="row" style="margin-bottom: 8px">
              <div class="grow">
                <b style="font-size: 13px">赠金池 / 账户额度配置（用于计算剩余赠金余额）</b>
                <div class="dim" style="font-size: 11.5px">
                  软件会自动从 BigQuery 累加所有已抵扣的 <span class="mono">PROMOTION</span> 赠金并从总额中扣减。若你是中途开启导出，可填「校准日当天剩余额度 + 校准日期」。
                </div>
              </div>
              <select v-model="f.currency" style="width: 90px" title="默认币种（查询真实账单后会自动同步账户币种）">
                <option value="USD">USD ($)</option>
                <option value="HKD">HKD</option>
                <option value="TWD">TWD</option>
                <option value="CNY">CNY (¥)</option>
                <option value="EUR">EUR (€)</option>
                <option value="JPY">JPY (¥)</option>
              </select>
              <button class="sm" @click="addGrant">＋ 添加赠金</button>
            </div>

            <div v-for="(g, i) in f.creditGrants" :key="g.id" class="grant-row card">
              <div>
                <label>赠金名称</label>
                <input v-model="g.name" placeholder="Free Trial 试用赠金" />
              </div>
              <div>
                <label>初始总额（或校准余额）</label>
                <input v-model.number="g.totalAmount" type="number" step="0.01" />
              </div>
              <div>
                <label>到期日（可选）</label>
                <input v-model="g.expiresAt" type="date" />
              </div>
              <div>
                <label>校准起始日（可选）</label>
                <input v-model="g.baselineDate" type="date" title="只扣减该日期及之后新产生的赠金消耗" />
              </div>
              <button class="ghost icon danger" style="margin-top: 18px" title="删除此项" @click="removeGrant(i)">🗑</button>
            </div>
          </div>
        </template>
      </div>

      <footer>
        <button @click="emit('close')">取消</button>
        <button class="primary" :disabled="saving" @click="save">
          {{ saving ? '正在连接 GCP 查询…' : '保存并同步账单' }}
        </button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.guide { padding: 12px 14px; background: #0b1324; border-color: #1e3a5f; font-size: 12.5px; line-height: 1.65; }
.guide p { margin: 4px 0 8px; }
.guide ol { margin: 0; padding-left: 18px; }
.guide code { background: #060b16; padding: 1px 6px; border-radius: 4px; color: #7dd3fc; }
.sa-status { background: var(--bg2); border: 1px solid var(--border2); border-radius: 8px; padding: 7px 10px; font-size: 12.5px; }
.grants-box { border-top: 1px solid var(--border); padding-top: 12px; display: grid; gap: 8px; }
.grant-row { padding: 10px 12px; background: #0c1426; display: grid; grid-template-columns: 1.5fr 1.1fr 1.1fr 1.1fr auto; gap: 8px; align-items: center; }
</style>
