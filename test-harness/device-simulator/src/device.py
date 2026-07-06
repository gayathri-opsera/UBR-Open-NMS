"""
Device fleet simulator — core device profile and data generation.
"""
from __future__ import annotations

import random
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Dict, List, Optional


class DeviceType(str, Enum):
    BTS = "BTS"
    CPE = "CPE"


class DeviceState(str, Enum):
    ONLINE = "ONLINE"
    OFFLINE = "OFFLINE"
    FAULTY = "FAULTY"


@dataclass
class KpiDistribution:
    min: float
    max: float
    mean: float
    stddev: float

    def sample(self) -> float:
        """Sample a value from a truncated normal distribution."""
        value = random.gauss(self.mean, self.stddev)
        return max(self.min, min(self.max, value))


@dataclass
class DeviceProfile:
    device_id: str
    serial_number: str
    device_type: DeviceType
    model: str
    network_id: str
    organization_id: str
    state: DeviceState = DeviceState.ONLINE
    ip_address: str = ""
    mac_address: str = ""

    @classmethod
    def generate(
        cls,
        index: int,
        device_type: DeviceType,
        models: List[str],
        network_id: str = "NET-001",
        organization_id: str = "ORG-001",
    ) -> "DeviceProfile":
        """Generate a synthetic device profile."""
        type_prefix = "BTS" if device_type == DeviceType.BTS else "CPE"
        device_id = f"{type_prefix}-{index:06d}"
        serial_number = f"SN-{uuid.uuid4().hex[:10].upper()}"
        model = models[index % len(models)]

        # Generate a deterministic but realistic-looking IP
        third_octet = (index // 254) % 254 + 1
        fourth_octet = (index % 254) + 1
        ip = f"10.{device_type == DeviceType.BTS and 1 or 2}.{third_octet}.{fourth_octet}"

        # Deterministic MAC
        mac_int = index + (0x100000000000 if device_type == DeviceType.BTS else 0x200000000000)
        mac = ":".join(f"{(mac_int >> (8 * i)) & 0xFF:02X}" for i in range(5, -1, -1))

        return cls(
            device_id=device_id,
            serial_number=serial_number,
            device_type=device_type,
            model=model,
            network_id=network_id,
            organization_id=organization_id,
            ip_address=ip,
            mac_address=mac,
        )


class Fleet:
    """Manages the simulated device fleet and state transitions."""

    def __init__(self, profile: dict):
        fleet_cfg = profile["fleet"]
        total = fleet_cfg["total_devices"]
        bts_count = int(total * fleet_cfg.get("bts_ratio", 0.3))
        cpe_count = total - bts_count

        bts_models = fleet_cfg.get("device_models", {}).get("bts", ["ENS500EXT"])
        cpe_models = fleet_cfg.get("device_models", {}).get("cpe", ["ENH200EXT"])

        self.devices: List[DeviceProfile] = []
        for i in range(bts_count):
            self.devices.append(DeviceProfile.generate(i, DeviceType.BTS, bts_models))
        for i in range(cpe_count):
            self.devices.append(DeviceProfile.generate(i, DeviceType.CPE, cpe_models))

        st = profile.get("state_transitions", {})
        self.offline_prob = st.get("offline_probability", 0.02)
        self.recovery_prob = st.get("recovery_probability", 0.80)
        self.faulty_prob = st.get("faulty_probability", 0.005)

    @property
    def active_count(self) -> int:
        return sum(1 for d in self.devices if d.state == DeviceState.ONLINE)

    def tick_state_transitions(self) -> List[DeviceProfile]:
        """Apply probabilistic state transitions; returns changed devices."""
        changed = []
        for device in self.devices:
            if device.state == DeviceState.ONLINE:
                if random.random() < self.faulty_prob:
                    device.state = DeviceState.FAULTY
                    changed.append(device)
                elif random.random() < self.offline_prob:
                    device.state = DeviceState.OFFLINE
                    changed.append(device)
            elif device.state in (DeviceState.OFFLINE, DeviceState.FAULTY):
                if random.random() < self.recovery_prob:
                    device.state = DeviceState.ONLINE
                    changed.append(device)
        return changed


# ── KPI response generation ────────────────────────────────────────────────

def generate_kpi_response(device: DeviceProfile, kpi_cfg: dict) -> dict:
    """Generate a realistic KPI poll response for a simulated device."""
    dists = {k: KpiDistribution(**v) for k, v in kpi_cfg.items()}

    response = {
        "deviceId": device.device_id,
        "serialNumber": device.serial_number,
        "deviceType": device.device_type.value,
        "modelNo": device.model,
        "metrics": {},
    }

    if "rssi_dbm" in dists:
        response["metrics"]["rssi_dbm"] = round(dists["rssi_dbm"].sample(), 2)
    if "snr_db" in dists:
        response["metrics"]["snr_db"] = round(dists["snr_db"].sample(), 2)
    if "throughput_mbps" in dists:
        response["metrics"]["throughput_mbps"] = round(dists["throughput_mbps"].sample(), 2)
    if "cpu_usage_pct" in dists:
        response["metrics"]["cpu_usage_pct"] = round(dists["cpu_usage_pct"].sample(), 2)
    if "memory_free_pct" in dists:
        response["metrics"]["memory_free_pct"] = round(dists["memory_free_pct"].sample(), 2)

    if device.device_type == DeviceType.BTS:
        response["wireless5GhzRadio"] = {
            "txPowerDbm": round(random.uniform(20, 27), 1),
            "rxPowerDbm": round(response["metrics"].get("rssi_dbm", -60), 2),
            "snrDb": round(response["metrics"].get("snr_db", 25), 2),
            "mcsIndex": random.randint(0, 9),
            "modulation": random.choice(["BPSK", "QPSK", "16-QAM", "64-QAM", "256-QAM"]),
            "associatedClients": random.randint(0, 64),
        }

    return response


# ── SNMP trap formatting ───────────────────────────────────────────────────

SNMP_GENERIC_TRAPS = {
    "linkDown": 2,
    "linkUp": 3,
    "authFailure": 4,
    "enterpriseTrap": 6,
}


def generate_snmp_trap(device: DeviceProfile, enterprise_oid_prefix: str,
                       trap_type: str = "enterpriseTrap") -> dict:
    """Generate an SNMP v2c trap PDU dictionary."""
    generic = SNMP_GENERIC_TRAPS.get(trap_type, 6)
    return {
        "version": "2c",
        "community": "public",
        "enterprise": f"{enterprise_oid_prefix}.{1 if device.device_type == DeviceType.BTS else 2}",
        "agentAddr": device.ip_address,
        "genericTrap": generic,
        "specificTrap": 0,
        "varBinds": [
            {"oid": "1.3.6.1.2.1.1.3.0", "type": "TimeTicks", "value": random.randint(0, 864000)},
            {"oid": f"{enterprise_oid_prefix}.1.1", "type": "OctetString", "value": device.serial_number},
            {"oid": f"{enterprise_oid_prefix}.1.2", "type": "OctetString", "value": device.state.value},
        ],
        "deviceId": device.device_id,
    }


# ── Syslog message formatting ──────────────────────────────────────────────

SYSLOG_SEVERITIES = ["debug", "info", "notice", "warning", "error"]

SAMPLE_MESSAGES = {
    "info": [
        "Interface eth0 link up",
        "DHCP lease renewed",
        "Configuration applied successfully",
        "Firmware version {model} running",
    ],
    "warning": [
        "High CPU utilization: {cpu}%",
        "Signal degraded: RSSI {rssi} dBm",
        "SNR below threshold: {snr} dB",
    ],
    "error": [
        "Interface eth0 link down",
        "SNMP authentication failure from {ip}",
        "Configuration push failed: timeout",
    ],
    "notice": [
        "Device check-in",
        "KPI threshold breached",
    ],
    "debug": ["Heartbeat tick"],
}


def generate_syslog_message(device: DeviceProfile, severity: str) -> dict:
    """Generate a syslog message dict for the given device and severity."""
    templates = SAMPLE_MESSAGES.get(severity, SAMPLE_MESSAGES["info"])
    template = random.choice(templates)
    message = template.format(
        model=device.model,
        cpu=round(random.uniform(10, 90), 1),
        rssi=round(random.uniform(-80, -40), 1),
        snr=round(random.uniform(5, 35), 1),
        ip=device.ip_address,
    )
    return {
        "facility": 16,
        "severity": severity,
        "hostname": device.device_id,
        "appName": "ubr-device",
        "message": message,
        "deviceId": device.device_id,
        "deviceType": device.device_type.value,
    }


def pick_severity(distribution: dict) -> str:
    """Pick a severity level according to the configured probability distribution."""
    sevs = list(distribution.keys())
    weights = [distribution[s] for s in sevs]
    return random.choices(sevs, weights=weights, k=1)[0]
