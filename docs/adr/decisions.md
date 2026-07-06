# ADR-001: Polyglot Technology Stack

**Status:** Accepted  
**Date:** 2024-01-15  
**Deciders:** Architecture Team, Engineering Leads

---

## Context

UBR NMS manages heterogeneous BTS/CPE equipment across multiple protocols (SNMP, syslog, REST). Different subsystems have vastly different performance, latency, and concurrency requirements.

## Decision

Use a polyglot stack with the optimal language per subsystem:

| Language | Services | Rationale |
|----------|----------|-----------|
| Java / Spring Boot | alarm, inventory, kpi-aggregation, kpi-query, diagnostics, config-management, topology, event-collector, kpi-collector, health-monitor | Rich ecosystem for enterprise integration, Micrometer metrics, Spring Data for MongoDB/ScyllaDB, mature Spring Kafka |
| Node.js / Express | auth, notification, audit, api-gateway | I/O-bound workloads, JWT libraries, WebSocket/SSE for push notifications, low latency |
| Python / FastAPI | report-service, device-simulator, oss-stubs, scenario-runner | Data manipulation, report generation (openpyxl, Jinja2), async I/O, rapid test tooling |
| Go | netcool-forwarder, mycom-forwarder, mobinet-sync, syslog-forwarder, discovery-service | Low memory footprint, native goroutine concurrency for high-throughput forwarding, minimal container image size |

## Consequences

**Positive:** Each service uses the best-fit tool. Go forwarders use < 20 MB RAM. Node.js auth handles thousands of concurrent WebSocket connections.

**Negative:** Increased operational complexity. Mitigated by: shared Prometheus metrics libraries per language, standardized Dockerfile patterns, unified Helm chart templates.

---

# ADR-002: Kafka as the Event Bus

**Status:** Accepted  
**Date:** 2024-01-15

## Context

NMS must handle 100K+ events/second during alarm storms. Events must be durable, replayable, and fan-out to multiple consumers (alarm correlation, KPI aggregation, northbound forwarding).

## Decision

Use Apache Kafka as the sole event bus. All inter-service communication for high-throughput event flows uses Kafka topics. Synchronous REST is used only for query paths.

Key topics:

| Topic | Producer | Consumers |
|-------|----------|-----------|
| `raw-alarms` | event-collector | alarm-service, netcool-forwarder, health-monitor |
| `kpi-events` | kpi-collector | kpi-aggregation-service, mycom-forwarder |
| `inventory-events` | inventory-service | mobinet-sync |
| `operational-events` | audit-service | syslog-forwarder |

## Consequences

Kafka provides exactly-once semantics (with idempotent producers), consumer group scaling, and 30-day retention for replay. DLQ topics (`*-dlq`) capture malformed messages. Adds operational overhead mitigated by Helm-deployed Strimzi operator.

---

# ADR-003: MongoDB vs PostgreSQL for Alarm / Inventory Data

**Status:** Accepted  
**Date:** 2024-01-15

## Context

Alarms and inventory records have variable schema (different device types expose different attributes). Query patterns are mostly by deviceId + time range. No strong transactional requirements across alarm/inventory.

## Decision

Use MongoDB (replica set) for alarms, inventory, config templates, and audit logs.

## Rejected Alternative

PostgreSQL: rigid schema requires migrations for each new device attribute. JSONB partial support adds complexity. MongoDB's document model maps naturally to device records.

## Consequences

Schema flexibility for device-type-specific attributes. No foreign key constraints — referential integrity enforced by application logic. Replica set provides HA. Compromise: no JOIN queries — compensated by denormalized document design.

---

# ADR-004: ScyllaDB for Time-Series KPI Data

**Status:** Accepted  
**Date:** 2024-01-15

## Context

KPI data is write-heavy (millions of data points/hour), append-only, queried by time range and device. Retention is 90 days for raw and 1 year for aggregated.

## Decision

Use ScyllaDB (Cassandra-compatible) with a time-series table design:

```cql
PRIMARY KEY ((device_id, granularity), timestamp)
WITH CLUSTERING ORDER BY (timestamp DESC)
AND default_time_to_live = 7776000  -- 90 days
```

## Consequences

ScyllaDB provides sub-millisecond P99 write latency at scale and linear horizontal scaling. Tombstone management requires regular compaction monitoring (runbook: database-monitoring). No secondary index on `timestamp` — all queries must include `device_id`.

---

# ADR-005: Three-Role RBAC Model

**Status:** Accepted  
**Date:** 2024-01-15

## Context

Different operator classes need different access levels: executives need read-only dashboards, NOC operators need alarm acknowledge, engineers need config push.

## Decision

Three roles: `ADMIN`, `OPERATOR`, `VIEWER`. Enforced via JWT claims validated by api-gateway middleware.

| Role | Permissions |
|------|-------------|
| ADMIN | All operations including user management, config push, threshold updates |
| OPERATOR | Alarm acknowledge/clear, device diagnostics, read all |
| VIEWER | Read-only access to dashboards, alarms, KPIs |

## Consequences

Simple to reason about. Limitation: no fine-grained per-device ACLs. Deferred to a future ADR if multi-tenant requirements emerge.

---

# ADR-006: Offline Command Policy

**Status:** Accepted  
**Date:** 2024-01-15

## Context

BTS/CPE devices may be offline for hours (power outage, maintenance). Config push and diagnostic commands targeting offline devices must not be silently dropped.

## Decision

All commands targeting devices are queued in MongoDB with status `PENDING`. The discovery-service polls device connectivity and retries pending commands when a device comes back online (within a 24-hour TTL). Commands exceeding TTL transition to `EXPIRED` and generate a notification.

## Consequences

Operators get reliable feedback for all command submissions. MongoDB used as a command queue (simpler than a separate message queue for low-volume command traffic). Risk: large backlog if many devices go offline simultaneously — mitigated by TTL and pagination in the command list API.
