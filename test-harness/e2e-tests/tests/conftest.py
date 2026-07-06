"""
Shared fixtures and helpers for UBR NMS end-to-end integration tests.
"""
import asyncio
import json
import os
import time
import pytest
import httpx


# ── Environment ───────────────────────────────────────────────────────────────

def _url(env_key: str, default: str) -> str:
    return os.environ.get(env_key, default)


URLS = {
    "auth":          _url("AUTH_URL",          "http://localhost:3000"),
    "alarm":         _url("ALARM_URL",         "http://localhost:8081"),
    "inventory":     _url("INVENTORY_URL",     "http://localhost:8082"),
    "kpi_query":     _url("KPI_QUERY_URL",     "http://localhost:8089"),
    "config":        _url("CONFIG_URL",        "http://localhost:8083"),
    "discovery":     _url("DISCOVERY_URL",     "http://localhost:8084"),
    "event_collector": _url("EVENT_COLLECTOR_URL", "http://localhost:8085"),
    "stubs":         _url("STUBS_URL",         "http://localhost:8080"),
    "notification":  _url("NOTIFICATION_URL",  "http://localhost:3030"),
}

ADMIN_USER = os.environ.get("TEST_ADMIN_USER", "admin")
ADMIN_PASS = os.environ.get("TEST_ADMIN_PASS", "admin123")


# ── HTTP client ───────────────────────────────────────────────────────────────

@pytest.fixture(scope="session")
def http():
    """Synchronous HTTPX client for the test session."""
    with httpx.Client(timeout=30) as client:
        yield client


@pytest.fixture(scope="session")
async def async_http():
    async with httpx.AsyncClient(timeout=30) as client:
        yield client


# ── Authentication ────────────────────────────────────────────────────────────

@pytest.fixture(scope="session")
def auth_tokens(http):
    """Login as admin and return access + refresh tokens."""
    resp = http.post(f"{URLS['auth']}/api/v1/auth/login",
                     json={"username": ADMIN_USER, "password": ADMIN_PASS})
    assert resp.status_code == 200, f"Login failed: {resp.text}"
    data = resp.json()
    return {"access": data["accessToken"], "refresh": data.get("refreshToken", "")}


@pytest.fixture
def auth_headers(auth_tokens):
    return {"Authorization": f"Bearer {auth_tokens['access']}"}


# ── Stub helpers ──────────────────────────────────────────────────────────────

def stub_reset(http, stub_name: str):
    http.delete(f"{URLS['stubs']}/api/v1/stub/{stub_name}/messages")


def stub_messages(http, stub_name: str) -> list:
    resp = http.get(f"{URLS['stubs']}/api/v1/stub/{stub_name}/messages")
    return resp.json().get("messages", [])


def wait_for_stub(http, stub_name: str, min_count: int = 1,
                  timeout: float = 15.0, interval: float = 0.5) -> list:
    """Poll stub until at least min_count messages arrive or timeout."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        msgs = stub_messages(http, stub_name)
        if len(msgs) >= min_count:
            return msgs
        time.sleep(interval)
    msgs = stub_messages(http, stub_name)
    assert len(msgs) >= min_count, (
        f"Stub '{stub_name}' expected {min_count}+ messages, got {len(msgs)} "
        f"after {timeout}s"
    )
    return msgs


def wait_for_api(http, url: str, headers: dict = None, timeout: float = 30.0,
                 interval: float = 1.0, expected_status: int = 200) -> httpx.Response:
    """Poll API URL until expected_status is returned or timeout."""
    deadline = time.time() + timeout
    last_resp = None
    while time.time() < deadline:
        try:
            resp = http.get(url, headers=headers or {})
            last_resp = resp
            if resp.status_code == expected_status:
                return resp
        except Exception:
            pass
        time.sleep(interval)
    assert last_resp is not None, f"No response from {url} within {timeout}s"
    assert last_resp.status_code == expected_status, (
        f"Expected {expected_status} from {url}, got {last_resp.status_code}: {last_resp.text[:200]}"
    )
    return last_resp
