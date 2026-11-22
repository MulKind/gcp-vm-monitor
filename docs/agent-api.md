# VMMon Agent API v1 (contract between agent and desktop app)

- Agent: single file `agent/vmmon_agent.py`, **Python 3.7+ standard library only**, Linux only (reads `/proc`, `/sys`).
- Runs as root via systemd unit `vmmon-agent.service`.
- Listens on **`127.0.0.1:9527`** only (configurable). The desktop app reaches it via SSH port forwarding.
- Config: `/etc/vmmon-agent/config.json` (created by installer if missing):
  ```json
  { "listen": "127.0.0.1", "port": 9527, "token": "<random hex>", "check_interval": 10,
    "manual_services": [ { "name": "My App", "port": 3000, "scheme": "http", "path": "/", "kind": "custom" } ],
    "hidden": [] }
  ```
- Every request needs header `Authorization: Bearer <token>`; otherwise 401 `{"error":"unauthorized"}`.
- All responses are JSON (`Content-Type: application/json; charset=utf-8`). Errors: `{"error": "<message>"}` with 4xx/5xx.
- Byte values are integers in bytes, rates are bytes/second, timestamps are Unix seconds (float).

## GET /api/v1/info
```json
{ "agent_version": "0.1.0", "hostname": "vm-1", "os": "Debian GNU/Linux 12 (bookworm)",
  "kernel": "6.1.0-18-cloud-amd64", "arch": "x86_64", "cpu_model": "AMD EPYC 7B12", "cpu_count": 2,
  "mem_total": 4102131712, "boot_time": 1732000000.0, "docker": true, "systemd": true }
```

## GET /api/v1/metrics
Rates are computed from a background sampler (1 s interval) so a single call returns instantly.
```json
{ "ts": 1732260000.1,
  "uptime": 86400.0,
  "cpu":  { "percent": 12.5, "per_core": [10.0, 15.0], "iowait": 0.3, "steal": 0.0 },
  "load": [0.12, 0.20, 0.18],
  "mem":  { "total": 0, "used": 0, "available": 0, "percent": 41.2, "buffers": 0, "cached": 0,
            "swap_total": 0, "swap_used": 0 },
  "disks": [ { "mount": "/", "device": "/dev/sda1", "fs": "ext4", "total": 0, "used": 0, "free": 0, "percent": 35.1 } ],
  "disk_io": { "read_bps": 0, "write_bps": 0, "read_iops": 0, "write_iops": 0 },
  "net": { "rx_bps": 0, "tx_bps": 0, "rx_total": 0, "tx_total": 0,
           "interfaces": [ { "name": "ens4", "rx_bps": 0, "tx_bps": 0, "rx_total": 0, "tx_total": 0 } ] },
  "procs": 123, "tcp": { "established": 10, "listen": 8, "time_wait": 2 } }
```
Disks: real filesystems only (skip tmpfs, overlay, squashfs, proc, sysfs, devtmpfs, etc.). Interfaces: skip `lo`, `docker*`, `veth*`, `br-*` in the per-interface list and totals.

## GET /api/v1/services
```json
{ "ts": 1732260000.1,
  "services": [
    { "id": "docker:portainer",            // stable id: "<source>:<name>"
      "name": "portainer",                 // container name / unit name w/o .service / process name
      "display_name": "Portainer",         // from fingerprint, else prettified name
      "kind": "portainer",                 // fingerprint key (see list below) or "custom"/"unknown"
      "category": "panel",                 // panel | web | database | cache | proxy | monitoring | proxy-tool | storage | app | system
      "source": "docker",                  // docker | systemd | process | manual
      "status": "running",                 // running | stopped | failed | restarting | unknown
      "health": "healthy",                 // healthy | degraded | down | stopped | unknown
      "ports": [ { "port": 9443, "proto": "tcp", "bind": "0.0.0.0", "host_port": 9443 } ],
      "web": { "port": 9443, "scheme": "https", "path": "/" },   // null if no web UI known/detected
      "check": { "ok": true, "code": 200, "latency_ms": 12.3, "ts": 1732260000.0, "error": null },
      "uptime": 3600.0,                    // seconds, null if unknown
      "container": { "id": "abc123", "image": "portainer/portainer-ce:latest", "state": "running",
                     "health": "healthy", "restarts": 0, "cpu_percent": 0.5, "mem_bytes": 31457280,
                     "mem_limit": 0, "compose_project": "portainer" },   // only for docker
      "systemd": { "unit": "nginx.service", "active": "active", "sub": "running", "pid": 812 },  // only for systemd
      "process": { "pid": 812, "name": "nginx", "cmdline": "nginx: master process", "cpu_percent": 0.1, "mem_bytes": 0 }
    } ] }
```

### Discovery rules
1. **Docker** via unix socket `/var/run/docker.sock` (raw HTTP over AF_UNIX): `GET /containers/json?all=1`, `GET /containers/{id}/json` (restart count, health, StartedAt), stats with `?stream=false` (cache stats, refresh at most every 10 s, in background thread). Published ports → `ports` with `host_port`. Host-network containers: map via listening sockets of their processes if possible.
2. **systemd**: `systemctl list-units --type=service --all --no-legend --no-pager --plain` → only include units that are (a) fingerprint-matched, or (b) own a listening TCP port, or (c) are in `failed` state and not in a built-in boring list. Exclude obvious system units (ssh, cron, systemd-*, getty, dbus, rsyslog, google-*, chrony, unattended-upgrades, etc.) **except** report them if failed.
3. **Listening processes**: parse `/proc/net/tcp{,6}` (state 0A) → inode → `/proc/<pid>/fd` → pid → comm/cmdline. Ports owned by a docker-proxy / container or a systemd unit's cgroup (`/proc/<pid>/cgroup` contains `<unit>.service`) are attached to that service, not duplicated. Remaining listeners become `source: "process"` services.
4. **Manual** services from config `manual_services`.
5. Drop ids in config `hidden`. Skip sshd (port 22) and the agent itself.

### Fingerprints (match on image name, unit name, process name, then port)
Each yields `kind`, `display_name`, `category`, default web `port/scheme/path` (if it has a UI).
Minimum set: nginx, caddy, apache(httpd), traefik, haproxy, mysql, mariadb, postgres, mongodb, redis, memcached, elasticsearch, rabbitmq, kafka, minio, portainer, bt (宝塔 BT-Panel, process `BT-Panel`/`bt`, path from `/www/server/panel/data/admin_path.pl`), 1panel, grafana, prometheus, node-exporter, uptime-kuma, netdata, alist, nextcloud, gitea, jenkins, code-server, jupyter, n8n, x-ui/3x-ui, v2ray/xray, sing-box, frp(frps), wireguard, docker registry, filebrowser, qbittorrent, aria2, nodejs (node), python (gunicorn/uvicorn), java, php-fpm, tomcat, mosquitto, clickhouse, influxdb, vaultwarden, wordpress, halo, nps.
Unknown listener with HTTP response → `kind: "unknown"`, `category: "app"`, web set to that port.

### Web detection & health check (background, every `check_interval` s)
- If `web` known: request `scheme://127.0.0.1:port/path` (ignore TLS errors, timeout 3 s, don't follow redirects; any HTTP status < 500 counts as reachable).
- If no fingerprint web info and service has TCP ports: probe each port once with HTTP then HTTPS (cache result); if it answers HTTP, set `web`.
- Non-web services (db/cache): TCP connect check.
- `health`: stopped → `stopped`; failed/exited non-zero/check failing → `down`; latency > 1500 ms or container health `unhealthy`/restarting → `degraded`; running + check ok → `healthy`; otherwise `unknown`.

## GET /api/v1/services/{id}/logs?lines=200
`{ "id": "...", "lines": ["..."] }` — docker: `/containers/{id}/logs?stdout=1&stderr=1&tail=N&timestamps=1` (demultiplex the 8-byte frame headers); systemd: `journalctl -u <unit> -n N --no-pager -o short-iso`; process/manual: `[]`.

## POST /api/v1/services/{id}/action  body `{"action":"start"|"stop"|"restart"}`
Docker: `POST /containers/{id}/{action}`; systemd: `systemctl <action> <unit>`. Returns `{ "ok": true, "output": "" }`. Unsupported → 400.

## GET /api/v1/top?n=10
`{ "procs": [ { "pid": 1, "name": "x", "user": "root", "cpu_percent": 1.2, "mem_bytes": 0, "cmdline": "..." } ] }` (cpu % from background sampler).

## GET /api/v1/health
No auth required. `{ "ok": true, "version": "0.1.0" }`.
