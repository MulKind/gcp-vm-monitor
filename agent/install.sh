#!/bin/sh
# VMMon Agent idempotent POSIX sh installer
set -eu

INSTALL_DIR="/opt/vmmon-agent"
CONFIG_DIR="/etc/vmmon-agent"
CONFIG_FILE="${CONFIG_DIR}/config.json"
SERVICE_FILE="/etc/systemd/system/vmmon-agent.service"

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"

if [ "$(id -u)" -ne 0 ]; then
    echo "Error: install.sh must be run as root (use sudo)." >&2
    exit 1
fi

# 1. Ensure python3 is installed
if ! command -v python3 >/dev/null 2>&1; then
    echo "python3 not found, attempting to install via apt-get..." >&2
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -y >&2 && apt-get install -y python3 >&2
fi

if ! command -v python3 >/dev/null 2>&1; then
    echo "Error: python3 is required but could not be found or installed." >&2
    exit 1
fi

PYTHON_BIN="$(command -v python3)"

# 2. Locate source vmmon_agent.py
AGENT_SRC=""
if [ "${1:-}" != "" ]; then
    if [ -d "$1" ] && [ -f "$1/vmmon_agent.py" ]; then
        AGENT_SRC="$1/vmmon_agent.py"
    elif [ -f "$1" ]; then
        AGENT_SRC="$1"
    else
        echo "Error: specified path '$1' does not contain vmmon_agent.py" >&2
        exit 1
    fi
elif [ -f "${SCRIPT_DIR}/vmmon_agent.py" ]; then
    AGENT_SRC="${SCRIPT_DIR}/vmmon_agent.py"
else
    echo "Error: vmmon_agent.py not found in ${SCRIPT_DIR}" >&2
    exit 1
fi

# 3. Install agent binary to /opt/vmmon-agent/
mkdir -p "${INSTALL_DIR}"
if [ "$(cd -- "$(dirname -- "${AGENT_SRC}")" && pwd)/$(basename -- "${AGENT_SRC}")" != "${INSTALL_DIR}/vmmon_agent.py" ]; then
    cp -f "${AGENT_SRC}" "${INSTALL_DIR}/vmmon_agent.py"
fi
chmod 0755 "${INSTALL_DIR}/vmmon_agent.py"

# 4. Create or validate config (/etc/vmmon-agent/config.json, mode 0600)
mkdir -p "${CONFIG_DIR}"
chmod 0700 "${CONFIG_DIR}"
TOKEN="$("${PYTHON_BIN}" "${INSTALL_DIR}/vmmon_agent.py" --config "${CONFIG_FILE}" --print-token)"
chmod 0600 "${CONFIG_FILE}"

# 5. Install systemd unit
if [ -f "${SCRIPT_DIR}/vmmon-agent.service" ]; then
    cp -f "${SCRIPT_DIR}/vmmon-agent.service" "${SERVICE_FILE}"
else
    cat > "${SERVICE_FILE}" <<'EOF'
[Unit]
Description=VMMon Server Monitoring and Service Discovery Agent
Documentation=https://github.com/gcp-vm-monitor
After=network.target docker.service
Wants=network.target

[Service]
Type=simple
User=root
Group=root
WorkingDirectory=/opt/vmmon-agent
ExecStart=/usr/bin/python3 /opt/vmmon-agent/vmmon_agent.py --config /etc/vmmon-agent/config.json
Restart=always
RestartSec=3
StandardOutput=journal
StandardError=journal
SyslogIdentifier=vmmon-agent
Environment="PYTHONUNBUFFERED=1"

ProtectControlGroups=true
RestrictRealtime=true
OOMScoreAdjust=-200

[Install]
WantedBy=multi-user.target
EOF
fi
chmod 0644 "${SERVICE_FILE}"

# 6. Reload systemd and enable/restart service
systemctl daemon-reload
systemctl enable --now vmmon-agent >/dev/null 2>&1 || systemctl enable vmmon-agent >/dev/null 2>&1
systemctl restart vmmon-agent

# 7. Wait up to 10s for /api/v1/health
HEALTH_OK=0
i=0
while [ "$i" -lt 20 ]; do
    if "${PYTHON_BIN}" - "${CONFIG_FILE}" <<'PYEOF' >/dev/null 2>&1
import json, sys, urllib.request
cfg_path = sys.argv[1]
with open(cfg_path, "r", encoding="utf-8") as f:
    cfg = json.load(f)
host = cfg.get("listen") or "127.0.0.1"
if host in ("0.0.0.0", "::"):
    host = "127.0.0.1"
port = int(cfg.get("port") or 9527)
url = "http://{}:{}/api/v1/health".format(host, port)
resp = urllib.request.urlopen(url, timeout=1.5)
data = json.loads(resp.read().decode("utf-8"))
sys.exit(0 if data.get("ok") is True else 1)
PYEOF
    then
        HEALTH_OK=1
        break
    fi
    sleep 0.5 2>/dev/null || sleep 1
    i=$((i + 1))
done

if [ "${HEALTH_OK}" -ne 1 ]; then
    echo "Error: vmmon-agent failed health check within 10s" >&2
    systemctl status vmmon-agent --no-pager >&2 || true
    exit 1
fi

printf 'VMMON_TOKEN=%s\n' "${TOKEN}"
