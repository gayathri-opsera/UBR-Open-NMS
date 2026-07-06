"""
Unit tests for the UBR NMS device fleet simulator.
"""
import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "../src"))

import json
import pytest
import random
from device import (
    DeviceProfile, DeviceType, DeviceState, Fleet, KpiDistribution,
    generate_kpi_response, generate_snmp_trap, generate_syslog_message, pick_severity,
)


# ── DeviceProfile.generate ────────────────────────────────────────────────────

def test_generate_bts_profile():
    d = DeviceProfile.generate(0, DeviceType.BTS, ["ENS500EXT"])
    assert d.device_type == DeviceType.BTS
    assert d.device_id.startswith("BTS-")
    assert d.serial_number.startswith("SN-")
    assert d.model == "ENS500EXT"
    assert d.state == DeviceState.ONLINE


def test_generate_cpe_profile():
    d = DeviceProfile.generate(5, DeviceType.CPE, ["ENH200EXT", "EOA7530"])
    assert d.device_type == DeviceType.CPE
    assert d.device_id.startswith("CPE-")
    assert d.model in ["ENH200EXT", "EOA7530"]


def test_device_id_is_unique_across_fleet():
    devices = [DeviceProfile.generate(i, DeviceType.CPE, ["ENH200EXT"]) for i in range(100)]
    ids = {d.device_id for d in devices}
    assert len(ids) == 100


def test_generate_deterministic_ip():
    d1 = DeviceProfile.generate(0, DeviceType.BTS, ["ENS500EXT"])
    d2 = DeviceProfile.generate(0, DeviceType.BTS, ["ENS500EXT"])
    assert d1.ip_address == d2.ip_address


# ── KpiDistribution ───────────────────────────────────────────────────────────

def test_kpi_distribution_clamps_to_bounds():
    dist = KpiDistribution(min=0, max=100, mean=50, stddev=200)  # extreme stddev
    for _ in range(100):
        val = dist.sample()
        assert 0 <= val <= 100, f"Value {val} out of bounds"


def test_kpi_distribution_samples_near_mean():
    dist = KpiDistribution(min=-100, max=100, mean=0, stddev=0.01)
    samples = [dist.sample() for _ in range(20)]
    for s in samples:
        assert abs(s) < 1.0, f"Expected near 0, got {s}"


# ── Fleet initialization ───────────────────────────────────────────────────────

def test_fleet_size_matches_profile():
    cfg = {
        "fleet": {
            "total_devices": 10,
            "bts_ratio": 0.4,
            "device_models": {"bts": ["ENS500EXT"], "cpe": ["ENH200EXT"]},
        },
        "state_transitions": {
            "offline_probability": 0.02,
            "recovery_probability": 0.80,
            "faulty_probability": 0.005,
        },
    }
    fleet = Fleet(cfg)
    assert len(fleet.devices) == 10
    bts_count = sum(1 for d in fleet.devices if d.device_type == DeviceType.BTS)
    cpe_count = sum(1 for d in fleet.devices if d.device_type == DeviceType.CPE)
    assert bts_count == 4
    assert cpe_count == 6


def test_fleet_active_count_initially_all_online():
    cfg = {
        "fleet": {"total_devices": 5, "bts_ratio": 0.4,
                  "device_models": {"bts": ["ENS500EXT"], "cpe": ["ENH200EXT"]}},
        "state_transitions": {"offline_probability": 0, "recovery_probability": 1, "faulty_probability": 0},
    }
    fleet = Fleet(cfg)
    assert fleet.active_count == 5


def test_fleet_state_transitions_offline():
    """With 100% offline probability, all devices should go offline after tick."""
    cfg = {
        "fleet": {"total_devices": 10, "bts_ratio": 0.5,
                  "device_models": {"bts": ["ENS500EXT"], "cpe": ["ENH200EXT"]}},
        "state_transitions": {"offline_probability": 1.0, "recovery_probability": 0, "faulty_probability": 0},
    }
    fleet = Fleet(cfg)
    fleet.tick_state_transitions()
    assert fleet.active_count == 0


def test_fleet_state_transitions_recovery():
    """With 0% offline + 100% recovery, offline devices should come back online."""
    cfg = {
        "fleet": {"total_devices": 5, "bts_ratio": 0.4,
                  "device_models": {"bts": ["ENS500EXT"], "cpe": ["ENH200EXT"]}},
        "state_transitions": {"offline_probability": 0, "recovery_probability": 1.0, "faulty_probability": 0},
    }
    fleet = Fleet(cfg)
    # Force all offline
    for d in fleet.devices:
        d.state = DeviceState.OFFLINE
    fleet.tick_state_transitions()
    assert fleet.active_count == 5


# ── KPI response generation ───────────────────────────────────────────────────

def test_generate_kpi_response_contains_required_fields():
    device = DeviceProfile.generate(0, DeviceType.CPE, ["ENH200EXT"])
    kpi_cfg = {
        "rssi_dbm": {"min": -80, "max": -40, "mean": -60, "stddev": 10},
        "snr_db": {"min": 5, "max": 40, "mean": 25, "stddev": 6},
        "cpu_usage_pct": {"min": 5, "max": 95, "mean": 30, "stddev": 15},
    }
    response = generate_kpi_response(device, kpi_cfg)
    assert response["deviceId"] == device.device_id
    assert response["serialNumber"] == device.serial_number
    assert response["deviceType"] == "CPE"
    assert "rssi_dbm" in response["metrics"]
    assert "snr_db" in response["metrics"]
    assert "cpu_usage_pct" in response["metrics"]


def test_generate_kpi_response_bts_includes_radio():
    device = DeviceProfile.generate(0, DeviceType.BTS, ["ENS500EXT"])
    kpi_cfg = {
        "rssi_dbm": {"min": -80, "max": -40, "mean": -60, "stddev": 10},
        "snr_db": {"min": 5, "max": 40, "mean": 25, "stddev": 6},
    }
    response = generate_kpi_response(device, kpi_cfg)
    assert "wireless5GhzRadio" in response
    radio = response["wireless5GhzRadio"]
    assert "txPowerDbm" in radio
    assert "associatedClients" in radio


def test_generate_kpi_response_values_in_bounds():
    device = DeviceProfile.generate(0, DeviceType.CPE, ["ENH200EXT"])
    kpi_cfg = {
        "cpu_usage_pct": {"min": 5, "max": 95, "mean": 30, "stddev": 15},
    }
    for _ in range(50):
        response = generate_kpi_response(device, kpi_cfg)
        cpu = response["metrics"]["cpu_usage_pct"]
        assert 5 <= cpu <= 95, f"CPU {cpu} out of [5, 95]"


# ── SNMP trap formatting ──────────────────────────────────────────────────────

def test_generate_snmp_trap_structure():
    device = DeviceProfile.generate(0, DeviceType.BTS, ["ENS500EXT"])
    trap = generate_snmp_trap(device, "1.3.6.1.4.1.28776")
    assert trap["version"] == "2c"
    assert trap["agentAddr"] == device.ip_address
    assert "varBinds" in trap
    assert len(trap["varBinds"]) >= 3
    assert trap["deviceId"] == device.device_id


def test_snmp_trap_enterprise_oid_contains_prefix():
    device = DeviceProfile.generate(0, DeviceType.BTS, ["ENS500EXT"])
    trap = generate_snmp_trap(device, "1.3.6.1.4.1.28776")
    assert trap["enterprise"].startswith("1.3.6.1.4.1.28776")


# ── Syslog message formatting ─────────────────────────────────────────────────

def test_generate_syslog_message_structure():
    device = DeviceProfile.generate(0, DeviceType.CPE, ["ENH200EXT"])
    msg = generate_syslog_message(device, "warning")
    assert msg["severity"] == "warning"
    assert msg["hostname"] == device.device_id
    assert msg["deviceType"] == "CPE"
    assert isinstance(msg["message"], str)
    assert len(msg["message"]) > 0


def test_generate_syslog_all_severities():
    device = DeviceProfile.generate(0, DeviceType.BTS, ["ENS500EXT"])
    for sev in ["debug", "info", "notice", "warning", "error"]:
        msg = generate_syslog_message(device, sev)
        assert msg["severity"] == sev


# ── Severity picker ───────────────────────────────────────────────────────────

def test_pick_severity_respects_distribution():
    distribution = {"info": 0.9, "error": 0.1}
    results = [pick_severity(distribution) for _ in range(200)]
    info_count = results.count("info")
    # With 90% info weight, should be > 50%
    assert info_count > 100, f"Expected >100 info results, got {info_count}"


def test_pick_severity_handles_single_option():
    distribution = {"critical": 1.0}
    for _ in range(10):
        assert pick_severity(distribution) == "critical"
