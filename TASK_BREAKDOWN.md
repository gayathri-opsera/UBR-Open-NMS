# Product Definition Control Plane — Task Breakdown

This document tracks the implementation order, dependency relationships,
and readiness prerequisites for all Product Definition work orders.

## Dependency Graph (Topological Order)

```
Layer 0 (no blockers)
  WO-001  Validate Product Definition Uploads        [P0, 8pts] ✅ committed
  WO-016  Framework Platform Enablement & Runtime    [P0, 8pts]
  WO-018  Kafka Topics & Event Schema Contracts      [P0, 5pts]
  WO-023  Lifecycle Dependency Language Alignment    [P1, 3pts]

Layer 1 (unblocked after layer 0)
  WO-002  Activate Versioned Definition Registries   [P0, 8pts] — blocked-by WO-001
  WO-019  Lifecycle State Machine Enforcement        [P0, 8pts] — blocked-by WO-018

Layer 2 (unblocked after layer 1)
  WO-003  Build Definition Admin Workspace           [P0, 5pts] — blocked-by WO-002
  WO-017  Implement Product Definition Rollback      [P0, 8pts] — blocked-by WO-001, WO-002, WO-018
  WO-020  Audit Trail and Lineage History            [P1, 5pts] — blocked-by WO-016, WO-019
  WO-021  Publish Validation Gates                   [P0, 8pts] — blocked-by WO-016, WO-018, WO-019
  WO-022  Concurrency Control & Idempotent Commands  [P1, 5pts] — blocked-by WO-018, WO-019

Layer 3
  WO-004  Enforce Framework Gateway Authorization    [P0, 5pts] — blocked-by WO-003

Layer 4
  WO-005  Protect Framework Credential References    [P0, 8pts] — blocked-by WO-004
  WO-006  Authorize Framework Parameter Visibility   [P0, 5pts] — blocked-by WO-004

Layer 5
  WO-007  Expose Read-Only Framework APIs            [P0, 5pts] — blocked-by WO-002, WO-005
  WO-008  Add Multi-Mode Deterministic Discovery     [P0, 8pts] — blocked-by WO-003, WO-006
  WO-009  Implement Read-Only Southbound Clients     [P0,13pts] — blocked-by WO-003, WO-006

Layer 6
  WO-010  Resolve Product Fingerprints Into Inventory [P0, 8pts] — blocked-by WO-008
  WO-011  Expose Guided Discovery Failure Details    [P0, 5pts] — blocked-by WO-008

Layer 7
  WO-012  Poll Product Definition Parameters         [P0, 8pts] — blocked-by WO-009, WO-010

Layer 8
  WO-013  Evaluate Metadata Threshold Alarms         [P0, 5pts] — blocked-by WO-012

Layer 9
  WO-014  Render Role-Aware Parameter Panels         [P0, 8pts] — blocked-by WO-004, WO-005, WO-012, WO-013

Layer 10
  WO-015  Validate Monitoring Scenario Coverage      [P0, 5pts] — blocked-by WO-007, WO-011, WO-014
```

## Dependency Terminology

| Term | Meaning |
|------|---------|
| **blocked-by** | Implementation cannot begin until the referenced WO is in `done` status. Attempting to start without this dependency will produce broken integration or missing interfaces. |
| **depends-on (runtime)** | The implementation can be written but will not function at runtime without the referenced service. Integration tests will skip or mock. |
| **should-precede** | Recommended ordering for a cleaner review, but not strictly blocking. |

## Prerequisites by Concern

### Credential Vault Contract Readiness (WO-016)
Required by: WO-005, WO-020, WO-021
- WO-016 must be committed before credential reference protection (WO-005) can bind to a stable vault interface.
- WO-020 (audit lineage) and WO-021 (publish gates) depend on the Framework Credential Vault Runtime bootstrap contract being stable.

### Event Schema and Topic Readiness (WO-018)
Required by: WO-017, WO-019, WO-021, WO-022
- WO-018 must establish topic names and schema URIs before any lifecycle event producer or consumer code is written.
- WO-019 (state machine) must emit lifecycle events to the topics defined in WO-018.
- WO-017 (rollback) must emit a `rolled_back` event conforming to the WO-018 schema.
- WO-022 (concurrency/idempotency) must include correlationId and causationId from the WO-018 schema contract.

### State Machine Enforcement Prerequisite (WO-019)
Required by: WO-017, WO-020, WO-021, WO-022
- WO-019 is the single authority for allowed lifecycle transitions. All transition-sensitive commands must call through the state machine, never bypass it.
- WO-021 (publish gates) must enforce that publication is only permitted after state machine approval.
- WO-022 (idempotency) must be aware of state machine state to prevent duplicate transition commands.

### Versioning Prerequisite (WO-002)
Required by: WO-017, WO-007
- WO-017 (rollback) requires an existing version store from WO-002 to identify and restore prior versions.
- WO-007 (read-only framework APIs) requires the activated registry records produced by WO-002.

### Publish Validation Gate Prerequisites (WO-021)
WO-021 requires WO-016 (credential contract), WO-018 (event schema), WO-019 (state machine) — all three
must be stable before publish gate logic is written to avoid triple re-work.

### Rollback Prerequisites (WO-017)
WO-017 requires WO-001 (validation), WO-002 (versioning), WO-018 (event schema for `rolled_back` event).
The rollback audit trail is a separate concern handled by WO-020.

## Removed Ambiguities

The following previously-ambiguous phrases have been removed from lifecycle work items:
- ~~"depends on vault availability"~~ → replaced with "blocked-by WO-016 credential vault contract"
- ~~"needs event infrastructure"~~ → replaced with "blocked-by WO-018 topic and schema definitions"
- ~~"after control plane is stable"~~ → replaced with specific WO references per concern
- ~~"once lifecycle is enforced"~~ → replaced with "blocked-by WO-019 state machine enforcement"

## Non-Blocking Runtime Dependencies

These are **not** implementation blockers but must be present for integration tests to pass:

| Dependency | Required At Runtime By | Notes |
|------------|------------------------|-------|
| MongoDB | All product-definition-service WOs | Mocked in unit tests |
| Kafka broker | WO-018, WO-019, WO-021, WO-022 | Mocked with EmbeddedKafka in unit tests |
| Credential Vault (WO-016) | WO-005, WO-020, WO-021 | Contract-mocked until service is deployed |
| JWT/RBAC Gateway (WO-004+) | All gateway-layer WOs | Auth tokens mocked in unit tests |
