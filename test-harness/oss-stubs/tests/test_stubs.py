"""
Unit tests for OSS/BSS stub validators and assertion API.
"""
import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "../src"))

import json
import pytest
from fastapi.testclient import TestClient

from stubs import (
    StubStore,
    validate_netcool, validate_mycom, validate_mobinet, validate_syslog_rfc5424,
    build_gis_tile_response,
)
from app import app, ingest_kafka_message, STORES


@pytest.fixture(autouse=True)
def reset_stores():
    """Clear all stores before each test."""
    for store in STORES.values():
        store.reset()
    yield


client = TestClient(app)


# ── StubStore ─────────────────────────────────────────────────────────────────

def test_stub_store_add_and_count():
    store = StubStore("test")
    store.add({"msg": "hello"})
    store.add({"msg": "world"})
    assert store.count() == 2
    assert len(store.all()) == 2


def test_stub_store_reset():
    store = StubStore("test")
    store.add({"msg": "hello"})
    store.reset()
    assert store.count() == 0


def test_stub_store_respects_max_messages():
    store = StubStore("test", max_messages=3)
    for i in range(5):
        store.add({"i": i})
    assert store.count() == 3


# ── Netcool validator ─────────────────────────────────────────────────────────

def valid_netcool_msg():
    return {
        "alarmId": "AL-001",
        "alarmName": "Link Down",
        "severity": "CRITICAL",
        "alarmDescription": "Interface down",
        "state": "ACTIVE",
        "Time": "2026-07-05T10:00:00Z",
        "data": {"deviceType": "CPE", "deviceId": "CPE-001"},
    }


def test_validate_netcool_valid():
    assert validate_netcool(valid_netcool_msg()) == []


def test_validate_netcool_missing_alarmid():
    msg = valid_netcool_msg()
    del msg["alarmId"]
    errors = validate_netcool(msg)
    assert any("alarmId" in e for e in errors)


def test_validate_netcool_missing_data_deviceid():
    msg = valid_netcool_msg()
    del msg["data"]["deviceId"]
    errors = validate_netcool(msg)
    assert any("data.deviceId" in e for e in errors)


def test_validate_netcool_invalid_time_format():
    msg = valid_netcool_msg()
    msg["Time"] = "07/05/2026"
    errors = validate_netcool(msg)
    assert any("Time" in e for e in errors)


def test_validate_netcool_clear_state():
    msg = valid_netcool_msg()
    msg["state"] = "CLEAR"
    msg["severity"] = "CLEAR"
    assert validate_netcool(msg) == []


# ── Mycom validator ───────────────────────────────────────────────────────────

def valid_mycom_msg():
    return {
        "serialNumber": "SN-001",
        "deviceType": "BTS",
        "modelNo": "ENS500EXT",
        "timestamp": "2026-07-05T10:00:00Z",
        "granularity": "5m",
        "metrics": {"cpu_usage_pct": 42.5},
        "latitude": -1.286389,
        "longitude": 36.817223,
    }


def test_validate_mycom_valid():
    assert validate_mycom(valid_mycom_msg()) == []


def test_validate_mycom_missing_serialnumber():
    msg = valid_mycom_msg()
    del msg["serialNumber"]
    errors = validate_mycom(msg)
    assert any("serialNumber" in e for e in errors)


def test_validate_mycom_latitude_must_be_float():
    msg = valid_mycom_msg()
    msg["latitude"] = "-1.286389"  # string instead of float
    errors = validate_mycom(msg)
    assert any("latitude" in e for e in errors)


def test_validate_mycom_metrics_must_be_object():
    msg = valid_mycom_msg()
    msg["metrics"] = "not-an-object"
    errors = validate_mycom(msg)
    assert any("metrics" in e for e in errors)


# ── Mobinet validator ─────────────────────────────────────────────────────────

def valid_mobinet_msg():
    return {
        "systemName": "BTS-001",
        "ipAddress": "10.1.0.1",
        "macAddress": "AA:BB:CC:DD:EE:FF",
        "serialNumber": "SN-001",
        "model": "ENS500EXT",
        "firmware": "3.0.0",
        "deviceStatus": "ACTIVE",
        "linkType": "wireless",
        "radioMode": "5GHz",
        "ssid": "UBR-Backhaul",
        "bandwidth": "80MHz",
        "channel": 36,
        "frequencyMHz": 5180.0,
        "latitude": -1.286389,
        "longitude": 36.817223,
    }


def test_validate_mobinet_valid():
    assert validate_mobinet(valid_mobinet_msg()) == []


def test_validate_mobinet_missing_field():
    msg = valid_mobinet_msg()
    del msg["ipAddress"]
    errors = validate_mobinet(msg)
    assert any("ipAddress" in e for e in errors)


def test_validate_mobinet_latitude_must_be_float():
    msg = valid_mobinet_msg()
    msg["latitude"] = "-1.286389"
    errors = validate_mobinet(msg)
    assert any("latitude" in e for e in errors)


# ── Syslog RFC 5424 validator ─────────────────────────────────────────────────

def test_validate_syslog_valid_rfc5424():
    line = "<130>1 2026-07-05T10:00:00Z CPE-001 alarm-service - EVT-001 - Link down on CPE-001"
    assert validate_syslog_rfc5424(line) == []


def test_validate_syslog_invalid_format():
    line = "not a valid syslog message"
    errors = validate_syslog_rfc5424(line)
    assert len(errors) > 0


def test_validate_syslog_invalid_facility():
    # Facility 25 is invalid (max is 23)
    line = "<201>1 2026-07-05T10:00:00Z host app - id - message"  # 201 = facility 25, sev 1
    errors = validate_syslog_rfc5424(line)
    assert any("facility" in e for e in errors)


# ── GIS stub ──────────────────────────────────────────────────────────────────

def test_build_gis_tile_returns_png():
    tile = build_gis_tile_response(10, 512, 384)
    assert tile[:4] == b"\x89PNG"


def test_gis_endpoint_returns_png():
    resp = client.get("/api/v1/stub/gis/tiles/10/512/384.png")
    assert resp.status_code == 200
    assert resp.headers["content-type"] == "image/png"
    assert resp.content[:4] == b"\x89PNG"


# ── REST assertion API ────────────────────────────────────────────────────────

def test_get_messages_empty():
    resp = client.get("/api/v1/stub/netcool/messages")
    assert resp.status_code == 200
    data = resp.json()
    assert data["count"] == 0
    assert data["messages"] == []


def test_get_messages_after_ingest():
    ingest_kafka_message("netcool", json.dumps(valid_netcool_msg()).encode())
    resp = client.get("/api/v1/stub/netcool/messages")
    data = resp.json()
    assert data["count"] == 1
    assert data["messages"][0]["valid"] is True


def test_ingest_invalid_message_stored_with_errors():
    ingest_kafka_message("netcool", b"not-json")
    resp = client.get("/api/v1/stub/netcool/messages")
    data = resp.json()
    assert data["count"] == 1
    assert data["messages"][0]["valid"] is False


def test_reset_clears_messages():
    ingest_kafka_message("mycom", json.dumps(valid_mycom_msg()).encode())
    assert STORES["mycom"].count() == 1

    resp = client.delete("/api/v1/stub/mycom/messages")
    assert resp.status_code == 200
    assert STORES["mycom"].count() == 0


def test_unknown_stub_returns_404():
    resp = client.get("/api/v1/stub/unknown/messages")
    assert resp.status_code == 404


def test_syslog_endpoint_valid():
    resp = client.post(
        "/api/v1/stub/syslog",
        content=b"<130>1 2026-07-05T10:00:00Z CPE-001 alarm-service - EVT-001 - Link down",
        headers={"content-type": "text/plain"},
    )
    assert resp.status_code == 200
    assert resp.json()["valid"] is True
    assert STORES["syslog"].count() == 1


def test_syslog_endpoint_invalid():
    resp = client.post(
        "/api/v1/stub/syslog",
        content=b"not a syslog message",
        headers={"content-type": "text/plain"},
    )
    assert resp.status_code == 200
    assert resp.json()["valid"] is False
