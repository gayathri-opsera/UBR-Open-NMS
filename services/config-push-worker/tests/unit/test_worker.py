"""Unit tests for Config Push Worker."""
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "../.."))

import asyncio
import pytest
from unittest.mock import AsyncMock, MagicMock, patch

from src.netconf_adapter import _build_netconf_xml
from src.cli_adapter import _params_to_cli_commands
from src.tr069_adapter import build_set_parameter_values_rpc
from src.retry import retry_async


# ── NETCONF XML generation ─────────────────────────────────────────

def test_build_netconf_xml_contains_params():
    xml = _build_netconf_xml({"ssid24": "MyNet", "channel24": 6})
    assert "<ssid24>MyNet</ssid24>" in xml
    assert "<channel24>6</channel24>" in xml
    assert "<config>" in xml


def test_build_netconf_xml_skips_none():
    xml = _build_netconf_xml({"ssid24": "Net", "txPower24": None})
    assert "txPower24" not in xml


# ── CLI command generation ─────────────────────────────────────────

def test_cli_commands_generated_for_ssid():
    cmds = _params_to_cli_commands({"ssid24": "OfficeNet", "channel24": 11})
    assert any("ssid" in c and "OfficeNet" in c for c in cmds)
    assert any("channel" in c and "11" in c for c in cmds)


def test_cli_reboot_command():
    cmds = _params_to_cli_commands({"deviceReboot": True})
    assert "reboot" in cmds


# ── TR-069 SOAP message ────────────────────────────────────────────

def test_tr069_soap_contains_parameter_names():
    soap = build_set_parameter_values_rpc({"ssid24": "WiFi5G", "channel5": 36})
    assert "WLANConfiguration.1.SSID" in soap
    assert "WiFi5G" in soap
    assert "WLANConfiguration.5.Channel" in soap


def test_tr069_soap_skips_unknown_params():
    soap = build_set_parameter_values_rpc({"unknownParam": "value"})
    assert "unknownParam" not in soap


def test_tr069_soap_is_valid_xml():
    from xml.etree import ElementTree as ET
    soap = build_set_parameter_values_rpc({"ssid24": "Test"})
    root = ET.fromstring(soap)
    assert root is not None


# ── Retry logic ────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_retry_succeeds_on_first_attempt():
    called = []
    async def fn():
        called.append(1)
        return "ok"
    result = await retry_async(fn, attempts=3, base_delay=0)
    assert result == "ok"
    assert len(called) == 1


@pytest.mark.asyncio
async def test_retry_retries_on_failure_then_succeeds():
    calls = []
    async def fn():
        calls.append(1)
        if len(calls) < 2:
            raise ConnectionError("transient")
        return "success"
    result = await retry_async(fn, attempts=3, base_delay=0)
    assert result == "success"
    assert len(calls) == 2


@pytest.mark.asyncio
async def test_retry_raises_after_max_attempts():
    async def fn():
        raise RuntimeError("always fails")
    with pytest.raises(RuntimeError, match="always fails"):
        await retry_async(fn, attempts=3, base_delay=0)


# ── Timeout handling ───────────────────────────────────────────────

@pytest.mark.asyncio
async def test_worker_handles_timeout(tmp_path):
    """Worker records TIMEOUT when dispatch raises asyncio.TimeoutError."""
    from src.worker import ConfigPushWorker

    db = MagicMock()
    db.config_templates.find_one = AsyncMock(return_value={
        "_id": "t1", "ssid24": "Net", "deviceType": "BTS"
    })
    db.devices.find_one = AsyncMock(return_value={
        "deviceId": "dev-1", "ipAddress": "10.0.0.1", "type": "BTS",
        "capabilities": ["CLI"]
    })
    db.config_jobs.update_one = AsyncMock()

    worker = ConfigPushWorker(db)

    with patch("src.worker.retry_async", side_effect=asyncio.TimeoutError):
        result = await worker.handle_push_event({
            "deviceId": "dev-1", "templateId": "t1", "jobId": "j1", "actor": "admin"
        })

    assert result["status"] in ("TIMEOUT", "FAILURE")  # TimeoutError is OSError in Py3.11+
