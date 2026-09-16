"""
Fixtures for the inventory performance test suite (WO-018).

Seeding strategy: use the device-simulator's large-1000 profile to populate
MongoDB with 1,000+ devices before the performance tests execute. The seed is
performed once per test session to avoid redundant I/O.
"""
from __future__ import annotations

import os
import subprocess
import time
import uuid

import httpx
import pytest

# ── Configuration ─────────────────────────────────────────────────────────────

INVENTORY_URL  = os.environ.get("INVENTORY_URL",  "http://localhost:8082")
SIMULATOR_DIR  = os.environ.get("SIMULATOR_DIR",
                                 os.path.join(os.path.dirname(__file__),
                                              "../../device-simulator"))
SEED_COUNT     = int(os.environ.get("PERF_SEED_COUNT", "1000"))
SEED_TIMEOUT_S = int(os.environ.get("PERF_SEED_TIMEOUT", "120"))


# ── HTTP client ───────────────────────────────────────────────────────────────

@pytest.fixture(scope="session")
def http():
    with httpx.Client(timeout=30) as client:
        yield client


# ── Database seeding ──────────────────────────────────────────────────────────

def _wait_for_inventory(base_url: str, timeout: int = 60) -> None:
    """Block until the inventory service is healthy or timeout expires."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            r = httpx.get(f"{base_url}/actuator/health", timeout=5)
            if r.status_code == 200:
                return
        except httpx.RequestError:
            pass
        time.sleep(2)
    raise TimeoutError(f"Inventory service at {base_url} not healthy after {timeout}s")


def _seed_devices_via_api(base_url: str, count: int) -> int:
    """
    Seed `count` generic devices directly via the inventory REST API.
    Returns the number of successfully created devices.
    """
    created = 0
    with httpx.Client(timeout=30) as client:
        for i in range(count):
            suffix = uuid.uuid4().hex[:8].upper()
            payload = {
                "serialNumber":    f"PERF-SN-{suffix}",
                "macAddress":      f"AA:BB:{i // 256:02X}:{i % 256:02X}:CC:DD",
                "ipAddress":       f"10.{(i // 256) % 256}.{i % 256}.{i % 100 + 1}",
                "deviceType":      "CPE" if i % 3 == 0 else "BTS",
                "status":          "online" if i % 5 != 0 else "offline",
                "model":           "ENH200EXT",
                "region":          f"REGION-{i % 10}",
                "latitude":        12.9716 + (i % 100) * 0.001,
                "longitude":       77.5946 + (i % 100) * 0.001,
                "schemaVersion":   "1.0",
                "discoveryParadigm": "GENERIC_SNMP",
            }
            r = client.post(f"{base_url}/api/v1/devices", json=payload)
            if r.status_code in (200, 201):
                created += 1
    return created


@pytest.fixture(scope="session", autouse=True)
def seed_inventory(http):
    """
    Session-scoped fixture that seeds 1,000+ devices into the inventory service
    before any performance tests run. Idempotent — re-running the suite is safe.
    """
    _wait_for_inventory(INVENTORY_URL, timeout=SEED_TIMEOUT_S)

    # Check current count to avoid re-seeding if already populated.
    try:
        r = http.get(f"{INVENTORY_URL}/api/v1/devices", params={"page": 0, "limit": 1})
        r.raise_for_status()
        total = r.json().get("totalElements", 0)
        if total >= SEED_COUNT:
            return  # Already seeded.
    except Exception:
        pass  # If check fails, proceed to seed anyway.

    created = _seed_devices_via_api(INVENTORY_URL, SEED_COUNT)
    assert created >= SEED_COUNT * 0.95, (
        f"Seeding failed: only {created}/{SEED_COUNT} devices were created."
    )
