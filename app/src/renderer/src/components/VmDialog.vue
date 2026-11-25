<script setup lang="ts">
import { reactive, ref } from 'vue'
import type { VmConfig } from '@shared/types'
import { errMsg, refreshVms, toast } from '../store'

const props = defineProps<{ vm?: VmConfig }>()
const emit = defineEmits<{ close: []; saved: [vm: VmConfig] }>()

const f = reactive<VmConfig>(
  props.vm
    ? { ...props.vm }
    : { id: '', name: '', kind: 'ssh', host: '', port: 22, username: '', authType: 'key', privateKeyPath: '', agentPort: 9527 }
)
const saving = ref(false)
const pubKey = ref('')
const showAdvanced = ref(false)

async function pick(): Promise<void> {
  const p = await window.api.pickKey()
  if (p) f.privateKeyPath = p
}

async function gen(): Promise<void> {
  if (!f.username) return toast('请先填写用户名（会作为公钥注释，GCP 用它创建登录用户）', 'error')
  const k = await window.api.generateKey(f.username)
  f.privateKeyPath = k.privateKeyPath
  f.authType = 'key'
  pubKey.value = k.publicKey
}

function copyPub(): void {
  void navigator.clipboard.writeText(pubKey.value)
  toast('公钥已复制', 'ok')
}

async function save(): Promise<void> {
  if (f.kind === 'ssh') {
    if (f.host) {
      let h = f.host.trim().replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '')
      const slash = h.indexOf('/')
      if (slash >= 0) h = h.slice(0, slash)
      const at = h.lastIndexOf('@')
      if (at >= 0) {
        if (!f.username) f.username = h.slice(0, at)
        h = h.slice(at + 1)
      }
      const colon = h.match(/^([^:]+):(\d+)$/)
      if (colon) {
        h = colon[1]
        if (!f.port || f.port === 22) f.port = Number(colon[2])
      }
      f.host = h.trim()
    }
    if (!f.host || !f.username) return toast('请填写主机地址和用户名', 'error')
    if (f.authType === 'key' && !f.privateKeyPath) return toast('请选择或生成私钥', 'error')
  }
  if (!f.name) f.name = f.kind === 'demo' ? '演示 VM' : f.host
  saving.value = true
  try {
    const vm = await window.api.saveVm(JSON.parse(JSON.stringify(f)))
    await refreshVms()
    emit('saved', vm)
    emit('close')
  } catch (e) {
    toast('保存失败: ' + errMsg(e), 'error')
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="modal-mask" @mousedown.self="emit('close')">
    <div class="modal">
      <header>{{ vm ? '编辑虚拟机' : '添加虚拟机' }}</header>
      <div class="body">
        <div class="grid2">
          <div>
            <label>显示名称</label>
            <input v-model="f.name" placeholder="如：GCP-东京-1" />
          </div>
          <div>
            <label>类型</label>
            <div class="seg">
              <button :class="{ on: f.kind === 'ssh' }" @click="f.kind = 'ssh'">SSH 连接</button>
              <button :class="{ on: f.kind === 'demo' }" @click="f.kind = 'demo'">演示数据</button>
            </div>
          </div>
        </div>

        <template v-if="f.kind === 'ssh'">
          <div class="grid2" style="grid-template-columns: 3fr 1fr">
            <div>
              <label>外网 IP / 主机名</label>
              <input v-model.trim="f.host" placeholder="34.84.x.x" class="mono" />
            </div>
            <div>
              <label>SSH 端口</label>
              <input v-model.number="f.port" type="number" />
            </div>
          </div>
          <div class="grid2">
            <div>
              <label>用户名</label>
              <input v-model.trim="f.username" placeholder="GCP 上的登录用户名" class="mono" />
            </div>
            <div>
              <label>认证方式</label>
              <div class="seg">
                <button :class="{ on: f.authType === 'key' }" @click="f.authType = 'key'">私钥</button>
                <button :class="{ on: f.authType === 'password' }" @click="f.authType = 'password'">密码</button>
                <button :class="{ on: f.authType === 'agent' }" @click="f.authType = 'agent'">ssh-agent</button>
              </div>
            </div>
          </div>

          <template v-if="f.authType === 'key'">
            <div>
              <label>私钥文件</label>
              <div class="row">
                <input v-model="f.privateKeyPath" class="mono grow" placeholder="C:\Users\...\.ssh\id_ed25519" />
                <button @click="pick">浏览…</button>
                <button title="生成新的 ed25519 密钥对" @click="gen">生成密钥</button>
              </div>
            </div>
            <div>
              <label>私钥密码（可选）</label>
              <input
                v-model="f.passphrase"
                type="password"
                :placeholder="f.hasPassphrase ? '已加密保存（留空保持不变）' : ''"
              />
            </div>
            <div v-if="pubKey" class="pub">
              <div class="row" style="margin-bottom: 6px">
                <b class="grow">请把下面的公钥添加到 GCP</b><button class="sm" @click="copyPub">复制</button>
              </div>
              <div class="mono key">{{ pubKey }}</div>
              <ol class="muted">
                <li>GCP 控制台 → Compute Engine → 元数据 → SSH 密钥 → 添加项（对整个项目生效）</li>
                <li>或者在 VM 详情 → 修改 → SSH 密钥 中添加（只对这台 VM 生效）</li>
                <li>保存后等待约 30 秒，GCP 会自动创建用户 <b class="mono">{{ f.username }}</b> 并授予免密 sudo</li>
              </ol>
            </div>
          </template>
          <div v-else-if="f.authType === 'password'">
            <label>密码</label>
            <input
              v-model="f.password"
              type="password"
              :placeholder="f.hasPassword ? '已加密保存（留空保持不变）' : ''"
            />
            <div class="dim" style="font-size: 12px; margin-top: 4px">GCP 默认禁用密码登录，推荐使用密钥</div>
          </div>
          <div v-else class="dim" style="font-size: 12px">使用 Windows OpenSSH Authentication Agent 中已加载的密钥</div>

          <a class="adv" @click="showAdvanced = !showAdvanced">{{ showAdvanced ? '▾' : '▸' }} 高级选项</a>
          <div v-if="showAdvanced" class="grid2">
            <div>
              <label>Agent 端口（VM 本机）</label>
              <input v-model.number="f.agentPort" type="number" />
            </div>
            <div>
              <label>Agent Token（自动获取，可留空）</label>
              <input
                v-model="f.agentToken"
                class="mono"
                type="password"
                :placeholder="f.hasAgentToken ? '已加密保存（留空保持不变）' : ''"
              />
            </div>
            <div style="grid-column: 1 / -1">
              <label>已固定的 SSH 主机指纹 (TOFU 防中间人校验)</label>
              <div class="row">
                <input
                  :value="f.hostFingerprint || '（首次连接时自动绑定服务器 SHA-256 指纹）'"
                  readonly
                  class="mono grow muted"
                />
                <button v-if="f.hostFingerprint" class="sm danger" @click="f.hostFingerprint = ''">重置指纹</button>
              </div>
            </div>
            <div>
              <label>GCP 项目（可选）</label>
              <input v-model="f.gcpProject" />
            </div>
            <div>
              <label>区域（可选）</label>
              <input v-model="f.gcpZone" placeholder="asia-northeast1-b" />
            </div>
          </div>
        </template>
        <div v-else class="muted" style="font-size: 13px">演示模式会生成模拟的主机指标和服务，用来体验界面和交互，不会连接任何服务器。</div>
      </div>
      <footer>
        <button @click="emit('close')">取消</button>
        <button class="primary" :disabled="saving" @click="save">{{ saving ? '保存中…' : '保存并连接' }}</button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.pub { background: #0b1222; border: 1px solid #1e3a5f; border-radius: 10px; padding: 12px; font-size: 13px; }
.key { word-break: break-all; font-size: 11.5px; background: #060b16; padding: 8px; border-radius: 6px; color: #7dd3fc; user-select: all; }
ol { margin: 8px 0 0; padding-left: 18px; font-size: 12px; line-height: 1.7; }
.adv { color: var(--blue); cursor: pointer; font-size: 13px; user-select: none; }
</style>
