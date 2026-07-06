"""
OSS/BSS Stub Message Store and Validators.

Each stub (Netcool, Mycom, Mobinet, Syslog) captures received messages in an
in-memory deque and exposes them via a shared assertion API.
"""
from __future__ import annotations

import json
import re
from collections import deque
from typing import Any, Dict, List, Optional


class StubStore:
    """Thread-safe in-memory message store for one stub endpoint."""

    def __init__(self, name: str, max_messages: int = 10_000):
        self.name = name
        self._messages: deque = deque(maxlen=max_messages)

    def add(self, message: dict):
        self._messages.append(message)

    def all(self) -> List[dict]:
        return list(self._messages)

    def count(self) -> int:
        return len(self._messages)

    def reset(self):
        self._messages.clear()


# ── Netcool schema validation ─────────────────────────────────────────────────

NETCOOL_REQUIRED_KEYS = {"alarmId", "alarmName", "severity", "alarmDescription", "state", "Time", "data"}
NETCOOL_DATA_KEYS = {"deviceType", "deviceId"}


def validate_netcool(msg: dict) -> List[str]:
    """Returns a list of validation errors (empty = valid)."""
    errors = []
    for key in NETCOOL_REQUIRED_KEYS:
        if key not in msg:
            errors.append(f"missing field: {key}")
    data = msg.get("data", {})
    if isinstance(data, dict):
        for key in NETCOOL_DATA_KEYS:
            if key not in data:
                errors.append(f"missing data.{key}")
    else:
        errors.append("data must be an object")
    # Time must be ISO 8601
    ts = msg.get("Time", "")
    if ts and not re.match(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}", ts):
        errors.append(f"invalid Time format: {ts}")
    return errors


# ── Mycom schema validation ───────────────────────────────────────────────────

MYCOM_REQUIRED_KEYS = {"serialNumber", "deviceType", "modelNo", "timestamp", "granularity", "metrics"}


def validate_mycom(msg: dict) -> List[str]:
    errors = []
    for key in MYCOM_REQUIRED_KEYS:
        if key not in msg:
            errors.append(f"missing field: {key}")
    if "metrics" in msg and not isinstance(msg["metrics"], dict):
        errors.append("metrics must be an object")
    # latitude/longitude must be numbers if present
    for coord in ("latitude", "longitude"):
        if coord in msg and not isinstance(msg[coord], (int, float)):
            errors.append(f"{coord} must be a number (float)")
    return errors


# ── Mobinet schema validation ─────────────────────────────────────────────────

MOBINET_REQUIRED_KEYS = {
    "systemName", "ipAddress", "macAddress", "serialNumber",
    "model", "firmware", "deviceStatus", "linkType", "radioMode",
    "ssid", "bandwidth", "channel", "frequencyMHz", "latitude", "longitude",
}


def validate_mobinet(msg: dict) -> List[str]:
    errors = []
    for key in MOBINET_REQUIRED_KEYS:
        if key not in msg:
            errors.append(f"missing field: {key}")
    # Latitude and longitude must be floats
    for coord in ("latitude", "longitude"):
        if coord in msg and not isinstance(msg[coord], (int, float)):
            errors.append(f"{coord} must be a float")
    return errors


# ── Syslog RFC 5424 validation ────────────────────────────────────────────────

RFC5424_PATTERN = re.compile(
    r"^<(?P<pri>\d{1,3})>1 "          # PRI + version
    r"(?P<ts>\d{4}-\d{2}-\d{2}T[\d:Z.+-]+|-) "  # TIMESTAMP
    r"(?P<host>\S+) "                  # HOSTNAME
    r"(?P<app>\S+) "                   # APP-NAME
    r"(?P<pid>\S+) "                   # PROCID
    r"(?P<msgid>\S+) "                 # MSGID
    r"(?P<sd>\S+) "                    # STRUCTURED-DATA
    r"(?P<msg>.*)$"                    # MSG
)


def validate_syslog_rfc5424(line: str) -> List[str]:
    """Validate a syslog line against RFC 5424 format."""
    errors = []
    m = RFC5424_PATTERN.match(line)
    if not m:
        errors.append("does not match RFC 5424 format")
        return errors
    pri = int(m.group("pri"))
    facility = pri >> 3
    severity = pri & 0x7
    if not (0 <= facility <= 23):
        errors.append(f"invalid facility: {facility}")
    if not (0 <= severity <= 7):
        errors.append(f"invalid severity: {severity}")
    return errors


# ── GIS stub response builder ─────────────────────────────────────────────────

def build_gis_tile_response(z: int, x: int, y: int) -> bytes:
    """Returns a minimal valid 1x1 PNG tile for offline GIS testing."""
    # 1x1 transparent PNG (standard 68-byte minimal PNG)
    return (
        b"\x89PNG\r\n\x1a\n"
        b"\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15\xc4\x89"
        b"\x00\x00\x00\nIDATx\x9cc\x00\x01\x00\x00\x05\x00\x01\r\n-\xb4"
        b"\x00\x00\x00\x00IEND\xaeB`\x82"
    )
