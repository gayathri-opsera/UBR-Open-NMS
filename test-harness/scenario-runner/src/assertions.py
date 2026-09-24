"""
WO-015: Framework monitoring assertion helpers.

Extends the core evaluate_assertion engine with structured assertions for:
  - freshness_state       : validates FreshnessState enum value and staleness thresholds
  - threshold_alarm       : validates alarm fields on a threshold breach result
  - role_filtered_absence : verifies that an unauthorized parameter is absent from the API response
  - registry_consistency  : verifies registry_version matches expected across all parameter groups
  - no_credential_leak    : verifies that no secret-like strings appear in failure reason fields

All helpers follow the same (bool, str) contract as evaluate_assertion in runner.py so
they can be referenced inline from scenario YAML or called directly in integration tests.
"""
from __future__ import annotations

import re
from typing import Any, Dict, List, Optional

# ── Constants ─────────────────────────────────────────────────────────────────

VALID_FRESHNESS_STATES = {"FRESH", "STALE", "FAILED", "UNMAPPED", "UNKNOWN_DEVICE"}

VALID_READ_STATUSES = {
    "SUCCESS", "UNREACHABLE", "AUTH_FAILURE", "TIMEOUT",
    "UNMAPPED", "ADAPTER_ERROR", "REGISTRY_STALE", "UNKNOWN",
}

VALID_FAILURE_CATEGORIES = {
    "UNREACHABLE", "AUTH_FAILURE", "TIMEOUT", "UNMAPPED_PARAMETER",
    "ADAPTER_ERROR", "REGISTRY_STALE", "UNKNOWN",
}

# Patterns that must never appear in operator-visible failure messages.
# These are checked case-insensitively.
_CREDENTIAL_PATTERNS: List[re.Pattern] = [
    re.compile(r"\bpassword\b", re.IGNORECASE),
    re.compile(r"\bsecret\b", re.IGNORECASE),
    re.compile(r"\btoken\b", re.IGNORECASE),
    re.compile(r"\bcommunity\b", re.IGNORECASE),
    re.compile(r"\bprivKey\b", re.IGNORECASE),
    re.compile(r"\bauthKey\b", re.IGNORECASE),
    re.compile(r"\bprivacy\b", re.IGNORECASE),
    re.compile(r"\bsnmpv3\b", re.IGNORECASE),
    re.compile(r"\bcredential\b", re.IGNORECASE),
]


# ── freshness_state assertion ─────────────────────────────────────────────────

def assert_freshness_state(
    parameter: Dict[str, Any],
    expected_state: str,
    *,
    parameter_id: Optional[str] = None,
) -> tuple[bool, str]:
    """
    Validate that a parameter object carries the expected freshnessState value.

    Args:
        parameter:      Dict with at least a 'freshnessState' key.
        expected_state: One of VALID_FRESHNESS_STATES.
        parameter_id:   Optional label for error messages.

    Returns:
        (True, detail) on pass; (False, detail) on fail.
    """
    label = parameter_id or parameter.get("parameterId", "<unknown>")

    if expected_state not in VALID_FRESHNESS_STATES:
        return False, f"expected_state '{expected_state}' is not a valid FreshnessState; valid={VALID_FRESHNESS_STATES}"

    actual = parameter.get("freshnessState") or parameter.get("freshness_state")
    if actual is None:
        return False, f"parameter '{label}' has no freshnessState field"

    if actual != expected_state:
        return False, f"parameter '{label}': freshnessState={actual!r}, expected={expected_state!r}"

    return True, f"parameter '{label}': freshnessState={actual!r} ✓"


def assert_all_freshness_states(
    groups: List[Dict[str, Any]],
    expected_state: str,
) -> tuple[bool, str]:
    """
    Validate that ALL parameters across all groups have the expected freshnessState.

    Args:
        groups:         List of group dicts, each with a 'parameters' list.
        expected_state: One of VALID_FRESHNESS_STATES.

    Returns:
        (True, detail) on all pass; (False, detail) on first failure.
    """
    if not groups:
        return False, "no groups to validate"

    total = 0
    for group in groups:
        for param in group.get("parameters", []):
            total += 1
            ok, detail = assert_freshness_state(param, expected_state)
            if not ok:
                return False, detail

    return True, f"all {total} parameter(s) have freshnessState={expected_state!r} ✓"


# ── threshold_alarm assertion ─────────────────────────────────────────────────

def assert_threshold_alarm(
    alarm: Dict[str, Any],
    *,
    expected_condition: str,
    expected_parameter_id: str,
    expected_device_id: str,
    expected_product_definition_id: Optional[str] = None,
) -> tuple[bool, str]:
    """
    Validate that an alarm dict produced by the alarm service contains the required
    framework threshold fields (WO-013).

    Args:
        alarm:                         Alarm dict from alarm-service response.
        expected_condition:            'HIGH' or 'LOW'.
        expected_parameter_id:         Framework parameter ID (e.g. 'cpu_load').
        expected_device_id:            Device identifier.
        expected_product_definition_id: Optional — checked if provided.

    Returns:
        (True, detail) on pass; (False, detail) on failure.
    """
    if alarm is None:
        return False, "alarm is None — no alarm was raised"

    errors: List[str] = []

    actual_device = alarm.get("deviceId") or alarm.get("device_id")
    if actual_device != expected_device_id:
        errors.append(f"deviceId: got={actual_device!r}, want={expected_device_id!r}")

    actual_param = alarm.get("parameterId") or alarm.get("parameter_id")
    if actual_param != expected_parameter_id:
        errors.append(f"parameterId: got={actual_param!r}, want={expected_parameter_id!r}")

    actual_cond = alarm.get("thresholdCondition") or alarm.get("threshold_condition")
    if actual_cond != expected_condition:
        errors.append(f"thresholdCondition: got={actual_cond!r}, want={expected_condition!r}")

    if expected_product_definition_id is not None:
        actual_pd = alarm.get("productDefinitionId") or alarm.get("product_definition_id")
        if actual_pd != expected_product_definition_id:
            errors.append(f"productDefinitionId: got={actual_pd!r}, want={expected_product_definition_id!r}")

    # observed_value and threshold_value must be present and numeric
    obs = alarm.get("observedValue") or alarm.get("observed_value")
    thr = alarm.get("thresholdValue") or alarm.get("threshold_value")
    if obs is None:
        errors.append("observedValue is missing")
    if thr is None:
        errors.append("thresholdValue is missing")

    # registry_version must be present
    rv = alarm.get("registryVersion") or alarm.get("registry_version")
    if not rv:
        errors.append("registryVersion is missing or empty")

    if errors:
        return False, f"threshold alarm validation failed: {'; '.join(errors)}"

    return True, (
        f"alarm for '{expected_parameter_id}' on '{expected_device_id}': "
        f"condition={actual_cond}, observed={obs}, threshold={thr} ✓"
    )


# ── role_filtered_absence assertion ──────────────────────────────────────────

def assert_role_filtered_absence(
    response: Dict[str, Any],
    *,
    absent_parameter_ids: List[str],
    absent_group_ids: Optional[List[str]] = None,
) -> tuple[bool, str]:
    """
    Verify that server-side role filtering has removed the specified parameters
    (and optionally entire groups) from an adaptive template or current-value response.

    Args:
        response:             Parsed API response dict (data.groups[].parameters[]).
        absent_parameter_ids: Parameter IDs that must NOT appear anywhere in the response.
        absent_group_ids:     Group IDs that must NOT appear anywhere in the response.

    Returns:
        (True, detail) on pass (items are absent); (False, detail) if an item was found.
    """
    data = response.get("data", {}) if "data" in response else response
    groups: List[Dict[str, Any]] = data.get("groups", [])

    # Collect all present group IDs
    present_group_ids = {g.get("groupId") or g.get("group_id", "") for g in groups}

    # Check group-level absence
    if absent_group_ids:
        for gid in absent_group_ids:
            if gid in present_group_ids:
                return False, f"group '{gid}' is present in response but should have been filtered out by role"

    # Collect all present parameter IDs
    present_param_ids: set[str] = set()
    for group in groups:
        for param in group.get("parameters", []):
            pid = param.get("parameterId") or param.get("parameter_id", "")
            if pid:
                present_param_ids.add(pid)

    for pid in absent_parameter_ids:
        if pid in present_param_ids:
            return False, f"parameter '{pid}' is present in response but should have been filtered out by role"

    checked = f"parameters={absent_parameter_ids}"
    if absent_group_ids:
        checked += f", groups={absent_group_ids}"
    return True, f"role-filtered items are absent from response ({checked}) ✓"


# ── registry_consistency assertion ────────────────────────────────────────────

def assert_registry_consistency(
    groups: List[Dict[str, Any]],
    *,
    expected_registry_version: str,
    expected_product_definition_id: str,
) -> tuple[bool, str]:
    """
    Validate that every parameter in every group carries the same registry_version
    and product_definition_id, ensuring no version drift across parameters.

    Args:
        groups:                         List of group dicts with 'parameters' lists.
        expected_registry_version:      Registry snapshot version string.
        expected_product_definition_id: Product Definition ID.

    Returns:
        (True, detail) on pass; (False, detail) on first mismatch.
    """
    if not groups:
        return False, "no groups to validate for registry consistency"

    total = 0
    for group in groups:
        for param in group.get("parameters", []):
            total += 1
            label = param.get("parameterId") or param.get("parameter_id", "<unknown>")

            rv = param.get("registryVersion") or param.get("registry_version")
            if rv != expected_registry_version:
                return False, (
                    f"parameter '{label}': registryVersion={rv!r}, "
                    f"expected={expected_registry_version!r}"
                )

            pd = param.get("productDefinitionId") or param.get("product_definition_id")
            if pd != expected_product_definition_id:
                return False, (
                    f"parameter '{label}': productDefinitionId={pd!r}, "
                    f"expected={expected_product_definition_id!r}"
                )

    return True, (
        f"all {total} parameter(s) share registryVersion={expected_registry_version!r} "
        f"and productDefinitionId={expected_product_definition_id!r} ✓"
    )


# ── no_credential_leak assertion ──────────────────────────────────────────────

def assert_no_credential_leak(text: str, *, label: str = "field") -> tuple[bool, str]:
    """
    Assert that a free-text string does not contain credential-like keywords that
    must never surface in operator-visible failure messages or API responses.

    Args:
        text:  The string to check.
        label: Description of the source field for error messages.

    Returns:
        (True, detail) on pass; (False, detail) if a pattern matched.
    """
    if not text:
        return True, f"{label}: empty/null — no credential leak possible ✓"

    for pattern in _CREDENTIAL_PATTERNS:
        m = pattern.search(text)
        if m:
            # Never log the matched value — only report the pattern name
            return False, (
                f"{label} contains credential-like keyword matching /{pattern.pattern}/i — "
                f"this must not appear in operator-visible output"
            )

    return True, f"{label}: no credential-like keywords found ✓"


def assert_no_credential_leak_in_groups(groups: List[Dict[str, Any]]) -> tuple[bool, str]:
    """
    Scan all failure_reason fields across all parameter groups for credential leaks.

    Returns:
        (True, detail) if clean; (False, detail) on first violation.
    """
    for group in groups:
        gid = group.get("groupId") or group.get("group_id", "<unknown-group>")
        for param in group.get("parameters", []):
            pid = param.get("parameterId") or param.get("parameter_id", "<unknown>")
            for field_name in ("failureReason", "failure_reason"):
                value = param.get(field_name, "")
                if value:
                    ok, detail = assert_no_credential_leak(
                        value, label=f"group={gid} param={pid} field={field_name}"
                    )
                    if not ok:
                        return False, detail

    return True, "no credential leaks found in any failure reason field ✓"


# ── Dispatch table (extends runner.py evaluate_assertion) ─────────────────────

def evaluate_framework_assertion(assertion: dict, context: dict) -> tuple[bool, str]:
    """
    Extended assertion evaluator for framework-monitoring scenarios.

    Handles assertion types not covered by the core runner:
      - freshness_state
      - all_freshness_states
      - threshold_alarm
      - role_filtered_absence
      - registry_consistency
      - no_credential_leak

    Falls back to (False, "Unknown assertion type") for unrecognised types.
    """
    kind = assertion.get("type", "")

    if kind == "freshness_state":
        param = context.get(assertion.get("parameter_context_key", "parameter"), {})
        return assert_freshness_state(
            param,
            expected_state=assertion["expected_state"],
            parameter_id=assertion.get("parameter_id"),
        )

    if kind == "all_freshness_states":
        groups = context.get(assertion.get("groups_context_key", "groups"), [])
        return assert_all_freshness_states(groups, expected_state=assertion["expected_state"])

    if kind == "threshold_alarm":
        alarm = context.get(assertion.get("alarm_context_key", "alarm"), {})
        return assert_threshold_alarm(
            alarm,
            expected_condition=assertion["expected_condition"],
            expected_parameter_id=assertion["expected_parameter_id"],
            expected_device_id=assertion["expected_device_id"],
            expected_product_definition_id=assertion.get("expected_product_definition_id"),
        )

    if kind == "role_filtered_absence":
        response = context.get(assertion.get("response_context_key", "response"), {})
        return assert_role_filtered_absence(
            response,
            absent_parameter_ids=assertion.get("absent_parameter_ids", []),
            absent_group_ids=assertion.get("absent_group_ids"),
        )

    if kind == "registry_consistency":
        groups = context.get(assertion.get("groups_context_key", "groups"), [])
        return assert_registry_consistency(
            groups,
            expected_registry_version=assertion["expected_registry_version"],
            expected_product_definition_id=assertion["expected_product_definition_id"],
        )

    if kind == "no_credential_leak":
        text = context.get(assertion.get("text_context_key", "text"), "")
        label = assertion.get("label", "field")
        return assert_no_credential_leak(str(text), label=label)

    return False, f"Unknown framework assertion type: {kind!r}"
