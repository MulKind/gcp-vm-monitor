# VMMon · GCP 虚拟机与云服务实时监控桌面软件

基于 **Electron + Vue 3 + ECharts + ssh2** 的三层下钻式 GCP 虚拟机与服务监控桌面软件，配合部署在 VM 上的零依赖单文件 **Python Agent (`vmmon_agent.py`)**：

- **第 1 层：虚拟机总览**：每台 VM 的实时 CPU 曲线、内存/磁盘进度条、上下行网速、系统负载，以及该 VM 上云服务的图标与健康汇总（🟢 正常 / 🟡 缓慢 / 🔴 宕机 / ⚪ 已停止）。
- **第 2 层：虚拟机详情 + 服务图标墙**：点击任意 VM 进入，上方展示 CPU/内存、网络上下行、磁盘 IO 的秒级 ECharts 实时曲线；下方展示自动发现的 **Docker 容器、systemd 服务、监听端口进程** 图标墙（内置 60+ 常见服务指纹识别与品牌图标：Nginx、宝塔面板、1Panel、Portainer、Grafana、MySQL、Redis、3X-UI、Alist、Uptime Kuma、n8n 等），右侧抽屉可查看服务详情、实时日志，以及一键启动/重启/停止容器或 systemd 服务。
- **第 3 层：内置多标签浏览器直达云服务后台**：点击任意带有 Web 后台的服务图标，软件会自动通过 SSH 建立 `本地端口 -> VM 127.0.0.1:服务端口` 隧道，并在顶部新建标签页、用内置 Chromium 浏览器打开该服务后台：
  - **无需在 GCP 防火墙对外开放后台端口**（只监听 `127.0.0.1` 的后台也能直接打开）。
  - **无 iframe 限制**：绕过 `X-Frame-Options` / CSP 限制，每个服务拥有独立的持久化 Cookie Session（`persist:svc-...`），登录状态长期保留，且自动信任本地隧道转发的自签名 HTTPS 证书（如 Portainer 9443、宝塔/1Panel SSL）。
- **原生支持 V2RayN 代理**：默认通过 `http://127.0.0.1:10808`（可在设置中切换 HTTP / SOCKS5 / 直连）建立到 GCP VM 的 SSH 连接；本地 SSH 隧道流量（`127.0.0.1` / `localhost`）始终直连不走代理。

---

## 目录结构

```text
gcp-vm-monitor/
├── app/                     # Electron + Vue 3 + TypeScript 桌面客户端
│   ├── src/main/            # 主进程：SSH/代理连接、端口转发隧道、Agent 轮询、一键安装、配置加密存储
│   ├── src/preload/         # Preload IPC 桥接
│   ├── src/renderer/        # Vue 3 + ECharts 前端界面（三层视图 + 多标签 Webview 浏览器）
│   └── src/shared/          # 共享类型定义
├── agent/                   # 部署在 GCP Linux VM 上的轻量级监控与服务发现 Agent
│   ├── vmmon_agent.py       # 单文件 Python 3.7+ 标准库实现（零第三方依赖）
│   ├── vmmon-agent.service  # systemd 守护进程配置
│   ├── install.sh           # 一键安装脚本（桌面端通过 SSH 自动调用）
│   ├── uninstall.sh         # 卸载脚本
│   └── tests/               # 解析器与指纹识别单元测试
├── docs/
│   └── agent-api.md         # Agent HTTP API 规范
└── start.bat                # Windows 一键启动脚本
```

---

## 快速启动

### 方式 1：双击 `start.bat`（或命令行启动）

```powershell
cd "d:\Antigravity_Projects\Claude Code\gcp-vm-monitor\app"
npm run preview
# 或开发热重载模式：
npm run dev
```

### 方式 2：体验演示模式
打开软件后，点击右上角 **「＋ 演示 VM」**，即可在不连接真实服务器的情况下体验完整的三层下钻交互、实时曲线、服务图标墙、日志抽屉以及在内置浏览器中打开模拟服务后台。

### 方式 3：连接你的真实 GCP 虚拟机
1. 点击右上角 **「＋ 添加虚拟机」**。
2. 填写 VM 的外网 IP、SSH 端口（默认 22）、登录用户名。
3. 选择 **私钥** 认证：
   - 如果已有 SSH 私钥，点击「浏览…」选择私钥文件；
   - 如果还没有密钥，点击 **「生成密钥」**，软件会自动生成 `ed25519` 密钥对并给出公钥内容，复制公钥粘贴到 **GCP 控制台 → Compute Engine → 元数据 → SSH 密钥** 保存即可。
4. 点击「保存并连接」。SSH 连上后，点击详情页提示条中的 **「⚡ 一键安装 Agent」**，几秒钟内即可开始实时监控主机指标与云服务。
