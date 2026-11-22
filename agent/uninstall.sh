#!/bin/sh
# VMMon Agent uninstaller
set -eu

INSTALL_DIR="/opt/vmmon-agent"
CONFIG_DIR="/etc/vmmon-agent"
SERVICE_FILE="/etc/systemd/system/vmmon-agent.service"

if [ "$(id -u)" -ne 0 ]; then
    echo "Error: uninstall.sh must be run as root (use sudo)." >&2
    exit 1
fi

if command -v systemctl >/dev/null 2>&1; then
    systemctl stop vmmon-agent >/dev/null 2>&1 || true
    systemctl disable vmmon-agent >/dev/null 2>&1 || true
fi

if [ -f "${SERVICE_FILE}" ]; then
    rm -f "${SERVICE_FILE}"
fi

if command -v systemctl >/dev/null 2>&1; then
    systemctl daemon-reload >/dev/null 2>&1 || true
fi

if [ -d "${INSTALL_DIR}" ]; then
    rm -rf "${INSTALL_DIR}"
fi

if [ "${1:-}" = "--purge" ] || [ "${PURGE:-0}" = "1" ]; then
    if [ -d "${CONFIG_DIR}" ]; then
        rm -rf "${CONFIG_DIR}"
    fi
    echo "vmmon-agent and its configuration in ${CONFIG_DIR} have been removed."
else
    echo "vmmon-agent removed (configuration preserved in ${CONFIG_DIR}; pass --purge to remove)."
fi
