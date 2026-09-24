# Framework Monitoring Validation Runbook

**WO-015** | Priority: P0 | Owner: SRE / QA

This runbook explains how to run the deterministic framework monitoring scenario suite locally or in a controlled test environment. No real southbound devices, real credentials, or production network access is required.

---

## Prerequisites

| Component | Version | Notes |
|-----------|---------|-------|
| Python | 3.11+ | Needed for scenario runner and assertion helpers |
| Node.js | 18+ | Needed for frontend tests |
| pytest | 7+ | `pip install pytest pytest-asyncio` |
| Docker Compose | v2 | Optional — for full service stack |

Install Python test dependencies:

```bash
cd test-harness/scenario-runner
pip install -r requirements.txt
```

Install frontend dependencies:

```bash
cd frontend
npm install
```

---

## 1. Run assertion unit tests (no services required)

These tests validate the framework assertion helpers in isolation. They run without any running services and should always pass in CI.

```bash
cd test-harness/scenario-runner
python -m pytest tests/test_assertions.py -v
```

**Expected output:**

```
tests/test_assertions.py::TestAssertFreshnessState::test_fresh_passes PASSED
...
tests/test_assertions.py::TestProfileFixtureIdentityAlignment::test_timeout_failure_reason_does_not_contain_credential_keywords PASSED
============================================================
XX passed in N.Ns
```

All tests should pass. If any fail, do not proceed to service-backed scenarios.

---

## 2. Run frontend integration tests

Tests for `AdaptiveDeviceParameterPanelsPage` use mocked API calls and run fully offline.

```bash
cd frontend
npx vitest run src/v2/pages/AdaptiveDeviceParameterPanelsPage.test.tsx --reporter=verbose
```

Run the full WO-015 frontend suite (panels + parameters + comparison view):

```bash
npx vitest run \
  src/v2/pages/AdaptiveDeviceParameterPanelsPage.test.tsx \
  src/api/framework-panels.api.test.ts \
  src/api/framework-parameters.api.test.ts \
  --reporter=verbose
```

**Expected output:** All tests PASS. No `credential` / `password` / `secret` keyword violations.

---

## 3. Run scenario suite (simulator-backed services)

The framework monitoring scenarios require simulator-backed services. These can be started with Docker Compose or by pointing environment variables at already-running services.

### 3a. Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PARAMETER_POLLER_URL` | `http://localhost:8084` | Parameter poller service base URL |
| `INVENTORY_URL` | `http://localhost:8080` | Inventory service base URL |
| `ALARM_URL` | `http://localhost:8081` | Alarm service base URL |
| `API_GW_URL` | `http://localhost:3000` | API gateway base URL |
| `SNMP_COMMUNITY_SUCCESS` | `public` | SNMP community for reachable simulator devices |
| `RESTRICTED_VIEWER_TOKEN` | *(required)* | JWT bearer token for restricted_viewer role |
| `RUN_ID` | Auto-generated | Unique run identifier for idempotency assertions |

**Security note:** Never set `SNMP_COMMUNITY_SUCCESS` to a real production community string in CI.  
Use the synthetic `public` value against the simulator only.

### 3b. Load the simulator profile

```bash
# Load the framework-monitoring profile against the running simulator
python test-harness/device-simulator/src/simulator.py \
  --profile test-harness/device-simulator/profiles/framework-monitoring.yaml \
  --mode deterministic
```

### 3c. Run individual scenarios

```bash
export PARAMETER_POLLER_URL=http://localhost:8084
export INVENTORY_URL=http://localhost:8080
export ALARM_URL=http://localhost:8081
export RUN_ID=$(python -c "import uuid; print(uuid.uuid4())")

# Scenario 1: Successful path
python test-harness/scenario-runner/src/app.py \
  --scenario test-harness/scenario-runner/scenarios/framework-monitoring.yaml \
  --filter framework-monitoring-successful-path

# Scenario 5: Threshold high alarm
python test-harness/scenario-runner/src/app.py \
  --scenario test-harness/scenario-runner/scenarios/framework-monitoring.yaml \
  --filter framework-monitoring-threshold-high
```

### 3d. Run all framework monitoring scenarios

```bash
python test-harness/scenario-runner/src/app.py \
  --scenario test-harness/scenario-runner/scenarios/framework-monitoring.yaml \
  --output evidence/framework-monitoring-run-${RUN_ID}.json
```

---

## 4. Expected pass output

A passing run produces a JSON report similar to:

```json
{
  "summary": {
    "total": 7,
    "passed": 7,
    "failed": 0,
    "pass_rate": 100.0
  },
  "scenarios": [
    { "name": "framework-monitoring-successful-path",  "status": "PASS", ... },
    { "name": "framework-monitoring-stale-telemetry",  "status": "PASS", ... },
    { "name": "framework-monitoring-protocol-timeout", "status": "PASS", ... },
    { "name": "framework-monitoring-auth-failure",     "status": "PASS", ... },
    { "name": "framework-monitoring-threshold-high",   "status": "PASS", ... },
    { "name": "framework-monitoring-threshold-low",    "status": "PASS", ... },
    { "name": "framework-monitoring-role-filtered-ui", "status": "PASS", ... }
  ]
}
```

---

## 5. Common failure categories and debugging steps

| Failure | Most likely cause | Debugging step |
|---------|-------------------|----------------|
| `freshnessState=STALE expected=FRESH` on successful-path | Parameter poller not yet collected first values | Increase `retry.times` or wait longer after profile load |
| `alarm is None` on threshold scenarios | Alarm service not wired to poller evaluateFrameworkThreshold | Check alarm-service logs for `evaluateFrameworkThreshold` calls |
| `grp-optical is present` on role-filtered scenario | RBAC middleware not enforcing server-side filtering | Check `RESTRICTED_VIEWER_TOKEN` role claims; verify gateway RBAC config |
| Credential keyword in failure reason | New failure message introduced without redaction check | Run `tests/test_assertions.py::TestAssertNoCredentialLeak` to identify the field |
| `stale_carried_over=true` on rerun-idempotency | In-memory store returning values from prior run | Restart parameter-poller between runs; or use `X-Correlation-ID` to force refresh |
| `registry_version_violations > 0` | Registry updated between template and values load | Re-run after registry stabilises; check product-definition-service logs |

### Failure report fields

Every scenario step failure includes:

- **capability**: which monitoring capability failed (polling, alarm, UI, RBAC)
- **endpoint or component**: URL or component name under test
- **expected value**: what the assertion required
- **observed value**: what the system returned
- **correlationId**: present when returned in the API response; use to correlate service logs

---

## 6. Safe cleanup

After a scenario run, no persistent state changes are made to production systems. If the simulator left in-memory state in the parameter poller or alarm service:

```bash
# Restart parameter poller to clear in-memory store
# (the poller does not persist to disk in development mode)
kill $(lsof -ti :8084) && \
  cd services/parameter-poller && \
  go run main.go &

# Clear active alarms for simulator device IDs (development only)
curl -X DELETE "${ALARM_URL}/api/v1/alarms?deviceIdPrefix=fw-dev-"
```

**Never run the cleanup DELETE against a production alarm service.**

---

## 7. Fixture identity alignment

Frontend mock fixtures and Python assertion fixtures use the same device and parameter identifiers as the simulator profile. This prevents silent drift between layers.

| Device scenario | Device ID | Profile key |
|-----------------|-----------|-------------|
| Successful read | `fw-dev-success-001` | `behaviour: successful-read` |
| Stale telemetry | `fw-dev-stale-001` | `behaviour: stale-read` |
| Timeout failure | `fw-dev-timeout-001` | `behaviour: timeout-failure` |
| Auth failure | `fw-dev-authfail-001` | `behaviour: auth-failure` |
| Threshold high | `fw-dev-threshold-high-001` | `behaviour: threshold-high` |
| Threshold low | `fw-dev-threshold-low-001` | `behaviour: threshold-low` |

If you add a new scenario device, update all three layers in the same commit:

1. `test-harness/device-simulator/profiles/framework-monitoring.yaml`
2. `test-harness/scenario-runner/scenarios/framework-monitoring.yaml`
3. `frontend/src/api/mocks/frameworkParameters.mocks.ts`
4. `test-harness/scenario-runner/tests/test_assertions.py` (`TestProfileFixtureIdentityAlignment`)
