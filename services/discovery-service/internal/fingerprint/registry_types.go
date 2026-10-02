// Package fingerprint implements product-definition fingerprint matching for WO-010.
//
// Registry entries read from the Product Definition registry describe how to
// identify specific vendor-model-firmware combinations from discovery probe evidence.
// The matcher resolves probe evidence into a deterministic product identity or
// returns a safe conflict/unknown outcome when matching is ambiguous.
//
// Security: fingerprint evidence never contains credential material. Failures are
// safe domain outcomes, not exceptions — conflict and unknown are valid results.
package fingerprint

import "time"

// ── Registry entry types ──────────────────────────────────────────────────────

// RegistryEntry is one active fingerprint entry from the Product Definition registry.
// Multiple entries can exist for a single product (one per firmware range or OID variant).
type RegistryEntry struct {
	// RegistryEntryID uniquely identifies this fingerprint rule.
	RegistryEntryID string
	// ProductDefinitionID links to the Product Definition this entry matches.
	ProductDefinitionID string
	// ProductDefinitionVersion is the version of the PD this entry was built for.
	ProductDefinitionVersion string
	// RegistryVersion is the generation counter for the registry snapshot.
	RegistryVersion string

	// ── Fingerprint selectors ─────────────────────────────────────────────────

	// SNMPOIDExact matches sysObjectID when it equals this value exactly.
	// Leading dot is normalised before comparison.
	SNMPOIDExact string
	// SNMPOIDPrefix matches sysObjectID when it has this prefix.
	// Use when a product family shares an OID subtree.
	SNMPOIDPrefix string

	// SSHBannerSubstring matches when the SSH banner contains this substring (case-insensitive).
	SSHBannerSubstring string

	// HTTPHeaderKey and HTTPHeaderContains match when the named HTTP response header
	// contains the expected substring (case-insensitive).
	HTTPHeaderKey      string
	HTTPHeaderContains string

	// HTTPBodyContains matches when the HTTP response body contains this substring.
	HTTPBodyContains string

	// GRPCServiceExact matches when the gRPC LISTING response contains this service name exactly.
	GRPCServiceExact string

	// ── Firmware range ────────────────────────────────────────────────────────

	// FirmwareMin is the minimum acceptable firmware version string (inclusive, semver-comparable).
	// Empty means no lower bound.
	FirmwareMin string
	// FirmwareMax is the maximum acceptable firmware version string (inclusive).
	// Empty means no upper bound.
	FirmwareMax string

	// ── Protocol preference ───────────────────────────────────────────────────

	// PreferredProtocol is the protocol the adapter selector should prefer for this product.
	PreferredProtocol string
	// SupportedProtocols is the ordered fallback list.
	SupportedProtocols []string

	// DeviceType is the semantic device category from the product definition
	// (e.g. SWITCH, ROUTER, RADIO). Used to populate genericDeviceType in inventory.
	DeviceType string

	// Vendor is the manufacturer name from the product definition (e.g. "Acme Networks").
	// Populated from the FingerprintRegistryEntry via the internal registry wire format.
	Vendor string

	// Model is the device model name from the product definition (e.g. "AcmeRouter-X9000").
	Model string

	// Metadata
	CreatedAt time.Time
}

// ── Evidence types ────────────────────────────────────────────────────────────

// ProbeEvidence holds the credential-free evidence collected by the probe orchestrator.
// The matcher only uses these fields — it has no access to credential material.
type ProbeEvidence struct {
	// IP is the management address of the discovered device.
	IP string
	// RunID links the evidence back to the originating discovery run.
	RunID string
	// CorrelationID for end-to-end tracing.
	CorrelationID string
	// FirmwareVersion is extracted from SNMP sysDescr parsing, SSH banner, or HTTP header.
	// Empty when firmware is not determinable from available evidence.
	FirmwareVersion string

	// SNMP evidence (from sysObjectID and sysDescr GET).
	SNMPOIDSysObjectID string
	SNMPSysDescr       string

	// SSH evidence (from banner exchange, NOT from credentials).
	SSHBanner string

	// HTTP evidence (from probe response headers and body, not auth challenge).
	HTTPResponseHeaders map[string]string
	HTTPResponseBody    string

	// gRPC evidence (service names from ListServices reflection).
	GRPCServices []string
}

// ── Match result types ────────────────────────────────────────────────────────

// FingerprintStatus is the classification outcome of a match attempt.
type FingerprintStatus string

const (
	// FingerprintStatusMatched means exactly one active registry entry matched all evidence.
	FingerprintStatusMatched FingerprintStatus = "MATCHED"
	// FingerprintStatusUnknown means no registry entry matched any evidence.
	FingerprintStatusUnknown FingerprintStatus = "UNKNOWN"
	// FingerprintStatusConflict means two or more entries matched the same evidence
	// at equal confidence. No inventory mutation is permitted in this state.
	FingerprintStatusConflict FingerprintStatus = "CONFLICT"
	// FingerprintStatusVersionMismatch means a product OID matched but the firmware
	// version falls outside the definition's acceptable range.
	FingerprintStatusVersionMismatch FingerprintStatus = "VERSION_MISMATCH"
	// FingerprintStatusRegistryUnavailable means the registry could not be read.
	// Probe evidence was recorded but no matching was attempted. Safe to retry.
	FingerprintStatusRegistryUnavailable FingerprintStatus = "REGISTRY_UNAVAILABLE"
)

// MatchResult is the deterministic outcome of matching probe evidence against the registry.
// A nil MatchResult means the matcher was not invoked (pre-existing behaviour is preserved).
type MatchResult struct {
	// Status is always set.
	Status FingerprintStatus

	// ── Set when Status == MATCHED ────────────────────────────────────────────

	// ProductDefinitionID is the matched Product Definition identifier.
	ProductDefinitionID string
	// ProductDefinitionVersion is the version that produced the match.
	ProductDefinitionVersion string
	// RegistryVersion is the registry snapshot version used for this match.
	RegistryVersion string
	// ActiveAdapterCandidate is the preferred protocol for this product.
	ActiveAdapterCandidate string
	// FirmwareVersion is the observed firmware version (from evidence), may be empty.
	FirmwareVersion string
	// MatchConfidence is a float in [0,1] — higher means stronger evidence.
	MatchConfidence float64
	// MatchEvidence is a human-readable, credential-free summary of the matched selector.
	MatchEvidence string
	// DeviceType is the semantic category resolved from the matched registry entry (e.g. SWITCH).
	DeviceType string
	// Vendor is the manufacturer name from the matched registry entry (e.g. "Acme Networks").
	Vendor string
	// Model is the device model name from the matched registry entry (e.g. "AcmeRouter-X9000").
	Model string

	// ── Set when Status == CONFLICT ───────────────────────────────────────────

	// ConflictReason describes which entries conflicted.
	ConflictReason string
	// ConflictCandidates lists the ProductDefinitionIDs that tied.
	ConflictCandidates []string

	// ── Set when Status == VERSION_MISMATCH ──────────────────────────────────

	// VersionMismatchEntry is the PD ID that matched but failed firmware range check.
	VersionMismatchEntry string
}
