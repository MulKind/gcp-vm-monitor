# -*- coding: utf-8 -*-
"""
Unit tests for VMMon Agent pure parsers, fingerprint engine, health classification,
and HTTP API handler. Runnable on Windows & Linux with Python 3.7+.
"""

import json
import os
import struct
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request

# Ensure agent directory is on sys.path
AGENT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if AGENT_DIR not in sys.path:
    sys.path.insert(0, AGENT_DIR)

import vmmon_agent  # noqa: E402


class TestProcStatParser(unittest.TestCase):
    def test_cpu_delta_to_percent(self) -> None:
        stat_t1 = """\
cpu  1000 0 500 8000 300 0 0 200 0 0
cpu0 600 0 200 4000 100 0 0 100 0 0
cpu1 400 0 300 4000 200 0 0 100 0 0
intr 12345
btime 1732000000
processes 4321
"""
        # Total delta = 1000 ticks (core0: 500, core1: 500)
        # Total: user +100, sys +50, idle +800, iowait +30, steal +20 -> busy = 170 -> 17.0%
        # Core0: user +50, sys +0, idle +400, iowait +25, steal +25 -> busy = 75/500 = 15.0%
        # Core1: user +50, sys +50, idle +400, iowait +5, steal -5(clamped 0) -> let's use +0:
        stat_t2 = """\
cpu  1100 0 550 8800 330 0 0 220 0 0
cpu0 650 0 200 4400 125 0 0 125 0 0
cpu1 450 0 350 4400 205 0 0 95 0 0
btime 1732000000
"""
        p1 = vmmon_agent.parse_proc_stat(stat_t1)
        p2 = vmmon_agent.parse_proc_stat(stat_t2)

        self.assertEqual(p1["btime"], 1732000000.0)
        self.assertEqual(len(p1["cores"]), 2)

        cpu = vmmon_agent.compute_cpu_percent(p1, p2)
        self.assertAlmostEqual(cpu["percent"], 17.0, places=1)
        self.assertAlmostEqual(cpu["iowait"], 3.0, places=1)
        self.assertAlmostEqual(cpu["steal"], 2.0, places=1)
        self.assertEqual(len(cpu["per_core"]), 2)
        self.assertAlmostEqual(cpu["per_core"][0], 15.0, places=1)
        self.assertAlmostEqual(cpu["per_core"][1], 19.0, places=1)


class TestProcMeminfoParser(unittest.TestCase):
    def test_parse_proc_meminfo(self) -> None:
        fixture = """\
MemTotal:        4000000 kB
MemFree:         1000000 kB
MemAvailable:    2400000 kB
Buffers:          200000 kB
Cached:          1200000 kB
SwapTotal:       1000000 kB
SwapFree:         750000 kB
"""
        mem = vmmon_agent.parse_proc_meminfo(fixture)
        self.assertEqual(mem["total"], 4000000 * 1024)
        self.assertEqual(mem["available"], 2400000 * 1024)
        self.assertEqual(mem["used"], 1600000 * 1024)
        self.assertAlmostEqual(mem["percent"], 40.0, places=1)
        self.assertEqual(mem["buffers"], 200000 * 1024)
        self.assertEqual(mem["cached"], 1200000 * 1024)
        self.assertEqual(mem["swap_total"], 1000000 * 1024)
        self.assertEqual(mem["swap_used"], 250000 * 1024)


class TestProcNetDevParser(unittest.TestCase):
    def test_parse_and_compute_net_dev(self) -> None:
        net_t1 = """\
Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 9999999    1000    0    0    0     0          0         0  9999999    1000    0    0    0     0       0          0
docker0: 555555     500    0    0    0     0          0         0   555555     500    0    0    0     0       0          0
veth1a2b: 44444      40    0    0    0     0          0         0    44444      40    0    0    0     0       0          0
br-1234:  33333      30    0    0    0     0          0         0    33333      30    0    0    0     0       0          0
  ens4: 1000000    1000    0    0    0     0          0         0  2000000    2000    0    0    0     0       0          0
"""
        net_t2 = """\
Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 9999999    1000    0    0    0     0          0         0  9999999    1000    0    0    0     0       0          0
  ens4: 1050000    1050    0    0    0     0          0         0  2100000    2100    0    0    0     0       0          0
"""
        p1 = vmmon_agent.parse_proc_net_dev(net_t1)
        p2 = vmmon_agent.parse_proc_net_dev(net_t2)

        # Filtered interfaces (lo, docker0, veth*, br-*) must not appear
        self.assertEqual(list(p1.keys()), ["ens4"])

        metrics = vmmon_agent.compute_net_metrics(p1, p2, dt=2.0)
        self.assertEqual(metrics["rx_bps"], 25000)
        self.assertEqual(metrics["tx_bps"], 50000)
        self.assertEqual(metrics["rx_total"], 1050000)
        self.assertEqual(metrics["tx_total"], 2100000)
        self.assertEqual(len(metrics["interfaces"]), 1)
        self.assertEqual(metrics["interfaces"][0]["name"], "ens4")


class TestProcNetTcpParser(unittest.TestCase):
    def test_ipv4_and_ipv6_parsing_and_state_summary(self) -> None:
        tcp4_fixture = """\
  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:2537 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 10001 1 0000000000000000 100 0 0 10 0
   1: 00000000:0050 00000000:0000 0A 00000000:00000000 00:00000000 00000000    33        0 10002 1 0000000000000000 100 0 0 10 0
   2: 0A000001:0050 0B000002:C350 01 00000000:00000000 00:00000000 00000000    33        0 10003 1 0000000000000000 100 0 0 10 0
   3: 0A000001:0050 0C000003:C351 06 00000000:00000000 00:00000000 00000000     0        0 0 1 0000000000000000 100 0 0 10 0
"""
        tcp6_fixture = """\
  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000000000000000000001000000:2328 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 20001 1 0000000000000000 100 0 0 10 0
   1: 00000000000000000000000000000000:01BB 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 20002 1 0000000000000000 100 0 0 10 0
"""
        entries4 = vmmon_agent.parse_proc_net_tcp(tcp4_fixture)
        entries6 = vmmon_agent.parse_proc_net_tcp(tcp6_fixture)

        self.assertEqual(len(entries4), 4)
        self.assertEqual(entries4[0]["local_ip"], "127.0.0.1")
        self.assertEqual(entries4[0]["local_port"], 9527)
        self.assertEqual(entries4[0]["state"], "0A")
        self.assertEqual(entries4[0]["state_name"], "LISTEN")
        self.assertEqual(entries4[0]["inode"], 10001)

        self.assertEqual(entries4[1]["local_ip"], "0.0.0.0")
        self.assertEqual(entries4[1]["local_port"], 80)

        self.assertEqual(entries4[2]["local_ip"], "1.0.0.10")
        self.assertEqual(entries4[2]["rem_ip"], "2.0.0.11")
        self.assertEqual(entries4[2]["rem_port"], 50000)
        self.assertEqual(entries4[2]["state_name"], "ESTABLISHED")

        self.assertEqual(len(entries6), 2)
        self.assertEqual(entries6[0]["local_ip"], "::1")
        self.assertEqual(entries6[0]["local_port"], 9000)
        self.assertEqual(entries6[1]["local_ip"], "::")
        self.assertEqual(entries6[1]["local_port"], 443)

        summary = vmmon_agent.summarize_tcp_states(entries4 + entries6)
        self.assertEqual(summary["listen"], 4)
        self.assertEqual(summary["established"], 1)
        self.assertEqual(summary["time_wait"], 1)


class TestProcDiskstatsAndMounts(unittest.TestCase):
    def test_diskstats_whole_disks_only(self) -> None:
        d1 = """\
   7       0 loop0 100 0 800 10 0 0 0 0 0 10 10
   8       0 sda 1000 0 20000 100 500 0 10000 50 0 100 150
   8       1 sda1 900 0 18000 90 450 0 9000 45 0 90 135
 259       0 nvme0n1 200 0 4000 20 100 0 2000 10 0 20 30
 259       1 nvme0n1p1 200 0 4000 20 100 0 2000 10 0 20 30
 253       0 dm-0 50 0 500 5 50 0 500 5 0 5 10
"""
        d2 = """\
   8       0 sda 1020 0 20200 110 510 0 10400 60 0 105 160
   8       1 sda1 920 0 18200 95 460 0 9400 50 0 95 145
 259       0 nvme0n1 210 0 4100 25 105 0 2100 15 0 22 35
"""
        p1 = vmmon_agent.parse_proc_diskstats(d1)
        p2 = vmmon_agent.parse_proc_diskstats(d2)

        # Must only contain whole disks sda and nvme0n1, not loop0, sda1, nvme0n1p1, dm-0
        self.assertEqual(sorted(p1.keys()), ["nvme0n1", "sda"])

        # sda delta: read +20 ios, +200 sectors (102400 B); write +10 ios, +400 sectors (204800 B)
        # nvme0n1 delta: read +10 ios, +100 sectors (51200 B); write +5 ios, +100 sectors (51200 B)
        # Total over dt=1.0s: read_bps = 153600, write_bps = 256000, read_iops = 30, write_iops = 15
        io = vmmon_agent.compute_disk_io_metrics(p1, p2, dt=1.0)
        self.assertEqual(io["read_bps"], 153600)
        self.assertEqual(io["write_bps"], 256000)
        self.assertEqual(io["read_iops"], 30)
        self.assertEqual(io["write_iops"], 15)

    def test_parse_proc_mounts_filters_pseudo_fs(self) -> None:
        mounts_text = """\
sysfs /sys sysfs rw,nosuid,nodev,noexec,relatime 0 0
proc /proc proc rw,nosuid,nodev,noexec,relatime 0 0
udev /dev devtmpfs rw,nosuid,relatime,size=1980000k 0 0
tmpfs /run tmpfs rw,nosuid,nodev 0 0
/dev/sda1 / ext4 rw,relatime,discard 0 0
/dev/sda15 /boot/efi vfat rw,relatime 0 0
/dev/loop0 /snap/core20/1974 squashfs ro,nodev,relatime 0 0
overlay /var/lib/docker/overlay2/abc/merged overlay rw,relatime 0 0
/dev/sdb1 /mnt/data\\040disk xfs rw,relatime 0 0
"""
        mounts = vmmon_agent.parse_proc_mounts(mounts_text)
        self.assertEqual(len(mounts), 3)
        self.assertEqual(mounts[0]["mount"], "/")
        self.assertEqual(mounts[1]["mount"], "/boot/efi")
        self.assertEqual(mounts[2]["mount"], "/mnt/data disk")


class TestDockerLogDemux(unittest.TestCase):
    @staticmethod
    def _make_frame(stream_type: int, text: str) -> bytes:
        payload = text.encode("utf-8")
        header = struct.pack(">BxxxI", stream_type, len(payload))
        return header + payload

    def test_demux_multiplexed_stream(self) -> None:
        raw = (
            self._make_frame(1, "2026-11-22T10:00:00Z stdout line 1\n")
            + self._make_frame(2, "2026-11-22T10:00:01Z stderr line 2\r\n")
            + self._make_frame(1, "2026-11-22T10:00:02Z line 3a\n2026-11-22T10:00:03Z line 3b\n")
        )
        lines = vmmon_agent.demux_docker_logs(raw)
        self.assertEqual(
            lines,
            [
                "2026-11-22T10:00:00Z stdout line 1",
                "2026-11-22T10:00:01Z stderr line 2",
                "2026-11-22T10:00:02Z line 3a",
                "2026-11-22T10:00:03Z line 3b",
            ],
        )

    def test_demux_plain_tty_stream(self) -> None:
        raw = b"2026-11-22T10:00:00Z plain tty line 1\n2026-11-22T10:00:01Z plain tty line 2\n"
        lines = vmmon_agent.demux_docker_logs(raw)
        self.assertEqual(
            lines,
            [
                "2026-11-22T10:00:00Z plain tty line 1",
                "2026-11-22T10:00:01Z plain tty line 2",
            ],
        )


class TestFingerprintMatching(unittest.TestCase):
    def test_image_fingerprint_and_port_mapping(self) -> None:
        fp = vmmon_agent.match_fingerprint(
            image="portainer/portainer-ce:latest",
            ports=[{"port": 9443, "host_port": 19443, "proto": "tcp", "bind": "0.0.0.0"}],
        )
        self.assertTrue(fp["matched"])
        self.assertEqual(fp["kind"], "portainer")
        self.assertEqual(fp["display_name"], "Portainer")
        self.assertEqual(fp["category"], "panel")
        self.assertEqual(fp["web"], {"port": 19443, "scheme": "https", "path": "/"})

    def test_specific_app_beats_generic_runtime(self) -> None:
        # Uptime Kuma runs on node; must match uptime-kuma, not generic nodejs
        fp = vmmon_agent.match_fingerprint(
            image="louislam/uptime-kuma:1",
            process="node",
            cmdline="node server/server.js",
            ports=[{"port": 3001, "host_port": 3001}],
        )
        self.assertEqual(fp["kind"], "uptime-kuma")
        self.assertEqual(fp["category"], "monitoring")

    def test_bt_panel_admin_path(self) -> None:
        fp = vmmon_agent.match_fingerprint(
            process="BT-Panel",
            ports=[{"port": 8888, "host_port": 8888}],
            bt_admin_path="my_secret_entry\n",
        )
        self.assertTrue(fp["matched"])
        self.assertEqual(fp["kind"], "bt")
        self.assertEqual(fp["category"], "panel")
        self.assertEqual(
            fp["web"],
            {"port": 8888, "scheme": "http", "path": "/my_secret_entry"},
        )

    def test_port_fallback_matching(self) -> None:
        fp = vmmon_agent.match_fingerprint(
            process="custom-db-wrapper",
            ports=[{"port": 6379, "host_port": 6379}],
        )
        self.assertTrue(fp["matched"])
        self.assertEqual(fp["kind"], "redis")
        self.assertEqual(fp["category"], "cache")
        self.assertIsNone(fp["web"])

    def test_unknown_service_fallback(self) -> None:
        fp = vmmon_agent.match_fingerprint(
            process="my_custom_binary",
            ports=[{"port": 4567, "host_port": 4567}],
        )
        self.assertFalse(fp["matched"])
        self.assertEqual(fp["kind"], "unknown")
        self.assertEqual(fp["category"], "app")
        self.assertEqual(fp["display_name"], "My Custom Binary")


class TestHealthClassification(unittest.TestCase):
    def test_health_classification_rules(self) -> None:
        # stopped -> stopped
        self.assertEqual(vmmon_agent.classify_health("stopped"), "stopped")
        # stopped with non-zero exit code -> down
        self.assertEqual(
            vmmon_agent.classify_health("stopped", exit_code=137), "down"
        )
        # failed -> down
        self.assertEqual(vmmon_agent.classify_health("failed"), "down")
        # restarting -> degraded
        self.assertEqual(vmmon_agent.classify_health("restarting"), "degraded")
        # running + check failing -> down
        self.assertEqual(
            vmmon_agent.classify_health(
                "running", check={"ok": False, "latency_ms": 10.0}
            ),
            "down",
        )
        # running + latency > 1500ms -> degraded
        self.assertEqual(
            vmmon_agent.classify_health(
                "running", check={"ok": True, "latency_ms": 1850.5}
            ),
            "degraded",
        )
        # running + container unhealthy -> degraded
        self.assertEqual(
            vmmon_agent.classify_health(
                "running",
                check={"ok": True, "latency_ms": 20.0},
                container_health="unhealthy",
            ),
            "degraded",
        )
        # running + check ok -> healthy
        self.assertEqual(
            vmmon_agent.classify_health(
                "running", check={"ok": True, "latency_ms": 15.2}
            ),
            "healthy",
        )
        # running + no check yet -> unknown
        self.assertEqual(vmmon_agent.classify_health("running"), "unknown")


class TestProcessAndCgroupParsers(unittest.TestCase):
    def test_parse_proc_pid_stat_with_parens_and_spaces(self) -> None:
        stat_line = (
            "1234 (nginx: worker (1)) S 1 1234 1234 0 -1 4194304 "
            "100 0 0 0 150 50 0 0 20 0 1 0 98765 12345678 2048 18446744073709551615"
        )
        parsed = vmmon_agent.parse_proc_pid_stat(stat_line)
        self.assertIsNotNone(parsed)
        assert parsed is not None
        self.assertEqual(parsed["pid"], 1234)
        self.assertEqual(parsed["name"], "nginx: worker (1)")
        self.assertEqual(parsed["ticks"], 200)
        self.assertEqual(parsed["starttime"], 98765)
        self.assertEqual(parsed["rss_pages"], 2048)

    def test_extract_cgroup_owner(self) -> None:
        cg_docker = "0::/system.slice/docker-a1b2c3d4e5f60123456789abcdef.scope\n"
        docker_id, unit = vmmon_agent.extract_cgroup_owner(cg_docker)
        self.assertEqual(docker_id, "a1b2c3d4e5f60123456789abcdef")

        cg_systemd = "0::/system.slice/nginx.service\n"
        docker_id2, unit2 = vmmon_agent.extract_cgroup_owner(cg_systemd)
        self.assertIsNone(docker_id2)
        self.assertEqual(unit2, "nginx.service")


class TestConfigAndHTTPServer(unittest.TestCase):
    def test_config_creation_and_http_endpoints(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            cfg_path = os.path.join(tmpdir, "config.json")
            cfg = vmmon_agent.load_or_create_config(cfg_path)
            self.assertEqual(len(cfg["token"]), 64)

            state = vmmon_agent.AgentState(cfg)
            state._info_cache = {
                "agent_version": vmmon_agent.AGENT_VERSION,
                "hostname": "test-vm",
                "os": "Debian GNU/Linux 12",
                "kernel": "6.1.0",
                "arch": "x86_64",
                "cpu_model": "AMD EPYC",
                "cpu_count": 2,
                "mem_total": 4096,
                "boot_time": 1732000000.0,
                "docker": False,
                "systemd": True,
            }

            server = vmmon_agent.AgentHTTPServer(
                ("127.0.0.1", 0), vmmon_agent.AgentRequestHandler, state
            )
            port = server.server_address[1]
            t = threading.Thread(target=server.serve_forever, daemon=True)
            t.start()

            try:
                base_url = "http://127.0.0.1:{}".format(port)

                # 1. /api/v1/health requires no auth
                with urllib.request.urlopen(base_url + "/api/v1/health", timeout=2) as resp:
                    self.assertEqual(resp.status, 200)
                    data = json.loads(resp.read().decode("utf-8"))
                    self.assertEqual(data, {"ok": True, "version": "0.1.0"})

                # 2. /api/v1/info without token -> 401
                with self.assertRaises(urllib.error.HTTPError) as ctx:
                    urllib.request.urlopen(base_url + "/api/v1/info", timeout=2)
                self.assertEqual(ctx.exception.code, 401)
                ctx.exception.close()

                # 3. /api/v1/info with valid Bearer token -> 200
                req = urllib.request.Request(
                    base_url + "/api/v1/info",
                    headers={"Authorization": "Bearer " + cfg["token"]},
                )
                with urllib.request.urlopen(req, timeout=2) as resp:
                    self.assertEqual(resp.status, 200)
                    info = json.loads(resp.read().decode("utf-8"))
                    self.assertEqual(info["hostname"], "test-vm")
            finally:
                server.shutdown()
                server.server_close()


if __name__ == "__main__":
    unittest.main()
