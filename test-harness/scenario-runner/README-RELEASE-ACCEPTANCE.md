# Release Acceptance Report Generator

**WO-065**: Generate machine-readable release acceptance reports from validation scenario results.

## Overview

The release acceptance report aggregates validation scenario results and produces an auditable go/no-go evidence artifact for release candidates. The report includes pass/fail status, P0 validation checks, failure categories, checksums, and redacted environment metadata.

## Features

- **Severity-based policy**: Release fails if ANY P0 validation fails, times out, or has missing evidence
- **Deterministic output**: Consistent JSON format with sorted keys for diff-ability
- **Secret redaction**: Automatically masks passwords, tokens, keys, and sensitive patterns
- **Artifact checksums**: SHA256 checksums for evidence files and report content
- **Failure categorization**: Structured failure reasons (P0_VALIDATION_FAILED, MISSING_EVIDENCE, TIMEOUT, etc.)

## Usage

### From Python (Programmatic)

```python
from runner import ScenarioResult, StepStatus, StepResult
from release_acceptance import generate_acceptance_report_from_scenarios

# Run scenarios
scenario_results = [
    ScenarioResult(
        name="device-onboarding",
        description="UBR Call-Home Discovery",
        status=StepStatus.PASS,
        duration_ms=1234.5,
        steps=[...],
    ),
    # ... more scenarios
]

# Define priority map (defaults to P1 if not specified)
priority_map = {
    "device-onboarding": "P0",
    "alarm-lifecycle": "P0",
    "configuration-push": "P1",
}

# Generate report
report = generate_acceptance_report_from_scenarios(
    scenario_results=scenario_results,
    run_id="v1.2.3-validation-001",
    release_candidate="v1.2.3",
    output_path="release-acceptance-v1.2.3.json",
    priority_map=priority_map,
)

print(f"Release Status: {report.overall_status}")
print(f"Report written to: release-acceptance-v1.2.3.json")
print(f"Checksum: release-acceptance-v1.2.3.json.sha256")
```

### From Validation Result Files

If you have pre-generated validation result JSON files:

```python
from release_acceptance import aggregate_validation_results, write_report

result_files = [
    "results/device-onboarding.json",
    "results/alarm-lifecycle.json",
    "results/kpi-collection.json",
]

report = aggregate_validation_results(
    result_files=result_files,
    run_id="v1.2.3-validation-001",
    release_candidate="v1.2.3",
    environment={
        "test_env": "staging",
        "git_commit": "abc123",
        "simulator_version": "1.0.0",
    },
)

write_report(report, "release-acceptance-v1.2.3.json")
```

## Validation Result Schema

Individual validation results should follow this JSON schema:

```json
{
  "scenario_name": "device-onboarding",
  "requirement_capability": "UBR Call-Home Discovery",
  "priority": "P0",
  "status": "PASS",
  "duration_ms": 1234.5,
  "device_count": 3,
  "artifact_path": "evidence/onboarding-evidence.json",
  "error_message": null
}
```

**Required fields:**
- `scenario_name`: Unique scenario identifier
- `requirement_capability`: Human-readable capability description
- `priority`: `P0` (critical), `P1` (high), `P2` (medium), `P3` (low)
- `status`: `PASS`, `FAIL`, `SKIP`, `BLOCKED`, `TIMEOUT`
- `duration_ms`: Execution time in milliseconds

**Optional fields:**
- `device_count`: Number of devices involved in validation
- `artifact_path`: Path to evidence export file
- `error_message`: Failure details (required if status is FAIL)

## Release Acceptance Report Schema

```json
{
  "runId": "v1.2.3-validation-001",
  "releaseCandidate": "v1.2.3",
  "generatedAt": "2026-09-07T10:30:00Z",
  "overallStatus": "PASSED",
  "scenarios": [
    {
      "scenarioName": "device-onboarding",
      "requirementCapability": "UBR Call-Home Discovery",
      "priority": "P0",
      "status": "PASS",
      "durationMs": 1234.5,
      "deviceCount": 3,
      "failureCategory": null,
      "errorMessage": null,
      "artifactPath": "evidence/onboarding-evidence.json",
      "artifactChecksum": "abc123...def456"
    }
  ],
  "environmentMetadata": {
    "test_env": "staging",
    "git_commit": "abc123"
  },
  "fixtureVersions": {
    "simulator_version": "1.0.0"
  },
  "failureSummary": null
}
```

## Severity Policy

The release acceptance report applies the following policy:

1. **FAILED** if:
   - ANY P0 validation has status `FAIL` or `TIMEOUT`
   - ANY P0 validation has missing evidence (`artifact_path` file not found)

2. **BLOCKED** if:
   - ANY validation has status `BLOCKED` (and no P0 failures)

3. **PASSED** otherwise

Non-critical (P1, P2, P3) failures do NOT cause release failure.

## Secret Redaction

The following are automatically redacted from all output:

**Sensitive keys:**
- password, secret, token, key, credential, hmac
- private_key, certificate, connection_string, api_key
- auth_token, bearer, jwt, access_token, refresh_token

**Sensitive value patterns:**
- Base64-encoded tokens (40+ characters)
- API keys (`sk-...`, `ghp_...`)
- Bearer tokens
- Private keys (`-----BEGIN PRIVATE KEY-----`)

Redacted values are replaced with `[REDACTED]`.

## Examples

### All Pass

```bash
$ python -c "from release_acceptance import aggregate_validation_results; \
  print(aggregate_validation_results(['fixtures/validation-all-pass.json'], \
  'run-001', 'v1.0.0').overall_status)"
PASSED
```

### P0 Failure

```bash
$ python -c "from release_acceptance import aggregate_validation_results; \
  print(aggregate_validation_results(['fixtures/validation-p0-failure.json'], \
  'run-002', 'v1.0.0').overall_status)"
FAILED
```

## Testing

Run unit tests:

```bash
cd test-harness/scenario-runner
pytest tests/test_release_acceptance.py -v
```

## Fixtures

Golden fixtures are available in `fixtures/`:

- `validation-all-pass.json`: Successful P0 validation
- `validation-p0-failure.json`: Failed P0 validation
- `validation-missing-evidence.json`: P0 with missing artifact file
- `validation-skipped-noncritical.json`: Skipped P2 (does not fail release)
- `validation-blocked.json`: Blocked validation
- `validation-malformed.txt`: Malformed input (treated as P0 failure)

## Integration with CI/CD

The report generator is designed to be runnable locally and in air-gapped environments without external services. It does NOT:

- Modify GitHub Actions, ArgoCD, Kubernetes, or Helm
- Submit data to external services
- Require network connectivity

Exit codes:
- `0`: Report generated successfully (status may be PASSED, FAILED, or BLOCKED)
- Non-zero: Report generation error (file not found, malformed JSON, etc.)

Check release status:

```python
report = aggregate_validation_results(...)
if report.overall_status == ReleaseStatus.FAILED:
    sys.exit(1)  # Fail the build
```

## Compliance and Audit

Each report includes:

- **Deterministic JSON**: Sorted keys, consistent formatting
- **SHA256 checksums**: For report content and linked artifacts
- **Generation metadata**: Timestamp, run ID, release candidate version
- **Evidence completeness**: Missing artifacts are explicitly marked
- **Redaction audit**: Sensitive values removed from all fields

Reports can be archived for release audit trails and attached to code review or QA review processes.
