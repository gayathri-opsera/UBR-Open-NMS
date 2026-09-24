// Package failure defines the guided discovery failure taxonomy for WO-011.
//
// Failures are first-class domain outcomes — not exceptions. Every failed or
// degraded discovery result gets a typed category, machine-readable code,
// human-readable reason, retryability flag, and recommended next action so
// NOC and support engineers can act without reading backend logs.
//
// Security: credential material must never appear in any exported field.
// All reason and action strings use generic descriptions that cannot leak
// community strings, passwords, or API tokens.
package failure

import (
	"fmt"
	"time"

	"github.com/airtel-ubrnms/discovery-service/internal/model"
)

// ── Taxonomy constants ────────────────────────────────────────────────────────

// Category is the top-level machine-readable failure class.
type Category string

const (
	CategoryReachabilityFailure  Category = "REACHABILITY_FAILURE"
	CategoryCredentialFailure    Category = "CREDENTIAL_FAILURE"
	CategoryProtocolTimeout      Category = "PROTOCOL_TIMEOUT"
	CategoryUnknownFingerprint   Category = "UNKNOWN_FINGERPRINT"
	CategoryConflictingFP        Category = "CONFLICTING_FINGERPRINT"
	CategoryRegistryUnavailable  Category = "REGISTRY_UNAVAILABLE"
	CategoryUnsupportedProtocol  Category = "UNSUPPORTED_PROTOCOL"
	CategoryAdapterHealthFailure Category = "ADAPTER_HEALTH_FAILURE"
	CategoryInternalError        Category = "INTERNAL_ERROR"
)

// Code provides a more specific sub-category code within a Category.
type Code string

const (
	CodeICMPUnreachable          Code = "ICMP_UNREACHABLE"
	CodeSNMPAuthFailed           Code = "SNMP_AUTH_FAILED"
	CodeSNMPTimeout              Code = "SNMP_TIMEOUT"
	CodeSSHAuthFailed            Code = "SSH_AUTH_FAILED"
	CodeSSHTimeout               Code = "SSH_TIMEOUT"
	CodeHTTPTimeout              Code = "HTTP_TIMEOUT"
	CodeGRPCUnavailable          Code = "GRPC_UNAVAILABLE"
	CodeOIDNotInScope            Code = "OID_NOT_IN_SCOPE"
	CodeFingerprintConflict      Code = "FINGERPRINT_CONFLICT"
	CodeFirmwareMismatch         Code = "FIRMWARE_RANGE_MISMATCH"
	CodeRegistryReadFailed       Code = "REGISTRY_READ_FAILED"
	CodeMalformedOID             Code = "MALFORMED_OID"
	CodeMissingDescr             Code = "MISSING_SYSDESCRR"
	CodeAdapterUnhealthy         Code = "ADAPTER_UNHEALTHY"
	CodeInternalError            Code = "INTERNAL_ERROR"
)

// ── Recommended next actions ──────────────────────────────────────────────────

// Action is a recommended operator action string shown in the UI.
type Action string

const (
	ActionCheckReachability  Action = "Verify device IP address, management-network routing, and firewall rules."
	ActionCheckCredentials   Action = "Verify the management credential reference in the credential vault for this device."
	ActionRetryLater         Action = "Retry the discovery run after confirming the device is responsive."
	ActionActivateDefinition Action = "Activate a matching Product Definition in the Product Definition manager."
	ActionResolveConflict    Action = "Resolve the conflicting Product Definitions in the framework registry before re-running discovery."
	ActionRefreshRegistry    Action = "Wait for the registry service to recover or manually trigger a registry refresh."
	ActionCheckProtocol      Action = "Verify that the management protocol is enabled and reachable on the target device."
	ActionContactSupport     Action = "Check backend logs with the correlationId and escalate if the issue persists."
)

// ── GuidedFailure type ────────────────────────────────────────────────────────

// GuidedFailure is the structured failure detail attached to a failed or degraded
// discovery result. It is designed to be rendered directly in the UI without
// requiring operators to read backend logs.
//
// Credential material MUST NEVER appear in any field of this struct.
type GuidedFailure struct {
	// Category is the top-level machine-readable failure class.
	Category Category `json:"category"`
	// Code is a specific sub-category code within Category.
	Code Code `json:"code"`
	// ExplicitReason is a human-readable, credential-free description of the failure.
	ExplicitReason string `json:"explicitReason"`
	// Retryable is true when submitting a new discovery run may resolve the issue.
	Retryable bool `json:"retryable"`
	// RetryAfter is the earliest UTC time the caller may retry, if known.
	// Nil means retry immediately.
	RetryAfter *time.Time `json:"retryAfter,omitempty"`
	// LastSuccessfulProtocolAttempt is the last protocol that produced usable evidence.
	// Empty string means no protocol has ever succeeded for this target.
	LastSuccessfulProtocolAttempt string `json:"lastSuccessfulProtocolAttempt,omitempty"`
	// LastAttemptedProtocol is the final protocol tried (failed or successful).
	LastAttemptedProtocol string `json:"lastAttemptedProtocol,omitempty"`
	// RecommendedNextAction is a human-readable guidance string for operators.
	RecommendedNextAction Action `json:"recommendedNextAction"`
	// CorrelationID links this failure record to the backend log for this operation.
	CorrelationID string `json:"correlationId,omitempty"`
}

// ── Taxonomy mapping ──────────────────────────────────────────────────────────

// FromSNMPFingerprintResult derives a GuidedFailure from an SNMP fingerprint result.
// Returns nil when the result was successful and no failure detail is needed.
func FromSNMPFingerprintResult(r model.SNMPFingerprintResult) *GuidedFailure {
	if r.Status == model.SNMPFingerprintSuccess {
		return nil
	}

	gf := &GuidedFailure{
		CorrelationID:         r.CorrelationID,
		LastAttemptedProtocol: "SNMP",
	}

	switch r.FailureCategory {
	case model.FingerprintCategoryAuthFailed:
		gf.Category = CategoryCredentialFailure
		gf.Code = CodeSNMPAuthFailed
		gf.ExplicitReason = "SNMP authentication failed — the configured credential was rejected or is absent."
		gf.Retryable = true
		gf.RecommendedNextAction = ActionCheckCredentials

	case model.FingerprintCategoryTimeout:
		gf.Category = CategoryProtocolTimeout
		gf.Code = CodeSNMPTimeout
		gf.ExplicitReason = "SNMP GET request timed out — the device did not respond within the configured timeout."
		gf.Retryable = true
		gf.RecommendedNextAction = ActionRetryLater

	case model.FingerprintCategoryMalformedOID:
		gf.Category = CategoryInternalError
		gf.Code = CodeMalformedOID
		gf.ExplicitReason = "The sysObjectID value returned by the device could not be parsed — the OID format is invalid."
		gf.Retryable = false
		gf.RecommendedNextAction = ActionContactSupport

	case model.FingerprintCategoryMissingDescr:
		gf.Category = CategoryUnknownFingerprint
		gf.Code = CodeMissingDescr
		gf.ExplicitReason = "The device responded to SNMP but did not return a sysDescr or sysObjectID — fingerprint evidence is insufficient."
		gf.Retryable = true
		gf.RecommendedNextAction = ActionCheckProtocol

	case model.FingerprintCategoryUnsupportedVersion:
		gf.Category = CategoryUnsupportedProtocol
		gf.Code = CodeMalformedOID
		gf.ExplicitReason = "The SNMP version configured for this target is not supported by the device."
		gf.Retryable = false
		gf.RecommendedNextAction = ActionCheckProtocol

	default:
		gf.Category = CategoryInternalError
		gf.Code = CodeInternalError
		gf.ExplicitReason = "SNMP fingerprinting failed due to an internal error — check backend logs for details."
		gf.Retryable = false
		gf.RecommendedNextAction = ActionContactSupport
	}

	return gf
}

// FromDiscoveryHostResult derives a GuidedFailure from a DiscoveryHostResult,
// considering both ICMP and SNMP statuses, classificationStatus, and any
// framework fingerprint status already attached by the matcher.
// Returns nil when no failure guidance is applicable.
func FromDiscoveryHostResult(r model.DiscoveryHostResult) *GuidedFailure {
	corrID := r.CorrelationID

	// ── ICMP unreachable ──────────────────────────────────────────────────────
	if r.IcmpStatus == "unreachable" {
		return &GuidedFailure{
			Category:              CategoryReachabilityFailure,
			Code:                  CodeICMPUnreachable,
			ExplicitReason:        "The host did not respond to ICMP ping — it may be down, unreachable, or ICMP-filtered.",
			Retryable:             true,
			LastAttemptedProtocol: "ICMP",
			RecommendedNextAction: ActionCheckReachability,
			CorrelationID:         corrID,
		}
	}

	// ── SNMP auth failure ─────────────────────────────────────────────────────
	if r.SnmpStatus == "auth_failed" {
		return &GuidedFailure{
			Category:                      CategoryCredentialFailure,
			Code:                          CodeSNMPAuthFailed,
			ExplicitReason:                "SNMP authentication failed — the credential was rejected or is not configured.",
			Retryable:                     true,
			LastSuccessfulProtocolAttempt: "ICMP",
			LastAttemptedProtocol:         "SNMP",
			RecommendedNextAction:         ActionCheckCredentials,
			CorrelationID:                 corrID,
		}
	}

	// ── SNMP timeout ──────────────────────────────────────────────────────────
	if r.SnmpStatus == "timeout" {
		return &GuidedFailure{
			Category:                      CategoryProtocolTimeout,
			Code:                          CodeSNMPTimeout,
			ExplicitReason:                "SNMP GET request timed out — the device did not respond within the configured timeout.",
			Retryable:                     true,
			LastSuccessfulProtocolAttempt: "ICMP",
			LastAttemptedProtocol:         "SNMP",
			RecommendedNextAction:         ActionRetryLater,
			CorrelationID:                 corrID,
		}
	}

	// ── Framework fingerprint statuses ────────────────────────────────────────
	switch r.FingerprintStatus {
	case "CONFLICT":
		return &GuidedFailure{
			Category:                      CategoryConflictingFP,
			Code:                          CodeFingerprintConflict,
			ExplicitReason:                fmt.Sprintf("Conflicting fingerprint matches: %s", r.FingerprintConflictReason),
			Retryable:                     false,
			LastSuccessfulProtocolAttempt: "SNMP",
			LastAttemptedProtocol:         "SNMP",
			RecommendedNextAction:         ActionResolveConflict,
			CorrelationID:                 corrID,
		}

	case "VERSION_MISMATCH":
		return &GuidedFailure{
			Category:                      CategoryUnknownFingerprint,
			Code:                          CodeFirmwareMismatch,
			ExplicitReason:                fmt.Sprintf("Firmware version mismatch: %s", r.FingerprintConflictReason),
			Retryable:                     false,
			LastSuccessfulProtocolAttempt: "SNMP",
			LastAttemptedProtocol:         "SNMP",
			RecommendedNextAction:         ActionActivateDefinition,
			CorrelationID:                 corrID,
		}

	case "UNKNOWN":
		return &GuidedFailure{
			Category:                      CategoryUnknownFingerprint,
			Code:                          CodeOIDNotInScope,
			ExplicitReason:                "No active Product Definition matched the device fingerprint evidence.",
			Retryable:                     false,
			LastSuccessfulProtocolAttempt: "SNMP",
			LastAttemptedProtocol:         "SNMP",
			RecommendedNextAction:         ActionActivateDefinition,
			CorrelationID:                 corrID,
		}

	case "REGISTRY_UNAVAILABLE":
		return &GuidedFailure{
			Category:                      CategoryRegistryUnavailable,
			Code:                          CodeRegistryReadFailed,
			ExplicitReason:                "The Product Definition registry was unavailable during fingerprint matching — probe evidence was recorded but not matched.",
			Retryable:                     true,
			LastSuccessfulProtocolAttempt: "SNMP",
			LastAttemptedProtocol:         "SNMP",
			RecommendedNextAction:         ActionRefreshRegistry,
			CorrelationID:                 corrID,
		}
	}

	// ── SNMP partial ──────────────────────────────────────────────────────────
	if r.SnmpStatus == "partial" {
		return &GuidedFailure{
			Category:                      CategoryUnknownFingerprint,
			Code:                          CodeMissingDescr,
			ExplicitReason:                "SNMP returned partial evidence (sysDescr present but no sysObjectID) — fingerprint is incomplete.",
			Retryable:                     true,
			LastSuccessfulProtocolAttempt: "ICMP",
			LastAttemptedProtocol:         "SNMP",
			RecommendedNextAction:         ActionCheckProtocol,
			CorrelationID:                 corrID,
		}
	}

	// No failure guidance needed for this result.
	return nil
}

// IsRetryable returns true for failure categories that may resolve on a retry attempt.
func IsRetryable(cat Category) bool {
	switch cat {
	case CategoryReachabilityFailure,
		CategoryCredentialFailure,
		CategoryProtocolTimeout,
		CategoryRegistryUnavailable:
		return true
	}
	return false
}
