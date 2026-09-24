// Package failure — unit tests for guided failure taxonomy mapping (WO-011).
package failure

import (
	"strings"
	"testing"

	"github.com/airtel-ubrnms/discovery-service/internal/model"
)

// ── FromSNMPFingerprintResult ─────────────────────────────────────────────────

func TestFromSNMPFingerprintResult_Success_ReturnsNil(t *testing.T) {
	r := model.SNMPFingerprintResult{
		Status:      model.SNMPFingerprintSuccess,
		SysObjectID: ".1.3.6.1.4.1.9.1.2071",
	}
	if gf := FromSNMPFingerprintResult(r); gf != nil {
		t.Errorf("expected nil for success result, got %+v", gf)
	}
}

func TestFromSNMPFingerprintResult_AuthFailed(t *testing.T) {
	r := model.SNMPFingerprintResult{
		Status:          model.SNMPFingerprintAuthFailed,
		FailureCategory: model.FingerprintCategoryAuthFailed,
		CorrelationID:   "corr-auth",
	}
	gf := FromSNMPFingerprintResult(r)
	if gf == nil {
		t.Fatal("expected non-nil GuidedFailure")
	}
	if gf.Category != CategoryCredentialFailure {
		t.Errorf("expected CREDENTIAL_FAILURE, got %s", gf.Category)
	}
	if gf.Code != CodeSNMPAuthFailed {
		t.Errorf("expected SNMP_AUTH_FAILED code, got %s", gf.Code)
	}
	if !gf.Retryable {
		t.Error("expected Retryable=true for auth failure")
	}
	if gf.CorrelationID != "corr-auth" {
		t.Errorf("expected correlationId corr-auth, got %s", gf.CorrelationID)
	}
	// Verify no credential material in reason.
	if strings.Contains(gf.ExplicitReason, "community") || strings.Contains(gf.ExplicitReason, "password") {
		t.Error("credential material detected in ExplicitReason")
	}
}

func TestFromSNMPFingerprintResult_Timeout(t *testing.T) {
	r := model.SNMPFingerprintResult{
		Status:          model.SNMPFingerprintTimeout,
		FailureCategory: model.FingerprintCategoryTimeout,
	}
	gf := FromSNMPFingerprintResult(r)
	if gf == nil {
		t.Fatal("expected non-nil GuidedFailure")
	}
	if gf.Category != CategoryProtocolTimeout {
		t.Errorf("expected PROTOCOL_TIMEOUT, got %s", gf.Category)
	}
	if gf.Code != CodeSNMPTimeout {
		t.Errorf("expected SNMP_TIMEOUT code, got %s", gf.Code)
	}
	if !gf.Retryable {
		t.Error("expected Retryable=true for timeout")
	}
}

func TestFromSNMPFingerprintResult_MalformedOID(t *testing.T) {
	r := model.SNMPFingerprintResult{
		Status:          model.SNMPFingerprintMalformed,
		FailureCategory: model.FingerprintCategoryMalformedOID,
	}
	gf := FromSNMPFingerprintResult(r)
	if gf.Category != CategoryInternalError {
		t.Errorf("expected INTERNAL_ERROR, got %s", gf.Category)
	}
	if gf.Retryable {
		t.Error("expected Retryable=false for malformed OID")
	}
}

func TestFromSNMPFingerprintResult_MissingDescr(t *testing.T) {
	r := model.SNMPFingerprintResult{
		Status:          model.SNMPFingerprintPartial,
		FailureCategory: model.FingerprintCategoryMissingDescr,
	}
	gf := FromSNMPFingerprintResult(r)
	if gf.Category != CategoryUnknownFingerprint {
		t.Errorf("expected UNKNOWN_FINGERPRINT, got %s", gf.Category)
	}
}

func TestFromSNMPFingerprintResult_UnsupportedVersion(t *testing.T) {
	r := model.SNMPFingerprintResult{
		Status:          model.SNMPFingerprintFailed,
		FailureCategory: model.FingerprintCategoryUnsupportedVersion,
	}
	gf := FromSNMPFingerprintResult(r)
	if gf.Category != CategoryUnsupportedProtocol {
		t.Errorf("expected UNSUPPORTED_PROTOCOL, got %s", gf.Category)
	}
	if gf.Retryable {
		t.Error("expected Retryable=false for unsupported version")
	}
}

// ── FromDiscoveryHostResult ───────────────────────────────────────────────────

func TestFromDiscoveryHostResult_Healthy_ReturnsNil(t *testing.T) {
	r := model.DiscoveryHostResult{
		IP:                   "10.0.0.1",
		IcmpStatus:           "reachable",
		SnmpStatus:           "success",
		ClassificationStatus: "RECOGNISED",
		FingerprintStatus:    "MATCHED",
	}
	if gf := FromDiscoveryHostResult(r); gf != nil {
		t.Errorf("expected nil for healthy result, got %+v", gf)
	}
}

func TestFromDiscoveryHostResult_ICMPUnreachable(t *testing.T) {
	r := model.DiscoveryHostResult{
		IP:         "10.0.0.2",
		IcmpStatus: "unreachable",
		SnmpStatus: "not_attempted",
	}
	gf := FromDiscoveryHostResult(r)
	if gf == nil {
		t.Fatal("expected GuidedFailure for unreachable host")
	}
	if gf.Category != CategoryReachabilityFailure {
		t.Errorf("expected REACHABILITY_FAILURE, got %s", gf.Category)
	}
	if gf.LastAttemptedProtocol != "ICMP" {
		t.Errorf("expected lastAttemptedProtocol=ICMP, got %s", gf.LastAttemptedProtocol)
	}
	if gf.LastSuccessfulProtocolAttempt != "" {
		t.Errorf("expected empty lastSuccessfulProtocol for fully unreachable host, got %q", gf.LastSuccessfulProtocolAttempt)
	}
}

func TestFromDiscoveryHostResult_SNMPAuthFailed_LastSuccessIsICMP(t *testing.T) {
	r := model.DiscoveryHostResult{
		IP:                   "10.0.0.3",
		IcmpStatus:           "reachable",
		SnmpStatus:           "auth_failed",
		ClassificationStatus: "CLASSIFICATION_ERROR",
		CorrelationID:        "corr-snmp-auth",
	}
	gf := FromDiscoveryHostResult(r)
	if gf == nil {
		t.Fatal("expected GuidedFailure for auth failed")
	}
	if gf.Category != CategoryCredentialFailure {
		t.Errorf("expected CREDENTIAL_FAILURE, got %s", gf.Category)
	}
	if gf.LastSuccessfulProtocolAttempt != "ICMP" {
		t.Errorf("expected lastSuccessful=ICMP, got %q", gf.LastSuccessfulProtocolAttempt)
	}
	if gf.CorrelationID != "corr-snmp-auth" {
		t.Errorf("expected correlationId corr-snmp-auth, got %q", gf.CorrelationID)
	}
}

func TestFromDiscoveryHostResult_SNMPTimeout(t *testing.T) {
	r := model.DiscoveryHostResult{
		IP:         "10.0.0.4",
		IcmpStatus: "reachable",
		SnmpStatus: "timeout",
	}
	gf := FromDiscoveryHostResult(r)
	if gf.Category != CategoryProtocolTimeout {
		t.Errorf("expected PROTOCOL_TIMEOUT, got %s", gf.Category)
	}
	if !gf.Retryable {
		t.Error("expected Retryable=true for SNMP timeout")
	}
}

func TestFromDiscoveryHostResult_FingerprintConflict(t *testing.T) {
	r := model.DiscoveryHostResult{
		IP:                        "10.0.0.5",
		IcmpStatus:                "reachable",
		SnmpStatus:                "success",
		FingerprintStatus:         "CONFLICT",
		FingerprintConflictReason: "pd-a vs pd-b at confidence 0.75",
	}
	gf := FromDiscoveryHostResult(r)
	if gf.Category != CategoryConflictingFP {
		t.Errorf("expected CONFLICTING_FINGERPRINT, got %s", gf.Category)
	}
	if gf.Retryable {
		t.Error("expected Retryable=false for conflict")
	}
	if gf.RecommendedNextAction != ActionResolveConflict {
		t.Errorf("unexpected action: %s", gf.RecommendedNextAction)
	}
}

func TestFromDiscoveryHostResult_FingerprintVersionMismatch(t *testing.T) {
	r := model.DiscoveryHostResult{
		IP:                        "10.0.0.6",
		IcmpStatus:                "reachable",
		SnmpStatus:                "success",
		FingerprintStatus:         "VERSION_MISMATCH",
		FingerprintConflictReason: "firmware 14.9 outside range [15.0, 17.9]",
	}
	gf := FromDiscoveryHostResult(r)
	if gf.Category != CategoryUnknownFingerprint {
		t.Errorf("expected UNKNOWN_FINGERPRINT for version mismatch, got %s", gf.Category)
	}
	if gf.Code != CodeFirmwareMismatch {
		t.Errorf("expected FIRMWARE_RANGE_MISMATCH code, got %s", gf.Code)
	}
}

func TestFromDiscoveryHostResult_FingerprintUnknown(t *testing.T) {
	r := model.DiscoveryHostResult{
		IP:                "10.0.0.7",
		IcmpStatus:        "reachable",
		SnmpStatus:        "success",
		FingerprintStatus: "UNKNOWN",
	}
	gf := FromDiscoveryHostResult(r)
	if gf.Category != CategoryUnknownFingerprint {
		t.Errorf("expected UNKNOWN_FINGERPRINT, got %s", gf.Category)
	}
	if gf.RecommendedNextAction != ActionActivateDefinition {
		t.Errorf("unexpected action: %s", gf.RecommendedNextAction)
	}
}

func TestFromDiscoveryHostResult_RegistryUnavailable(t *testing.T) {
	r := model.DiscoveryHostResult{
		IP:                "10.0.0.8",
		IcmpStatus:        "reachable",
		SnmpStatus:        "success",
		FingerprintStatus: "REGISTRY_UNAVAILABLE",
	}
	gf := FromDiscoveryHostResult(r)
	if gf.Category != CategoryRegistryUnavailable {
		t.Errorf("expected REGISTRY_UNAVAILABLE, got %s", gf.Category)
	}
	if !gf.Retryable {
		t.Error("expected Retryable=true for registry unavailable")
	}
}

func TestFromDiscoveryHostResult_PartialSNMP(t *testing.T) {
	r := model.DiscoveryHostResult{
		IP:         "10.0.0.9",
		IcmpStatus: "reachable",
		SnmpStatus: "partial",
	}
	gf := FromDiscoveryHostResult(r)
	if gf == nil {
		t.Fatal("expected GuidedFailure for partial SNMP")
	}
	if gf.Category != CategoryUnknownFingerprint {
		t.Errorf("expected UNKNOWN_FINGERPRINT for partial SNMP, got %s", gf.Category)
	}
}

// ── IsRetryable ───────────────────────────────────────────────────────────────

func TestIsRetryable(t *testing.T) {
	cases := []struct {
		cat      Category
		expected bool
	}{
		{CategoryReachabilityFailure, true},
		{CategoryCredentialFailure, true},
		{CategoryProtocolTimeout, true},
		{CategoryRegistryUnavailable, true},
		{CategoryConflictingFP, false},
		{CategoryUnknownFingerprint, false},
		{CategoryInternalError, false},
	}
	for _, tc := range cases {
		got := IsRetryable(tc.cat)
		if got != tc.expected {
			t.Errorf("IsRetryable(%s) = %v, want %v", tc.cat, got, tc.expected)
		}
	}
}

// ── Credential redaction assertions ──────────────────────────────────────────

// TestNoCredentialMaterialInFailures verifies that none of the GuidedFailure
// fields produced by the taxonomy contain credential-like strings.
func TestNoCredentialMaterialInFailures(t *testing.T) {
	credentialKeywords := []string{"password", "secret", "token", "community", "apikey", "api_key", "private_key"}

	fingerPrintResults := []model.SNMPFingerprintResult{
		{Status: model.SNMPFingerprintAuthFailed, FailureCategory: model.FingerprintCategoryAuthFailed},
		{Status: model.SNMPFingerprintTimeout, FailureCategory: model.FingerprintCategoryTimeout},
		{Status: model.SNMPFingerprintMalformed, FailureCategory: model.FingerprintCategoryMalformedOID},
		{Status: model.SNMPFingerprintPartial, FailureCategory: model.FingerprintCategoryMissingDescr},
		{Status: model.SNMPFingerprintFailed, FailureCategory: model.FingerprintCategoryUnsupportedVersion},
	}

	for _, r := range fingerPrintResults {
		gf := FromSNMPFingerprintResult(r)
		if gf == nil {
			continue
		}
		checkField(t, "ExplicitReason", gf.ExplicitReason, credentialKeywords)
		checkField(t, "RecommendedNextAction", string(gf.RecommendedNextAction), credentialKeywords)
	}
}

func checkField(t *testing.T, fieldName, value string, forbidden []string) {
	t.Helper()
	lower := strings.ToLower(value)
	for _, kw := range forbidden {
		if strings.Contains(lower, kw) {
			t.Errorf("credential keyword %q found in %s: %q", kw, fieldName, value)
		}
	}
}
