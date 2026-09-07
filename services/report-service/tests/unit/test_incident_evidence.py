"""Unit tests for WO-068: CTSO/TSOC Incident Evidence Export"""
import pytest
from datetime import datetime, timezone, timedelta
from unittest.mock import AsyncMock, MagicMock
import json

# Mock motor client before importing report_service
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent.parent / "src"))

from report_service import ReportService


@pytest.fixture
def mock_client():
    """Mock MongoDB client with collections."""
    client = MagicMock()

    # Mock collections
    reports_col = AsyncMock()
    alarms_col = AsyncMock()
    audit_col = AsyncMock()
    inv_col = AsyncMock()
    events_col = AsyncMock()

    # Configure client to return mocked collections
    client.__getitem__ = lambda self, db: {
        "reports": reports_col,
        "alarms": alarms_col,
        "audit": audit_col,
        "inventory": inv_col,
        "events": events_col,
    }[db]

    return client, reports_col, alarms_col, audit_col, inv_col, events_col


@pytest.fixture
def service(mock_client):
    """Create ReportService with mocked client."""
    client, reports_col, alarms_col, audit_col, inv_col, events_col = mock_client
    svc = ReportService(client=client)
    svc._reports_col = reports_col
    svc._alarms_col = alarms_col
    svc._audit_col = audit_col
    svc._inv_col = inv_col
    svc._events_col = events_col
    return svc, reports_col, alarms_col, audit_col, inv_col, events_col


@pytest.mark.asyncio
async def test_collect_alarm_timeline_with_lifecycle(service):
    """Collects alarm timeline with complete lifecycle events."""
    svc, _, alarms_col, _, _, _ = service

    now = datetime.now(timezone.utc)
    mock_alarm = {
        "_id": "alarm-001",
        "alarmId": "ALM-001",
        "deviceId": "DEV-001",
        "alarmType": "DEVICE_DOWN",
        "severity": "CRITICAL",
        "correlationId": "corr-001",
        "raisedAt": now - timedelta(hours=2),
        "acknowledgedAt": now - timedelta(hours=1, minutes=30),
        "acknowledgedBy": "admin@example.com",
        "clearedAt": now - timedelta(minutes=30),
    }

    alarms_col.find.return_value.sort.return_value.to_list = AsyncMock(return_value=[mock_alarm])

    timeline = await svc._collect_alarm_timeline(
        alarm_id="ALM-001",
        correlation_id=None,
        device_id=None,
        from_dt=now - timedelta(days=1),
        to_dt=now
    )

    assert len(timeline) == 1
    assert timeline[0]["alarmId"] == "ALM-001"
    assert timeline[0]["deviceId"] == "DEV-001"
    assert timeline[0]["severity"] == "CRITICAL"
    assert len(timeline[0]["lifecycleEvents"]) == 3  # RAISED, ACKNOWLEDGED, CLEARED
    assert timeline[0]["lifecycleEvents"][0]["state"] == "RAISED"
    assert timeline[0]["lifecycleEvents"][1]["state"] == "ACKNOWLEDGED"
    assert timeline[0]["lifecycleEvents"][2]["state"] == "CLEARED"


@pytest.mark.asyncio
async def test_collect_alarm_timeline_no_alarms_found(service):
    """Returns unavailable status when no alarms match criteria."""
    svc, _, alarms_col, _, _, _ = service

    alarms_col.find.return_value.sort.return_value.to_list = AsyncMock(return_value=[])

    timeline = await svc._collect_alarm_timeline(
        alarm_id="NONEXISTENT",
        correlation_id=None,
        device_id=None,
        from_dt=datetime.now(timezone.utc) - timedelta(days=1),
        to_dt=datetime.now(timezone.utc)
    )

    assert len(timeline) == 1
    assert timeline[0]["status"] == "unavailable"
    assert "No alarms found" in timeline[0]["reason"]


@pytest.mark.asyncio
async def test_collect_audit_events(service):
    """Collects audit events for incident."""
    svc, _, _, audit_col, _, _ = service

    now = datetime.now(timezone.utc)
    mock_events = [
        {
            "_id": "evt-001",
            "timestamp": now - timedelta(hours=1),
            "actor": "admin@example.com",
            "action": "alarm.acknowledge",
            "resource": "ALM-001",
            "outcome": "success",
            "correlationId": "corr-001",
            "metadata": {"resourceType": "alarm"},
        },
        {
            "_id": "evt-002",
            "timestamp": now - timedelta(minutes=30),
            "actor": "system",
            "action": "alarm.clear",
            "resource": "ALM-001",
            "outcome": "success",
            "correlationId": "corr-001",
            "metadata": {"resourceType": "alarm"},
        },
    ]

    audit_col.find.return_value.sort.return_value.to_list = AsyncMock(return_value=mock_events)

    events = await svc._collect_audit_events(
        alarm_id="ALM-001",
        correlation_id=None,
        device_id=None,
        from_dt=now - timedelta(days=1),
        to_dt=now
    )

    assert len(events) == 2
    assert events[0]["actor"] == "admin@example.com"
    assert events[0]["action"] == "alarm.acknowledge"
    assert events[0]["outcome"] == "success"
    assert events[1]["action"] == "alarm.clear"


@pytest.mark.asyncio
async def test_collect_audit_events_no_events(service):
    """Returns unavailable status when no audit events found."""
    svc, _, _, audit_col, _, _ = service

    audit_col.find.return_value.sort.return_value.to_list = AsyncMock(return_value=[])

    events = await svc._collect_audit_events(
        alarm_id="NONEXISTENT",
        correlation_id=None,
        device_id=None,
        from_dt=datetime.now(timezone.utc) - timedelta(days=1),
        to_dt=datetime.now(timezone.utc)
    )

    assert len(events) == 1
    assert events[0]["status"] == "unavailable"


@pytest.mark.asyncio
async def test_collect_affected_inventory(service):
    """Collects inventory for affected devices."""
    svc, _, _, _, inv_col, _ = service

    alarm_timeline = [
        {"alarmId": "ALM-001", "deviceId": "DEV-001"},
        {"alarmId": "ALM-002", "deviceId": "DEV-002"},
    ]

    mock_devices = [
        {
            "deviceId": "DEV-001",
            "deviceType": "BTS",
            "model": "BTS-5000",
            "networkId": "NET-001",
            "status": "OFFLINE",
        },
        {
            "deviceId": "DEV-002",
            "deviceType": "CPE",
            "model": "CPE-200",
            "networkId": "NET-001",
            "status": "ONLINE",
        },
    ]

    inv_col.find.return_value.to_list = AsyncMock(return_value=mock_devices)

    inventory = await svc._collect_affected_inventory(alarm_timeline, device_id=None)

    assert len(inventory) == 2
    assert inventory[0]["deviceId"] == "DEV-001"
    assert inventory[0]["deviceType"] == "BTS"
    assert inventory[1]["deviceId"] == "DEV-002"


@pytest.mark.asyncio
async def test_collect_affected_inventory_devices_not_found(service):
    """Returns unavailable when devices not in inventory."""
    svc, _, _, _, inv_col, _ = service

    alarm_timeline = [{"alarmId": "ALM-001", "deviceId": "DEV-999"}]
    inv_col.find.return_value.to_list = AsyncMock(return_value=[])

    inventory = await svc._collect_affected_inventory(alarm_timeline, device_id=None)

    assert len(inventory) == 1
    assert inventory[0]["status"] == "unavailable"


@pytest.mark.asyncio
async def test_collect_integration_metadata(service):
    """Collects northbound integration metadata when available."""
    svc, _, _, _, _, events_col = service

    now = datetime.now(timezone.utc)
    mock_events = [
        {
            "_id": "int-001",
            "deliveryStatus": "SUCCESS",
            "destination": "netcool",
            "timestamp": now - timedelta(hours=1),
            "correlationId": "corr-001",
        },
    ]

    events_col.find.return_value.to_list = AsyncMock(return_value=mock_events)

    metadata = await svc._collect_integration_metadata(
        alarm_id=None,
        correlation_id="corr-001",
        from_dt=now - timedelta(days=1),
        to_dt=now
    )

    assert len(metadata) == 1
    assert metadata[0]["deliveryStatus"] == "SUCCESS"
    assert metadata[0]["destination"] == "netcool"


@pytest.mark.asyncio
async def test_collect_integration_metadata_unavailable(service):
    """Returns unavailable status when integration metadata not available."""
    svc, _, _, _, _, events_col = service

    events_col.find.return_value.to_list = AsyncMock(side_effect=Exception("Collection failed"))

    metadata = await svc._collect_integration_metadata(
        alarm_id="ALM-001",
        correlation_id=None,
        from_dt=datetime.now(timezone.utc) - timedelta(days=1),
        to_dt=datetime.now(timezone.utc)
    )

    assert len(metadata) == 1
    assert metadata[0]["status"] == "unavailable"
    assert "Collection error" in metadata[0]["reason"]


def test_assess_completeness_complete():
    """Assesses completeness when all sections have data."""
    svc = ReportService.__new__(ReportService)

    alarm_timeline = [{"alarmId": "ALM-001"}]
    audit_events = [{"eventId": "evt-001"}]
    affected_devices = [{"deviceId": "DEV-001"}]

    completeness = svc._assess_completeness(alarm_timeline, audit_events, affected_devices)

    assert completeness["alarmData"] == "complete"
    assert completeness["auditData"] == "complete"
    assert completeness["inventoryData"] == "complete"


def test_assess_completeness_partial():
    """Assesses completeness when some sections are unavailable."""
    svc = ReportService.__new__(ReportService)

    alarm_timeline = [{"status": "unavailable", "reason": "No alarms"}]
    audit_events = [{"eventId": "evt-001"}]
    affected_devices = [{"deviceId": "DEV-001"}]

    completeness = svc._assess_completeness(alarm_timeline, audit_events, affected_devices)

    assert completeness["alarmData"] == "unavailable"
    assert completeness["auditData"] == "complete"
    assert completeness["inventoryData"] == "complete"


def test_mask_sensitive_fields():
    """Masks sensitive fields in evidence package."""
    svc = ReportService.__new__(ReportService)

    evidence = {
        "alarmTimeline": [
            {
                "alarmId": "ALM-001",
                "metadata": {
                    "api_key": "sk-secret123",
                    "device_name": "BTS-001",
                    "auth_token": "Bearer abc123",
                }
            }
        ],
        "auditEvents": [
            {
                "actor": "admin@example.com",
                "password": "cleartext-password",
                "action": "login",
            }
        ],
    }

    masked = svc._mask_sensitive_fields(evidence)

    assert masked["alarmTimeline"][0]["metadata"]["api_key"] == "[REDACTED]"
    assert masked["alarmTimeline"][0]["metadata"]["device_name"] == "BTS-001"  # Not sensitive
    assert masked["alarmTimeline"][0]["metadata"]["auth_token"] == "[REDACTED]"
    assert masked["auditEvents"][0]["password"] == "[REDACTED]"
    assert masked["auditEvents"][0]["actor"] == "admin@example.com"  # Not sensitive
    assert masked["auditEvents"][0]["action"] == "login"  # Not sensitive


def test_mask_sensitive_fields_nested():
    """Masks sensitive fields in deeply nested structures."""
    svc = ReportService.__new__(ReportService)

    evidence = {
        "config": {
            "database": {
                "host": "localhost",
                "connection_string": "mongodb://user:pass@host/db",
            },
            "jwt_secret": "supersecret",
        }
    }

    masked = svc._mask_sensitive_fields(evidence)

    assert masked["config"]["database"]["host"] == "localhost"
    assert masked["config"]["database"]["connection_string"] == "[REDACTED]"
    assert masked["config"]["jwt_secret"] == "[REDACTED]"


@pytest.mark.asyncio
async def test_collect_incident_evidence_missing_criteria(service):
    """Raises ValueError when no lookup criteria provided."""
    svc, _, _, _, _, _ = service

    with pytest.raises(ValueError, match="requires at least one of"):
        await svc._collect_incident_evidence(
            scope={},
            from_dt=datetime.now(timezone.utc) - timedelta(days=1),
            to_dt=datetime.now(timezone.utc)
        )


@pytest.mark.asyncio
async def test_collect_incident_evidence_complete_package(service):
    """Generates complete incident evidence package with all sections."""
    svc, _, alarms_col, audit_col, inv_col, events_col = service

    now = datetime.now(timezone.utc)

    # Mock alarm data
    alarms_col.find.return_value.sort.return_value.to_list = AsyncMock(return_value=[
        {
            "_id": "alarm-001",
            "alarmId": "ALM-001",
            "deviceId": "DEV-001",
            "alarmType": "DEVICE_DOWN",
            "severity": "CRITICAL",
            "raisedAt": now - timedelta(hours=1),
            "clearedAt": now - timedelta(minutes=30),
        }
    ])

    # Mock audit data
    audit_col.find.return_value.sort.return_value.to_list = AsyncMock(return_value=[
        {
            "_id": "evt-001",
            "timestamp": now - timedelta(hours=1),
            "actor": "admin",
            "action": "alarm.acknowledge",
            "resource": "ALM-001",
            "outcome": "success",
        }
    ])

    # Mock inventory data
    inv_col.find.return_value.to_list = AsyncMock(return_value=[
        {
            "deviceId": "DEV-001",
            "deviceType": "BTS",
            "model": "BTS-5000",
        }
    ])

    # Mock integration data
    events_col.find.return_value.to_list = AsyncMock(return_value=[])

    evidence = await svc._collect_incident_evidence(
        scope={"alarmId": "ALM-001"},
        from_dt=now - timedelta(days=1),
        to_dt=now
    )

    assert evidence["reportType"] == "CTSO_TSOC_INCIDENT_EVIDENCE"
    assert "generatedAt" in evidence
    assert "checksum" in evidence
    assert len(evidence["alarmTimeline"]) == 1
    assert len(evidence["auditEvents"]) == 1
    assert len(evidence["affectedDevices"]) == 1
    assert evidence["evidenceCompleteness"]["alarmData"] == "complete"
    assert evidence["privacyPolicyVersion"] == "1.0"
