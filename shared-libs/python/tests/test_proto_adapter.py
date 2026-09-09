"""Unit tests for shared-libs/python/proto/adapter.py (WO-024).

Covers:
  - Round-trip DeviceEntity → proto dict → DeviceEntity
  - Proto empty-string default → None normalisation
  - None optional field → key absent in wire dict
  - Epoch-milli ↔ datetime conversion including zero sentinel
  - AlarmRecord round-trip including nullable cleared_at pointer
"""
from datetime import datetime, timezone

import pytest

from ..models.models import AlarmRecord, DeviceEntity, DeviceTag
from ..proto.adapter import (
    alarm_from_proto_dict,
    alarm_to_proto_dict,
    device_from_proto_dict,
    device_to_proto_dict,
)


# ── Fixtures ───────────────────────────────────────────────────────────────────

def make_device(**overrides) -> DeviceEntity:
    defaults = dict(
        device_id="dev-001",
        serial_number="SN-001",
        mac_address="AA:BB:CC:DD:EE:FF",
        device_type="BTS",
        status="online",
        ip_address="10.0.0.1",
        model="NR-3500",
        region="North",
        uptime_seconds=3600,
        connected_cpe_count=3,
        organization_id="org-001",
        created_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
        updated_at=datetime(2026, 1, 2, tzinfo=timezone.utc),
    )
    defaults.update(overrides)
    return DeviceEntity(**defaults)


def make_alarm(**overrides) -> AlarmRecord:
    defaults = dict(
        alarm_id="alarm-001",
        device_id="dev-001",
        alarm_name="LINK_DOWN",
        severity="CRITICAL",
        state="RAISED",
        acknowledged=False,
        raised_at=datetime(2026, 1, 1, 12, 0, tzinfo=timezone.utc),
    )
    defaults.update(overrides)
    return AlarmRecord(**defaults)


# ── DeviceEntity ───────────────────────────────────────────────────────────────

class TestDeviceToProtoDict:
    def test_required_fields_present(self):
        device = make_device()
        wire = device_to_proto_dict(device)

        assert wire["deviceId"] == "dev-001"
        assert wire["serialNumber"] == "SN-001"
        assert wire["macAddress"] == "AA:BB:CC:DD:EE:FF"
        assert wire["status"] == "online"

    def test_none_optional_field_absent_from_dict(self):
        device = make_device(ip_address=None, model=None, connected_bts_serial=None)
        wire = device_to_proto_dict(device)

        assert "ipAddress" not in wire, "None ip_address must not appear in proto dict"
        assert "model" not in wire
        assert "connectedBtsSerial" not in wire

    def test_timestamps_converted_to_epoch_milli(self):
        dt = datetime(2026, 1, 1, tzinfo=timezone.utc)
        device = make_device(created_at=dt, updated_at=dt)
        wire = device_to_proto_dict(device)

        expected_milli = int(dt.timestamp() * 1000)
        assert wire["createdAtMilli"] == expected_milli
        assert wire["updatedAtMilli"] == expected_milli

    def test_none_timestamp_absent_from_dict(self):
        device = make_device(created_at=None, updated_at=None)
        wire = device_to_proto_dict(device)

        assert "createdAtMilli" not in wire
        assert "updatedAtMilli" not in wire

    def test_tags_serialised(self):
        device = make_device(tags=[DeviceTag(key="site", value="HQ")])
        wire = device_to_proto_dict(device)

        assert wire["tags"] == [{"key": "site", "value": "HQ"}]


class TestDeviceFromProtoDict:
    def test_round_trip_preserves_all_fields(self):
        original = make_device()
        wire = device_to_proto_dict(original)
        result = device_from_proto_dict(wire)

        assert result.device_id == original.device_id
        assert result.ip_address == original.ip_address
        assert result.model == original.model
        assert result.uptime_seconds == original.uptime_seconds
        assert result.connected_cpe_count == original.connected_cpe_count
        assert result.created_at == original.created_at

    def test_empty_string_normalised_to_none(self):
        # Proto default for absent optional string is "".
        wire = {
            "deviceId": "dev-002",
            "serialNumber": "SN-002",
            "macAddress": "AA:BB:CC:DD:EE:02",
            "deviceType": "CPE",
            "status": "offline",
            "ipAddress": "",        # proto absent / default
            "model": "",
            "connectedBtsSerial": "",
        }
        result = device_from_proto_dict(wire)

        assert result.ip_address is None, "empty string must map to None"
        assert result.model is None
        assert result.connected_bts_serial is None

    def test_zero_milli_timestamps_become_none(self):
        wire = {
            "deviceId": "dev-003",
            "macAddress": "AA:BB:CC:DD:EE:03",
            "deviceType": "IDU",
            "status": "offline",
            "createdAtMilli": 0,    # proto absent sentinel
        }
        result = device_from_proto_dict(wire)
        assert result.created_at is None

    def test_missing_optional_keys_yield_defaults(self):
        wire = {
            "deviceId": "dev-004",
            "macAddress": "AA:BB:CC:DD:EE:04",
            "deviceType": "BTS",
            "status": "online",
        }
        result = device_from_proto_dict(wire)

        assert result.connected_cpe_count == 0
        assert result.connected_idu_count == 0
        assert result.uptime_seconds is None
        assert result.created_at is None


# ── AlarmRecord ───────────────────────────────────────────────────────────────

class TestAlarmRoundTrip:
    def test_round_trip_all_fields(self):
        cleared = datetime(2026, 1, 1, 13, 0, tzinfo=timezone.utc)
        original = make_alarm(
            acknowledged=True,
            acknowledged_by="operator@example.com",
            cleared_at=cleared,
        )
        wire = alarm_to_proto_dict(original)
        result = alarm_from_proto_dict(wire)

        assert result.alarm_id == original.alarm_id
        assert result.severity == original.severity
        assert result.acknowledged_by == "operator@example.com"
        assert result.cleared_at is not None
        assert result.cleared_at == cleared

    def test_none_cleared_at_absent_from_wire(self):
        alarm = make_alarm(cleared_at=None)
        wire = alarm_to_proto_dict(alarm)

        assert "clearedAtMilli" not in wire

    def test_missing_cleared_at_in_wire_yields_none(self):
        alarm = make_alarm()
        wire = alarm_to_proto_dict(alarm)
        wire.pop("clearedAtMilli", None)

        result = alarm_from_proto_dict(wire)
        assert result.cleared_at is None

    def test_empty_acknowledged_by_normalised_to_none(self):
        alarm = make_alarm(acknowledged_by=None)
        wire = alarm_to_proto_dict(alarm)
        # Simulate proto transmitting empty string default for absent optional.
        wire["acknowledgedBy"] = ""

        result = alarm_from_proto_dict(wire)
        assert result.acknowledged_by is None
