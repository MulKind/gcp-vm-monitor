#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
VMMon Agent - Single-file server-side monitoring & service discovery agent.
Python 3.7+ standard library only. Linux target (importable on Windows for unit tests).
"""

import argparse
import hmac
import http.client
import ipaddress
import json
import logging
import os
import platform
import re
import secrets
import socket
import ssl
import struct
import subprocess
import sys
import threading
import time
import urllib.parse
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler
from typing import Any, Dict, List, Optional, Tuple

try:
    from http.server import ThreadingHTTPServer
except ImportError:  # pragma: no cover
    from http.server import HTTPServer
    from socketserver import ThreadingMixIn

    class ThreadingHTTPServer(ThreadingMixIn, HTTPServer):  # type: ignore
        daemon_threads = True

try:
    import pwd
except ImportError:  # Windows compatibility for tests
    pwd = None  # type: ignore


AGENT_VERSION = "0.1.0"
DEFAULT_CONFIG_PATH = "/etc/vmmon-agent/config.json"
DEFAULT_LISTEN = "127.0.0.1"
DEFAULT_PORT = 9527
DEFAULT_CHECK_INTERVAL = 10
DOCKER_SOCK_PATH = "/var/run/docker.sock"

logger = logging.getLogger("vmmon-agent")


# =====================================================================
# Pure Parsing & Classification Functions (Testable on any OS)
# =====================================================================

TCP_STATE_MAP = {
    "01": "ESTABLISHED",
    "02": "SYN_SENT",
    "03": "SYN_RECV",
    "04": "FIN_WAIT1",
    "05": "FIN_WAIT2",
    "06": "TIME_WAIT",
    "07": "CLOSE",
    "08": "CLOSE_WAIT",
    "09": "LAST_ACK",
    "0A": "LISTEN",
    "0B": "CLOSING",
}

IGNORED_FS_TYPES = {
    "proc",
    "sysfs",
    "devtmpfs",
    "devpts",
    "tmpfs",
    "securityfs",
    "cgroup",
    "cgroup2",
    "pstore",
    "efivarfs",
    "bpf",
    "autofs",
    "mqueue",
    "hugetlbfs",
    "debugfs",
    "tracefs",
    "fusectl",
    "configfs",
    "ramfs",
    "squashfs",
    "overlay",
    "nsfs",
    "rpc_pipefs",
    "binfmt_misc",
    "fuse.lxcfs",
    "fuse.portal",
    "fuse.gvfsd-fuse",
    "iso9660",
    "udf",
    "selinuxfs",
    "systemd-1",
}

IGNORED_MOUNT_PREFIXES = (
    "/proc",
    "/sys",
    "/dev",
    "/run",
    "/snap",
    "/var/lib/docker/overlay2",
    "/var/lib/docker/containers",
    "/var/lib/docker/rootfs",
    "/var/lib/kubelet",
)

WHOLE_DISK_RE = re.compile(r"^(?:(?:sd|vd|xvd|hd)[a-z]+|nvme\d+n\d+|mmcblk\d+)$")


def parse_proc_stat(text: str) -> Dict[str, Any]:
    """
    Parse /proc/stat contents.
    Returns:
      {
        "total": (user, nice, system, idle, iowait, irq, softirq, steal),
        "cores": [(user, nice, system, idle, iowait, irq, softirq, steal), ...],
        "btime": Optional[float],
      }
    """
    total = (0, 0, 0, 0, 0, 0, 0, 0)
    cores: List[Tuple[int, Tuple[int, ...]]] = []
    btime: Optional[float] = None

    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        parts = line.split()
        key = parts[0]
        if key == "cpu" and len(parts) >= 5:
            vals = [int(x) for x in parts[1:9]]
            while len(vals) < 8:
                vals.append(0)
            total = tuple(vals[:8])  # type: ignore
        elif key.startswith("cpu") and key[3:].isdigit() and len(parts) >= 5:
            core_idx = int(key[3:])
            vals = [int(x) for x in parts[1:9]]
            while len(vals) < 8:
                vals.append(0)
            cores.append((core_idx, tuple(vals[:8])))
        elif key == "btime" and len(parts) >= 2:
            try:
                btime = float(parts[1])
            except ValueError:
                pass

    cores.sort(key=lambda item: item[0])
    return {
        "total": total,
        "cores": [c[1] for c in cores],
        "btime": btime,
    }


def _calc_single_cpu_deltas(
    prev: Tuple[int, ...], curr: Tuple[int, ...]
) -> Tuple[float, float, float]:
    """Return (busy_percent, iowait_percent, steal_percent) from two 8-tuples."""
    prev_total = sum(prev[:8])
    curr_total = sum(curr[:8])
    total_delta = curr_total - prev_total
    if total_delta <= 0:
        return (0.0, 0.0, 0.0)

    idle_delta = max(0, curr[3] - prev[3])
    iowait_delta = max(0, curr[4] - prev[4])
    steal_delta = max(0, curr[7] - prev[7])
    busy_delta = max(0, total_delta - idle_delta - iowait_delta)

    percent = round(min(100.0, max(0.0, (busy_delta / total_delta) * 100.0)), 1)
    iowait = round(min(100.0, max(0.0, (iowait_delta / total_delta) * 100.0)), 1)
    steal = round(min(100.0, max(0.0, (steal_delta / total_delta) * 100.0)), 1)
    return (percent, iowait, steal)


def compute_cpu_percent(
    prev_stat: Dict[str, Any], curr_stat: Dict[str, Any]
) -> Dict[str, Any]:
    """
    Compute CPU percentage metrics from two parsed /proc/stat snapshots.
    Returns:
      { "percent": float, "per_core": [float, ...], "iowait": float, "steal": float }
    """
    percent, iowait, steal = _calc_single_cpu_deltas(
        prev_stat.get("total", (0,) * 8),
        curr_stat.get("total", (0,) * 8),
    )
    prev_cores = prev_stat.get("cores", [])
    curr_cores = curr_stat.get("cores", [])
    per_core: List[float] = []
    for idx, curr_c in enumerate(curr_cores):
        if idx < len(prev_cores):
            c_pct, _, _ = _calc_single_cpu_deltas(prev_cores[idx], curr_c)
        else:
            c_pct = 0.0
        per_core.append(c_pct)

    return {
        "percent": percent,
        "per_core": per_core,
        "iowait": iowait,
        "steal": steal,
    }


def parse_proc_meminfo(text: str) -> Dict[str, Any]:
    """
    Parse /proc/meminfo text into bytes and percentage according to the API contract.
    """
    kv: Dict[str, int] = {}
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or ":" not in line:
            continue
        key, rest = line.split(":", 1)
        parts = rest.strip().split()
        if not parts:
            continue
        try:
            val = int(parts[0])
        except ValueError:
            continue
        unit = parts[1].lower() if len(parts) > 1 else ""
        if unit == "kb":
            val *= 1024
        elif unit == "mb":
            val *= 1024 * 1024
        elif unit == "gb":
            val *= 1024 * 1024 * 1024
        kv[key.strip()] = val

    total = kv.get("MemTotal", 0)
    free = kv.get("MemFree", 0)
    buffers = kv.get("Buffers", 0)
    cached = kv.get("Cached", 0)
    if "MemAvailable" in kv:
        available = kv["MemAvailable"]
    else:
        available = min(total, free + buffers + cached)

    used = max(0, total - available)
    percent = round((used / total) * 100.0, 1) if total > 0 else 0.0
    swap_total = kv.get("SwapTotal", 0)
    swap_free = kv.get("SwapFree", 0)
    swap_used = max(0, swap_total - swap_free)

    return {
        "total": total,
        "used": used,
        "available": available,
        "percent": percent,
        "buffers": buffers,
        "cached": cached,
        "swap_total": swap_total,
        "swap_used": swap_used,
    }


def is_ignored_net_interface(name: str) -> bool:
    """Skip lo, docker*, veth*, br-* as specified in agent-api.md."""
    n = name.strip()
    if not n or n == "lo":
        return True
    if n.startswith(("docker", "veth", "br-")):
        return True
    return False


def parse_proc_net_dev(
    text: str, include_ignored: bool = False
) -> Dict[str, Dict[str, int]]:
    """
    Parse /proc/net/dev into {iface: {"rx_bytes": int, "tx_bytes": int}}.
    """
    result: Dict[str, Dict[str, int]] = {}
    for raw_line in text.splitlines():
        if ":" not in raw_line:
            continue
        iface_part, data_part = raw_line.split(":", 1)
        iface = iface_part.strip()
        if not iface:
            continue
        if not include_ignored and is_ignored_net_interface(iface):
            continue
        fields = data_part.split()
        if len(fields) < 9:
            continue
        try:
            rx_bytes = int(fields[0])
            tx_bytes = int(fields[8])
        except ValueError:
            continue
        result[iface] = {
            "rx_bytes": rx_bytes,
            "tx_bytes": tx_bytes,
        }
    return result


def compute_net_metrics(
    prev_net: Dict[str, Dict[str, int]],
    curr_net: Dict[str, Dict[str, int]],
    dt: float,
) -> Dict[str, Any]:
    """
    Compute aggregate and per-interface network totals and rates (bytes/sec).
    """
    safe_dt = dt if dt > 0 else 1.0
    interfaces: List[Dict[str, Any]] = []
    rx_total_all = 0
    tx_total_all = 0
    rx_bps_all = 0
    tx_bps_all = 0

    for name in sorted(curr_net.keys()):
        if is_ignored_net_interface(name):
            continue
        curr_item = curr_net[name]
        rx_total = int(curr_item.get("rx_bytes", 0))
        tx_total = int(curr_item.get("tx_bytes", 0))
        if name in prev_net and dt > 0:
            prev_item = prev_net[name]
            rx_delta = max(0, rx_total - int(prev_item.get("rx_bytes", 0)))
            tx_delta = max(0, tx_total - int(prev_item.get("tx_bytes", 0)))
            rx_bps = int(round(rx_delta / safe_dt))
            tx_bps = int(round(tx_delta / safe_dt))
        else:
            rx_bps = 0
            tx_bps = 0

        rx_total_all += rx_total
        tx_total_all += tx_total
        rx_bps_all += rx_bps
        tx_bps_all += tx_bps
        interfaces.append(
            {
                "name": name,
                "rx_bps": rx_bps,
                "tx_bps": tx_bps,
                "rx_total": rx_total,
                "tx_total": tx_total,
            }
        )

    return {
        "rx_bps": rx_bps_all,
        "tx_bps": tx_bps_all,
        "rx_total": rx_total_all,
        "tx_total": tx_total_all,
        "interfaces": interfaces,
    }


def is_whole_disk(dev_name: str) -> bool:
    """Return True if dev_name is a whole block disk (not a partition or loop/ram/dm device)."""
    return bool(WHOLE_DISK_RE.match(dev_name.strip()))


def parse_proc_diskstats(text: str) -> Dict[str, Dict[str, int]]:
    """
    Parse /proc/diskstats for whole disks only.
    Returns {dev_name: {"read_ios": int, "read_bytes": int, "write_ios": int, "write_bytes": int}}
    """
    result: Dict[str, Dict[str, int]] = {}
    for raw_line in text.splitlines():
        parts = raw_line.split()
        if len(parts) < 10:
            continue
        dev_name = parts[2]
        if not is_whole_disk(dev_name):
            continue
        try:
            read_ios = int(parts[3])
            read_sectors = int(parts[5])
            write_ios = int(parts[7])
            write_sectors = int(parts[9])
        except ValueError:
            continue
        result[dev_name] = {
            "read_ios": read_ios,
            "read_bytes": read_sectors * 512,
            "write_ios": write_ios,
            "write_bytes": write_sectors * 512,
        }
    return result


def compute_disk_io_metrics(
    prev_disks: Dict[str, Dict[str, int]],
    curr_disks: Dict[str, Dict[str, int]],
    dt: float,
) -> Dict[str, int]:
    """
    Compute aggregate disk I/O read/write bytes/sec and IOPS across whole disks.
    """
    if dt <= 0:
        return {"read_bps": 0, "write_bps": 0, "read_iops": 0, "write_iops": 0}

    read_bytes_delta = 0
    write_bytes_delta = 0
    read_ios_delta = 0
    write_ios_delta = 0

    for dev, curr in curr_disks.items():
        prev = prev_disks.get(dev)
        if not prev:
            continue
        read_bytes_delta += max(0, curr["read_bytes"] - prev["read_bytes"])
        write_bytes_delta += max(0, curr["write_bytes"] - prev["write_bytes"])
        read_ios_delta += max(0, curr["read_ios"] - prev["read_ios"])
        write_ios_delta += max(0, curr["write_ios"] - prev["write_ios"])

    return {
        "read_bps": int(round(read_bytes_delta / dt)),
        "write_bps": int(round(write_bytes_delta / dt)),
        "read_iops": int(round(read_ios_delta / dt)),
        "write_iops": int(round(write_ios_delta / dt)),
    }


def parse_proc_mounts(text: str) -> List[Dict[str, str]]:
    """
    Parse /proc/mounts and filter to real filesystems only.
    Returns list of {"mount": str, "device": str, "fs": str}.
    """
    candidates: List[Dict[str, str]] = []
    for raw_line in text.splitlines():
        parts = raw_line.split()
        if len(parts) < 3:
            continue
        device, mount_raw, fstype = parts[0], parts[1], parts[2]
        mount = mount_raw.replace("\\040", " ").replace("\\011", "\t")
        fs_lower = fstype.lower()

        if fs_lower in IGNORED_FS_TYPES or fs_lower.startswith("fuse."):
            continue
        if not device.startswith("/") and fs_lower not in ("zfs", "btrfs"):
            continue
        if device.startswith("/dev/loop"):
            continue
        if any(
            mount == pref or mount.startswith(pref + "/")
            for pref in IGNORED_MOUNT_PREFIXES
        ):
            continue
        candidates.append({"mount": mount, "device": device, "fs": fstype})

    # Sort by mount length so root '/' or shortest mount comes first when deduplicating by device
    candidates.sort(key=lambda item: (len(item["mount"]), item["mount"]))
    seen_mounts = set()
    seen_devices = set()
    result: List[Dict[str, str]] = []
    for item in candidates:
        if item["mount"] in seen_mounts or item["device"] in seen_devices:
            continue
        seen_mounts.add(item["mount"])
        seen_devices.add(item["device"])
        result.append(item)
    return result


def decode_proc_net_addr(hex_addr_port: str) -> Tuple[str, int]:
    """
    Decode hex IP:PORT from /proc/net/tcp or /proc/net/tcp6 (little-endian 32-bit words).
    Returns (ip_string, port_int).
    """
    addr_hex, port_hex = hex_addr_port.strip().split(":", 1)
    port = int(port_hex, 16)
    addr_hex = addr_hex.strip()

    if len(addr_hex) == 8:
        raw = bytes.fromhex(addr_hex)
        ip_bytes = raw[::-1]
        ip_str = str(ipaddress.IPv4Address(ip_bytes))
        return (ip_str, port)
    elif len(addr_hex) == 32:
        words = [bytes.fromhex(addr_hex[i : i + 8])[::-1] for i in range(0, 32, 8)]
        ip_bytes = b"".join(words)
        ipv6 = ipaddress.IPv6Address(ip_bytes)
        if ipv6.ipv4_mapped is not None:
            return (str(ipv6.ipv4_mapped), port)
        return (str(ipv6), port)
    else:
        raise ValueError("Invalid /proc/net/tcp address length: {}".format(addr_hex))


def parse_proc_net_tcp(text: str) -> List[Dict[str, Any]]:
    """
    Parse /proc/net/tcp or /proc/net/tcp6 text.
    Returns list of dicts:
      {
        "local_ip": str,
        "local_port": int,
        "rem_ip": str,
        "rem_port": int,
        "state": str,        # hex e.g. "0A"
        "state_name": str,   # e.g. "LISTEN"
        "uid": int,
        "inode": int,
      }
    """
    entries: List[Dict[str, Any]] = []
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("sl"):
            continue
        parts = line.split()
        if len(parts) < 10:
            continue
        try:
            local_ip, local_port = decode_proc_net_addr(parts[1])
            rem_ip, rem_port = decode_proc_net_addr(parts[2])
            state_hex = parts[3].upper()
            uid = int(parts[7])
            inode = int(parts[9])
        except (ValueError, IndexError):
            continue

        entries.append(
            {
                "local_ip": local_ip,
                "local_port": local_port,
                "rem_ip": rem_ip,
                "rem_port": rem_port,
                "state": state_hex,
                "state_name": TCP_STATE_MAP.get(state_hex, "UNKNOWN"),
                "uid": uid,
                "inode": inode,
            }
        )
    return entries


def summarize_tcp_states(entries: List[Dict[str, Any]]) -> Dict[str, int]:
    """
    Count established (01), listen (0A), and time_wait (06) sockets.
    """
    established = 0
    listen = 0
    time_wait = 0
    for entry in entries:
        st = entry.get("state", "").upper()
        if st == "01":
            established += 1
        elif st == "0A":
            listen += 1
        elif st == "06":
            time_wait += 1
    return {
        "established": established,
        "listen": listen,
        "time_wait": time_wait,
    }


def parse_proc_pid_stat(text: str) -> Optional[Dict[str, Any]]:
    """
    Parse /proc/<pid>/stat single-line content safely (handling spaces/parens in comm).
    """
    line = text.strip()
    if not line:
        return None
    lpar = line.find("(")
    rpar = line.rfind(")")
    if lpar == -1 or rpar == -1 or rpar < lpar:
        return None
    try:
        pid = int(line[:lpar].strip())
        comm = line[lpar + 1 : rpar]
        rest = line[rpar + 2 :].split()
        if len(rest) < 22:
            return None
        state = rest[0]
        utime = int(rest[11])
        stime = int(rest[12])
        starttime = int(rest[19])
        rss_pages = int(rest[21])
        return {
            "pid": pid,
            "name": comm,
            "state": state,
            "ticks": utime + stime,
            "starttime": starttime,
            "rss_pages": rss_pages,
        }
    except (ValueError, IndexError):
        return None


DOCKER_CGROUP_RE = re.compile(
    r"(?:docker[-/]([0-9a-f]{12,64})(?:\.scope)?|/containers/([0-9a-f]{12,64}))"
)
SYSTEMD_SERVICE_CGROUP_RE = re.compile(r"/([^/]+\.service)(?:/|$)")


def extract_cgroup_owner(text: str) -> Tuple[Optional[str], Optional[str]]:
    """
    Extract (docker_container_id, systemd_unit) from /proc/<pid>/cgroup content.
    """
    docker_id: Optional[str] = None
    systemd_unit: Optional[str] = None

    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        m_dock = DOCKER_CGROUP_RE.search(line)
        if m_dock:
            docker_id = m_dock.group(1) or m_dock.group(2)
        for m_unit in SYSTEMD_SERVICE_CGROUP_RE.finditer(line):
            candidate = m_unit.group(1)
            if candidate not in ("docker.service", "containerd.service"):
                systemd_unit = candidate
    return (docker_id, systemd_unit)


def demux_docker_logs(data: bytes) -> List[str]:
    """
    Demultiplex Docker container log stream (8-byte frame headers: [stream, 0, 0, 0, size_be32])
    or plain TTY stream into a list of log lines.
    """
    if not data:
        return []

    # Check if data starts with a valid Docker multiplexed stream header
    is_mux = (
        len(data) >= 8
        and data[0] in (0, 1, 2)
        and data[1:4] == b"\x00\x00\x00"
    )

    if not is_mux:
        text = data.decode("utf-8", errors="replace")
        return [line.rstrip("\r") for line in text.splitlines()]

    lines: List[str] = []
    pos = 0
    n = len(data)
    while pos + 8 <= n:
        stream_type = data[pos]
        if stream_type not in (0, 1, 2) or data[pos + 1 : pos + 4] != b"\x00\x00\x00":
            rem = data[pos:].decode("utf-8", errors="replace")
            lines.extend(line.rstrip("\r") for line in rem.splitlines())
            break
        size = struct.unpack(">I", data[pos + 4 : pos + 8])[0]
        pos += 8
        payload = data[pos : pos + size]
        pos += size
        if not payload:
            continue
        decoded = payload.decode("utf-8", errors="replace")
        for line in decoded.splitlines():
            lines.append(line.rstrip("\r"))
    return lines


# =====================================================================
# Fingerprint Definitions & Matching
# =====================================================================

# Each entry:
#   kind: str
#   display_name: str
#   category: panel | web | database | cache | proxy | monitoring | proxy-tool | storage | app | system
#   tokens: tuple of matching tokens for image/unit/process
#   ports: tuple of default TCP ports
#   web: Optional[{"port": int, "scheme": str, "path": str}]
#   generic: bool (True for generic runtimes like nodejs/python/java matched only if no specific app matched)

FINGERPRINTS: List[Dict[str, Any]] = [
    # Panels
    {
        "kind": "portainer",
        "display_name": "Portainer",
        "category": "panel",
        "tokens": ("portainer", "portainer-ce", "portainer-ee"),
        "ports": (9443, 9000),
        "web": {"port": 9443, "scheme": "https", "path": "/"},
    },
    {
        "kind": "bt",
        "display_name": "BT-Panel",
        "category": "panel",
        "tokens": ("bt-panel", "btpanel", "baota", "bt"),
        "ports": (8888,),
        "web": {"port": 8888, "scheme": "http", "path": "/"},
    },
    {
        "kind": "1panel",
        "display_name": "1Panel",
        "category": "panel",
        "tokens": ("1panel", "1panel-core"),
        "ports": (10086,),
        "web": {"port": 10086, "scheme": "http", "path": "/"},
    },
    # Web servers & Reverse proxies
    {
        "kind": "nginx",
        "display_name": "Nginx",
        "category": "web",
        "tokens": ("nginx", "openresty"),
        "ports": (80, 443),
        "web": {"port": 80, "scheme": "http", "path": "/"},
    },
    {
        "kind": "caddy",
        "display_name": "Caddy",
        "category": "web",
        "tokens": ("caddy",),
        "ports": (80, 443, 2019),
        "web": {"port": 80, "scheme": "http", "path": "/"},
    },
    {
        "kind": "apache",
        "display_name": "Apache",
        "category": "web",
        "tokens": ("apache2", "httpd", "apache"),
        "ports": (80, 443),
        "web": {"port": 80, "scheme": "http", "path": "/"},
    },
    {
        "kind": "tomcat",
        "display_name": "Tomcat",
        "category": "web",
        "tokens": ("tomcat", "catalina"),
        "ports": (8080,),
        "web": {"port": 8080, "scheme": "http", "path": "/"},
    },
    {
        "kind": "traefik",
        "display_name": "Traefik",
        "category": "proxy",
        "tokens": ("traefik",),
        "ports": (8080, 80, 443),
        "web": {"port": 8080, "scheme": "http", "path": "/dashboard/"},
    },
    {
        "kind": "haproxy",
        "display_name": "HAProxy",
        "category": "proxy",
        "tokens": ("haproxy",),
        "ports": (),
        "web": None,
    },
    # Databases
    {
        "kind": "mysql",
        "display_name": "MySQL",
        "category": "database",
        "tokens": ("mysqld", "mysql", "percona"),
        "ports": (3306, 33060),
        "web": None,
    },
    {
        "kind": "mariadb",
        "display_name": "MariaDB",
        "category": "database",
        "tokens": ("mariadbd", "mariadb"),
        "ports": (3306,),
        "web": None,
    },
    {
        "kind": "postgres",
        "display_name": "PostgreSQL",
        "category": "database",
        "tokens": ("postgresql", "postgres", "postmaster"),
        "ports": (5432,),
        "web": None,
    },
    {
        "kind": "mongodb",
        "display_name": "MongoDB",
        "category": "database",
        "tokens": ("mongod", "mongodb", "mongo"),
        "ports": (27017,),
        "web": None,
    },
    {
        "kind": "elasticsearch",
        "display_name": "Elasticsearch",
        "category": "database",
        "tokens": ("elasticsearch",),
        "ports": (9200, 9300),
        "web": {"port": 9200, "scheme": "http", "path": "/"},
    },
    {
        "kind": "clickhouse",
        "display_name": "ClickHouse",
        "category": "database",
        "tokens": ("clickhouse-server", "clickhouse"),
        "ports": (8123, 9000),
        "web": {"port": 8123, "scheme": "http", "path": "/"},
    },
    {
        "kind": "influxdb",
        "display_name": "InfluxDB",
        "category": "database",
        "tokens": ("influxd", "influxdb"),
        "ports": (8086,),
        "web": {"port": 8086, "scheme": "http", "path": "/"},
    },
    # Caches
    {
        "kind": "redis",
        "display_name": "Redis",
        "category": "cache",
        "tokens": ("redis-server", "redis"),
        "ports": (6379,),
        "web": None,
    },
    {
        "kind": "memcached",
        "display_name": "Memcached",
        "category": "cache",
        "tokens": ("memcached",),
        "ports": (11211,),
        "web": None,
    },
    # Monitoring
    {
        "kind": "grafana",
        "display_name": "Grafana",
        "category": "monitoring",
        "tokens": ("grafana-server", "grafana"),
        "ports": (3000,),
        "web": {"port": 3000, "scheme": "http", "path": "/"},
    },
    {
        "kind": "prometheus",
        "display_name": "Prometheus",
        "category": "monitoring",
        "tokens": ("prometheus",),
        "ports": (9090,),
        "web": {"port": 9090, "scheme": "http", "path": "/"},
    },
    {
        "kind": "node-exporter",
        "display_name": "Node Exporter",
        "category": "monitoring",
        "tokens": ("node-exporter", "node_exporter", "prometheus-node-exporter"),
        "ports": (9100,),
        "web": {"port": 9100, "scheme": "http", "path": "/metrics"},
    },
    {
        "kind": "uptime-kuma",
        "display_name": "Uptime Kuma",
        "category": "monitoring",
        "tokens": ("uptime-kuma", "uptimekuma"),
        "ports": (3001,),
        "web": {"port": 3001, "scheme": "http", "path": "/"},
    },
    {
        "kind": "netdata",
        "display_name": "Netdata",
        "category": "monitoring",
        "tokens": ("netdata",),
        "ports": (19999,),
        "web": {"port": 19999, "scheme": "http", "path": "/"},
    },
    # Proxy & Tunnel tools
    {
        "kind": "x-ui",
        "display_name": "X-UI / 3X-UI",
        "category": "proxy-tool",
        "tokens": ("3x-ui", "x-ui"),
        "ports": (2053, 54321),
        "web": {"port": 2053, "scheme": "http", "path": "/"},
    },
    {
        "kind": "v2ray",
        "display_name": "V2Ray / Xray",
        "category": "proxy-tool",
        "tokens": ("v2ray", "xray"),
        "ports": (),
        "web": None,
    },
    {
        "kind": "sing-box",
        "display_name": "sing-box",
        "category": "proxy-tool",
        "tokens": ("sing-box",),
        "ports": (),
        "web": None,
    },
    {
        "kind": "frp",
        "display_name": "FRP",
        "category": "proxy-tool",
        "tokens": ("frps", "frpc", "frp"),
        "ports": (7000, 7500),
        "web": {"port": 7500, "scheme": "http", "path": "/"},
    },
    {
        "kind": "nps",
        "display_name": "NPS",
        "category": "proxy-tool",
        "tokens": ("nps", "npc"),
        "ports": (8080, 8024),
        "web": {"port": 8080, "scheme": "http", "path": "/"},
    },
    {
        "kind": "wireguard",
        "display_name": "WireGuard",
        "category": "proxy-tool",
        "tokens": ("wireguard", "wg-quick"),
        "ports": (51820,),
        "web": None,
    },
    # Storage & File services
    {
        "kind": "minio",
        "display_name": "MinIO",
        "category": "storage",
        "tokens": ("minio",),
        "ports": (9001, 9000),
        "web": {"port": 9001, "scheme": "http", "path": "/"},
    },
    {
        "kind": "alist",
        "display_name": "AList",
        "category": "storage",
        "tokens": ("alist",),
        "ports": (5244,),
        "web": {"port": 5244, "scheme": "http", "path": "/"},
    },
    {
        "kind": "nextcloud",
        "display_name": "Nextcloud",
        "category": "storage",
        "tokens": ("nextcloud",),
        "ports": (80,),
        "web": {"port": 80, "scheme": "http", "path": "/"},
    },
    {
        "kind": "registry",
        "display_name": "Docker Registry",
        "category": "storage",
        "tokens": ("registry", "docker-registry"),
        "ports": (5000,),
        "web": {"port": 5000, "scheme": "http", "path": "/v2/"},
    },
    {
        "kind": "filebrowser",
        "display_name": "FileBrowser",
        "category": "storage",
        "tokens": ("filebrowser",),
        "ports": (8080, 80),
        "web": {"port": 8080, "scheme": "http", "path": "/"},
    },
    # Applications & Middleware
    {
        "kind": "rabbitmq",
        "display_name": "RabbitMQ",
        "category": "app",
        "tokens": ("rabbitmq", "rabbitmq-server"),
        "ports": (15672, 5672),
        "web": {"port": 15672, "scheme": "http", "path": "/"},
    },
    {
        "kind": "kafka",
        "display_name": "Kafka",
        "category": "app",
        "tokens": ("kafka",),
        "ports": (9092,),
        "web": None,
    },
    {
        "kind": "mosquitto",
        "display_name": "Mosquitto",
        "category": "app",
        "tokens": ("mosquitto",),
        "ports": (1883, 9001),
        "web": None,
    },
    {
        "kind": "gitea",
        "display_name": "Gitea",
        "category": "app",
        "tokens": ("gitea",),
        "ports": (3000,),
        "web": {"port": 3000, "scheme": "http", "path": "/"},
    },
    {
        "kind": "jenkins",
        "display_name": "Jenkins",
        "category": "app",
        "tokens": ("jenkins",),
        "ports": (8080,),
        "web": {"port": 8080, "scheme": "http", "path": "/"},
    },
    {
        "kind": "code-server",
        "display_name": "code-server",
        "category": "app",
        "tokens": ("code-server",),
        "ports": (8080,),
        "web": {"port": 8080, "scheme": "http", "path": "/"},
    },
    {
        "kind": "jupyter",
        "display_name": "Jupyter",
        "category": "app",
        "tokens": ("jupyter", "jupyter-lab", "jupyter-notebook", "jupyterhub"),
        "ports": (8888,),
        "web": {"port": 8888, "scheme": "http", "path": "/"},
    },
    {
        "kind": "n8n",
        "display_name": "n8n",
        "category": "app",
        "tokens": ("n8n",),
        "ports": (5678,),
        "web": {"port": 5678, "scheme": "http", "path": "/"},
    },
    {
        "kind": "qbittorrent",
        "display_name": "qBittorrent",
        "category": "app",
        "tokens": ("qbittorrent", "qbittorrent-nox"),
        "ports": (8080,),
        "web": {"port": 8080, "scheme": "http", "path": "/"},
    },
    {
        "kind": "aria2",
        "display_name": "Aria2",
        "category": "app",
        "tokens": ("aria2c", "aria2"),
        "ports": (6800,),
        "web": {"port": 6800, "scheme": "http", "path": "/jsonrpc"},
    },
    {
        "kind": "vaultwarden",
        "display_name": "Vaultwarden",
        "category": "app",
        "tokens": ("vaultwarden", "bitwarden_rs"),
        "ports": (80,),
        "web": {"port": 80, "scheme": "http", "path": "/"},
    },
    {
        "kind": "wordpress",
        "display_name": "WordPress",
        "category": "app",
        "tokens": ("wordpress",),
        "ports": (80,),
        "web": {"port": 80, "scheme": "http", "path": "/"},
    },
    {
        "kind": "halo",
        "display_name": "Halo",
        "category": "app",
        "tokens": ("halo",),
        "ports": (8090,),
        "web": {"port": 8090, "scheme": "http", "path": "/"},
    },
    {
        "kind": "php-fpm",
        "display_name": "PHP-FPM",
        "category": "app",
        "tokens": ("php-fpm", "php7", "php8"),
        "ports": (9000,),
        "web": None,
    },
    # Generic Runtimes (matched after specific apps)
    {
        "kind": "nodejs",
        "display_name": "Node.js",
        "category": "app",
        "tokens": ("nodejs", "node"),
        "ports": (),
        "web": None,
        "generic": True,
    },
    {
        "kind": "python",
        "display_name": "Python",
        "category": "app",
        "tokens": ("gunicorn", "uvicorn", "uwsgi", "celery", "python3", "python"),
        "ports": (),
        "web": None,
        "generic": True,
    },
    {
        "kind": "java",
        "display_name": "Java",
        "category": "app",
        "tokens": ("java", "openjdk"),
        "ports": (),
        "web": None,
        "generic": True,
    },
]

# Unambiguous well-known ports for port-only fallback matching
PORT_FALLBACK_KIND: Dict[int, str] = {
    3306: "mysql",
    5432: "postgres",
    6379: "redis",
    27017: "mongodb",
    11211: "memcached",
    9200: "elasticsearch",
    15672: "rabbitmq",
    9443: "portainer",
    10086: "1panel",
    9090: "prometheus",
    9100: "node-exporter",
    3001: "uptime-kuma",
    19999: "netdata",
    5244: "alist",
    5678: "n8n",
    6800: "aria2",
    8123: "clickhouse",
    8086: "influxdb",
    1883: "mosquitto",
    8090: "halo",
}

FINGERPRINT_BY_KIND: Dict[str, Dict[str, Any]] = {
    fp["kind"]: fp for fp in FINGERPRINTS
}


def prettify_service_name(name: str) -> str:
    """Turn 'my-cool_service' into 'My Cool Service'."""
    cleaned = re.sub(r"[_.-]+", " ", name.strip())
    if not cleaned:
        return name
    return " ".join(w.capitalize() for w in cleaned.split())


def normalize_bt_admin_path(raw_text: Optional[str]) -> str:
    """Normalize BT-Panel admin_path.pl contents into a clean URL path."""
    if not raw_text:
        return "/"
    p = raw_text.strip()
    if not p:
        return "/"
    if not p.startswith("/"):
        p = "/" + p
    return p


def _candidate_matches_token(candidate: str, token: str) -> bool:
    """
    Check if a normalized candidate string (image, unit, process, cmdline) matches a fingerprint token.
    Uses word/token boundaries so short tokens like 'bt' don't false-match 'debt' or 'btrfs'.
    """
    if not candidate:
        return False
    c = candidate.lower().strip()
    t = token.lower().strip()
    if c == t:
        return True
    # Split candidate into alphanumeric/hyphen words
    # Also check exact token boundary with non-alphanumeric separators
    pattern = r"(?:^|[/:\s_@.-])" + re.escape(t) + r"(?:$|[/:\s_@.\d-])"
    if len(t) <= 3:
        # Strict boundary for short tokens like 'bt', 'nps', 'frp', 'n8n'
        strict_pat = r"(?:^|[/:\s_@-])" + re.escape(t) + r"(?:$|[/:\s_@-])"
        return bool(re.search(strict_pat, c))
    return bool(re.search(pattern, c))


def _resolve_web_for_fingerprint(
    fp: Dict[str, Any],
    ports: Optional[List[Any]] = None,
    bt_admin_path: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    """
    Build the `web` dict {"port": int, "scheme": str, "path": str} for a matched fingerprint,
    mapping container port -> host_port when published ports are provided.
    """
    fp_web = fp.get("web")
    if not fp_web:
        return None

    default_port = fp_web["port"]
    scheme = fp_web["scheme"]
    path = fp_web["path"]
    if fp["kind"] == "bt" and bt_admin_path is not None:
        path = normalize_bt_admin_path(bt_admin_path)

    if not ports:
        return {"port": default_port, "scheme": scheme, "path": path}

    # Normalize port items into (container_port, host_port)
    port_pairs: List[Tuple[int, int]] = []
    for p in ports:
        if isinstance(p, int):
            port_pairs.append((p, p))
        elif isinstance(p, dict):
            c_port = int(p.get("port") or p.get("host_port") or 0)
            h_port = int(p.get("host_port") or p.get("port") or 0)
            if c_port > 0 and h_port > 0:
                port_pairs.append((c_port, h_port))

    if not port_pairs:
        return {"port": default_port, "scheme": scheme, "path": path}

    # Special handling for portainer (9443 https vs 9000 http)
    if fp["kind"] == "portainer":
        for c_port, h_port in port_pairs:
            if c_port == 9443 or h_port == 9443:
                return {"port": h_port, "scheme": "https", "path": path}
        for c_port, h_port in port_pairs:
            if c_port == 9000 or h_port == 9000:
                return {"port": h_port, "scheme": "http", "path": path}

    # Check if default_port matches any container port or host port
    for c_port, h_port in port_pairs:
        if c_port == default_port:
            return {"port": h_port, "scheme": scheme, "path": path}
    for c_port, h_port in port_pairs:
        if h_port == default_port:
            return {"port": h_port, "scheme": scheme, "path": path}

    # If 443 is exposed on a web server, or single port is exposed
    for c_port, h_port in port_pairs:
        if c_port == 443 and scheme == "http":
            return {"port": h_port, "scheme": "https", "path": path}

    return {"port": port_pairs[0][1], "scheme": scheme, "path": path}


def match_fingerprint(
    image: Optional[str] = None,
    unit: Optional[str] = None,
    process: Optional[str] = None,
    cmdline: Optional[str] = None,
    ports: Optional[List[Any]] = None,
    bt_admin_path: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Match a service against known fingerprints in priority order:
      1. image name
      2. unit name
      3. process name / cmdline
      4. port
    Specific application fingerprints always take priority over generic runtimes (node/python/java).
    Returns:
      {
        "matched": bool,
        "kind": str,
        "display_name": str,
        "category": str,
        "web": Optional[{"port": int, "scheme": str, "path": str}],
      }
    """
    # Strip tag/digest from image for cleaner matching
    img_clean = ""
    if image:
        img_clean = image.split("@")[0].split(":")[0].strip().lower()

    unit_clean = ""
    if unit:
        unit_clean = unit.strip().lower()
        if unit_clean.endswith(".service"):
            unit_clean = unit_clean[:-8]

    proc_clean = (process or "").strip().lower()
    cmd_clean = (cmdline or "").strip().lower()

    specific_fps = [fp for fp in FINGERPRINTS if not fp.get("generic")]
    generic_fps = [fp for fp in FINGERPRINTS if fp.get("generic")]

    sources = [img_clean, unit_clean, proc_clean, cmd_clean]

    # Pass 1: Specific fingerprints across (image -> unit -> process -> cmdline)
    for candidate in sources:
        if not candidate:
            continue
        for fp in specific_fps:
            for token in fp["tokens"]:
                if _candidate_matches_token(candidate, token):
                    return {
                        "matched": True,
                        "kind": fp["kind"],
                        "display_name": fp["display_name"],
                        "category": fp["category"],
                        "web": _resolve_web_for_fingerprint(fp, ports, bt_admin_path),
                    }

    # Pass 2: Generic runtime fingerprints across (image -> unit -> process -> cmdline)
    for candidate in sources:
        if not candidate:
            continue
        for fp in generic_fps:
            for token in fp["tokens"]:
                if _candidate_matches_token(candidate, token):
                    return {
                        "matched": True,
                        "kind": fp["kind"],
                        "display_name": fp["display_name"],
                        "category": fp["category"],
                        "web": _resolve_web_for_fingerprint(fp, ports, bt_admin_path),
                    }

    # Pass 3: Port fallback matching
    if ports:
        for p in ports:
            port_num = p if isinstance(p, int) else int(p.get("port") or p.get("host_port") or 0)
            if port_num in PORT_FALLBACK_KIND:
                fp = FINGERPRINT_BY_KIND[PORT_FALLBACK_KIND[port_num]]
                return {
                    "matched": True,
                    "kind": fp["kind"],
                    "display_name": fp["display_name"],
                    "category": fp["category"],
                    "web": _resolve_web_for_fingerprint(fp, ports, bt_admin_path),
                }

    fallback_name = unit_clean or proc_clean or img_clean.split("/")[-1] or "Unknown"
    return {
        "matched": False,
        "kind": "unknown",
        "display_name": prettify_service_name(fallback_name),
        "category": "app",
        "web": None,
    }


def classify_health(
    status: str,
    check: Optional[Dict[str, Any]] = None,
    container_health: Optional[str] = None,
    exit_code: Optional[int] = None,
) -> str:
    """
    Classify service health according to agent-api.md:
      - stopped -> 'stopped' (unless exited non-zero -> 'down')
      - failed / exited non-zero / check failing -> 'down'
      - latency > 1500 ms or container health 'unhealthy' / restarting -> 'degraded'
      - running + check ok -> 'healthy'
      - otherwise 'unknown'
    """
    st = (status or "unknown").lower()
    c_health = (container_health or "").lower()

    if st == "failed":
        return "down"
    if exit_code is not None and exit_code != 0 and st != "running":
        return "down"
    if st == "stopped":
        return "stopped"
    if st == "restarting":
        return "degraded"

    if st == "running":
        if check is not None and check.get("ok") is False:
            return "down"
        if c_health == "unhealthy":
            return "degraded"
        if check is not None and check.get("ok") is True:
            latency = check.get("latency_ms")
            if latency is not None and float(latency) > 1500.0:
                return "degraded"
            return "healthy"
        if c_health == "healthy":
            return "healthy"
        return "unknown"

    return "unknown"


# =====================================================================
# Systemd Parsing & Filtering Helpers
# =====================================================================

BORING_SYSTEMD_PREFIXES = (
    "systemd-",
    "getty@",
    "serial-getty@",
    "container-getty@",
    "console-getty",
    "autovt@",
    "user@",
    "user-runtime-dir@",
    "dbus",
    "rsyslog",
    "syslog",
    "google-",
    "gce-",
    "cloud-",
    "chrony",
    "ntp",
    "unattended-upgrades",
    "apt-",
    "dpkg-",
    "fstrim",
    "logrotate",
    "man-db",
    "modprobe@",
    "kmod",
    "udev",
    "polkit",
    "accounts-daemon",
    "networkd-dispatcher",
    "networkmanager",
    "wpa_supplicant",
    "multipathd",
    "udisks2",
    "upower",
    "plymouth",
    "apparmor",
    "ufw",
    "nftables",
    "iptables",
    "haveged",
    "irqbalance",
    "lvm2-",
    "dm-event",
    "blk-availability",
    "e2scrub",
    "motd-news",
    "fwupd",
    "packagekit",
    "snapd",
    "thermald",
    "acpid",
    "atd",
    "UU",
)

BORING_SYSTEMD_EXACT = {
    "ssh",
    "sshd",
    "cron",
    "crond",
    "docker",
    "containerd",
    "vmmon-agent",
    "rescue",
    "emergency",
    "rc-local",
    "getty-static",
    "console-setup",
    "keyboard-setup",
    "setvtrgb",
    " networking",
    "networking",
    "ifupdown-pre",
}

ALWAYS_SKIP_SYSTEMD_UNITS = {
    "ssh",
    "sshd",
    "docker",
    "containerd",
    "vmmon-agent",
}


def is_system_systemd_unit(unit_name: str) -> bool:
    """Return True if unit_name is an obvious OS/system service."""
    u = unit_name.strip().lower()
    if u.endswith(".service"):
        u = u[:-8]
    if u in BORING_SYSTEMD_EXACT:
        return True
    for pref in BORING_SYSTEMD_PREFIXES:
        if u.startswith(pref.lower()):
            return True
    return False


def parse_systemctl_list_units(text: str) -> List[Dict[str, str]]:
    """
    Parse output of `systemctl list-units --type=service --all --no-legend --no-pager --plain`.
    """
    units: List[Dict[str, str]] = []
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        # Handle optional leading bullet symbol '●' if --plain wasn't honored
        if line.startswith("●"):
            line = line[1:].strip()
        parts = line.split(None, 4)
        if len(parts) < 4:
            continue
        unit, load, active, sub = parts[0], parts[1], parts[2], parts[3]
        desc = parts[4] if len(parts) > 4 else ""
        if not unit.endswith(".service"):
            continue
        units.append(
            {
                "unit": unit,
                "name": unit[:-8],
                "load": load,
                "active": active,
                "sub": sub,
                "description": desc,
            }
        )
    return units


def parse_iso_timestamp(ts_str: Optional[str]) -> Optional[float]:
    """
    Parse Docker ISO-8601 timestamp (e.g. '2026-11-22T09:15:00.123456789Z') to Unix seconds.
    Returns None for zero/invalid timestamps ('0001-01-01T00:00:00Z').
    """
    if not ts_str or ts_str.startswith("0001-01-01"):
        return None
    s = ts_str.strip()
    try:
        # Handle Z suffix and nanoseconds for Python 3.7 compatibility
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        # Truncate fractional seconds to 6 digits if present
        m = re.match(
            r"^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?([+-]\d{2}:?\d{2})?$",
            s,
        )
        if m:
            base, frac, tz = m.group(1), m.group(2) or "0", m.group(3) or "+00:00"
            frac6 = (frac + "000000")[:6]
            if len(tz) == 5 and ":" not in tz:
                tz = tz[:3] + ":" + tz[3:]
            dt_obj = datetime.strptime(
                "{}.{}".format(base, frac6), "%Y-%m-%dT%H:%M:%S.%f"
            )
            sign = -1 if tz.startswith("-") else 1
            tz_h, tz_m = int(tz[1:3]), int(tz[4:6])
            offset_sec = sign * (tz_h * 3600 + tz_m * 60)
            epoch = dt_obj.replace(tzinfo=timezone.utc).timestamp() - offset_sec
            return float(epoch)
    except Exception:
        pass
    return None


# =====================================================================
# Docker Unix Domain Socket Client
# =====================================================================


class UnixHTTPConnection(http.client.HTTPConnection):
    """HTTPConnection speaking over a Unix domain socket (/var/run/docker.sock)."""

    def __init__(self, socket_path: str, timeout: float = 5.0) -> None:
        super().__init__("localhost", timeout=timeout)
        self.socket_path = socket_path

    def connect(self) -> None:
        af_unix = getattr(socket, "AF_UNIX", None)
        if af_unix is None:
            raise OSError("AF_UNIX not supported on this platform")
        sock = socket.socket(af_unix, socket.SOCK_STREAM)
        sock.settimeout(self.timeout)
        sock.connect(self.socket_path)
        self.sock = sock


class DockerClient:
    """Minimal Docker Engine API client over /var/run/docker.sock."""

    def __init__(self, socket_path: str = DOCKER_SOCK_PATH) -> None:
        self.socket_path = socket_path

    def is_available(self) -> bool:
        if getattr(socket, "AF_UNIX", None) is None:
            return False
        if not os.path.exists(self.socket_path):
            return False
        try:
            status, _, _ = self._request("GET", "/_ping", timeout=2.0)
            return status == 200
        except Exception:
            return False

    def _request(
        self,
        method: str,
        path: str,
        body: Optional[bytes] = None,
        timeout: float = 5.0,
    ) -> Tuple[int, Dict[str, str], bytes]:
        conn = UnixHTTPConnection(self.socket_path, timeout=timeout)
        try:
            headers = {"Host": "localhost", "User-Agent": "vmmon-agent/" + AGENT_VERSION}
            if body is not None:
                headers["Content-Type"] = "application/json"
                headers["Content-Length"] = str(len(body))
            conn.request(method, path, body=body, headers=headers)
            resp = conn.getresponse()
            data = resp.read()
            resp_headers = {k.lower(): v for k, v in resp.getheaders()}
            return (resp.status, resp_headers, data)
        finally:
            conn.close()

    def get_json(self, path: str, timeout: float = 5.0) -> Any:
        status, _, data = self._request("GET", path, timeout=timeout)
        if status < 200 or status >= 300:
            raise RuntimeError("Docker GET {} returned HTTP {}".format(path, status))
        return json.loads(data.decode("utf-8", errors="replace"))

    def list_containers(self, all_containers: bool = True) -> List[Dict[str, Any]]:
        flag = "1" if all_containers else "0"
        return self.get_json("/containers/json?all=" + flag, timeout=5.0)

    def inspect_container(self, container_id: str) -> Dict[str, Any]:
        safe_id = urllib.parse.quote(container_id, safe="")
        return self.get_json("/containers/{}/json".format(safe_id), timeout=5.0)

    def get_stats(self, container_id: str) -> Dict[str, Any]:
        safe_id = urllib.parse.quote(container_id, safe="")
        return self.get_json(
            "/containers/{}/stats?stream=false".format(safe_id), timeout=5.0
        )

    def get_logs(self, container_id: str, tail: int = 200) -> List[str]:
        safe_id = urllib.parse.quote(container_id, safe="")
        path = "/containers/{}/logs?stdout=1&stderr=1&tail={}&timestamps=1".format(
            safe_id, int(tail)
        )
        status, _, data = self._request("GET", path, timeout=5.0)
        if status < 200 or status >= 300:
            raise RuntimeError("Docker logs returned HTTP {}".format(status))
        return demux_docker_logs(data)

    def container_action(self, container_id: str, action: str) -> Tuple[bool, str]:
        if action not in ("start", "stop", "restart"):
            return (False, "Invalid action")
        safe_id = urllib.parse.quote(container_id, safe="")
        status, _, data = self._request(
            "POST", "/containers/{}/{}".format(safe_id, action), timeout=25.0
        )
        # 204 = success, 304 = already in desired state
        if status in (200, 204, 304):
            return (True, "")
        msg = data.decode("utf-8", errors="replace").strip()
        try:
            err_json = json.loads(msg)
            msg = err_json.get("message", msg)
        except Exception:
            pass
        return (False, msg or "Docker HTTP {}".format(status))


def compute_docker_stats_summary(stats_obj: Dict[str, Any]) -> Dict[str, Any]:
    """
    Extract cpu_percent, mem_bytes, mem_limit from Docker /containers/{id}/stats?stream=false JSON.
    """
    cpu_percent = 0.0
    try:
        cpu_stats = stats_obj.get("cpu_stats") or {}
        precpu_stats = stats_obj.get("precpu_stats") or {}
        cpu_usage = cpu_stats.get("cpu_usage") or {}
        precpu_usage = precpu_stats.get("cpu_usage") or {}

        cpu_delta = int(cpu_usage.get("total_usage", 0)) - int(
            precpu_usage.get("total_usage", 0)
        )
        sys_delta = int(cpu_stats.get("system_cpu_usage", 0)) - int(
            precpu_stats.get("system_cpu_usage", 0)
        )
        online_cpus = int(
            cpu_stats.get("online_cpus")
            or len(cpu_usage.get("percpu_usage") or [])
            or 1
        )
        if cpu_delta > 0 and sys_delta > 0:
            cpu_percent = round((cpu_delta / sys_delta) * online_cpus * 100.0, 1)
    except Exception:
        cpu_percent = 0.0

    mem_bytes = 0
    mem_limit = 0
    try:
        mem_stats = stats_obj.get("memory_stats") or {}
        usage = int(mem_stats.get("usage", 0))
        stats_detail = mem_stats.get("stats") or {}
        inactive_file = int(
            stats_detail.get("inactive_file")
            or stats_detail.get("total_inactive_file")
            or stats_detail.get("cache")
            or 0
        )
        mem_bytes = max(0, usage - inactive_file)
        mem_limit = int(mem_stats.get("limit", 0))
    except Exception:
        pass

    return {
        "cpu_percent": cpu_percent,
        "mem_bytes": mem_bytes,
        "mem_limit": mem_limit,
    }


# =====================================================================
# Host File Reading & Probe Helpers
# =====================================================================


def read_text_file(path: str) -> Optional[str]:
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            return f.read()
    except OSError:
        return None


def probe_http_endpoint(
    scheme: str,
    port: int,
    path: str = "/",
    host: str = "127.0.0.1",
    timeout: float = 3.0,
) -> Dict[str, Any]:
    """
    Perform an HTTP/HTTPS health check without following redirects and ignoring TLS certificate errors.
    Any HTTP status < 500 counts as ok=True.
    """
    t0 = time.monotonic()
    ts = round(time.time(), 3)
    norm_path = path if path.startswith("/") else "/" + path
    conn: Optional[http.client.HTTPConnection] = None
    try:
        if scheme.lower() == "https":
            ctx = ssl._create_unverified_context()
            conn = http.client.HTTPSConnection(host, port, timeout=timeout, context=ctx)
        else:
            conn = http.client.HTTPConnection(host, port, timeout=timeout)

        conn.request(
            "GET",
            norm_path,
            headers={
                "Host": "{}:{}".format(host, port),
                "User-Agent": "vmmon-agent/" + AGENT_VERSION,
                "Connection": "close",
            },
        )
        resp = conn.getresponse()
        resp.read(512)
        latency_ms = round((time.monotonic() - t0) * 1000.0, 1)
        code = int(resp.status)
        ok = code < 500
        return {
            "ok": ok,
            "code": code,
            "latency_ms": latency_ms,
            "ts": ts,
            "error": None if ok else "HTTP {}".format(code),
        }
    except Exception as exc:
        latency_ms = round((time.monotonic() - t0) * 1000.0, 1)
        return {
            "ok": False,
            "code": None,
            "latency_ms": latency_ms,
            "ts": ts,
            "error": str(exc)[:160],
        }
    finally:
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass


def probe_tcp_port(
    port: int, host: str = "127.0.0.1", timeout: float = 3.0
) -> Dict[str, Any]:
    """Perform a TCP connect health check for non-web services."""
    t0 = time.monotonic()
    ts = round(time.time(), 3)
    try:
        with socket.create_connection((host, port), timeout=timeout):
            latency_ms = round((time.monotonic() - t0) * 1000.0, 1)
            return {
                "ok": True,
                "code": None,
                "latency_ms": latency_ms,
                "ts": ts,
                "error": None,
            }
    except Exception as exc:
        latency_ms = round((time.monotonic() - t0) * 1000.0, 1)
        return {
            "ok": False,
            "code": None,
            "latency_ms": latency_ms,
            "ts": ts,
            "error": str(exc)[:160],
        }


# =====================================================================
# Agent State & Background Samplers
# =====================================================================


class AgentState:
    """
    Holds thread-safe caches for system info, 1s metrics, top processes,
    discovered services, Docker container stats, and health checks.
    """

    def __init__(self, config: Dict[str, Any]) -> None:
        self.config = config
        self.docker = DockerClient()
        self.lock = threading.Lock()
        self.refresh_event = threading.Event()
        self.stop_event = threading.Event()

        try:
            self.page_size = os.sysconf("SC_PAGE_SIZE")
        except (AttributeError, ValueError):
            self.page_size = 4096

        try:
            self.clk_tck = os.sysconf("SC_CLK_TCK")
        except (AttributeError, ValueError):
            self.clk_tck = 100

        # Previous sampler snapshots for delta calculations
        self._prev_sample_mono: Optional[float] = None
        self._prev_cpu_stat: Optional[Dict[str, Any]] = None
        self._prev_diskstats: Dict[str, Dict[str, int]] = {}
        self._prev_netdev: Dict[str, Dict[str, int]] = {}
        self._prev_proc_ticks: Dict[int, int] = {}
        self._prev_total_cpu_ticks: int = 0
        self._uid_cache: Dict[int, str] = {}

        # Caches served directly by HTTP endpoints
        self._info_cache: Dict[str, Any] = {}
        self._metrics_cache: Dict[str, Any] = self._default_metrics()
        self._top_procs_cache: List[Dict[str, Any]] = []
        self._proc_snapshot_by_pid: Dict[int, Dict[str, Any]] = {}
        self._services_cache: Dict[str, Any] = {"ts": round(time.time(), 3), "services": []}
        self._service_lookup: Dict[str, Dict[str, Any]] = {}

        # Background caches for docker stats & health checks
        self._docker_stats_cache: Dict[str, Dict[str, Any]] = {}
        self._health_check_cache: Dict[str, Dict[str, Any]] = {}
        # Cache of HTTP probe results on unknown TCP ports: (service_id, port) -> Optional[{"port": int, "scheme": str, "path": str}]
        self._probed_web_cache: Dict[Tuple[str, int], Optional[Dict[str, Any]]] = {}

    def _default_metrics(self) -> Dict[str, Any]:
        return {
            "ts": round(time.time(), 3),
            "uptime": 0.0,
            "cpu": {"percent": 0.0, "per_core": [], "iowait": 0.0, "steal": 0.0},
            "load": [0.0, 0.0, 0.0],
            "mem": {
                "total": 0,
                "used": 0,
                "available": 0,
                "percent": 0.0,
                "buffers": 0,
                "cached": 0,
                "swap_total": 0,
                "swap_used": 0,
            },
            "disks": [],
            "disk_io": {"read_bps": 0, "write_bps": 0, "read_iops": 0, "write_iops": 0},
            "net": {
                "rx_bps": 0,
                "tx_bps": 0,
                "rx_total": 0,
                "tx_total": 0,
                "interfaces": [],
            },
            "procs": 0,
            "tcp": {"established": 0, "listen": 0, "time_wait": 0},
        }

    def start_background_workers(self) -> None:
        # Take initial synchronous metrics snapshot so endpoints have data immediately
        try:
            self.sample_metrics_once()
        except Exception as exc:
            logger.warning("Initial metrics sample error: %s", exc)

        try:
            self.sample_info_once()
        except Exception as exc:
            logger.warning("Initial info sample error: %s", exc)

        try:
            self.discover_services_once()
        except Exception as exc:
            logger.warning("Initial service discovery error: %s", exc)

        threads = [
            threading.Thread(
                target=self._metrics_loop, name="vmmon-metrics", daemon=True
            ),
            threading.Thread(
                target=self._discovery_loop, name="vmmon-discovery", daemon=True
            ),
            threading.Thread(
                target=self._docker_stats_loop, name="vmmon-docker-stats", daemon=True
            ),
            threading.Thread(
                target=self._health_check_loop, name="vmmon-health-check", daemon=True
            ),
        ]
        for t in threads:
            t.start()

    # -----------------------------------------------------------------
    # Info Collection
    # -----------------------------------------------------------------
    def sample_info_once(self) -> Dict[str, Any]:
        hostname = socket.gethostname()
        os_pretty = self._read_os_pretty_name()
        kernel = platform.release()
        arch = platform.machine() or "unknown"
        cpu_model = self._read_cpu_model()
        cpu_count = os.cpu_count() or 1

        meminfo_text = read_text_file("/proc/meminfo") or ""
        mem_parsed = parse_proc_meminfo(meminfo_text)
        mem_total = mem_parsed.get("total", 0)

        stat_text = read_text_file("/proc/stat") or ""
        stat_parsed = parse_proc_stat(stat_text)
        boot_time = stat_parsed.get("btime")
        if boot_time is None:
            uptime = self._read_uptime()
            boot_time = round(time.time() - uptime, 1)

        has_docker = self.docker.is_available()
        has_systemd = os.path.isdir("/run/systemd/system")

        info = {
            "agent_version": AGENT_VERSION,
            "hostname": hostname,
            "os": os_pretty,
            "kernel": kernel,
            "arch": arch,
            "cpu_model": cpu_model,
            "cpu_count": cpu_count,
            "mem_total": mem_total,
            "boot_time": float(boot_time),
            "docker": has_docker,
            "systemd": has_systemd,
        }
        with self.lock:
            self._info_cache = info
        return info

    def _read_os_pretty_name(self) -> str:
        text = read_text_file("/etc/os-release")
        if text:
            kv: Dict[str, str] = {}
            for line in text.splitlines():
                if "=" in line:
                    k, v = line.split("=", 1)
                    kv[k.strip()] = v.strip().strip('"').strip("'")
            if "PRETTY_NAME" in kv:
                return kv["PRETTY_NAME"]
            if "NAME" in kv:
                return (kv["NAME"] + " " + kv.get("VERSION", "")).strip()
        return platform.platform()

    def _read_cpu_model(self) -> str:
        text = read_text_file("/proc/cpuinfo")
        if text:
            for key in ("model name", "Model", "Hardware", "Processor"):
                for line in text.splitlines():
                    if ":" in line:
                        k, v = line.split(":", 1)
                        if k.strip().lower() == key.lower() and v.strip():
                            return v.strip()
        return platform.processor() or "Generic CPU"

    def _read_uptime(self) -> float:
        text = read_text_file("/proc/uptime")
        if text:
            parts = text.split()
            if parts:
                try:
                    return round(float(parts[0]), 1)
                except ValueError:
                    pass
        return 0.0

    def _read_loadavg(self) -> List[float]:
        text = read_text_file("/proc/loadavg")
        if text:
            parts = text.split()
            if len(parts) >= 3:
                try:
                    return [
                        round(float(parts[0]), 2),
                        round(float(parts[1]), 2),
                        round(float(parts[2]), 2),
                    ]
                except ValueError:
                    pass
        if hasattr(os, "getloadavg"):
            try:
                l1, l5, l15 = os.getloadavg()  # type: ignore
                return [round(l1, 2), round(l5, 2), round(l15, 2)]
            except OSError:
                pass
        return [0.0, 0.0, 0.0]

    def _read_disks(self) -> List[Dict[str, Any]]:
        mounts_text = read_text_file("/proc/mounts") or ""
        mounts = parse_proc_mounts(mounts_text)
        statvfs_fn = getattr(os, "statvfs", None)
        if statvfs_fn is None:
            return []

        disks: List[Dict[str, Any]] = []
        for m in mounts:
            mount_path = m["mount"]
            try:
                st = statvfs_fn(mount_path)
            except OSError:
                continue
            frsize = st.f_frsize or st.f_bsize or 4096
            total = int(st.f_blocks * frsize)
            if total <= 0:
                continue
            free = int(st.f_bavail * frsize)
            used = max(0, int((st.f_blocks - st.f_bfree) * frsize))
            percent = round((used / total) * 100.0, 1) if total > 0 else 0.0
            disks.append(
                {
                    "mount": mount_path,
                    "device": m["device"],
                    "fs": m["fs"],
                    "total": total,
                    "used": used,
                    "free": free,
                    "percent": percent,
                }
            )
        return disks

    def _resolve_username(self, uid: int) -> str:
        if uid in self._uid_cache:
            return self._uid_cache[uid]
        name = str(uid)
        if pwd is not None:
            try:
                name = pwd.getpwuid(uid).pw_name
            except KeyError:
                name = str(uid)
        self._uid_cache[uid] = name
        return name

    # -----------------------------------------------------------------
    # 1s Metrics & Process Sampler
    # -----------------------------------------------------------------
    def _metrics_loop(self) -> None:
        while not self.stop_event.wait(1.0):
            try:
                self.sample_metrics_once()
            except Exception as exc:
                logger.debug("Metrics sampler error: %s", exc)

    def sample_metrics_once(self) -> None:
        now_ts = round(time.time(), 3)
        now_mono = time.monotonic()
        dt = (
            (now_mono - self._prev_sample_mono)
            if self._prev_sample_mono is not None
            else 0.0
        )

        uptime = self._read_uptime()
        load = self._read_loadavg()

        # CPU
        stat_text = read_text_file("/proc/stat") or ""
        curr_cpu_stat = parse_proc_stat(stat_text)
        if self._prev_cpu_stat is not None and dt > 0:
            cpu_metrics = compute_cpu_percent(self._prev_cpu_stat, curr_cpu_stat)
        else:
            core_cnt = len(curr_cpu_stat.get("cores", []))
            cpu_metrics = {
                "percent": 0.0,
                "per_core": [0.0] * core_cnt,
                "iowait": 0.0,
                "steal": 0.0,
            }

        # Memory
        meminfo_text = read_text_file("/proc/meminfo") or ""
        mem_metrics = parse_proc_meminfo(meminfo_text)

        # Disks
        disks = self._read_disks()

        # Disk IO
        diskstats_text = read_text_file("/proc/diskstats") or ""
        curr_diskstats = parse_proc_diskstats(diskstats_text)
        if self._prev_diskstats and dt > 0:
            disk_io = compute_disk_io_metrics(
                self._prev_diskstats, curr_diskstats, dt
            )
        else:
            disk_io = {
                "read_bps": 0,
                "write_bps": 0,
                "read_iops": 0,
                "write_iops": 0,
            }

        # Network
        netdev_text = read_text_file("/proc/net/dev") or ""
        curr_netdev = parse_proc_net_dev(netdev_text)
        net_metrics = compute_net_metrics(self._prev_netdev, curr_netdev, dt)

        # TCP states
        tcp4_text = read_text_file("/proc/net/tcp") or ""
        tcp6_text = read_text_file("/proc/net/tcp6") or ""
        tcp_entries = parse_proc_net_tcp(tcp4_text) + parse_proc_net_tcp(tcp6_text)
        tcp_summary = summarize_tcp_states(tcp_entries)

        # Processes & per-process CPU
        curr_total_ticks = sum(curr_cpu_stat.get("total", (0,) * 8))
        total_ticks_delta = max(0, curr_total_ticks - self._prev_total_cpu_ticks)
        cpu_count = max(1, len(curr_cpu_stat.get("cores", [])) or (os.cpu_count() or 1))
        proc_count, top_procs, by_pid, curr_proc_ticks = self._sample_processes(
            total_ticks_delta, cpu_count
        )

        self._prev_sample_mono = now_mono
        self._prev_cpu_stat = curr_cpu_stat
        self._prev_diskstats = curr_diskstats
        self._prev_netdev = curr_netdev
        self._prev_total_cpu_ticks = curr_total_ticks
        self._prev_proc_ticks = curr_proc_ticks

        metrics = {
            "ts": now_ts,
            "uptime": uptime,
            "cpu": cpu_metrics,
            "load": load,
            "mem": mem_metrics,
            "disks": disks,
            "disk_io": disk_io,
            "net": net_metrics,
            "procs": proc_count,
            "tcp": tcp_summary,
        }

        with self.lock:
            self._metrics_cache = metrics
            self._top_procs_cache = top_procs
            self._proc_snapshot_by_pid = by_pid

    def _sample_processes(
        self, total_ticks_delta: int, cpu_count: int
    ) -> Tuple[
        int,
        List[Dict[str, Any]],
        Dict[int, Dict[str, Any]],
        Dict[int, int],
    ]:
        if not os.path.isdir("/proc"):
            return (0, [], {}, {})

        try:
            pid_names = [d for d in os.listdir("/proc") if d.isdigit()]
        except OSError:
            return (0, [], {}, {})

        proc_count = len(pid_names)
        curr_ticks: Dict[int, int] = {}
        raw_procs: List[Dict[str, Any]] = []

        for pid_str in pid_names:
            pid = int(pid_str)
            stat_text = read_text_file("/proc/{}/stat".format(pid_str))
            if not stat_text:
                continue
            parsed = parse_proc_pid_stat(stat_text)
            if not parsed:
                continue

            ticks = parsed["ticks"]
            curr_ticks[pid] = ticks
            prev_t = self._prev_proc_ticks.get(pid)
            if prev_t is not None and total_ticks_delta > 0:
                delta_t = max(0, ticks - prev_t)
                cpu_pct = round(
                    min(100.0 * cpu_count, (delta_t / total_ticks_delta) * 100.0 * cpu_count),
                    1,
                )
            else:
                cpu_pct = 0.0

            mem_bytes = int(parsed["rss_pages"] * self.page_size)
            raw_procs.append(
                {
                    "pid": pid,
                    "name": parsed["name"],
                    "cpu_percent": cpu_pct,
                    "mem_bytes": mem_bytes,
                    "starttime": parsed["starttime"],
                }
            )

        raw_procs.sort(
            key=lambda p: (p["cpu_percent"], p["mem_bytes"]), reverse=True
        )

        by_pid: Dict[int, Dict[str, Any]] = {}
        top_procs: List[Dict[str, Any]] = []
        for idx, p in enumerate(raw_procs):
            pid = p["pid"]
            by_pid[pid] = p
            # Enrich top 100 processes with cmdline and user to avoid unnecessary /proc reads
            if idx < 100:
                uid = 0
                try:
                    uid = os.stat("/proc/{}".format(pid)).st_uid
                except OSError:
                    pass
                cmdline_raw = read_text_file("/proc/{}/cmdline".format(pid)) or ""
                cmdline = cmdline_raw.replace("\x00", " ").strip()
                if not cmdline:
                    cmdline = p["name"]
                if len(cmdline) > 300:
                    cmdline = cmdline[:297] + "..."
                enriched = {
                    "pid": pid,
                    "name": p["name"],
                    "user": self._resolve_username(uid),
                    "cpu_percent": p["cpu_percent"],
                    "mem_bytes": p["mem_bytes"],
                    "cmdline": cmdline,
                }
                p["cmdline"] = cmdline
                top_procs.append(enriched)

        return (proc_count, top_procs, by_pid, curr_ticks)

    # -----------------------------------------------------------------
    # Docker Stats Background Worker (at most every 10s)
    # -----------------------------------------------------------------
    def _docker_stats_loop(self) -> None:
        while not self.stop_event.is_set():
            try:
                self._refresh_docker_stats()
            except Exception as exc:
                logger.debug("Docker stats worker error: %s", exc)
            self.stop_event.wait(10.0)

    def _refresh_docker_stats(self) -> None:
        if not self.docker.is_available():
            return
        try:
            containers = self.docker.list_containers(all_containers=False)
        except Exception:
            return

        updated: Dict[str, Dict[str, Any]] = {}
        for c in containers:
            cid = (c.get("Id") or "")[:12]
            if not cid:
                continue
            try:
                raw_stats = self.docker.get_stats(cid)
                updated[cid] = compute_docker_stats_summary(raw_stats)
            except Exception:
                continue

        with self.lock:
            self._docker_stats_cache.update(updated)

    # -----------------------------------------------------------------
    # Service Discovery Loop
    # -----------------------------------------------------------------
    def _discovery_loop(self) -> None:
        interval = max(3.0, min(5.0, float(self.config.get("check_interval", 10))))
        while not self.stop_event.is_set():
            self.refresh_event.wait(interval)
            self.refresh_event.clear()
            if self.stop_event.is_set():
                break
            try:
                self.discover_services_once()
            except Exception as exc:
                logger.warning("Discovery worker error: %s", exc)

    def _scan_listening_sockets(self) -> List[Dict[str, Any]]:
        """
        Scan /proc/net/tcp{,6} for LISTEN (0A) sockets and map inodes to /proc/<pid>/fd.
        """
        tcp4_text = read_text_file("/proc/net/tcp") or ""
        tcp6_text = read_text_file("/proc/net/tcp6") or ""
        all_tcp = parse_proc_net_tcp(tcp4_text) + parse_proc_net_tcp(tcp6_text)

        listeners_by_inode: Dict[int, Dict[str, Any]] = {}
        for entry in all_tcp:
            if entry["state"] != "0A":
                continue
            inode = entry["inode"]
            if inode <= 0:
                continue
            listeners_by_inode[inode] = entry

        if not listeners_by_inode or not os.path.isdir("/proc"):
            return []

        inode_owner: Dict[int, int] = {}
        try:
            pids = [d for d in os.listdir("/proc") if d.isdigit()]
        except OSError:
            pids = []

        for pid_str in pids:
            fd_dir = "/proc/{}/fd".format(pid_str)
            try:
                fds = os.listdir(fd_dir)
            except OSError:
                continue
            for fd in fds:
                try:
                    target = os.readlink("{}/{}".format(fd_dir, fd))
                except OSError:
                    continue
                if target.startswith("socket:[") and target.endswith("]"):
                    try:
                        ino = int(target[8:-1])
                    except ValueError:
                        continue
                    if ino in listeners_by_inode and ino not in inode_owner:
                        inode_owner[ino] = int(pid_str)

        pid_meta_cache: Dict[int, Dict[str, Any]] = {}
        results: List[Dict[str, Any]] = []

        for ino, sock_entry in listeners_by_inode.items():
            pid = inode_owner.get(ino)
            meta: Dict[str, Any] = {
                "pid": pid,
                "comm": "",
                "cmdline": "",
                "docker_id": None,
                "systemd_unit": None,
            }
            if pid is not None:
                if pid not in pid_meta_cache:
                    comm = (read_text_file("/proc/{}/comm".format(pid)) or "").strip()
                    cmd_raw = read_text_file("/proc/{}/cmdline".format(pid)) or ""
                    cmdline = cmd_raw.replace("\x00", " ").strip() or comm
                    if len(cmdline) > 300:
                        cmdline = cmdline[:297] + "..."
                    cg_text = read_text_file("/proc/{}/cgroup".format(pid)) or ""
                    docker_id, systemd_unit = extract_cgroup_owner(cg_text)
                    pid_meta_cache[pid] = {
                        "pid": pid,
                        "comm": comm,
                        "cmdline": cmdline,
                        "docker_id": docker_id,
                        "systemd_unit": systemd_unit,
                    }
                meta = pid_meta_cache[pid]

            results.append(
                {
                    "port": sock_entry["local_port"],
                    "proto": "tcp",
                    "bind": sock_entry["local_ip"],
                    "host_port": sock_entry["local_port"],
                    "inode": ino,
                    "pid": meta["pid"],
                    "comm": meta["comm"],
                    "cmdline": meta["cmdline"],
                    "docker_id": meta["docker_id"],
                    "systemd_unit": meta["systemd_unit"],
                }
            )
        return results

    def _dedup_ports(self, ports: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Deduplicate port entries (prefer 0.0.0.0 or 127.0.0.1 over IPv6 :: duplicate)."""
        by_key: Dict[Tuple[int, int, str], Dict[str, Any]] = {}
        for p in ports:
            c_port = int(p.get("port", 0))
            h_port = int(p.get("host_port") or c_port)
            proto = str(p.get("proto", "tcp"))
            bind = str(p.get("bind") or "0.0.0.0")
            key = (c_port, h_port, proto)
            if key not in by_key:
                by_key[key] = {
                    "port": c_port,
                    "proto": proto,
                    "bind": "0.0.0.0" if bind in ("::", "0.0.0.0", "*") else bind,
                    "host_port": h_port,
                }
            else:
                if by_key[key]["bind"] in ("::", "::1") and bind in ("0.0.0.0", "127.0.0.1"):
                    by_key[key]["bind"] = bind
        return sorted(by_key.values(), key=lambda x: (x["host_port"], x["port"]))

    def _get_bt_admin_path(self) -> Optional[str]:
        return read_text_file("/www/server/panel/data/admin_path.pl")

    def _get_proc_info_for_pid(
        self, pid: Optional[int], fallback_name: str = ""
    ) -> Optional[Dict[str, Any]]:
        if not pid or pid <= 0:
            return None
        with self.lock:
            snap = dict(self._proc_snapshot_by_pid.get(pid) or {})
        name = snap.get("name") or (
            read_text_file("/proc/{}/comm".format(pid)) or fallback_name
        ).strip()
        cmdline = snap.get("cmdline")
        if not cmdline:
            cmd_raw = read_text_file("/proc/{}/cmdline".format(pid)) or ""
            cmdline = cmd_raw.replace("\x00", " ").strip() or name
            if len(cmdline) > 300:
                cmdline = cmdline[:297] + "..."
        return {
            "pid": pid,
            "name": name,
            "cmdline": cmdline,
            "cpu_percent": float(snap.get("cpu_percent", 0.0)),
            "mem_bytes": int(snap.get("mem_bytes", 0)),
        }

    def discover_services_once(self) -> List[Dict[str, Any]]:
        now_ts = round(time.time(), 3)
        agent_pid = os.getpid()
        agent_port = int(self.config.get("port", DEFAULT_PORT))
        hidden_set = set(self.config.get("hidden") or [])
        bt_admin_path = self._get_bt_admin_path()
        system_uptime = self._read_uptime()

        listeners = self._scan_listening_sockets()

        # Group listeners by docker container id and by systemd unit
        docker_listeners: Dict[str, List[Dict[str, Any]]] = {}
        systemd_listeners: Dict[str, List[Dict[str, Any]]] = {}
        unclaimed_listeners: List[Dict[str, Any]] = []

        for lst in listeners:
            # Skip sshd (port 22) and the agent itself
            if lst["port"] == 22 or lst["comm"] == "sshd":
                continue
            if lst["pid"] == agent_pid or lst["port"] == agent_port:
                continue
            if lst["comm"] in ("docker-proxy", "dockerd", "containerd", "containerd-shim", "containerd-shim-runc-v2"):
                continue

            if lst["docker_id"]:
                short_id = lst["docker_id"][:12]
                docker_listeners.setdefault(short_id, []).append(lst)
            elif lst["systemd_unit"]:
                systemd_listeners.setdefault(lst["systemd_unit"], []).append(lst)
            else:
                unclaimed_listeners.append(lst)

        services: List[Dict[str, Any]] = []
        lookup: Dict[str, Dict[str, Any]] = {}
        claimed_host_ports: set = set()

        # 1. Docker services
        if self.docker.is_available():
            for svc in self._discover_docker_services(
                docker_listeners, bt_admin_path, now_ts
            ):
                if svc["id"] in hidden_set or svc["name"] in hidden_set:
                    continue
                for p in svc["ports"]:
                    claimed_host_ports.add(p["host_port"])
                services.append(svc)
                lookup[svc["id"]] = svc

        # 2. systemd services
        if os.path.isdir("/run/systemd/system"):
            for svc in self._discover_systemd_services(
                systemd_listeners, bt_admin_path, system_uptime
            ):
                if svc["id"] in hidden_set or svc["name"] in hidden_set:
                    continue
                for p in svc["ports"]:
                    claimed_host_ports.add(p["host_port"])
                services.append(svc)
                lookup[svc["id"]] = svc

        # 3. Remaining listening processes
        for svc in self._discover_process_services(
            unclaimed_listeners, claimed_host_ports, bt_admin_path, system_uptime
        ):
            if svc["id"] in hidden_set or svc["name"] in hidden_set:
                continue
            services.append(svc)
            lookup[svc["id"]] = svc

        # 4. Manual services from config
        for svc in self._discover_manual_services():
            if svc["id"] in hidden_set or svc["name"] in hidden_set:
                continue
            services.append(svc)
            lookup[svc["id"]] = svc

        # Attach cached health check & probed web info and compute health classification
        with self.lock:
            for svc in services:
                sid = svc["id"]
                if svc["web"] is None and svc["ports"]:
                    for p in svc["ports"]:
                        hp = p["host_port"]
                        probed = self._probed_web_cache.get((sid, hp))
                        if probed:
                            svc["web"] = dict(probed)
                            break

                chk = self._health_check_cache.get(sid)
                if svc["status"] != "running":
                    chk = None
                svc["check"] = chk
                c_health = (
                    svc["container"]["health"] if svc.get("container") else None
                )
                exit_code = svc.pop("_exit_code", None)
                svc["health"] = classify_health(
                    svc["status"],
                    check=chk,
                    container_health=c_health,
                    exit_code=exit_code,
                )

            self._services_cache = {"ts": now_ts, "services": services}
            self._service_lookup = lookup

        return services

    def _discover_docker_services(
        self,
        docker_listeners: Dict[str, List[Dict[str, Any]]],
        bt_admin_path: Optional[str],
        now_ts: float,
    ) -> List[Dict[str, Any]]:
        results: List[Dict[str, Any]] = []
        try:
            containers = self.docker.list_containers(all_containers=True)
        except Exception as exc:
            logger.debug("Docker list_containers failed: %s", exc)
            return results

        for c in containers:
            try:
                full_id = c.get("Id") or ""
                short_id = full_id[:12]
                names = c.get("Names") or []
                name = (names[0].lstrip("/") if names else short_id) or short_id
                service_id = "docker:{}".format(name)
                image = c.get("Image") or ""

                inspect_data: Dict[str, Any] = {}
                try:
                    inspect_data = self.docker.inspect_container(full_id or short_id)
                except Exception:
                    pass

                state_obj = inspect_data.get("State") or {}
                raw_state = (state_obj.get("Status") or c.get("State") or "unknown").lower()
                exit_code = state_obj.get("ExitCode")
                restarts = int(inspect_data.get("RestartCount") or 0)
                health_obj = state_obj.get("Health") or {}
                container_health = health_obj.get("Status")
                pid = int(state_obj.get("Pid") or 0)

                if raw_state == "running":
                    status = "running"
                elif raw_state == "restarting":
                    status = "restarting"
                elif raw_state == "dead":
                    status = "failed"
                elif raw_state in ("exited", "created", "paused"):
                    status = "stopped"
                else:
                    status = "unknown"

                uptime: Optional[float] = None
                if status == "running":
                    started_ts = parse_iso_timestamp(state_obj.get("StartedAt"))
                    if started_ts is not None:
                        uptime = round(max(0.0, now_ts - started_ts), 1)

                # Ports from Docker API + host-network cgroup sockets
                raw_ports: List[Dict[str, Any]] = []
                for p in c.get("Ports") or []:
                    if (p.get("Type") or "tcp").lower() != "tcp":
                        continue
                    priv_port = int(p.get("PrivatePort") or 0)
                    pub_port = int(p.get("PublicPort") or 0)
                    if pub_port > 0:
                        raw_ports.append(
                            {
                                "port": priv_port or pub_port,
                                "proto": "tcp",
                                "bind": p.get("IP") or "0.0.0.0",
                                "host_port": pub_port,
                            }
                        )

                for lst in docker_listeners.get(short_id, []):
                    raw_ports.append(
                        {
                            "port": lst["port"],
                            "proto": "tcp",
                            "bind": lst["bind"],
                            "host_port": lst["host_port"],
                        }
                    )

                ports = self._dedup_ports(raw_ports)
                fp = match_fingerprint(
                    image=image,
                    process=name,
                    ports=ports,
                    bt_admin_path=bt_admin_path,
                )

                labels = (
                    (inspect_data.get("Config") or {}).get("Labels")
                    or c.get("Labels")
                    or {}
                )
                compose_project = labels.get("com.docker.compose.project")

                with self.lock:
                    stats = dict(self._docker_stats_cache.get(short_id) or {})

                container_info = {
                    "id": short_id,
                    "image": image,
                    "state": raw_state,
                    "health": container_health,
                    "restarts": restarts,
                    "cpu_percent": float(stats.get("cpu_percent", 0.0)),
                    "mem_bytes": int(stats.get("mem_bytes", 0)),
                    "mem_limit": int(stats.get("mem_limit", 0)),
                    "compose_project": compose_project,
                }

                proc_info = self._get_proc_info_for_pid(pid, fallback_name=name) if status == "running" else None

                results.append(
                    {
                        "id": service_id,
                        "name": name,
                        "display_name": fp["display_name"] if fp["matched"] else prettify_service_name(name),
                        "kind": fp["kind"],
                        "category": fp["category"],
                        "source": "docker",
                        "status": status,
                        "health": "unknown",
                        "ports": ports,
                        "web": fp["web"],
                        "check": None,
                        "uptime": uptime,
                        "container": container_info,
                        "systemd": None,
                        "process": proc_info,
                        "_exit_code": exit_code,
                        "_container_id": full_id or short_id,
                    }
                )
            except Exception as exc:
                logger.debug("Error discovering docker container: %s", exc)
                continue

        return results

    def _discover_systemd_services(
        self,
        systemd_listeners: Dict[str, List[Dict[str, Any]]],
        bt_admin_path: Optional[str],
        system_uptime: float,
    ) -> List[Dict[str, Any]]:
        results: List[Dict[str, Any]] = []
        try:
            proc = subprocess.run(
                [
                    "systemctl",
                    "list-units",
                    "--type=service",
                    "--all",
                    "--no-legend",
                    "--no-pager",
                    "--plain",
                ],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                universal_newlines=True,
                timeout=5.0,
            )
            if proc.returncode != 0 and not proc.stdout:
                return results
            units = parse_systemctl_list_units(proc.stdout)
        except Exception as exc:
            logger.debug("systemctl list-units failed: %s", exc)
            return results

        selected: List[Tuple[Dict[str, str], Dict[str, Any], List[Dict[str, Any]], bool]] = []
        for u in units:
            unit_full = u["unit"]
            unit_name = u["name"]
            if unit_name.lower() in ALWAYS_SKIP_SYSTEMD_UNITS:
                continue
            if u["load"] == "not-found":
                continue

            is_failed = u["active"] == "failed" or u["sub"] == "failed"
            is_sys = is_system_systemd_unit(unit_name)
            unit_ports = self._dedup_ports(systemd_listeners.get(unit_full, []))
            fp = match_fingerprint(
                unit=unit_name,
                ports=unit_ports,
                bt_admin_path=bt_admin_path,
            )

            # Exclusion rule: exclude obvious system units except report them if failed
            if is_sys:
                if is_failed:
                    selected.append((u, fp, unit_ports, True))
                continue

            # Include if (a) fingerprint-matched, (b) owns a listening TCP port, or (c) failed
            if fp["matched"] or bool(unit_ports) or is_failed:
                selected.append((u, fp, unit_ports, is_failed))

        if not selected:
            return results

        # Batch fetch MainPID & ActiveEnterTimestampMonotonic for selected units
        unit_props = self._batch_systemctl_show([item[0]["unit"] for item in selected])

        for u, fp, unit_ports, is_failed in selected:
            try:
                unit_full = u["unit"]
                unit_name = u["name"]
                props = unit_props.get(unit_full, {})
                pid = int(props.get("MainPID") or 0)
                active = props.get("ActiveState") or u["active"]
                sub = props.get("SubState") or u["sub"]

                if active == "failed" or sub == "failed":
                    status = "failed"
                elif active == "active" and sub in ("running", "exited", "listening"):
                    status = "running"
                elif active in ("activating", "reloading") or sub == "auto-restart":
                    status = "restarting"
                elif active in ("inactive", "deactivating"):
                    status = "stopped"
                else:
                    status = "unknown"

                uptime: Optional[float] = None
                if status == "running":
                    mono_us = int(props.get("ActiveEnterTimestampMonotonic") or 0)
                    if mono_us > 0 and system_uptime > 0:
                        uptime = round(max(0.0, system_uptime - (mono_us / 1_000_000.0)), 1)

                proc_info = self._get_proc_info_for_pid(pid, fallback_name=unit_name) if pid > 0 else None
                if not fp["matched"] and proc_info:
                    fp = match_fingerprint(
                        unit=unit_name,
                        process=proc_info["name"],
                        cmdline=proc_info["cmdline"],
                        ports=unit_ports,
                        bt_admin_path=bt_admin_path,
                    )

                category = fp["category"]
                if is_system_systemd_unit(unit_name) and is_failed:
                    category = "system"

                results.append(
                    {
                        "id": "systemd:{}".format(unit_name),
                        "name": unit_name,
                        "display_name": fp["display_name"] if fp["matched"] else prettify_service_name(unit_name),
                        "kind": fp["kind"],
                        "category": category,
                        "source": "systemd",
                        "status": status,
                        "health": "unknown",
                        "ports": unit_ports,
                        "web": fp["web"],
                        "check": None,
                        "uptime": uptime,
                        "container": None,
                        "systemd": {
                            "unit": unit_full,
                            "active": active,
                            "sub": sub,
                            "pid": pid if pid > 0 else None,
                        },
                        "process": proc_info,
                    }
                )
            except Exception as exc:
                logger.debug("Error building systemd service %s: %s", u.get("unit"), exc)
                continue

        return results

    def _batch_systemctl_show(
        self, unit_names: List[str]
    ) -> Dict[str, Dict[str, str]]:
        result: Dict[str, Dict[str, str]] = {}
        if not unit_names:
            return result
        try:
            cmd = [
                "systemctl",
                "show",
                "--property=Id,MainPID,ActiveState,SubState,ActiveEnterTimestampMonotonic",
                "--no-pager",
            ] + unit_names
            proc = subprocess.run(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                universal_newlines=True,
                timeout=5.0,
            )
            current: Dict[str, str] = {}
            for raw_line in proc.stdout.splitlines():
                line = raw_line.strip()
                if not line:
                    if "Id" in current:
                        result[current["Id"]] = current
                    current = {}
                    continue
                if "=" in line:
                    k, v = line.split("=", 1)
                    current[k.strip()] = v.strip()
            if "Id" in current:
                result[current["Id"]] = current
        except Exception as exc:
            logger.debug("systemctl show failed: %s", exc)
        return result

    def _discover_process_services(
        self,
        unclaimed_listeners: List[Dict[str, Any]],
        claimed_host_ports: set,
        bt_admin_path: Optional[str],
        system_uptime: float,
    ) -> List[Dict[str, Any]]:
        grouped: Dict[str, Dict[str, Any]] = {}
        for lst in unclaimed_listeners:
            if lst["host_port"] in claimed_host_ports:
                continue
            pid = lst["pid"]
            comm = lst["comm"] or "port-{}".format(lst["port"])
            key = "{}:{}".format(pid or 0, comm)
            if key not in grouped:
                grouped[key] = {
                    "pid": pid,
                    "comm": comm,
                    "cmdline": lst["cmdline"] or comm,
                    "ports": [],
                }
            grouped[key]["ports"].append(
                {
                    "port": lst["port"],
                    "proto": "tcp",
                    "bind": lst["bind"],
                    "host_port": lst["host_port"],
                }
            )

        results: List[Dict[str, Any]] = []
        used_names: set = set()

        for item in grouped.values():
            try:
                pid = item["pid"]
                comm = item["comm"]
                cmdline = item["cmdline"]
                ports = self._dedup_ports(item["ports"])
                if not ports:
                    continue

                fp = match_fingerprint(
                    process=comm,
                    cmdline=cmdline,
                    ports=ports,
                    bt_admin_path=bt_admin_path,
                )

                base_name = fp["kind"] if (fp["matched"] and not FINGERPRINT_BY_KIND.get(fp["kind"], {}).get("generic")) else comm
                name = base_name
                if name in used_names:
                    name = "{}-{}".format(base_name, ports[0]["host_port"])
                used_names.add(name)

                uptime: Optional[float] = None
                proc_info = self._get_proc_info_for_pid(pid, fallback_name=comm)
                if pid:
                    with self.lock:
                        snap = self._proc_snapshot_by_pid.get(pid)
                    if snap and snap.get("starttime") and system_uptime > 0:
                        proc_start_sec = float(snap["starttime"]) / float(self.clk_tck)
                        uptime = round(max(0.0, system_uptime - proc_start_sec), 1)

                results.append(
                    {
                        "id": "process:{}".format(name),
                        "name": name,
                        "display_name": fp["display_name"] if fp["matched"] else prettify_service_name(name),
                        "kind": fp["kind"],
                        "category": fp["category"],
                        "source": "process",
                        "status": "running",
                        "health": "unknown",
                        "ports": ports,
                        "web": fp["web"],
                        "check": None,
                        "uptime": uptime,
                        "container": None,
                        "systemd": None,
                        "process": proc_info,
                    }
                )
            except Exception as exc:
                logger.debug("Error building process service: %s", exc)
                continue

        return results

    def _discover_manual_services(self) -> List[Dict[str, Any]]:
        results: List[Dict[str, Any]] = []
        manual_list = self.config.get("manual_services") or []
        if not isinstance(manual_list, list):
            return results

        for item in manual_list:
            if not isinstance(item, dict):
                continue
            try:
                raw_name = str(item.get("name") or "custom").strip()
                port = int(item.get("port") or 0)
                if port <= 0:
                    continue
                slug = re.sub(r"[^a-zA-Z0-9_.-]+", "-", raw_name.lower()).strip("-") or str(port)
                service_id = str(item.get("id") or "manual:{}".format(slug))
                scheme = str(item.get("scheme") or "http").lower()
                path = str(item.get("path") or "/")
                kind = str(item.get("kind") or "custom")
                category = str(item.get("category") or "app")

                ports = [
                    {
                        "port": port,
                        "proto": "tcp",
                        "bind": "127.0.0.1",
                        "host_port": port,
                    }
                ]
                web: Optional[Dict[str, Any]] = None
                if scheme in ("http", "https"):
                    web = {"port": port, "scheme": scheme, "path": path}

                results.append(
                    {
                        "id": service_id,
                        "name": slug,
                        "display_name": raw_name,
                        "kind": kind,
                        "category": category,
                        "source": "manual",
                        "status": "running",
                        "health": "unknown",
                        "ports": ports,
                        "web": web,
                        "check": None,
                        "uptime": None,
                        "container": None,
                        "systemd": None,
                        "process": None,
                    }
                )
            except Exception as exc:
                logger.debug("Error building manual service: %s", exc)
                continue

        return results

    # -----------------------------------------------------------------
    # Health Check & Web Detection Background Worker
    # -----------------------------------------------------------------
    def _health_check_loop(self) -> None:
        interval = max(2.0, float(self.config.get("check_interval", DEFAULT_CHECK_INTERVAL)))
        while not self.stop_event.is_set():
            try:
                self.run_health_checks_once()
            except Exception as exc:
                logger.debug("Health check worker error: %s", exc)
            self.stop_event.wait(interval)

    def run_health_checks_once(self) -> None:
        with self.lock:
            services_snapshot = [dict(s) for s in self._services_cache.get("services", [])]

        new_checks: Dict[str, Dict[str, Any]] = {}
        new_probed_web: Dict[Tuple[str, int], Optional[Dict[str, Any]]] = {}

        for svc in services_snapshot:
            sid = svc["id"]
            if svc.get("status") != "running":
                continue

            web = svc.get("web")
            ports = svc.get("ports") or []
            category = svc.get("category") or "app"

            # 1. If web endpoint is already known, probe it directly
            if web and web.get("port"):
                chk = probe_http_endpoint(
                    scheme=web.get("scheme", "http"),
                    port=int(web["port"]),
                    path=web.get("path", "/"),
                    timeout=3.0,
                )
                new_checks[sid] = chk
                continue

            # 2. If no web info and service has TCP ports, probe each port once for HTTP/HTTPS
            #    (skip probing HTTP for known non-web database/cache services)
            if ports and category not in ("database", "cache"):
                detected_web: Optional[Dict[str, Any]] = None
                detected_check: Optional[Dict[str, Any]] = None

                for p in ports:
                    hp = int(p.get("host_port") or p.get("port") or 0)
                    if hp <= 0:
                        continue
                    cache_key = (sid, hp)
                    with self.lock:
                        already_probed = cache_key in self._probed_web_cache
                        cached_web = self._probed_web_cache.get(cache_key)

                    if already_probed:
                        if cached_web:
                            detected_web = cached_web
                            detected_check = probe_http_endpoint(
                                cached_web["scheme"],
                                cached_web["port"],
                                cached_web["path"],
                                timeout=3.0,
                            )
                            break
                        continue

                    # Try HTTP then HTTPS once
                    http_chk = probe_http_endpoint("http", hp, "/", timeout=3.0)
                    if http_chk["ok"] and http_chk["code"] is not None:
                        w = {"port": hp, "scheme": "http", "path": "/"}
                        new_probed_web[cache_key] = w
                        detected_web = w
                        detected_check = http_chk
                        break

                    https_chk = probe_http_endpoint("https", hp, "/", timeout=3.0)
                    if https_chk["ok"] and https_chk["code"] is not None:
                        w = {"port": hp, "scheme": "https", "path": "/"}
                        new_probed_web[cache_key] = w
                        detected_web = w
                        detected_check = https_chk
                        break

                    new_probed_web[cache_key] = None

                if detected_web and detected_check:
                    new_checks[sid] = detected_check
                    continue

            # 3. Non-web service with TCP port(s): perform TCP connect check
            if ports:
                hp = int(ports[0].get("host_port") or ports[0].get("port") or 0)
                if hp > 0:
                    new_checks[sid] = probe_tcp_port(hp, timeout=3.0)

        # Merge results back into live cache without blocking discovery
        with self.lock:
            self._probed_web_cache.update(new_probed_web)
            self._health_check_cache.update(new_checks)

            for svc in self._services_cache.get("services", []):
                sid = svc["id"]
                if svc.get("web") is None and svc.get("ports"):
                    for p in svc["ports"]:
                        hp = int(p.get("host_port") or p.get("port") or 0)
                        probed = self._probed_web_cache.get((sid, hp))
                        if probed:
                            svc["web"] = dict(probed)
                            if svc.get("kind") == "unknown":
                                svc["category"] = "app"
                            break

                chk = self._health_check_cache.get(sid) if svc.get("status") == "running" else None
                svc["check"] = chk
                c_health = (
                    svc["container"]["health"] if svc.get("container") else None
                )
                svc["health"] = classify_health(
                    svc["status"],
                    check=chk,
                    container_health=c_health,
                )

    # -----------------------------------------------------------------
    # Snapshots & Actions for HTTP Handler
    # -----------------------------------------------------------------
    def get_info(self) -> Dict[str, Any]:
        with self.lock:
            if self._info_cache:
                return dict(self._info_cache)
        return self.sample_info_once()

    def get_metrics(self) -> Dict[str, Any]:
        with self.lock:
            return dict(self._metrics_cache)

    def get_services(self) -> Dict[str, Any]:
        with self.lock:
            return {
                "ts": self._services_cache.get("ts", round(time.time(), 3)),
                "services": list(self._services_cache.get("services", [])),
            }

    def get_top(self, n: int = 10) -> Dict[str, Any]:
        limit = max(1, min(200, int(n)))
        with self.lock:
            procs = list(self._top_procs_cache[:limit])
        return {"procs": procs}

    def get_service_logs(
        self, service_id: str, lines: int = 200
    ) -> Tuple[int, Dict[str, Any]]:
        tail = max(1, min(2000, int(lines)))
        if ":" not in service_id:
            return (400, {"error": "invalid service id"})

        source, name = service_id.split(":", 1)
        source = source.lower()

        if source == "docker":
            if not self.docker.is_available():
                return (503, {"error": "docker is not available"})
            with self.lock:
                svc = self._service_lookup.get(service_id)
            target = (svc.get("_container_id") if svc else None) or name
            try:
                log_lines = self.docker.get_logs(target, tail=tail)
                return (200, {"id": service_id, "lines": log_lines})
            except Exception as exc:
                return (500, {"error": str(exc)})

        elif source == "systemd":
            if not re.match(r"^[a-zA-Z0-9_.@-]+$", name):
                return (400, {"error": "invalid systemd unit name"})
            unit = name if name.endswith(".service") else name + ".service"
            try:
                proc = subprocess.run(
                    [
                        "journalctl",
                        "-u",
                        unit,
                        "-n",
                        str(tail),
                        "--no-pager",
                        "-o",
                        "short-iso",
                    ],
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    universal_newlines=True,
                    timeout=6.0,
                )
                out_lines = [
                    line.rstrip("\r")
                    for line in (proc.stdout or "").splitlines()
                ]
                return (200, {"id": service_id, "lines": out_lines})
            except Exception as exc:
                return (500, {"error": str(exc)})

        elif source in ("process", "manual"):
            return (200, {"id": service_id, "lines": []})

        return (404, {"error": "unknown service source"})

    def perform_service_action(
        self, service_id: str, action: str
    ) -> Tuple[int, Dict[str, Any]]:
        if action not in ("start", "stop", "restart"):
            return (400, {"error": "action must be start, stop, or restart"})
        if ":" not in service_id:
            return (400, {"error": "invalid service id"})

        source, name = service_id.split(":", 1)
        source = source.lower()

        if source == "docker":
            if not self.docker.is_available():
                return (503, {"error": "docker is not available"})
            with self.lock:
                svc = self._service_lookup.get(service_id)
            target = (svc.get("_container_id") if svc else None) or name
            try:
                ok, output = self.docker.container_action(target, action)
                self.refresh_event.set()
                if ok:
                    return (200, {"ok": True, "output": output})
                return (500, {"error": output or "docker action failed"})
            except Exception as exc:
                return (500, {"error": str(exc)})

        elif source == "systemd":
            if not re.match(r"^[a-zA-Z0-9_.@-]+$", name):
                return (400, {"error": "invalid systemd unit name"})
            unit = name if name.endswith(".service") else name + ".service"
            try:
                proc = subprocess.run(
                    ["systemctl", action, unit],
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    universal_newlines=True,
                    timeout=25.0,
                )
                self.refresh_event.set()
                output = ((proc.stdout or "") + "\n" + (proc.stderr or "")).strip()
                if proc.returncode == 0:
                    return (200, {"ok": True, "output": output})
                return (
                    500,
                    {"error": output or "systemctl {} failed".format(action)},
                )
            except Exception as exc:
                return (500, {"error": str(exc)})

        else:
            return (
                400,
                {"error": "action not supported for source '{}'".format(source)},
            )


# =====================================================================
# Configuration Loader / Generator
# =====================================================================


def load_or_create_config(config_path: str) -> Dict[str, Any]:
    """
    Load config JSON from config_path. If missing, generate one with a random
    32-byte hex token and mode 0600.
    """
    cfg: Dict[str, Any] = {
        "listen": DEFAULT_LISTEN,
        "port": DEFAULT_PORT,
        "token": "",
        "check_interval": DEFAULT_CHECK_INTERVAL,
        "manual_services": [],
        "hidden": [],
    }

    needs_write = False
    if os.path.exists(config_path):
        try:
            with open(config_path, "r", encoding="utf-8") as f:
                loaded = json.load(f)
            if isinstance(loaded, dict):
                cfg.update(loaded)
        except Exception as exc:
            logger.error("Failed to read config %s: %s", config_path, exc)
            raise
    else:
        needs_write = True

    if not cfg.get("token") or not isinstance(cfg.get("token"), str):
        cfg["token"] = secrets.token_hex(32)
        needs_write = True

    if needs_write:
        parent = os.path.dirname(os.path.abspath(config_path))
        if parent and not os.path.exists(parent):
            os.makedirs(parent, exist_ok=True)
        with open(config_path, "w", encoding="utf-8") as f:
            json.dump(cfg, f, indent=2, ensure_ascii=False)
            f.write("\n")
        try:
            os.chmod(config_path, 0o600)
        except OSError:
            pass

    return cfg


# =====================================================================
# HTTP Request Handler & Server
# =====================================================================

SERVICE_LOGS_RE = re.compile(r"^/api/v1/services/([^/]+)/logs$")
SERVICE_ACTION_RE = re.compile(r"^/api/v1/services/([^/]+)/action$")


class AgentRequestHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args: Any) -> None:
        # Quiet normal polling requests; log only errors
        pass

    def _send_json(self, status_code: int, payload: Dict[str, Any]) -> None:
        # Strip private helper keys starting with '_' from service dicts
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)

    def _check_auth(self) -> bool:
        state: AgentState = self.server.agent_state  # type: ignore
        expected_token = str(state.config.get("token") or "")
        auth_header = self.headers.get("Authorization") or ""
        if not auth_header.startswith("Bearer "):
            return False
        provided_token = auth_header[7:].strip()
        if not expected_token or not provided_token:
            return False
        return hmac.compare_digest(provided_token, expected_token)

    def do_GET(self) -> None:
        parsed = urllib.parse.urlsplit(self.path)
        path = parsed.path.rstrip("/") or "/"
        query = urllib.parse.parse_qs(parsed.query)

        # Unauthenticated health endpoint
        if path == "/api/v1/health":
            self._send_json(200, {"ok": True, "version": AGENT_VERSION})
            return

        if not self._check_auth():
            self._send_json(401, {"error": "unauthorized"})
            return

        state: AgentState = self.server.agent_state  # type: ignore

        if path == "/api/v1/info":
            self._send_json(200, state.get_info())
            return

        if path == "/api/v1/metrics":
            self._send_json(200, state.get_metrics())
            return

        if path == "/api/v1/services":
            raw = state.get_services()
            clean_services = [
                {k: v for k, v in s.items() if not k.startswith("_")}
                for s in raw.get("services", [])
            ]
            self._send_json(200, {"ts": raw["ts"], "services": clean_services})
            return

        if path == "/api/v1/top":
            n_str = (query.get("n") or ["10"])[0]
            try:
                n_val = int(n_str)
            except ValueError:
                n_val = 10
            self._send_json(200, state.get_top(n_val))
            return

        m_logs = SERVICE_LOGS_RE.match(path)
        if m_logs:
            service_id = urllib.parse.unquote(m_logs.group(1))
            lines_str = (query.get("lines") or ["200"])[0]
            try:
                lines_val = int(lines_str)
            except ValueError:
                lines_val = 200
            status_code, resp = state.get_service_logs(service_id, lines=lines_val)
            self._send_json(status_code, resp)
            return

        self._send_json(404, {"error": "not found"})

    def do_POST(self) -> None:
        parsed = urllib.parse.urlsplit(self.path)
        path = parsed.path.rstrip("/") or "/"

        if not self._check_auth():
            self._send_json(401, {"error": "unauthorized"})
            return

        state: AgentState = self.server.agent_state  # type: ignore

        m_action = SERVICE_ACTION_RE.match(path)
        if m_action:
            service_id = urllib.parse.unquote(m_action.group(1))
            content_len = int(self.headers.get("Content-Length") or 0)
            if content_len <= 0 or content_len > 65536:
                self._send_json(400, {"error": "invalid request body"})
                return
            raw_body = self.rfile.read(content_len)
            try:
                body_obj = json.loads(raw_body.decode("utf-8"))
            except Exception:
                self._send_json(400, {"error": "invalid JSON body"})
                return
            action = str(body_obj.get("action") or "").strip().lower()
            status_code, resp = state.perform_service_action(service_id, action)
            self._send_json(status_code, resp)
            return

        self._send_json(404, {"error": "not found"})


class AgentHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(
        self,
        server_address: Tuple[str, int],
        RequestHandlerClass: Any,
        agent_state: AgentState,
    ) -> None:
        super().__init__(server_address, RequestHandlerClass)
        self.agent_state = agent_state


# =====================================================================
# CLI Entrypoint
# =====================================================================


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="VMMon Server Agent")
    parser.add_argument(
        "--config",
        default=DEFAULT_CONFIG_PATH,
        help="Path to config.json (default: {})".format(DEFAULT_CONFIG_PATH),
    )
    parser.add_argument(
        "--listen",
        default=None,
        help="Override listen address (default from config: 127.0.0.1)",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=None,
        help="Override listen port (default from config: 9527)",
    )
    parser.add_argument(
        "--print-token",
        action="store_true",
        help="Load/create config, print the bearer token to stdout, and exit",
    )
    args = parser.parse_args(argv)

    logging.basicConfig(
        stream=sys.stderr,
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
    )

    try:
        config = load_or_create_config(args.config)
    except Exception as exc:
        logger.error("Failed to load or create config at %s: %s", args.config, exc)
        return 1

    if args.print_token:
        sys.stdout.write(str(config["token"]) + "\n")
        sys.stdout.flush()
        return 0

    if args.listen:
        config["listen"] = args.listen
    if args.port:
        config["port"] = args.port

    listen_addr = str(config.get("listen") or DEFAULT_LISTEN)
    listen_port = int(config.get("port") or DEFAULT_PORT)

    state = AgentState(config)
    state.start_background_workers()

    server = AgentHTTPServer((listen_addr, listen_port), AgentRequestHandler, state)
    logger.info(
        "VMMon Agent v%s listening on http://%s:%d",
        AGENT_VERSION,
        listen_addr,
        listen_port,
    )

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        logger.info("Shutting down VMMon Agent...")
    finally:
        state.stop_event.set()
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
