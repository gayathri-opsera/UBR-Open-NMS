"""
WO-015: Unit tests for framework monitoring assertion helpers (assertions.py).

Covers:
  - freshness_state: valid/invalid states, missing field, label propagation
  - all_freshness_states: empty groups, mixed states, full pass
  - threshold_alarm: high/low breach, missing fields, credential redaction
  - role_filtered_absence: absent groups/parameters, present when should be absent
  - registry_consistency: matching, mismatched version, mismatched PD ID
  - no_credential_leak: clean text, each forbidden keyword individually
  - evaluate_framework_assertion: dispatch for all supported types, unknown type
"""
import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "../src"))

import pytest
from assertions import (
    assert_freshness_state,
    assert_all_freshness_states,
    assert_threshold_alarm,
    assert_role_filtered_absence,
    assert_registry_consistency,
    assert_no_credential_leak,
    assert_no_credential_leak_in_groups,
    evaluate_framework_assertion,
    VALID_FRESHNESS_STATES,
    _CREDENTIAL_PATTERNS,
)


# ── Fixtures ──────────────────────────────────────────────────────────────────

def _param(
    parameter_id="cpu_load",
    freshness_state="FRESH",
    read_status="SUCCESS",
    failure_reason=None,
    registry_version="registry-fw-001",
    product_definition_id="pd-framework-router-v1",
    value_numeric=42.0,
):
    p = {
        "parameterId": parameter_id,
        "freshnessState": freshness_state,
        "readStatus": read_status,
        "registryVersion": registry_version,
        "productDefinitionId": product_definition_id,
        "valueNumeric": value_numeric,
    }
    if failure_reason:
        p["failureReason"] = failure_reason
    return p


def _group(group_id="grp-chassis", params=None):
    return {"groupId": group_id, "parameters": params or [_param()]}


def _alarm(
    device_id="fw-dev-threshold-high-001",
    parameter_id="cpu_load",
    condition="HIGH",
    observed_value=94.5,
    threshold_value=90.0,
    registry_version="registry-fw-001",
    product_definition_id="pd-framework-router-v1",
):
    return {
        "deviceId": device_id,
        "parameterId": parameter_id,
        "thresholdCondition": condition,
        "observedValue": observed_value,
        "thresholdValue": threshold_value,
        "registryVersion": registry_version,
        "productDefinitionId": product_definition_id,
    }


# ── assert_freshness_state ────────────────────────────────────────────────────

class TestAssertFreshnessState:
    def test_fresh_passes(self):
        ok, detail = assert_freshness_state(_param(freshness_state="FRESH"), "FRESH")
        assert ok is True
        assert "FRESH" in detail

    def test_stale_passes(self):
        ok, _ = assert_freshness_state(_param(freshness_state="STALE"), "STALE")
        assert ok is True

    def test_failed_passes(self):
        ok, _ = assert_freshness_state(_param(freshness_state="FAILED"), "FAILED")
        assert ok is True

    def test_mismatch_fails(self):
        ok, detail = assert_freshness_state(_param(freshness_state="STALE"), "FRESH")
        assert ok is False
        assert "STALE" in detail
        assert "FRESH" in detail

    def test_missing_freshness_field_fails(self):
        param = {"parameterId": "cpu_load"}
        ok, detail = assert_freshness_state(param, "FRESH")
        assert ok is False
        assert "no freshnessState field" in detail

    def test_invalid_expected_state_fails(self):
        ok, detail = assert_freshness_state(_param(), "INVALID_STATE")
        assert ok is False
        assert "valid FreshnessState" in detail

    def test_all_valid_states_accepted(self):
        for state in VALID_FRESHNESS_STATES:
            ok, _ = assert_freshness_state(_param(freshness_state=state), state)
            assert ok is True, f"State {state} should pass"

    def test_parameter_id_in_error_message(self):
        ok, detail = assert_freshness_state(_param(freshness_state="STALE"), "FRESH", parameter_id="my_param")
        assert ok is False
        assert "my_param" in detail


# ── assert_all_freshness_states ───────────────────────────────────────────────

class TestAssertAllFreshnessStates:
    def test_all_fresh_passes(self):
        groups = [
            _group(params=[_param(freshness_state="FRESH"), _param(freshness_state="FRESH")]),
        ]
        ok, detail = assert_all_freshness_states(groups, "FRESH")
        assert ok is True
        assert "2" in detail

    def test_one_stale_fails(self):
        groups = [
            _group(params=[
                _param(freshness_state="FRESH"),
                _param(parameter_id="mem_util", freshness_state="STALE"),
            ]),
        ]
        ok, detail = assert_all_freshness_states(groups, "FRESH")
        assert ok is False
        assert "mem_util" in detail or "STALE" in detail

    def test_empty_groups_fails(self):
        ok, detail = assert_all_freshness_states([], "FRESH")
        assert ok is False
        assert "no groups" in detail

    def test_empty_parameters_in_group_ignored(self):
        groups = [_group(params=[_param(freshness_state="FAILED")])]
        ok, _ = assert_all_freshness_states(groups, "FAILED")
        assert ok is True

    def test_multiple_groups_all_must_match(self):
        groups = [
            _group("grp-chassis", [_param(freshness_state="STALE")]),
            _group("grp-optical", [_param(parameter_id="rx_power", freshness_state="FRESH")]),
        ]
        ok, detail = assert_all_freshness_states(groups, "STALE")
        assert ok is False
        assert "FRESH" in detail


# ── assert_threshold_alarm ────────────────────────────────────────────────────

class TestAssertThresholdAlarm:
    def test_high_breach_passes(self):
        alarm = _alarm(condition="HIGH")
        ok, detail = assert_threshold_alarm(
            alarm,
            expected_condition="HIGH",
            expected_parameter_id="cpu_load",
            expected_device_id="fw-dev-threshold-high-001",
        )
        assert ok is True
        assert "HIGH" in detail

    def test_low_breach_passes(self):
        alarm = _alarm(
            device_id="fw-dev-threshold-low-001",
            parameter_id="rx_power",
            condition="LOW",
            observed_value=-13.5,
            threshold_value=-10.0,
        )
        ok, detail = assert_threshold_alarm(
            alarm,
            expected_condition="LOW",
            expected_parameter_id="rx_power",
            expected_device_id="fw-dev-threshold-low-001",
        )
        assert ok is True
        assert "rx_power" in detail

    def test_wrong_condition_fails(self):
        alarm = _alarm(condition="HIGH")
        ok, detail = assert_threshold_alarm(
            alarm,
            expected_condition="LOW",
            expected_parameter_id="cpu_load",
            expected_device_id="fw-dev-threshold-high-001",
        )
        assert ok is False
        assert "thresholdCondition" in detail

    def test_wrong_parameter_id_fails(self):
        alarm = _alarm(parameter_id="mem_util")
        ok, detail = assert_threshold_alarm(
            alarm,
            expected_condition="HIGH",
            expected_parameter_id="cpu_load",
            expected_device_id="fw-dev-threshold-high-001",
        )
        assert ok is False
        assert "parameterId" in detail

    def test_none_alarm_fails(self):
        ok, detail = assert_threshold_alarm(
            None,
            expected_condition="HIGH",
            expected_parameter_id="cpu_load",
            expected_device_id="dev-001",
        )
        assert ok is False
        assert "None" in detail

    def test_missing_observed_value_fails(self):
        alarm = _alarm()
        del alarm["observedValue"]
        ok, detail = assert_threshold_alarm(
            alarm,
            expected_condition="HIGH",
            expected_parameter_id="cpu_load",
            expected_device_id="fw-dev-threshold-high-001",
        )
        assert ok is False
        assert "observedValue" in detail

    def test_missing_registry_version_fails(self):
        alarm = _alarm()
        alarm["registryVersion"] = ""
        ok, detail = assert_threshold_alarm(
            alarm,
            expected_condition="HIGH",
            expected_parameter_id="cpu_load",
            expected_device_id="fw-dev-threshold-high-001",
        )
        assert ok is False
        assert "registryVersion" in detail

    def test_product_definition_id_checked_when_provided(self):
        alarm = _alarm(product_definition_id="pd-wrong")
        ok, detail = assert_threshold_alarm(
            alarm,
            expected_condition="HIGH",
            expected_parameter_id="cpu_load",
            expected_device_id="fw-dev-threshold-high-001",
            expected_product_definition_id="pd-framework-router-v1",
        )
        assert ok is False
        assert "productDefinitionId" in detail


# ── assert_role_filtered_absence ─────────────────────────────────────────────

class TestAssertRoleFilteredAbsence:
    def _response(self, groups):
        return {"data": {"groups": groups}}

    def test_absent_parameter_passes(self):
        response = self._response([
            {"groupId": "grp-chassis", "parameters": [{"parameterId": "cpu_load"}]},
        ])
        ok, detail = assert_role_filtered_absence(
            response,
            absent_parameter_ids=["rx_power", "tx_power"],
        )
        assert ok is True
        assert "rx_power" in detail

    def test_present_parameter_fails(self):
        response = self._response([
            {"groupId": "grp-optical", "parameters": [{"parameterId": "rx_power"}]},
        ])
        ok, detail = assert_role_filtered_absence(
            response,
            absent_parameter_ids=["rx_power"],
        )
        assert ok is False
        assert "rx_power" in detail

    def test_absent_group_passes(self):
        response = self._response([
            {"groupId": "grp-chassis", "parameters": []},
        ])
        ok, detail = assert_role_filtered_absence(
            response,
            absent_parameter_ids=[],
            absent_group_ids=["grp-optical"],
        )
        assert ok is True

    def test_present_group_fails(self):
        response = self._response([
            {"groupId": "grp-optical", "parameters": []},
        ])
        ok, detail = assert_role_filtered_absence(
            response,
            absent_parameter_ids=[],
            absent_group_ids=["grp-optical"],
        )
        assert ok is False
        assert "grp-optical" in detail

    def test_empty_response_passes(self):
        ok, _ = assert_role_filtered_absence(
            {"data": {"groups": []}},
            absent_parameter_ids=["rx_power"],
            absent_group_ids=["grp-optical"],
        )
        assert ok is True


# ── assert_registry_consistency ──────────────────────────────────────────────

class TestAssertRegistryConsistency:
    def test_all_matching_passes(self):
        groups = [
            _group(params=[
                _param(registry_version="registry-fw-001", product_definition_id="pd-framework-router-v1"),
                _param(parameter_id="mem_util", registry_version="registry-fw-001", product_definition_id="pd-framework-router-v1"),
            ]),
        ]
        ok, detail = assert_registry_consistency(
            groups,
            expected_registry_version="registry-fw-001",
            expected_product_definition_id="pd-framework-router-v1",
        )
        assert ok is True
        assert "2" in detail

    def test_mismatched_registry_version_fails(self):
        groups = [
            _group(params=[
                _param(registry_version="registry-v999"),
            ]),
        ]
        ok, detail = assert_registry_consistency(
            groups,
            expected_registry_version="registry-fw-001",
            expected_product_definition_id="pd-framework-router-v1",
        )
        assert ok is False
        assert "registryVersion" in detail
        assert "registry-v999" in detail

    def test_mismatched_product_definition_fails(self):
        groups = [
            _group(params=[
                _param(product_definition_id="pd-wrong"),
            ]),
        ]
        ok, detail = assert_registry_consistency(
            groups,
            expected_registry_version="registry-fw-001",
            expected_product_definition_id="pd-framework-router-v1",
        )
        assert ok is False
        assert "productDefinitionId" in detail

    def test_empty_groups_fails(self):
        ok, detail = assert_registry_consistency(
            [],
            expected_registry_version="registry-fw-001",
            expected_product_definition_id="pd-framework-router-v1",
        )
        assert ok is False
        assert "no groups" in detail


# ── assert_no_credential_leak ─────────────────────────────────────────────────

class TestAssertNoCredentialLeak:
    @pytest.mark.parametrize("keyword", [
        "password", "secret", "token", "community", "privKey", "authKey",
        "privacy", "snmpv3", "credential",
    ])
    def test_each_forbidden_keyword_detected(self, keyword):
        ok, detail = assert_no_credential_leak(f"The {keyword} was invalid", label="test")
        assert ok is False
        assert "credential-like keyword" in detail

    @pytest.mark.parametrize("safe_text", [
        "management access was rejected — verify the vault reference configured for this device",
        "protocol read request timed out — device did not respond within the configured interval",
        "device did not respond",
        "adapter error: connection refused",
        "registry version mismatch",
    ])
    def test_safe_failure_reasons_pass(self, safe_text):
        ok, detail = assert_no_credential_leak(safe_text, label="failure_reason")
        assert ok is True, f"Safe text should pass: {safe_text!r}; detail={detail}"

    def test_empty_string_passes(self):
        ok, _ = assert_no_credential_leak("", label="empty_field")
        assert ok is True

    def test_case_insensitive_detection(self):
        ok, _ = assert_no_credential_leak("Invalid PASSWORD supplied", label="test")
        assert ok is False

    def test_groups_scan_clean(self):
        groups = [
            {"groupId": "grp-chassis", "parameters": [
                _param(failure_reason="device did not respond within interval"),
                _param(parameter_id="mem_util", failure_reason="connection refused by peer"),
            ]},
        ]
        ok, detail = assert_no_credential_leak_in_groups(groups)
        assert ok is True

    def test_groups_scan_detects_leak(self):
        groups = [
            {"groupId": "grp-chassis", "parameters": [
                _param(failure_reason="wrong password supplied"),
            ]},
        ]
        ok, detail = assert_no_credential_leak_in_groups(groups)
        assert ok is False
        assert "credential-like keyword" in detail


# ── evaluate_framework_assertion dispatch ─────────────────────────────────────

class TestEvaluateFrameworkAssertion:
    def test_freshness_state_dispatch(self):
        context = {"parameter": _param(freshness_state="FRESH")}
        assertion = {
            "type": "freshness_state",
            "parameter_context_key": "parameter",
            "expected_state": "FRESH",
        }
        ok, _ = evaluate_framework_assertion(assertion, context)
        assert ok is True

    def test_all_freshness_states_dispatch(self):
        context = {"groups": [_group(params=[_param(freshness_state="STALE")])]}
        assertion = {
            "type": "all_freshness_states",
            "groups_context_key": "groups",
            "expected_state": "STALE",
        }
        ok, _ = evaluate_framework_assertion(assertion, context)
        assert ok is True

    def test_threshold_alarm_dispatch(self):
        context = {"alarm": _alarm()}
        assertion = {
            "type": "threshold_alarm",
            "alarm_context_key": "alarm",
            "expected_condition": "HIGH",
            "expected_parameter_id": "cpu_load",
            "expected_device_id": "fw-dev-threshold-high-001",
        }
        ok, _ = evaluate_framework_assertion(assertion, context)
        assert ok is True

    def test_role_filtered_absence_dispatch(self):
        context = {
            "response": {"data": {"groups": [
                {"groupId": "grp-chassis", "parameters": [{"parameterId": "cpu_load"}]},
            ]}},
        }
        assertion = {
            "type": "role_filtered_absence",
            "response_context_key": "response",
            "absent_parameter_ids": ["rx_power"],
            "absent_group_ids": ["grp-optical"],
        }
        ok, _ = evaluate_framework_assertion(assertion, context)
        assert ok is True

    def test_registry_consistency_dispatch(self):
        context = {"groups": [_group(params=[_param()])]}
        assertion = {
            "type": "registry_consistency",
            "groups_context_key": "groups",
            "expected_registry_version": "registry-fw-001",
            "expected_product_definition_id": "pd-framework-router-v1",
        }
        ok, _ = evaluate_framework_assertion(assertion, context)
        assert ok is True

    def test_no_credential_leak_dispatch(self):
        context = {"text": "management access was rejected"}
        assertion = {
            "type": "no_credential_leak",
            "text_context_key": "text",
            "label": "test_field",
        }
        ok, _ = evaluate_framework_assertion(assertion, context)
        assert ok is True

    def test_no_credential_leak_dispatch_fails_on_keyword(self):
        context = {"text": "wrong password rejected"}
        assertion = {
            "type": "no_credential_leak",
            "text_context_key": "text",
        }
        ok, _ = evaluate_framework_assertion(assertion, context)
        assert ok is False

    def test_unknown_type_returns_false(self):
        ok, detail = evaluate_framework_assertion({"type": "magic_assert"}, {})
        assert ok is False
        assert "Unknown" in detail

    def test_missing_type_returns_false(self):
        ok, detail = evaluate_framework_assertion({}, {})
        assert ok is False
        assert "Unknown" in detail


# ── Profile-fixture identity alignment ────────────────────────────────────────

class TestProfileFixtureIdentityAlignment:
    """
    Ensure that device_ids referenced in scenario YAML match the device_id
    constants used in Python assertion fixtures. These tests act as a guard
    against identity drift between the simulator profile and test fixtures.
    """

    SCENARIO_DEVICE_IDS = {
        "successful":     "fw-dev-success-001",
        "stale":          "fw-dev-stale-001",
        "timeout":        "fw-dev-timeout-001",
        "authfail":       "fw-dev-authfail-001",
        "threshold_high": "fw-dev-threshold-high-001",
        "threshold_low":  "fw-dev-threshold-low-001",
    }

    def test_threshold_high_alarm_matches_scenario_device_id(self):
        alarm = _alarm(device_id=self.SCENARIO_DEVICE_IDS["threshold_high"])
        ok, _ = assert_threshold_alarm(
            alarm,
            expected_condition="HIGH",
            expected_parameter_id="cpu_load",
            expected_device_id=self.SCENARIO_DEVICE_IDS["threshold_high"],
        )
        assert ok is True

    def test_threshold_low_alarm_matches_scenario_device_id(self):
        alarm = _alarm(
            device_id=self.SCENARIO_DEVICE_IDS["threshold_low"],
            parameter_id="rx_power",
            condition="LOW",
            observed_value=-13.5,
            threshold_value=-10.0,
        )
        ok, _ = assert_threshold_alarm(
            alarm,
            expected_condition="LOW",
            expected_parameter_id="rx_power",
            expected_device_id=self.SCENARIO_DEVICE_IDS["threshold_low"],
        )
        assert ok is True

    def test_auth_failure_reason_does_not_contain_credential_keywords(self):
        """The fixture failure reason used in the auth-failure scenario must pass the redaction check."""
        reason = "management access was rejected — verify the vault reference configured for this device"
        ok, _ = assert_no_credential_leak(reason, label="auth_failure_reason")
        assert ok is True

    def test_timeout_failure_reason_does_not_contain_credential_keywords(self):
        reason = "protocol read request timed out — device did not respond within the configured interval"
        ok, _ = assert_no_credential_leak(reason, label="timeout_failure_reason")
        assert ok is True
