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


# ── IDU device type ───────────────────────────────────────────────────────────

def test_generate_idu_profile():
    """IDU must be a recognised DeviceType (WO-035)."""
    d = DeviceProfile.generate(0, DeviceType.IDU, ["IDU-3000"])
    assert d.device_type == DeviceType.IDU
    assert d.device_id.startswith("IDU-")


# ── UBR Protocol helpers (ubr_protocol module) ────────────────────────────────

import sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "../src"))

from ubr_protocol import (
    generate_nonce, build_auth_info, compute_auth_signature, build_signed_headers,
    decode_kv_registry, make_kv_entry, ServiceRegistry, is_timestamp_fresh,
    parse_retry_headers,
)


def test_generate_nonce_length():
    nonce = generate_nonce(30)
    assert len(nonce) == 30


def test_generate_nonce_is_alphanumeric():
    nonce = generate_nonce(30)
    assert nonce.isalnum(), f"Nonce contains non-alphanumeric chars: {nonce}"


def test_generate_nonce_uniqueness():
    nonces = {generate_nonce() for _ in range(100)}
    assert len(nonces) == 100, "Nonces must be unique across 100 samples"


def test_build_auth_info_format():
    ai = build_auth_info("AA:BB:CC:DD:EE:FF", timestamp=1700000000, nonce="A" * 30)
    assert ai == "id=AA:BB:CC:DD:EE:FF,timestamp=1700000000,nonce=" + "A" * 30


def test_build_auth_info_defaults_timestamp_and_nonce():
    import time
    before = int(time.time())
    ai = build_auth_info("AA:BB:CC:DD:EE:FF")
    after = int(time.time())
    import re
    m = re.search(r"timestamp=(\d+)", ai)
    assert m is not None
    ts = int(m.group(1))
    assert before <= ts <= after + 1
    nm = re.search(r"nonce=(\w+)", ai)
    assert nm and len(nm.group(1)) == 30


def test_compute_auth_signature_deterministic():
    """Same inputs must produce the same signature."""
    sig1 = compute_auth_signature("mysecret", "id=aa:bb,timestamp=123,nonce=abc",
                                  "/api/v1/discovery/check-in", b'{"serial":"X"}')
    sig2 = compute_auth_signature("mysecret", "id=aa:bb,timestamp=123,nonce=abc",
                                  "/api/v1/discovery/check-in", b'{"serial":"X"}')
    assert sig1 == sig2


def test_compute_auth_signature_changes_with_different_secret():
    path = "/api/v1/discovery/check-in"
    ai = "id=aa:bb,timestamp=123,nonce=abc"
    body = b""
    sig1 = compute_auth_signature("secret-one", ai, path, body)
    sig2 = compute_auth_signature("secret-two", ai, path, body)
    assert sig1 != sig2


def test_compute_auth_signature_is_hex():
    sig = compute_auth_signature("s", "ai", "/path", b"")
    assert len(sig) == 64
    assert all(c in "0123456789abcdef" for c in sig)


def test_build_signed_headers_contains_required_keys():
    headers = build_signed_headers("secret", "AA:BB:CC:DD:EE:FF",
                                   "/api/v1/discovery/check-in", b"body")
    assert "Auth-Info" in headers
    assert "Auth-Signature" in headers
    assert len(headers["Auth-Signature"]) == 64


def test_build_signed_headers_does_not_expose_secret():
    """Secret must not appear in any header value."""
    secret = "super-secret-hmac-key"
    headers = build_signed_headers(secret, "AA:BB:CC:DD:EE:FF", "/path", b"")
    for val in headers.values():
        assert secret not in val, f"Secret leaked into header: {val}"


# ── KV registry decoding ──────────────────────────────────────────────────────

def test_decode_kv_registry_complete():
    kv = [
        make_kv_entry("auth",     "http://svc:8080/auth"),
        make_kv_entry("checkin",  "http://svc:8080/checkin"),
        make_kv_entry("events",   "http://svc:8080/events"),
        make_kv_entry("realtime", "wss://svc:8443/ws"),
    ]
    registry = decode_kv_registry(kv)
    assert registry.auth_url     == "http://svc:8080/auth"
    assert registry.checkin_url  == "http://svc:8080/checkin"
    assert registry.event_url    == "http://svc:8080/events"
    assert registry.realtime_url == "wss://svc:8443/ws"
    assert registry.is_complete()


def test_decode_kv_registry_not_a_list():
    registry = decode_kv_registry({"bad": "data"})
    assert not registry.is_complete()


def test_decode_kv_registry_invalid_base64():
    kv = [{"Key": "services/auth", "Value": "!!!not-base64!!!"}]
    registry = decode_kv_registry(kv)
    assert registry.auth_url is None


def test_decode_kv_registry_missing_value():
    kv = [{"Key": "services/auth"}]
    registry = decode_kv_registry(kv)
    assert registry.auth_url is None


def test_decode_kv_registry_unsupported_scheme():
    import base64, json
    bad_url = json.dumps({"url": "ftp://notallowed.example.com"}).encode()
    kv = [{"Key": "services/auth", "Value": base64.b64encode(bad_url).decode()}]
    registry = decode_kv_registry(kv)
    assert registry.auth_url is None


def test_decode_kv_registry_partial_fills_available_services():
    kv = [
        make_kv_entry("auth", "http://svc:8080/auth"),
        make_kv_entry("checkin", "http://svc:8080/checkin"),
    ]
    registry = decode_kv_registry(kv)
    assert registry.auth_url    == "http://svc:8080/auth"
    assert registry.checkin_url == "http://svc:8080/checkin"
    assert registry.event_url   is None
    assert not registry.is_complete()


# ── is_timestamp_fresh ────────────────────────────────────────────────────────

def test_timestamp_fresh_current_time():
    import time
    ai = build_auth_info("AA:BB:CC:DD:EE:FF", timestamp=int(time.time()))
    assert is_timestamp_fresh(ai)


def test_timestamp_stale():
    ai = build_auth_info("AA:BB:CC:DD:EE:FF", timestamp=1_000_000)  # epoch 2001
    assert not is_timestamp_fresh(ai)


# ── parse_retry_headers ───────────────────────────────────────────────────────

def test_parse_retry_headers_explicit():
    headers = {"Retry-After": "60", "X-Retry-Jitter-Max": "15"}
    ra, jm = parse_retry_headers(headers)
    assert ra == 60
    assert jm == 15


def test_parse_retry_headers_defaults_when_missing():
    ra, jm = parse_retry_headers({})
    assert ra == 30  # documented default
    assert jm == 10  # documented default


def test_parse_retry_headers_invalid_values_use_defaults():
    headers = {"Retry-After": "notanumber", "X-Retry-Jitter-Max": "also-bad"}
    ra, jm = parse_retry_headers(headers)
    assert ra == 30
    assert jm == 10


# ── UbrDeviceSimulator state machine ─────────────────────────────────────────

from simulator import UbrDeviceSimulator, SimulatorBootstrapState


class _MockResponse:
    def __init__(self, status_code: int, body=None, headers=None):
        self.status_code = status_code
        self._body = body or {}
        self.headers = headers or {}

    def json(self):
        return self._body


class _MockHttpClient:
    def __init__(self, responses: dict):
        """responses: {(method, url): MockResponse}"""
        self._responses = responses

    def get(self, url, **kwargs):
        return self._responses.get(("GET", url), _MockResponse(404))

    def post(self, url, **kwargs):
        return self._responses.get(("POST", url), _MockResponse(404))


class _MockWsClient:
    def __init__(self, success: bool = True):
        self._success = success

    def connect(self, url, **kwargs):
        return self._success


def _valid_kv_registry():
    from ubr_protocol import make_kv_entry
    return [
        make_kv_entry("auth",     "http://svc:8081/auth"),
        make_kv_entry("checkin",  "http://svc:8081/checkin"),
        make_kv_entry("events",   "http://svc:8081/events"),
        make_kv_entry("realtime", "wss://svc:8081/ws"),
    ]


def _make_simulator(http_client, ws_client=None, secret="test-secret"):
    return UbrDeviceSimulator(
        serial_number="SN-TEST-001",
        mac_address="AA:BB:CC:DD:EE:FF",
        device_type="BTS",
        firmware_version="fw-2.4.1",
        http_client=http_client,
        ws_client=ws_client or _MockWsClient(True),
        hmac_secret=secret,
        discovery_base_url="http://svc:8081",
    )


def test_simulator_full_success_path():
    kv_url = "http://svc:8081/discovery/v1/kv/services?recurse=1"
    responses = {
        ("GET", kv_url):               _MockResponse(200, _valid_kv_registry()),
        ("POST", "http://svc:8081/auth"):    _MockResponse(200),
        ("POST", "http://svc:8081/checkin"): _MockResponse(200),
    }
    sim = _make_simulator(_MockHttpClient(responses))
    result = sim.run()
    assert result.state == SimulatorBootstrapState.OPERATION
    assert "BOOT" in result.transitions
    assert "DISCOVERY" in result.transitions
    assert "AUTHENTICATION" in result.transitions
    assert "CHECK_IN" in result.transitions
    assert "REALTIME" in result.transitions
    assert "OPERATION" in result.transitions


def test_simulator_registry_302_failover():
    kv_url = "http://svc:8081/discovery/v1/kv/services?recurse=1"
    responses = {
        ("GET", kv_url): _MockResponse(302, headers={"Location": "http://backup:8081"}),
    }
    sim = _make_simulator(_MockHttpClient(responses))
    result = sim.run()
    assert result.state == SimulatorBootstrapState.REDIRECTED
    assert result.reason == "NMS_FAILOVER"


def test_simulator_auth_hmac_invalid():
    kv_url = "http://svc:8081/discovery/v1/kv/services?recurse=1"
    responses = {
        ("GET", kv_url):            _MockResponse(200, _valid_kv_registry()),
        ("POST", "http://svc:8081/auth"): _MockResponse(462),
    }
    sim = _make_simulator(_MockHttpClient(responses))
    result = sim.run()
    assert result.state == SimulatorBootstrapState.FAILED
    assert "HMAC" in result.reason
    assert not result.retryable


def test_simulator_checkin_hmac_invalid_after_auth():
    kv_url = "http://svc:8081/discovery/v1/kv/services?recurse=1"
    responses = {
        ("GET", kv_url):                 _MockResponse(200, _valid_kv_registry()),
        ("POST", "http://svc:8081/auth"):     _MockResponse(200),
        ("POST", "http://svc:8081/checkin"):  _MockResponse(462),
    }
    sim = _make_simulator(_MockHttpClient(responses))
    result = sim.run()
    assert result.state == SimulatorBootstrapState.FAILED
    assert result.reason == "HMAC_INVALID_AFTER_AUTH"
    assert not result.retryable


def test_simulator_rate_limited_uses_retry_headers():
    kv_url = "http://svc:8081/discovery/v1/kv/services?recurse=1"
    responses = {
        ("GET", kv_url): _MockResponse(429, headers={"Retry-After": "45", "X-Retry-Jitter-Max": "5"}),
    }
    sim = _make_simulator(_MockHttpClient(responses))
    result = sim.run()
    assert result.state == SimulatorBootstrapState.FAILED
    assert result.reason == "RATE_LIMITED"
    assert result.retryable
    assert result.retry_after_seconds == 45
    assert result.retry_jitter_max_seconds == 5


def test_simulator_realtime_timeout():
    kv_url = "http://svc:8081/discovery/v1/kv/services?recurse=1"
    responses = {
        ("GET", kv_url):                 _MockResponse(200, _valid_kv_registry()),
        ("POST", "http://svc:8081/auth"):     _MockResponse(200),
        ("POST", "http://svc:8081/checkin"):  _MockResponse(200),
    }
    sim = _make_simulator(_MockHttpClient(responses), ws_client=_MockWsClient(False))
    result = sim.run()
    assert result.state == SimulatorBootstrapState.FAILED
    assert result.reason == "REALTIME_TIMEOUT"
    assert result.retryable


def test_simulator_never_logs_secret(caplog):
    """Secret must not appear anywhere in log output."""
    import logging
    secret = "ultra-secret-key-abc123"
    kv_url = "http://svc:8081/discovery/v1/kv/services?recurse=1"
    responses = {
        ("GET", kv_url):                 _MockResponse(200, _valid_kv_registry()),
        ("POST", "http://svc:8081/auth"):     _MockResponse(200),
        ("POST", "http://svc:8081/checkin"):  _MockResponse(200),
    }
    with caplog.at_level(logging.DEBUG, logger="ubr_protocol"):
        sim = _make_simulator(_MockHttpClient(responses), secret=secret)
        sim.run()
    for record in caplog.records:
        assert secret not in record.getMessage(), \
            f"Secret leaked into log: {record.getMessage()}"


def test_simulator_malformed_registry_response():
    kv_url = "http://svc:8081/discovery/v1/kv/services?recurse=1"
    responses = {
        ("GET", kv_url): _MockResponse(200, "not-a-list"),
    }
    sim = _make_simulator(_MockHttpClient(responses))
    result = sim.run()
    assert result.state == SimulatorBootstrapState.FAILED
    assert result.reason in ("INCOMPLETE_REGISTRY", "MALFORMED_REGISTRY_RESPONSE")
