"""Contract tests for Product Definition lifecycle event schemas (WO-018).

Verifies that:
- Every lifecycle event type can be constructed and serialised as a dict.
- All required schema fields are present in every event type.
- Event-type-specific metadata fields are included where documented.
- Consumer contract: events with unknown metadata fields must not raise errors.
- No credential material leaks through event payloads.
"""
from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone
from typing import Any, Dict
from uuid import uuid4

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from models.kafka_messages import (
    ProductDefinitionActor,
    ProductDefinitionEventType,
    ProductDefinitionLifecycleEvent,
    ProductDefinitionLifecycleState,
)


# ─── Helpers ──────────────────────────────────────────────────────────────────

def _actor(actor_type: str = "USER") -> ProductDefinitionActor:
    return ProductDefinitionActor(actor_id="user-001", actor_type=actor_type, actor_email="admin@ubrnms.internal")


def _base_event(
    event_type: ProductDefinitionEventType,
    lifecycle_state: ProductDefinitionLifecycleState,
    previous_state: ProductDefinitionLifecycleState | None = None,
    metadata: Dict[str, Any] | None = None,
) -> ProductDefinitionLifecycleEvent:
    return ProductDefinitionLifecycleEvent(
        event_id=str(uuid4()),
        event_type=event_type,
        aggregate_id=str(uuid4()),
        version_id=str(uuid4()),
        version=1,
        lifecycle_state=lifecycle_state,
        previous_lifecycle_state=previous_state,
        actor=_actor(),
        timestamp=datetime(2026, 9, 16, 12, 0, 0, tzinfo=timezone.utc),
        correlation_id=str(uuid4()),
        causation_id=None,
        tenant_id="tenant-001",
        metadata=metadata or {},
    )


def _to_dict(event: ProductDefinitionLifecycleEvent) -> Dict[str, Any]:
    """Simulate serialising the event to a Kafka message payload."""
    return {
        "eventId": event.event_id,
        "eventType": event.event_type.value,
        "aggregateId": event.aggregate_id,
        "versionId": event.version_id,
        "version": event.version,
        "lifecycleState": event.lifecycle_state.value,
        "previousLifecycleState": event.previous_lifecycle_state.value if event.previous_lifecycle_state else None,
        "actor": {
            "actorId": event.actor.actor_id,
            "actorType": event.actor.actor_type,
            "actorEmail": event.actor.actor_email,
        },
        "timestamp": event.timestamp.isoformat(),
        "correlationId": event.correlation_id,
        "causationId": event.causation_id,
        "tenantId": event.tenant_id,
        "metadata": event.metadata,
    }


_REQUIRED_FIELDS = {"eventId", "eventType", "aggregateId", "version", "lifecycleState", "actor", "timestamp", "correlationId"}


# ─── Required fields contract ─────────────────────────────────────────────────

@pytest.mark.parametrize("event_type,lifecycle_state,previous_state", [
    (ProductDefinitionEventType.CREATED, ProductDefinitionLifecycleState.DRAFT, None),
    (ProductDefinitionEventType.SUBMITTED, ProductDefinitionLifecycleState.SUBMITTED, ProductDefinitionLifecycleState.DRAFT),
    (ProductDefinitionEventType.APPROVED, ProductDefinitionLifecycleState.APPROVED, ProductDefinitionLifecycleState.SUBMITTED),
    (ProductDefinitionEventType.REJECTED, ProductDefinitionLifecycleState.REJECTED, ProductDefinitionLifecycleState.SUBMITTED),
    (ProductDefinitionEventType.PUBLISHED, ProductDefinitionLifecycleState.PUBLISHED, ProductDefinitionLifecycleState.APPROVED),
    (ProductDefinitionEventType.DEPRECATED, ProductDefinitionLifecycleState.DEPRECATED, ProductDefinitionLifecycleState.PUBLISHED),
    (ProductDefinitionEventType.ARCHIVED, ProductDefinitionLifecycleState.ARCHIVED, ProductDefinitionLifecycleState.DEPRECATED),
    (ProductDefinitionEventType.ROLLED_BACK, ProductDefinitionLifecycleState.ROLLED_BACK, ProductDefinitionLifecycleState.PUBLISHED),
])
def test_all_required_fields_present(event_type, lifecycle_state, previous_state):
    """Every event type must include all required schema fields."""
    event = _base_event(event_type, lifecycle_state, previous_state)
    payload = _to_dict(event)
    missing = _REQUIRED_FIELDS - set(payload.keys())
    assert not missing, f"{event_type.value} missing required fields: {missing}"


# ─── Event-type-specific metadata ─────────────────────────────────────────────

def test_created_event_includes_vendor_model_and_hash():
    event = _base_event(
        ProductDefinitionEventType.CREATED,
        ProductDefinitionLifecycleState.DRAFT,
        metadata={"vendorName": "Cisco", "modelName": "ASR-1001-X", "contentHash": "abc123", "validationStatus": "VALID"},
    )
    payload = _to_dict(event)
    assert payload["metadata"]["vendorName"] == "Cisco"
    assert payload["metadata"]["modelName"] == "ASR-1001-X"
    assert payload["metadata"]["validationStatus"] == "VALID"
    assert "contentHash" in payload["metadata"]


def test_rejected_event_includes_rejection_reason():
    event = _base_event(
        ProductDefinitionEventType.REJECTED,
        ProductDefinitionLifecycleState.REJECTED,
        previous_state=ProductDefinitionLifecycleState.SUBMITTED,
        metadata={"rejectionReason": "Missing SNMP fingerprint OID."},
    )
    payload = _to_dict(event)
    assert payload["metadata"]["rejectionReason"] == "Missing SNMP fingerprint OID."


def test_rolled_back_event_includes_version_references():
    from_version = str(uuid4())
    restored_version = str(uuid4())
    event = _base_event(
        ProductDefinitionEventType.ROLLED_BACK,
        ProductDefinitionLifecycleState.ROLLED_BACK,
        previous_state=ProductDefinitionLifecycleState.PUBLISHED,
        metadata={"rollbackFromVersionId": from_version, "restoredVersionId": restored_version},
    )
    payload = _to_dict(event)
    assert payload["metadata"]["rollbackFromVersionId"] == from_version
    assert payload["metadata"]["restoredVersionId"] == restored_version


def test_approved_event_includes_validation_gates():
    event = _base_event(
        ProductDefinitionEventType.APPROVED,
        ProductDefinitionLifecycleState.APPROVED,
        previous_state=ProductDefinitionLifecycleState.SUBMITTED,
        metadata={"publishValidationGatesPassed": ["CREDENTIAL_CONTRACT", "FINGERPRINT_PRESENT", "NO_VALIDATION_ERRORS"]},
    )
    payload = _to_dict(event)
    gates = payload["metadata"]["publishValidationGatesPassed"]
    assert isinstance(gates, list)
    assert "CREDENTIAL_CONTRACT" in gates


# ─── Consumer contract: forward compatibility ─────────────────────────────────

def test_consumer_handles_unknown_metadata_fields():
    """Consumers must not fail when metadata contains unrecognised fields."""
    event = _base_event(
        ProductDefinitionEventType.PUBLISHED,
        ProductDefinitionLifecycleState.PUBLISHED,
        previous_state=ProductDefinitionLifecycleState.APPROVED,
        metadata={"future_field": "some_value", "another_new_field": 42},
    )
    payload = _to_dict(event)
    # Consumer simulation: deserialise and access only known fields
    known = {k: payload["metadata"].get(k) for k in ["vendorName", "modelName"]}
    assert known["vendorName"] is None   # absent = None, not KeyError
    assert payload["metadata"]["future_field"] == "some_value"  # preserved, not stripped


# ─── Security: no credential material ─────────────────────────────────────────

CREDENTIAL_PATTERNS = ["password", "secret", "api_key", "community", "private_key", "token"]


def test_event_payload_contains_no_credential_material():
    """Event serialisation must not leak credential material."""
    event = _base_event(
        ProductDefinitionEventType.PUBLISHED,
        ProductDefinitionLifecycleState.PUBLISHED,
        previous_state=ProductDefinitionLifecycleState.APPROVED,
        metadata={"vendorName": "Ericsson", "modelName": "AIR-4480"},
    )
    serialised = json.dumps(_to_dict(event)).lower()
    for pattern in CREDENTIAL_PATTERNS:
        assert pattern not in serialised, f"Event payload must not contain '{pattern}'"


# ─── Schema field type validation ─────────────────────────────────────────────

def test_event_id_is_string():
    event = _base_event(ProductDefinitionEventType.CREATED, ProductDefinitionLifecycleState.DRAFT)
    assert isinstance(event.event_id, str)


def test_version_is_positive_integer():
    event = _base_event(ProductDefinitionEventType.CREATED, ProductDefinitionLifecycleState.DRAFT)
    assert isinstance(event.version, int)
    assert event.version >= 1


def test_timestamp_is_datetime():
    event = _base_event(ProductDefinitionEventType.CREATED, ProductDefinitionLifecycleState.DRAFT)
    assert isinstance(event.timestamp, datetime)


def test_correlation_id_is_present():
    event = _base_event(ProductDefinitionEventType.SUBMITTED, ProductDefinitionLifecycleState.SUBMITTED)
    assert event.correlation_id is not None
    assert len(event.correlation_id) > 0


# ─── Message key strategy ─────────────────────────────────────────────────────

def test_aggregate_id_used_as_message_key():
    """The aggregate_id is the Kafka message key — must be a non-empty string."""
    event = _base_event(ProductDefinitionEventType.PUBLISHED, ProductDefinitionLifecycleState.PUBLISHED)
    assert isinstance(event.aggregate_id, str)
    assert len(event.aggregate_id) > 0
    # Verify it's a valid UUID format
    import re
    assert re.match(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", event.aggregate_id)
