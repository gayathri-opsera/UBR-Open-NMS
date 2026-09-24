# Product Definition Lifecycle

This document describes the full lifecycle of a Product Definition within the UBR NMS
Product Definition Control Plane.

## Lifecycle States

```
DRAFT → SUBMITTED → APPROVED → PUBLISHED
          ↓            ↓
       REJECTED     REJECTED
          ↓
        DRAFT (re-edit)

PUBLISHED → DEPRECATED → ARCHIVED
PUBLISHED → ROLLED_BACK → DRAFT (prior version restored)
```

| State | Description | Mutable |
|-------|-------------|---------|
| `DRAFT` | Uploaded artifact, not yet submitted for review. Validation report exists. No registry impact. | Yes |
| `SUBMITTED` | Administrator has submitted for approval workflow. Awaiting SuperAdmin review. | No |
| `APPROVED` | SuperAdmin has approved. Ready for publication to active registry. | No |
| `REJECTED` | Reviewer has rejected with reasons. May be returned to DRAFT for correction. | No |
| `PUBLISHED` | Active in the registry. Fingerprint, parameter, and adaptive UI registries are built from this version. | No |
| `DEPRECATED` | Successor version published. Still in registry but flagged. | No |
| `ARCHIVED` | Retired. No longer in active registry. Historical record preserved. | No |
| `ROLLED_BACK` | A prior version has been restored as the active published version. The displaced version enters ROLLED_BACK. | No |

## Allowed Transitions

| From | To | Trigger | Prerequisite |
|------|----|---------|-------------|
| `DRAFT` | `SUBMITTED` | Admin submits for review | Validation status must be `VALID` (WO-019 state machine) |
| `SUBMITTED` | `APPROVED` | SuperAdmin approves | Publish validation gates must pass (WO-021) |
| `SUBMITTED` | `REJECTED` | SuperAdmin rejects with reasons | — |
| `REJECTED` | `DRAFT` | Admin edits and re-uploads | — |
| `APPROVED` | `PUBLISHED` | Admin triggers publication | Registry rebuild must complete successfully |
| `PUBLISHED` | `DEPRECATED` | Newer version published | — |
| `DEPRECATED` | `ARCHIVED` | Admin archives | No active devices dependent on this version |
| `PUBLISHED` | `ROLLED_BACK` | Admin initiates rollback | Prior APPROVED version must exist (WO-017) |
| `ROLLED_BACK` | `DRAFT` | System creates new draft from rolled-back version | Prior version content copied to new DRAFT |

## State Machine Enforcement (WO-019)

All transitions are enforced by the centralized state machine in the Product Definition Service:
`com.ubrnms.productdef.lifecycle.ProductDefinitionStateMachine`

- **Single authority**: No service, controller, or background worker may mutate `lifecycleStatus` without first calling `ProductDefinitionStateMachine.validateTransition(from, to)`.
- **Invalid transitions** return `HTTP 409 CONFLICT` with machine-readable error code `INVALID_LIFECYCLE_TRANSITION`.
- **Unknown state** returns `HTTP 409 CONFLICT` with error code `UNKNOWN_LIFECYCLE_STATE`.
- **Lifecycle events** are emitted to the `product-definition.lifecycle.events` Kafka topic on every successful transition (WO-018).

### Canonical States (WO-019)

| State | Description | Mutable |
|-------|-------------|---------|
| `DRAFT` | Uploaded artifact; validation complete; no registry impact | Yes |
| `STAGED` | VALID definition held for admin review before activation | No |
| `ACTIVE` | Live; fingerprint and parameter registries built from this version | No |
| `SUPERSEDED` | Displaced by a newer activation; historical record preserved | No |
| `ARCHIVED` | Manually retired; no longer in active registry; terminal state | No |

### Transition Matrix (WO-019)

| From | To | Trigger | Prerequisite |
|------|----|---------|-------------|
| `DRAFT` | `STAGED` | Admin stages for review | `validationStatus` must be `VALID` |
| `DRAFT` | `ARCHIVED` | Admin discards unwanted draft | — |
| `STAGED` | `ACTIVE` | Admin activates; registries rebuilt | Conflict check must pass |
| `STAGED` | `DRAFT` | Admin retracts for revision | — |
| `STAGED` | `ARCHIVED` | Admin discards staged version | — |
| `ACTIVE` | `SUPERSEDED` | System displaces on newer activation | — |
| `ACTIVE` | `ARCHIVED` | Admin retires active definition | — |
| `SUPERSEDED` | `ACTIVE` | System restores during rollback | Previous version metadata must be present |
| `SUPERSEDED` | `ARCHIVED` | Admin archives superseded version | — |
| `ARCHIVED` | *(none)* | Terminal — no outbound transitions | — |

All other transitions (e.g. `DRAFT → ACTIVE`, `ACTIVE → DRAFT`) are invalid and return `INVALID_LIFECYCLE_TRANSITION`.

## Publish Validation Gates (WO-021)

Before a `SUBMITTED` → `APPROVED` transition is permitted, all publish validation gates must pass:
1. Credential vault contract fields are populated and reference a valid vault path.
2. All mandatory protocol mappings are present and conformant.
3. At least one fingerprint is defined.
4. No INVALID validation errors remain in the current validation report.
5. The credential runtime contract (WO-016) indicates the vault runtime is ready.

## Rollback (WO-017)

Rollback restores a prior `APPROVED` or `PUBLISHED` version as the active published definition:
1. The current `PUBLISHED` version transitions to `ROLLED_BACK`.
2. The target prior version transitions from its current state to `PUBLISHED`.
3. Registry rebuild is triggered for the restored version.
4. A `rolled_back` event is emitted to `product-definition.lifecycle` (WO-018).
5. The rollback is recorded in the audit lineage trail (WO-020).

**Prerequisites**: WO-001 (version exists), WO-002 (version store), WO-018 (event schema for `rolled_back`).

## Audit Trail and Lineage (WO-020)

Every lifecycle state transition records:
- `actor` — identity of the user or system that triggered the transition
- `from_state` / `to_state` — the state change
- `timestamp` — ISO-8601 with UTC offset
- `correlation_id` — links the audit record to the originating request
- `causation_id` — links the audit record to the triggering Kafka event (if applicable)
- `reason` — optional human-readable explanation (required for REJECTED transitions)

Audit records are append-only and immutable. No audit record may be deleted.

**Prerequisites**: WO-016 (credential vault runtime bootstrap for secure lineage store), WO-019 (state machine enforces all transitions through auditable path).

## Concurrency and Idempotency (WO-022)

- All lifecycle commands include an `idempotencyKey` field.
- Re-submitting a command with the same `idempotencyKey` returns the same response without re-executing the transition.
- Optimistic locking is used on version documents (`version` field in MongoDB) to prevent concurrent modification.
- Commands that arrive during an in-progress transition return `HTTP 409 CONFLICT` with error code `LIFECYCLE_COMMAND_IN_PROGRESS`.

**Prerequisites**: WO-018 (correlationId and causationId in event schema), WO-019 (state machine as the single concurrency gate).

## Event Schema (WO-018)

All lifecycle events are published to the `product-definition.lifecycle` Kafka topic.
Failed events are routed to `product-definition.lifecycle.dlq`.

See [Kafka Schema Reference](../shared-libs/json-schemas/kafka/README.md) for full schema definitions.

| Event Type | Emitted When |
|------------|-------------|
| `product_definition.created` | New DRAFT version created after successful upload |
| `product_definition.submitted` | DRAFT → SUBMITTED transition |
| `product_definition.approved` | SUBMITTED → APPROVED transition |
| `product_definition.rejected` | SUBMITTED → REJECTED transition |
| `product_definition.published` | APPROVED → PUBLISHED transition |
| `product_definition.deprecated` | PUBLISHED → DEPRECATED transition |
| `product_definition.archived` | DEPRECATED → ARCHIVED transition |
| `product_definition.rolled_back` | PUBLISHED → ROLLED_BACK transition with prior version restored |
