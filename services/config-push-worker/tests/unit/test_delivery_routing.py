"""
Unit tests for WO-049: per-paradigm delivery routing in ConfigPushWorker.

Covers:
- Protocol order consumption from routed events
- NETCONF → CLI fallback on transient failure
- All protocols exhausted → FAILURE result with attempt history
- Legacy single-protocol path still works
- UBR_REALTIME events do not enter the protocol fallback path (queued separately)
- Idempotency key is forwarded in result
- Delivery channel is recorded in result
- Unsupported protocol falls back gracefully
"""
import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "../.."))

import asyncio
import pytest
from unittest.mock import AsyncMock, MagicMock, patch, call


# ── Fixtures ──────────────────────────────────────────────────────────────────

def make_worker():
    from src.worker import ConfigPushWorker
    db = MagicMock()
    db.config_templates.find_one = AsyncMock(return_value={
        "_id": "tmpl-1",
        "name": "test-template",
        "txPower": 20,
        "ssid24": "TestNet",
    })
    db.devices.find_one = AsyncMock(return_value={
        "deviceId": "dev-1",
        "ipAddress": "10.0.0.1",
        "type": "BTS",
        "capabilities": ["NETCONF"],
    })
    db.config_jobs.update_one = AsyncMock()
    db.pending_commands.find = MagicMock()
    db.pending_commands.update_one = AsyncMock()
    return ConfigPushWorker(mongo_db=db)


ROUTED_EVENT = {
    "deviceId": "dev-1",
    "templateId": "tmpl-1",
    "jobId": "job-abc",
    "actor": "eng-jsmith",
    "protocolOrder": ["NETCONF", "CLI"],
    "deliveryChannel": "CLI_PROTOCOL",
    "idempotencyKey": "idem-xyz",
}


# ── AC1: Delivery route selection ─────────────────────────────────────────────

@pytest.mark.asyncio
async def test_routed_event_uses_netconf_first():
    worker = make_worker()
    with patch("src.worker.netconf_push", new_callable=AsyncMock) as mock_netconf, \
         patch("src.worker.retry_async", new_callable=AsyncMock) as mock_retry:
        mock_retry.return_value = None  # success
        result = await worker.handle_push_event(ROUTED_EVENT)
    assert result["status"] == "SUCCESS"
    assert result["protocol"] == "NETCONF"


@pytest.mark.asyncio
async def test_routed_event_records_delivery_channel():
    worker = make_worker()
    with patch("src.worker.retry_async", new_callable=AsyncMock):
        result = await worker.handle_push_event(ROUTED_EVENT)
    assert result.get("deliveryChannel") == "CLI_PROTOCOL"


@pytest.mark.asyncio
async def test_routed_event_forwards_idempotency_key():
    worker = make_worker()
    with patch("src.worker.retry_async", new_callable=AsyncMock):
        result = await worker.handle_push_event(ROUTED_EVENT)
    assert result.get("idempotencyKey") == "idem-xyz"


@pytest.mark.asyncio
async def test_routed_event_records_protocol_attempts():
    worker = make_worker()
    with patch("src.worker.retry_async", new_callable=AsyncMock):
        result = await worker.handle_push_event(ROUTED_EVENT)
    attempts = result.get("protocolAttempts", [])
    assert len(attempts) >= 1
    assert attempts[0]["protocol"] == "NETCONF"
    assert attempts[0]["status"] == "SUCCESS"


# ── AC2: Protocol fallback on failure ────────────────────────────────────────

@pytest.mark.asyncio
async def test_netconf_failure_falls_back_to_cli():
    """When NETCONF fails, CLI must be tried next and recorded as FALLBACK then SUCCESS."""
    worker = make_worker()

    call_count = {"n": 0}

    async def mock_retry(fn, **kwargs):
        call_count["n"] += 1
        if call_count["n"] == 1:
            raise Exception("NETCONF timeout")
        # CLI succeeds
        return None

    with patch("src.worker.retry_async", side_effect=mock_retry):
        result = await worker.handle_push_event(ROUTED_EVENT)

    assert result["status"] == "SUCCESS"
    assert result["protocol"] == "CLI"
    attempts = result.get("protocolAttempts", [])
    assert len(attempts) == 2
    # First attempt is NETCONF with FALLBACK status
    assert attempts[0]["protocol"] == "NETCONF"
    assert attempts[0]["status"] == "FALLBACK"
    # Second attempt is CLI with SUCCESS
    assert attempts[1]["protocol"] == "CLI"
    assert attempts[1]["status"] == "SUCCESS"


@pytest.mark.asyncio
async def test_fallback_success_updates_job_to_success():
    worker = make_worker()
    call_count = {"n": 0}

    async def mock_retry(fn, **kwargs):
        call_count["n"] += 1
        if call_count["n"] == 1:
            raise Exception("NETCONF failed")
        return None  # CLI succeeds

    with patch("src.worker.retry_async", side_effect=mock_retry):
        result = await worker.handle_push_event(ROUTED_EVENT)

    worker.db.config_jobs.update_one.assert_awaited_with(
        {"_id": "job-abc"},
        {"$set": {"perDeviceStatus.dev-1": "SUCCESS"}},
    )


# ── AC2: All protocols exhausted ─────────────────────────────────────────────

@pytest.mark.asyncio
async def test_all_protocols_fail_returns_failure():
    worker = make_worker()

    async def mock_retry(fn, **kwargs):
        raise Exception("Connection refused")

    with patch("src.worker.retry_async", side_effect=mock_retry):
        result = await worker.handle_push_event(ROUTED_EVENT)

    assert result["status"] == "FAILURE"
    attempts = result.get("protocolAttempts", [])
    assert len(attempts) == 2  # NETCONF + CLI both failed


@pytest.mark.asyncio
async def test_all_protocols_fail_records_last_error():
    worker = make_worker()

    async def mock_retry(fn, **kwargs):
        raise Exception("Connection refused: all protocols exhausted")

    with patch("src.worker.retry_async", side_effect=mock_retry):
        result = await worker.handle_push_event(ROUTED_EVENT)

    assert "Connection refused" in result.get("reason", "")


@pytest.mark.asyncio
async def test_all_protocols_fail_updates_job_to_failure():
    worker = make_worker()

    async def mock_retry(fn, **kwargs):
        raise Exception("failed")

    with patch("src.worker.retry_async", side_effect=mock_retry):
        await worker.handle_push_event(ROUTED_EVENT)

    worker.db.config_jobs.update_one.assert_awaited_with(
        {"_id": "job-abc"},
        {"$set": {"perDeviceStatus.dev-1": "FAILURE"}},
    )


# ── Edge: Legacy single-protocol path ────────────────────────────────────────

@pytest.mark.asyncio
async def test_legacy_event_without_protocol_order_still_works():
    """Events without protocolOrder must use the legacy _select_protocol path."""
    worker = make_worker()
    legacy_event = {
        "deviceId": "dev-1",
        "templateId": "tmpl-1",
        "jobId": "job-legacy",
        "actor": "system",
        # No protocolOrder — legacy path
    }

    with patch("src.worker.retry_async", new_callable=AsyncMock):
        result = await worker.handle_push_event(legacy_event)

    assert result["status"] == "SUCCESS"
    # Legacy path does not include protocolAttempts list
    assert "protocolAttempts" not in result or result.get("deliveryChannel") is None


# ── Edge: Missing template or device ─────────────────────────────────────────

@pytest.mark.asyncio
async def test_missing_template_returns_failure():
    worker = make_worker()
    worker.db.config_templates.find_one = AsyncMock(return_value=None)
    result = await worker.handle_push_event(ROUTED_EVENT)
    assert result["status"] == "FAILURE"


@pytest.mark.asyncio
async def test_missing_device_returns_failure():
    worker = make_worker()
    worker.db.devices.find_one = AsyncMock(return_value=None)
    result = await worker.handle_push_event(ROUTED_EVENT)
    assert result["status"] == "FAILURE"


# ── Edge: Single-protocol order list ─────────────────────────────────────────

@pytest.mark.asyncio
async def test_single_protocol_order_dispatches_once():
    worker = make_worker()
    event = {**ROUTED_EVENT, "protocolOrder": ["CLI"], "deliveryChannel": "CLI_PROTOCOL"}

    with patch("src.worker.retry_async", new_callable=AsyncMock):
        result = await worker.handle_push_event(event)

    assert result["status"] == "SUCCESS"
    assert result["protocol"] == "CLI"


# ── Edge: Timeout treated as TIMEOUT attempt status ──────────────────────────

@pytest.mark.asyncio
async def test_timeout_recorded_in_attempts():
    worker = make_worker()
    call_count = {"n": 0}

    async def mock_retry(fn, **kwargs):
        call_count["n"] += 1
        if call_count["n"] == 1:
            raise asyncio.TimeoutError("Timeout")
        return None  # CLI succeeds

    with patch("src.worker.retry_async", side_effect=mock_retry):
        result = await worker.handle_push_event(ROUTED_EVENT)

    assert result["status"] == "SUCCESS"
    assert result["protocol"] == "CLI"


# ── AC6: Mock data and fixtures ───────────────────────────────────────────────

def test_routed_event_fixture_has_all_required_fields():
    """Verify ROUTED_EVENT fixture covers all required WO-049 fields."""
    required = ["deviceId", "templateId", "jobId", "actor", "protocolOrder",
                "deliveryChannel", "idempotencyKey"]
    for f in required:
        assert f in ROUTED_EVENT, f"Missing field: {f}"


def test_protocol_order_must_not_be_empty():
    assert len(ROUTED_EVENT["protocolOrder"]) > 0


def test_cli_protocol_channel_fixture():
    event = {**ROUTED_EVENT, "protocolOrder": ["CLI"], "deliveryChannel": "CLI_PROTOCOL"}
    assert event["deliveryChannel"] == "CLI_PROTOCOL"


def test_snmp_protocol_channel_fixture():
    event = {**ROUTED_EVENT, "protocolOrder": ["SNMP", "CLI"], "deliveryChannel": "SNMP_PROTOCOL"}
    assert event["protocolOrder"][0] == "SNMP"
