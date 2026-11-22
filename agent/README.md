# VMMon Agent（服务端监控与服务发现代理）

`vmmon_agent.py` 是 GCP VM Monitor 桌面客户端配套的轻量级 Linux 服务端代理程序。采用 **单文件、零第三方依赖（仅使用 Python 3.7+ 标准库）** 设计，直接读取 `/proc`、`/sys`、`/var/run/docker.sock` 与 `systemd`，为桌面端提供毫秒级响应的系统指标采集、服务自动发现、健康检查、日志查看与启停控制能力。

---

## 核心功能

1. **实时系统指标采样（1 秒后台采样线程）**
   - **CPU**：从 `/proc/stat` 采样计算总使用率、每核使用率（`per_core`）、`iowait` 与 `steal`。
   - **内存与 Swap**：从 `/proc/meminfo` 解析 `total`、`used`、`available`、`buffers`、`cached` 与 Swap 使用情况。
   - **磁盘空间与 I/O**：基于 `/proc/mounts` + `os.statvfs` 过滤真实文件系统（自动跳过 `tmpfs`、`overlay`、`squashfs` 等虚拟挂载），并从 `/proc/diskstats` 统计整盘读写吞吐（`read_bps` / `write_bps`）与 IOPS。
   - **网络流量与 TCP 状态**：从 `/proc/net/dev` 统计物理网卡实时吞吐与累计字节（自动过滤 `lo`、`docker*`、`veth*`、`br-*`），并从 `/proc/net/tcp{,6}` 统计 `ESTABLISHED`、`LISTEN`、`TIME_WAIT` 连接数。
   - **Top 进程采样**：后台持续计算各进程 CPU 百分比与常驻内存（RSS），支持 `/api/v1/top?n=10`。

2. **多源服务自动发现与指纹识别**
   - **Docker 容器**：通过 `/var/run/docker.sock`（`AF_UNIX` 原始 HTTP）获取容器状态、重启次数、镜像、Compose 项目名、端口映射以及后台缓存的容器 CPU / 内存占用。
   - **systemd 服务**：通过 `systemctl` 发现匹配指纹、持有监听端口或处于 `failed` 状态的服务单元（自动过滤常规系统守护进程，但异常失败时仍会上报告警）。
   - **独立监听进程**：解析 `/proc/net/tcp{,6}` 的 `0A (LISTEN)` 套接字并通过 `/proc/<pid>/fd` 与 `/proc/<pid>/cgroup` 自动归属到对应 Docker 容器或 systemd 服务；未归属的监听进程作为 `process` 服务上报。
   - **内置 50+ 服务指纹库**：支持 Nginx、Caddy、Apache、Traefik、HAProxy、MySQL、MariaDB、PostgreSQL、MongoDB、Redis、Memcached、Elasticsearch、RabbitMQ、Kafka、MinIO、Portainer、宝塔面板（BT-Panel，自动读取 `/www/server/panel/data/admin_path.pl` 安全入口）、1Panel、Grafana、Prometheus、Node Exporter、Uptime Kuma、Netdata、AList、Nextcloud、Gitea、Jenkins、code-server、Jupyter、n8n、X-UI/3X-UI、V2Ray/Xray、sing-box、FRP、NPS、WireGuard、Docker Registry、FileBrowser、qBittorrent、Aria2、Vaultwarden、WordPress、Halo 等。

3. **后台异步 Web 探测与健康检查**
   - 已知 Web 服务：后台定期请求 `scheme://127.0.0.1:port/path`（超时 3 秒、忽略自签名证书错误、不跟随重定向，HTTP 状态码 `< 500` 判定可达）。
   - 未知 TCP 端口：自动执行一次 HTTP/HTTPS 嗅探并缓存结果，若响应 HTTP 则自动识别为 Web 应用。
   - 数据库/缓存等非 Web 服务：执行本地 TCP 握手连通性检查与耗时测量。

---

## 手动安装与卸载

### 一键安装（推荐）

将 `agent/` 目录上传至目标 Linux 服务器后，以 `root` 权限执行 `install.sh`：

```bash
sudo sh install.sh
```

也可以指定 `vmmon_agent.py` 所在路径：

```bash
sudo sh install.sh /path/to/vmmon_agent.py
```

安装脚本是**幂等**的，会自动完成以下步骤：
1. 检查 `python3` 是否存在（若缺失则尝试通过 `apt-get install -y python3` 安装）。
2. 将 `vmmon_agent.py` 复制到 `/opt/vmmon-agent/vmmon_agent.py`。
3. 若 `/etc/vmmon-agent/config.json` 不存在，自动生成包含 32 字节随机十六进制 Token 的配置文件（权限 `0600`）。
4. 安装 `/etc/systemd/system/vmmon-agent.service`，执行 `systemctl daemon-reload && systemctl enable --now vmmon-agent`。
5. 等待最多 10 秒验证 `/api/v1/health` 就绪，并在最后一行输出 `VMMON_TOKEN=<token>` 供桌面端解析。

### 常用运维命令

```bash
# 查看运行状态
sudo systemctl status vmmon-agent

# 查看实时日志（输出至 stderr / journald）
sudo journalctl -u vmmon-agent -f

# 打印当前认证 Token
sudo /usr/bin/python3 /opt/vmmon-agent/vmmon_agent.py --print-token
```

### 卸载

```bash
# 卸载服务与程序（保留 /etc/vmmon-agent/config.json）
sudo sh uninstall.sh

# 彻底卸载并清除配置文件
sudo sh uninstall.sh --purge
```

---

## 配置文件说明 (`/etc/vmmon-agent/config.json`)

```json
{
  "listen": "127.0.0.1",
  "port": 9527,
  "token": "64位随机十六进制字符串",
  "check_interval": 10,
  "manual_services": [
    {
      "name": "My App",
      "port": 3000,
      "scheme": "http",
      "path": "/",
      "kind": "custom"
    }
  ],
  "hidden": [
    "systemd:chrony",
    "docker:old-test-container"
  ]
}
```

| 字段名 | 类型 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| `listen` | `string` | `"127.0.0.1"` | 绑定监听地址（建议保持 `127.0.0.1`，仅允许本机及 SSH 隧道访问） |
| `port` | `int` | `9527` | 监听 TCP 端口 |
| `token` | `string` | 自动生成 | API 访问 Bearer Token（32 字节随机 hex，共 64 字符） |
| `check_interval` | `int` | `10` | 后台服务健康检查间隔（秒） |
| `manual_services` | `array` | `[]` | 手动声明的自定义服务列表（包含 `name`、`port`、`scheme`、`path`、`kind`） |
| `hidden` | `array` | `[]` | 需要在 `/api/v1/services` 中隐藏的服务 ID（如 `"docker:xxx"`）或服务名列表 |

修改配置文件后重启服务生效：

```bash
sudo systemctl restart vmmon-agent
```

---

## 安全说明

1. **仅监听本地回环地址 (`127.0.0.1`)**：
   Agent 默认只绑定 `127.0.0.1:9527`，**不向公网或局域网暴露任何端口**，无需在 GCP 防火墙或 `ufw`/`iptables` 中开放 9527 端口。桌面客户端完全通过 **SSH 本地端口转发（SSH Tunnel）** 安全访问 Agent。
2. **Bearer Token 强认证**：
   除 `/api/v1/health` 存活探针外，所有 API 请求均强制校验 `Authorization: Bearer <token>` 请求头（采用 `hmac.compare_digest` 防时序攻击比对），未授权请求一律返回 `401 {"error":"unauthorized"}`。
3. **最小权限配置文件**：
   `/etc/vmmon-agent/config.json` 权限强制设为 `0600`（仅 `root` 可读写），防止普通低权限用户读取 Token。
4. **Root 运行原因**：
   Agent 需要读取所有进程的 `/proc/<pid>/fd`（映射监听套接字归属）、访问 `/var/run/docker.sock` 以及执行 `systemctl start|stop|restart`，因此以 `root` 身份在 `systemd` 下运行。
