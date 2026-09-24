// Package spal implements the read-only Southbound Protocol Abstraction Layer (WO-009).
//
// The SPAL provides a common DeviceClient contract for SNMP, CLI (SSH/Telnet),
// REST, and gRPC read operations. All protocol differences are hidden behind the
// DeviceClient interface so callers (discovery, poller) do not depend on vendor
// SDKs or transport specifics.
//
// Security constraints:
//   - Credentials are accessed only via CredentialResolver; secret values are
//     never returned to callers, logged, or included in error messages.
//   - REST and gRPC adapters validate target addresses against an allowlist before
//     making outbound requests (SSRF protection).
//   - Write, set, subscribe, and provision operations are explicitly disabled.
package spal

import (
	"context"
	"fmt"
	"time"
)

// ── Core types ────────────────────────────────────────────────────────────────

// Protocol identifies the transport used by a southbound adapter.
type Protocol string

const (
	ProtocolSNMP    Protocol = "SNMP"
	ProtocolSSH     Protocol = "SSH"
	ProtocolTelnet  Protocol = "TELNET"
	ProtocolREST    Protocol = "REST"
	ProtocolGRPC    Protocol = "GRPC"
	ProtocolUnknown Protocol = "UNKNOWN"
)

// AdapterFailureCategory classifies why an adapter operation failed.
type AdapterFailureCategory string

const (
	FailureCategoryAuthFailed          AdapterFailureCategory = "AUTH_FAILED"
	FailureCategoryTimeout             AdapterFailureCategory = "TIMEOUT"
	FailureCategoryUnreachable         AdapterFailureCategory = "UNREACHABLE"
	FailureCategoryParseError          AdapterFailureCategory = "PARSE_ERROR"
	FailureCategoryUnsupportedParam    AdapterFailureCategory = "UNSUPPORTED_PARAMETER"
	FailureCategorySSRFBlocked         AdapterFailureCategory = "SSRF_BLOCKED"
	FailureCategoryReadOnly            AdapterFailureCategory = "READ_ONLY_ENFORCED"
	FailureCategoryCredentialResolution AdapterFailureCategory = "CREDENTIAL_RESOLUTION_FAILED"
	FailureCategoryInternal            AdapterFailureCategory = "INTERNAL_ERROR"
)

// ParamRef identifies a parameter to be read from a device.
// OID is used for SNMP, CLICommand for CLI, JSONPath/URLPath for REST,
// and FieldPath for gRPC. At least one selector must be non-empty.
type ParamRef struct {
	// ParameterID is the registry-assigned parameter identifier.
	ParameterID string
	// OID is the SNMP object identifier (e.g. ".1.3.6.1.2.1.1.1.0").
	OID string
	// CLICommand is the CLI command to run and parse (e.g. "show version").
	CLICommand string
	// CLIParseRegex is the named-group regex applied to CLI output.
	// Groups are mapped to parameter values.
	CLIParseRegex string
	// URLPath is the REST endpoint path relative to the device base URL.
	URLPath string
	// JSONPath is the JSON field extraction path for REST responses (dot notation).
	JSONPath string
	// GRPCFieldPath is the protobuf field path for gRPC responses (dot notation).
	GRPCFieldPath string
}

// ReadValue holds the normalized result of a parameter read operation.
// Credential values are never present in any field.
type ReadValue struct {
	// ParameterID matches the ParamRef that produced this value.
	ParameterID string
	// Value is the string representation of the parameter value.
	Value string
	// ValueNumeric is set when Value can be interpreted as a float64.
	// Zero value means not applicable (string-only parameters).
	ValueNumeric float64
	// NumericValid is true when ValueNumeric was successfully parsed.
	NumericValid bool
	// SourceProtocol is the protocol that produced this value.
	SourceProtocol Protocol
	// ObservedAt is the UTC timestamp when the value was read from the device.
	ObservedAt time.Time
	// LatencyMs is the round-trip time in milliseconds.
	LatencyMs int64
	// AdapterVersion identifies the adapter implementation version.
	AdapterVersion string
}

// AdapterHealth describes the current health of one adapter instance.
type AdapterHealth struct {
	// Protocol is the adapter's transport protocol.
	Protocol Protocol
	// Healthy is true when the adapter passed its last health check.
	Healthy bool
	// LatencyMs is the latency of the last health check (ping) in milliseconds.
	LatencyMs int64
	// CheckedAt is the UTC timestamp of the last health check.
	CheckedAt time.Time
	// FailureCategory is set when Healthy is false.
	FailureCategory AdapterFailureCategory
	// FailureReason is a human-readable description (no credential values).
	FailureReason string
}

// AdapterFailure describes a single parameter read failure.
type AdapterFailure struct {
	// ParameterID is the registry identifier of the parameter that failed.
	ParameterID string
	// Protocol is the adapter that attempted the read.
	Protocol Protocol
	// FailureCategory is the machine-readable failure classification.
	FailureCategory AdapterFailureCategory
	// FailureReason is a human-readable description (no credential values).
	FailureReason string
	// Retryable is true when a retry attempt might succeed.
	Retryable bool
}

// DeviceContext carries all the context needed by an adapter to connect to a device.
// Credential values are never included — only opaque references.
type DeviceContext struct {
	// DeviceID is the inventory device identifier.
	DeviceID string
	// IPAddress is the management IP address of the device.
	IPAddress string
	// ProductDefinitionID is the identifier of the matched Product Definition.
	ProductDefinitionID string
	// PreferredProtocol is the primary protocol from the Product Definition.
	PreferredProtocol Protocol
	// SupportedProtocols is the fallback list in preference order.
	SupportedProtocols []Protocol
	// CredentialRef is the opaque credential reference from the credential vault.
	// Adapters pass this to CredentialResolver — the actual secret is never stored here.
	CredentialRef string
	// CorrelationID for end-to-end tracing.
	CorrelationID string
	// BaseURL is required for REST adapters (e.g. "https://10.0.0.1:443").
	// Must be on the managed-device allow-list.
	BaseURL string
	// GRPCEndpoint is required for gRPC adapters (e.g. "10.0.0.1:50051").
	GRPCEndpoint string
	// ManagementNetworkAllowList is the IP/CIDR list of allowed management targets.
	// REST and gRPC adapters reject requests to addresses not in this list (SSRF guard).
	ManagementNetworkAllowList []string
}

// PingResult holds the outcome of a device reachability + health check.
type PingResult struct {
	// Reachable is true when the adapter was able to connect to the device.
	Reachable bool
	// Protocol is the adapter that performed the health check.
	Protocol Protocol
	// LatencyMs is the round-trip time in milliseconds.
	LatencyMs int64
	// FailureCategory is set when Reachable is false.
	FailureCategory AdapterFailureCategory
	// FailureReason is a human-readable description (no credential values).
	FailureReason string
}

// GetResult holds normalized values and failures from a batch parameter read.
type GetResult struct {
	// Values contains successfully read parameter values.
	Values []ReadValue
	// Failures contains parameters that could not be read.
	Failures []AdapterFailure
	// ActiveProtocol is the protocol used for this get operation.
	ActiveProtocol Protocol
	// ObservedAt is the UTC timestamp of the read batch.
	ObservedAt time.Time
	// LatencyMs is the total latency for this get operation.
	LatencyMs int64
}

// ── Interfaces ────────────────────────────────────────────────────────────────

// DeviceClient is the read-only southbound contract.
// Callers must not assume any write capability exists.
type DeviceClient interface {
	// Ping checks device reachability and adapter health.
	// Returns a PingResult describing reachability, latency, and failure details.
	Ping(ctx context.Context, device DeviceContext) PingResult

	// Get reads one or more parameters from the device.
	// Returns normalized ReadValues and any per-parameter AdapterFailures.
	// Credential material is never included in the response.
	Get(ctx context.Context, device DeviceContext, params []ParamRef) GetResult

	// Protocol returns the adapter's primary protocol.
	Protocol() Protocol

	// AdapterVersion returns a string identifying this adapter implementation.
	AdapterVersion() string
}

// ResolvedCredential holds the runtime secret fields for one credential reference.
// Secret values must never be logged, stored to disk, or included in API responses.
type ResolvedCredential struct {
	// Username is the device user — used by CLI and gRPC adapters.
	Username string
	// Password holds the plaintext secret (community string, password, or API token).
	// Never log or marshal this field.
	Password string
	// PrivateKey holds a PEM-encoded SSH private key for key-based auth.
	// Password is the passphrase when the key is encrypted.
	PrivateKey string
}

// CredentialResolver resolves opaque credential references to runtime secrets.
// The resolved credential is passed to the adapter SDK and must never be stored or logged.
type CredentialResolver interface {
	// Resolve returns the runtime credential for a given credential reference.
	// The credential fields are passed directly to the protocol SDK and must never
	// appear in northbound responses, logs, audit records, or error messages.
	// Returns (ResolvedCredential, nil) on success; (zero, error) on resolution failure.
	Resolve(ctx context.Context, credentialRef string) (ResolvedCredential, error)
}

// ParameterRegistryResolver resolves product parameter metadata by parameterId.
// Adapters use this to find OIDs, CLI commands, REST paths, and gRPC fields.
type ParameterRegistryResolver interface {
	// ResolveParam returns the ParamRef metadata for a given parameterId.
	// Returns (ParamRef, nil) when found; (ParamRef{}, error) when not found or
	// when the registry is temporarily unavailable.
	ResolveParam(ctx context.Context, productDefinitionID, parameterID string) (ParamRef, error)
}

// ── ErrReadOnly ───────────────────────────────────────────────────────────────

// ErrReadOnly is returned when a caller attempts a write, set, subscribe, or
// provision operation through the read-only P0 southbound runtime.
// This error is intentional — write operations are explicitly out of scope
// for the first release. See constraints in WO-009.
type ErrReadOnly struct {
	Operation string
	Protocol  Protocol
}

func (e ErrReadOnly) Error() string {
	return fmt.Sprintf("southbound operation %q is not permitted: read-only runtime (protocol=%s)", e.Operation, e.Protocol)
}

// NewReadOnlyError constructs a typed read-only enforcement error.
func NewReadOnlyError(operation string, protocol Protocol) ErrReadOnly {
	return ErrReadOnly{Operation: operation, Protocol: protocol}
}

// ErrCredentialResolution is returned when a credential reference cannot be resolved.
// The original resolution error is wrapped so callers can choose to retry or surface
// guided failure details without exposing the failed secret reference.
type ErrCredentialResolution struct {
	CredentialRef string // opaque reference — never the secret value
	Cause         error
}

func (e ErrCredentialResolution) Error() string {
	return fmt.Sprintf("credential resolution failed for ref=%s: %v", e.CredentialRef, e.Cause)
}
func (e ErrCredentialResolution) Unwrap() error { return e.Cause }
