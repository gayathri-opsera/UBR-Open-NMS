# Kafka Message Schemas — UBR NMS

JSON Schema Draft-07 definitions for all Kafka topics used by the UBR NMS platform.
Schema IDs follow the pattern `https://ubr-nms.airtel.internal/schemas/kafka/<topic>.schema.json`.

## Topics and Schemas

| Schema File | Topic | Direction | Description |
|-------------|-------|-----------|-------------|
| `config-push.schema.json` | `config-push` | Config Service → Config Push Worker | Config job dispatch |
| `device-discovered.schema.json` | `device-discovered` | Discovery Service → Inventory Service | New device check-in |
| `inventory-sync.schema.json` | `inventory-sync` | Mobinet/Telemedia → Inventory Service | Bulk inventory sync |
| `raw-alarms.schema.json` | `raw-alarms` | Forwarders → Alarm Service | Raw alarm events from devices |
| `processed-alarms.schema.json` | `processed-alarms` | Alarm Service → Notification/Audit | Correlated, deduplicated alarms |
| `raw-kpi.schema.json` | `raw-kpi` | KPI Collectors → KPI Aggregation | Device KPI data points |
| `mycom-kpi-export.schema.json` | `mycom-kpi-export` | Mycom Forwarder → KPI Aggregation | Mycom device KPIs |
| `netcool-alarms-forward.schema.json` | `netcool-alarms` | Alarm Service → Netcool Forwarder | Northbound Netcool forwarding |
| **`product-definition-lifecycle.schema.json`** | **`product-definition.lifecycle`** | Product Definition Service → All consumers | **Product Definition lifecycle events** |

## Product Definition Lifecycle Events

Topic: `product-definition.lifecycle`
Message key: `{definitionId}` — preserves per-definition event ordering
DLQ topic: `product-definition.lifecycle.dlq`
Retention: 30 days (longer than default for audit replay support)
Partitions: 12 (keyed by definitionId for ordered delivery per definition)
Replication factor: 3 (production), 1 (dev/test)

### Event Types

All events conform to `product-definition-lifecycle.schema.json`. The `eventType` field
discriminates the specific event. The `metadata` object carries event-specific payload.

| `eventType` | Trigger | Key `metadata` fields |
|-------------|---------|----------------------|
| `product_definition.created` | New DRAFT version after successful upload | `vendorName`, `modelName`, `contentHash`, `validationStatus` |
| `product_definition.submitted` | Admin submits DRAFT for review | `vendorName`, `modelName` |
| `product_definition.approved` | SuperAdmin approves for publication | `publishValidationGatesPassed` |
| `product_definition.rejected` | SuperAdmin rejects | `rejectionReason` |
| `product_definition.published` | APPROVED version activated in registry | `vendorName`, `modelName`, `schemaVersion` |
| `product_definition.deprecated` | Superseded by newer published version | — |
| `product_definition.archived` | Retired from active registry | — |
| `product_definition.rolled_back` | Prior version restored as published | `rollbackFromVersionId`, `restoredVersionId` |

### Message Key Strategy

The Kafka message key is set to the `aggregateId` (Product Definition identifier). This ensures:
- All events for the same Product Definition land on the same partition.
- Consumers that maintain per-definition state receive events in order.
- No inter-definition ordering guarantees are made (separate definitions may interleave).

### Schema Compatibility

New optional fields may be added to the `metadata` object without a schema version bump.
Removing fields, renaming fields, or changing field types requires a new schema version and
a migration guide.

### Producer Contract (Product Definition Service)

```python
# Python producer example
from shared_libs.models.kafka_messages import ProductDefinitionLifecycleEvent
from shared_libs.models.kafka_messages import ProductDefinitionActor, ProductDefinitionEventType

event = ProductDefinitionLifecycleEvent(
    event_id=str(uuid4()),
    event_type=ProductDefinitionEventType.CREATED,
    aggregate_id=definition_id,
    version_id=version_id,
    version=1,
    lifecycle_state="DRAFT",
    actor=ProductDefinitionActor(actor_id=actor_id, actor_type="USER"),
    timestamp=datetime.utcnow(),
    correlation_id=correlation_id,
    metadata={"vendorName": "Cisco", "modelName": "ASR-1001-X", "contentHash": sha256}
)
```

### Consumer Contract

Consumers must:
1. Filter on `eventType` before processing.
2. Use `correlationId` for distributed tracing.
3. Use `causationId` to reconstruct event chains.
4. Handle unknown `eventType` values gracefully (skip, log, forward to DLQ).
5. Never reject a message solely because `metadata` contains unfamiliar fields.
