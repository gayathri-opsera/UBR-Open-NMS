"""
proto/adapter.py — Python bridge between hand-written dataclass models and
the Protobuf-generated wire types (WO-024).

Why this adapter exists
-----------------------
Protobuf Python classes use:
- Default integer/float value of 0 (not None)
- Default string value of "" (not None)
- HasField() checks for optional scalar fields (proto3 optional keyword)

The hand-written models use Python None for absent optional fields. This
adapter handles all proto default-value edge cases so consuming services
can migrate without touching business logic.

Usage (Kafka publishing path)
-----------------------------
    from shared_libs.proto.adapter import device_to_proto_dict, device_from_proto_dict
    wire = device_to_proto_dict(device)
    kafka.produce('device-events', json.dumps(wire))

Usage (Kafka consuming path)
-----------------------------
    msg = json.loads(kafka_message.value)
    device = device_from_proto_dict(msg)
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, Optional

from ..models.models import DeviceEntity, AlarmRecord, KPIDataPoint, DeviceTag


# ── DeviceEntity ──────────────────────────────────────────────────────────────

def device_to_proto_dict(d: DeviceEntity) -> Dict[str, Any]:
    """Convert a DeviceEntity dataclass to a proto-json wire dict.

    Edge cases:
    - None optional fields are omitted from the dict (proto absent)
    - datetime fields are converted to epoch milliseconds (int)
    - connected_bts_serial (Optional[str]) → absent key when None
    """
    result: Dict[str, Any] = {
        "deviceId":     d.device_id,
        "serialNumber": d.serial_number,
        "macAddress":   d.mac_address,
        "deviceType":   d.device_type,
        "status":       d.status,
    }
    # Optional string fields — only include when set (proto absent otherwise)
    _set_if_not_none(result, "ipAddress",       d.ip_address)
    _set_if_not_none(result, "model",           d.model)
    _set_if_not_none(result, "firmwareVersion", d.firmware_version)
    _set_if_not_none(result, "region",          d.region)
    _set_if_not_none(result, "organizationId",  d.organization_id)
    _set_if_not_none(result, "networkId",       d.network_id)
    _set_if_not_none(result, "connectedBtsSerial", d.connected_bts_serial)

    # Numeric fields — omit when 0 / None (proto absent)
    if d.uptime_seconds is not None:
        result["uptimeSeconds"] = d.uptime_seconds
    if d.connected_cpe_count:
        result["connectedCpeCount"] = d.connected_cpe_count
    if d.connected_idu_count:
        result["connectedIduCount"] = d.connected_idu_count
    if d.latitude is not None:
        result["latitude"] = d.latitude
    if d.longitude is not None:
        result["longitude"] = d.longitude

    # Timestamp → epoch millis (absent when None)
    if d.created_at is not None:
        result["createdAtMilli"] = _to_milli(d.created_at)
    if d.updated_at is not None:
        result["updatedAtMilli"] = _to_milli(d.updated_at)

    if d.tags:
        result["tags"] = [{"key": t.key, "value": t.value} for t in d.tags]

    return result


def device_from_proto_dict(m: Dict[str, Any]) -> DeviceEntity:
    """Convert a proto-json wire dict back to a DeviceEntity dataclass.

    Edge cases:
    - Missing / empty string keys → None in dataclass
    - Missing numeric keys → None or 0 per field type
    - createdAtMilli=0 or absent → None datetime
    """
    tags = [
        DeviceTag(key=t["key"], value=t["value"])
        for t in m.get("tags", [])
    ]
    return DeviceEntity(
        device_id=m["deviceId"],
        serial_number=m.get("serialNumber", ""),
        mac_address=m.get("macAddress", ""),
        device_type=m.get("deviceType", "BTS"),  # type: ignore[arg-type]
        status=m.get("status", "offline"),         # type: ignore[arg-type]
        ip_address=_empty_to_none(m.get("ipAddress")),
        model=_empty_to_none(m.get("model")),
        firmware_version=_empty_to_none(m.get("firmwareVersion")),
        region=_empty_to_none(m.get("region")),
        organization_id=_empty_to_none(m.get("organizationId")),
        network_id=_empty_to_none(m.get("networkId")),
        connected_bts_serial=_empty_to_none(m.get("connectedBtsSerial")),
        uptime_seconds=m.get("uptimeSeconds"),
        connected_cpe_count=m.get("connectedCpeCount", 0),
        connected_idu_count=m.get("connectedIduCount", 0),
        latitude=m.get("latitude"),
        longitude=m.get("longitude"),
        created_at=_from_milli(m.get("createdAtMilli")),
        updated_at=_from_milli(m.get("updatedAtMilli")),
        tags=tags,
    )


# ── AlarmRecord ───────────────────────────────────────────────────────────────

def alarm_to_proto_dict(a: AlarmRecord) -> Dict[str, Any]:
    """Convert an AlarmRecord to proto-json wire dict."""
    result: Dict[str, Any] = {
        "alarmId":      a.alarm_id,
        "deviceId":     a.device_id,
        "alarmName":    a.alarm_name,
        "severity":     a.severity,
        "state":        a.state,
        "acknowledged": a.acknowledged,
        "raisedAtMilli": _to_milli(a.raised_at),
    }
    _set_if_not_none(result, "alarmDescription", a.alarm_description)
    _set_if_not_none(result, "correlationGroup", a.correlation_group)
    _set_if_not_none(result, "rootCause",        a.root_cause)
    _set_if_not_none(result, "acknowledgedBy",   a.acknowledged_by)
    if a.cleared_at is not None:
        result["clearedAtMilli"] = _to_milli(a.cleared_at)
    return result


def alarm_from_proto_dict(m: Dict[str, Any]) -> AlarmRecord:
    """Convert a proto-json dict back to an AlarmRecord dataclass."""
    import dataclasses
    # AlarmRecord does not have an __init__ with all optional fields in some versions;
    # build via a dict and reconstruct to handle missing keys gracefully.
    return AlarmRecord(
        alarm_id=m["alarmId"],
        device_id=m["deviceId"],
        alarm_name=m["alarmName"],
        severity=m["severity"],   # type: ignore[arg-type]
        state=m["state"],          # type: ignore[arg-type]
        acknowledged=m.get("acknowledged", False),
        raised_at=_from_milli(m.get("raisedAtMilli")) or datetime.now(tz=timezone.utc),
        alarm_description=_empty_to_none(m.get("alarmDescription")),
        correlation_group=_empty_to_none(m.get("correlationGroup")),
        root_cause=_empty_to_none(m.get("rootCause")),
        acknowledged_by=_empty_to_none(m.get("acknowledgedBy")),
        cleared_at=_from_milli(m.get("clearedAtMilli")),
    )


# ── KPIDataPoint ──────────────────────────────────────────────────────────────

def kpi_to_proto_dict(k: KPIDataPoint) -> Dict[str, Any]:
    """Convert a KPIDataPoint to proto-json wire dict."""
    result: Dict[str, Any] = {
        "deviceId":      k.device_id,
        "kpiName":       k.kpi_name,
        "value":         k.value,
        "timestampMilli": _to_milli(k.timestamp) if k.timestamp else 0,
    }
    _set_if_not_none(result, "unit",        k.unit)
    _set_if_not_none(result, "granularity", k.granularity)
    return result


# ── Internal helpers ──────────────────────────────────────────────────────────

def _set_if_not_none(d: Dict[str, Any], key: str, value: Optional[Any]) -> None:
    """Only insert key when value is not None (keeps dict clean for proto absent fields)."""
    if value is not None:
        d[key] = value


def _to_milli(dt: datetime) -> int:
    """Convert datetime to epoch milliseconds."""
    return int(dt.timestamp() * 1000)


def _from_milli(milli: Optional[int]) -> Optional[datetime]:
    """Convert epoch milliseconds to UTC datetime.
    Returns None when milli is None or 0 (proto absent sentinel)."""
    if not milli:
        return None
    return datetime.fromtimestamp(milli / 1000.0, tz=timezone.utc)


def _empty_to_none(s: Optional[str]) -> Optional[str]:
    """Convert proto empty-string default back to Python None for optional fields."""
    if s is None or s == "":
        return None
    return s
