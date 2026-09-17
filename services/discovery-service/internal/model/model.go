// Package model defines the Discovery Service domain types.
package model

import (
	"time"
)

// CheckInRequest is the full UBR device periodic check-in payload (WO-021).
// All optional commissioning fields (GPS, azimuth) are recorded as pending when absent.
type CheckInRequest struct {
	SerialNumber        string    `json:"serialNumber"`
	MACAddress          string    `json:"macAddress"`
	IPAddress           string    `json:"ipAddress"`
	DeviceType          string    `json:"deviceType"`
	FirmwareVersion     string    `json:"firmwareVersion,omitempty"`
	SoftwareVersion     string    `json:"softwareVersion"`
	OperationalStatus   string    `json:"operationalStatus,omitempty"`  // UP, DOWN, DEGRADED
	Latitude            float64   `json:"latitude,omitempty"`
	Longitude           float64   `json:"longitude,omitempty"`
	Azimuth             float64   `json:"azimuth,omitempty"`
	UptimeSeconds       int64     `json:"uptimeSeconds"`
	CapabilityProfileID string    `json:"capabilityProfileId,omitempty"`
	ConfigVersion       string    `json:"configVersion,omitempty"`
	Tags                []string  `json:"tags,omitempty"`
	Timestamp           time.Time `json:"timestamp"`
	Signature           string    `json:"signature"` // HMAC-SHA256 hex of canonical request body
}

// CheckInResponse is the response returned to the device after a successful check-in (WO-021).
type CheckInResponse struct {
	Result              string `json:"result"`         // "accepted"
	DeviceID            string `json:"deviceId"`
	CurrentConfigVersion string `json:"currentConfigVersion,omitempty"`
	ConfigAction        string `json:"configAction"`   // NO_CHANGE | CONFIG_AVAILABLE | ASSIGNMENT_REQUIRED
	PendingCommand      *string `json:"pendingCommand,omitempty"`
	CheckInIntervalSecs int    `json:"checkInIntervalSecs"`
	EventID             string `json:"eventId"`
	RetryAfterSecs      int    `json:"retryAfterSecs,omitempty"` // present when CONFIG_AVAILABLE requires retry
}

// BootstrapState constants for the UBR device onboarding state machine.
const (
	BootstrapStatePending          = "PENDING"
	BootstrapStateCheckInReceived  = "CHECK_IN_RECEIVED"
	BootstrapStateRealtimeEstablished = "REALTIME_ESTABLISHED"
	BootstrapStateOnline           = "ONLINE"
	BootstrapStateOffline          = "OFFLINE"
)

// SupportedDeviceTypes is the allowlist for UBR call-home check-in (WO-021).
// Devices with other types must be rejected at the application layer.
var SupportedDeviceTypes = map[string]bool{
	"BTS": true,
	"CPE": true,
	"IDU": true,
}

// DiscoveredDevice is the enriched device payload published to Kafka.
type DiscoveredDevice struct {
	EventID         string    `json:"eventId"`
	SerialNumber    string    `json:"serialNumber"`
	MACAddress      string    `json:"macAddress"`
	IPAddress       string    `json:"ipAddress"`
	DeviceType      string    `json:"deviceType"`
	SoftwareVersion string    `json:"softwareVersion"`
	Latitude        float64   `json:"latitude"`
	Longitude       float64   `json:"longitude"`
	Azimuth         float64   `json:"azimuth"`
	UptimeSeconds   int64     `json:"uptimeSeconds"`
	DiscoveredAt    time.Time `json:"discoveredAt"`
	CheckInInterval int       `json:"checkInIntervalSeconds"`

	// WO-026: onboarding state tracking fields — populated by check-in processor.
	BootstrapState    string     `json:"bootstrapState,omitempty"`
	OperationalStatus string     `json:"operationalStatus,omitempty"`
	LastCheckInAt     *time.Time `json:"lastCheckInAt,omitempty"`
	LastRealtimeAt    *time.Time `json:"lastRealtimeAt,omitempty"`
	FailureReason     string     `json:"failureReason,omitempty"`
}

// Alarm represents a raw alarm event for the alarms Kafka topic.
type Alarm struct {
	EventID   string    `json:"eventId"`
	AlarmType string    `json:"alarmType"`
	Severity  string    `json:"severity"`
	Source    string    `json:"source"`
	Message   string    `json:"message"`
	Timestamp time.Time `json:"timestamp"`
}

// ScanRequest is the body for triggering an SNMP/ICMP network scan.
type ScanRequest struct {
	IPRange string `json:"ipRange"`
	SNMP    bool   `json:"snmp"`
	ICMP    bool   `json:"icmp"`
}

// KVEntry is a Consul-style service registry entry (WO-009).
// Returned by GET /discovery/v1/kv/services?recurse=1 for UBR call-home devices.
type KVEntry struct {
	LockIndex   int    `json:"LockIndex"`
	Key         string `json:"Key"`
	Flags       int    `json:"Flags"`
	Value       string `json:"Value"`       // base64-encoded ServiceMetadata JSON
	CreateIndex int    `json:"CreateIndex"`
	ModifyIndex int    `json:"ModifyIndex"`
}

// ServiceMetadata is the decoded Value payload for each service in the registry.
type ServiceMetadata struct {
	Scheme   string `json:"scheme"`           // "http" or "https"
	Address  string `json:"address"`          // "hostname:port" or IPv6 literal
	AuthPath string `json:"auth_path,omitempty"`     // for services/auth
	CheckinPath string `json:"checkin_path,omitempty"` // for services/checkin
	EventPath string `json:"event_path,omitempty"`   // for services/event
	WSPath   string `json:"ws_path,omitempty"`      // for services/realtime
}

// ── WO-010: Device authentication models ────────────────────────────────────

// DeviceAuthRequest is the payload for POST /auth/v1/device (WO-010).
// UBR devices use this to obtain a unique per-device HMAC secret for call-home requests.
type DeviceAuthRequest struct {
	SerialNumber    string `json:"serialNumber"`
	MACAddress      string `json:"macAddress"`
	DeviceType      string `json:"deviceType"`
	FirmwareVersion string `json:"firmwareVersion,omitempty"`
}

// DeviceAuthResponse is the successful authentication response (WO-010).
// The Secret field contains the per-device HMAC key and must never be logged.
type DeviceAuthResponse struct {
	DeviceID    string    `json:"deviceId"`
	SerialNumber string   `json:"serialNumber"`
	MACAddress   string   `json:"macAddress"`
	Secret       string   `json:"secret"`       // HMAC signing secret — NEVER log this value
	IssuedAt     time.Time `json:"issuedAt"`
	ExpiresAt    *time.Time `json:"expiresAt,omitempty"` // nil if no expiration
	KeyVersion   int       `json:"keyVersion"`
}

// DeviceSecret represents the per-device authentication secret metadata (WO-010).
// Stored in SecretStore to track secret lifecycle and invalidation state.
type DeviceSecret struct {
	DeviceID        string
	SerialNumber    string
	MACAddress      string
	SecretValue     string    // HMAC secret — NEVER log this value
	KeyVersion      int
	IssuedAt        time.Time
	InvalidatedAt   *time.Time
	InvalidatedReason string
	Active          bool
}

// ── WO-011: Generic discovery scope intake models ────────────────────────────

// ScopeEntry represents a single discovery target (CIDR, IP, or seed device).
type ScopeEntry struct {
	Type            string   `json:"type"`                      // "CIDR", "IP", or "SEED"
	Value           string   `json:"value"`                     // e.g., "192.168.1.0/24", "10.0.0.1", "device.example.com"
	Label           string   `json:"label,omitempty"`           // Optional user-provided label
	ManagementPorts []int    `json:"managementPorts,omitempty"` // Optional custom ports
	Tags            []string `json:"tags,omitempty"`            // Optional tags
}

// DiscoveryRunRequest is the request payload for POST /api/v1/discovery/runs (WO-011, WO-027, WO-008).
type DiscoveryRunRequest struct {
	Scope          []ScopeEntry `json:"scope"`
	Protocol       string       `json:"protocol,omitempty"`       // SNMP_V1, SNMP_V2C
	CredentialID   string       `json:"credentialId,omitempty"` // stored credential reference
	Community      string       `json:"community,omitempty"`      // ephemeral v1/v2c community (never persisted)
	TimeoutSeconds int          `json:"timeoutSeconds,omitempty"`
	Retries        int          `json:"retries,omitempty"`
	// WO-008: trigger mode and correlation identifier for multi-mode deterministic probing.
	// TriggerMode defaults to MANUAL when absent.
	TriggerMode   TriggerMode  `json:"triggerMode,omitempty"`
	CorrelationID string       `json:"correlationId,omitempty"`
}

// DiscoveryRunResponse is the successful response for creating a discovery run (WO-011).
type DiscoveryRunResponse struct {
	RunID              string         `json:"runId"`
	Status             string         `json:"status"`              // "CREATED" or "QUEUED"
	NormalizedScope    []ScopeEntry   `json:"normalizedScope"`
	CreatedBy          string         `json:"createdBy"`
	CreatedAt          time.Time      `json:"createdAt"`
	ValidationSummary  string         `json:"validationSummary"`
}

// ValidationError represents field-level validation errors (WO-011).
type ValidationError struct {
	Field   string `json:"field"`
	Message string `json:"message"`
}

// ScopeValidationError is returned for invalid scope requests (WO-011).
type ScopeValidationError struct {
	Status      string            `json:"status"`
	Reason      string            `json:"reason"`
	Message     string            `json:"message"`
	FieldErrors []ValidationError `json:"fieldErrors,omitempty"`
}

// SweepProgress tracks ICMP sweep progress for a discovery run (WO-016).
type SweepProgress struct {
	TotalHosts       int        `json:"totalHosts"`
	HostsScanned     int        `json:"hostsScanned"`
	ReachableHosts   int        `json:"reachableHosts"`
	SweepStartedAt   *time.Time `json:"sweepStartedAt,omitempty"`
	SweepCompletedAt *time.Time `json:"sweepCompletedAt,omitempty"`
	SweepDurationMs  int64      `json:"sweepDurationMs,omitempty"`
	WorkerCount      int        `json:"workerCount,omitempty"`
}

// DiscoveryHostResult is the per-host API result returned to the UI (WO-001, WO-016).
type DiscoveryHostResult struct {
	IP                   string `json:"ip"`
	IcmpStatus           string `json:"icmpStatus"`
	SnmpStatus           string `json:"snmpStatus"`
	Vendor               string `json:"vendor,omitempty"`
	Model                string `json:"model,omitempty"`
	GenericDeviceType    string `json:"genericDeviceType,omitempty"`
	SysObjectID          string `json:"sysObjectID,omitempty"`
	SysDescr             string `json:"sysDescr,omitempty"`
	SysName              string `json:"sysName,omitempty"`
	SysContact           string `json:"sysContact,omitempty"`
	SysLocation          string `json:"sysLocation,omitempty"`
	SysUpTimeSeconds     int64  `json:"sysUpTimeSeconds,omitempty"`
	ClassificationStatus string `json:"classificationStatus"`
	DeferReason          string `json:"deferReason,omitempty"`
	CorrelationID        string `json:"correlationId,omitempty"`
	// MACAddress is the chassis MAC address retrieved via ifPhysAddress (IF-MIB) walk.
	// Empty string when the device doesn't expose the IF-MIB or when only scalar GETs
	// were attempted (e.g. community string restricted to MIB-II scalars only).
	MACAddress           string `json:"macAddress,omitempty"`

	// ── WO-011: Guided failure detail (nil when result is not failed/degraded) ─
	// GuidedFailure is populated for any failed, auth-failed, timeout, partial,
	// or degraded host result. It provides machine-readable category, operator
	// guidance, retryability, and last successful protocol without credential material.
	// Nil for healthy MATCHED results.
	GuidedFailure *GuidedFailure `json:"guidedFailure,omitempty"`

	// ── WO-010: Framework identity fields (additive, nullable) ────────────────
	// These fields are populated by the FingerprintMatcher after probe evidence is
	// matched against the active Product Definition registry. They are never written
	// by UBR call-home and must not overwrite authoritative identity fields.

	// ProductDefinitionID is the matched Product Definition identifier.
	// Nil/empty when the device is UNKNOWN, CONFLICT, or registry is unavailable.
	ProductDefinitionID string `json:"productDefinitionId,omitempty"`
	// ProductDefinitionVersion is the PD version that produced the match.
	ProductDefinitionVersion string `json:"productDefinitionVersion,omitempty"`
	// RegistryVersion identifies the fingerprint registry snapshot used for matching.
	RegistryVersion string `json:"registryVersion,omitempty"`
	// ActiveAdapterCandidate is the preferred protocol for this product (e.g. SNMP, SSH).
	ActiveAdapterCandidate string `json:"activeAdapterCandidate,omitempty"`
	// FingerprintStatus is the matching outcome: MATCHED, UNKNOWN, CONFLICT,
	// VERSION_MISMATCH, or REGISTRY_UNAVAILABLE.
	FingerprintStatus string `json:"fingerprintStatus,omitempty"`
	// FingerprintConflictReason describes which definitions conflicted (set on CONFLICT).
	FingerprintConflictReason string `json:"fingerprintConflictReason,omitempty"`
	// MatchConfidence is a float in [0,1] representing matching strength (set on MATCHED).
	MatchConfidence float64 `json:"matchConfidence,omitempty"`
	// MatchEvidence is a credential-free summary of the matched selector (set on MATCHED).
	MatchEvidence string `json:"matchEvidence,omitempty"`
}

// DiscoveryRun represents a stored discovery run record (WO-011, WO-008).
type DiscoveryRun struct {
	ID              string
	NormalizedScope []ScopeEntry
	Status          string
	CreatedBy       string
	CreatedAt       time.Time
	CompletedAt     *time.Time
	ValidationNotes string
	CredentialID    string
	Protocol        string
	// TimeoutSeconds is the per-SNMP-GET timeout passed by the caller.
	// 0 means "use service default" (5 s).
	TimeoutSeconds int
	// Retries is the number of SNMP GET attempts (including the first).
	// 0 means "use service default" (2 attempts total: 1 original + 1 retry).
	Retries int
	// EphemeralCommunity is an in-memory-only community string supplied by the
	// caller when no stored credential is referenced. It is never written to
	// persistent storage or included in API responses.
	EphemeralCommunity string
	FailureReason   string
	Sweep           *SweepProgress
	Results         []DiscoveryHostResult
	DevicesFound    int
	// WO-008: multi-mode deterministic probe fields (additive — nil-safe for legacy records).
	TriggerMode         TriggerMode    // MANUAL, SCHEDULED, EVENT_SNMP_TRAP, EVENT_SYSLOG, EVENT_DHCP
	CorrelationID       string         // request-scoped correlation identifier
	ProbeAttempts       []ProbeAttempt // ordered probe attempt chain per run (aggregated across all targets)
	SuccessfulProbeType ProbeType      // first probe type that produced usable evidence
	RetryAt             *time.Time     // when this run should be retried (event-driven runs)
}

// DiscoveryRunSummary is the list-row shape for GET /discovery/runs (WO-003).
type DiscoveryRunSummary struct {
	RunID           string       `json:"runId"`
	Status          string       `json:"status"`
	ScopeSummary    string       `json:"scopeSummary,omitempty"`
	CreatedAt       time.Time    `json:"createdAt"`
	CompletedAt     *time.Time   `json:"completedAt,omitempty"`
	DevicesFound    int          `json:"devicesFound,omitempty"`
	CreatedBy       string       `json:"createdBy,omitempty"`
	NormalizedScope []ScopeEntry `json:"normalizedScope,omitempty"`
}

// DiscoveryRunDetailResponse is returned by GET /discovery/runs/{runId}.
type DiscoveryRunDetailResponse struct {
	RunID             string         `json:"runId"`
	Status            string         `json:"status"`
	NormalizedScope   []ScopeEntry   `json:"normalizedScope"`
	CreatedBy         string         `json:"createdBy"`
	CreatedAt         time.Time      `json:"createdAt"`
	UpdatedAt         *time.Time     `json:"updatedAt,omitempty"`
	ValidationSummary string         `json:"validationSummary,omitempty"`
	Sweep             *SweepProgress `json:"sweep,omitempty"`
	FailureReason     string         `json:"failureReason,omitempty"`
	Protocol          string         `json:"protocol,omitempty"`
	SnmpAttemptCount  int            `json:"snmpAttemptCount,omitempty"`
	SnmpSuccessCount  int            `json:"snmpSuccessCount,omitempty"`
	// WO-008: multi-mode probe fields (additive; omitted for legacy runs without probe chains).
	TriggerMode         TriggerMode    `json:"triggerMode,omitempty"`
	CorrelationID       string         `json:"correlationId,omitempty"`
	ProbeAttempts       []ProbeAttempt `json:"probeAttempts,omitempty"`
	SuccessfulProbeType ProbeType      `json:"successfulProbeType,omitempty"`
	RetryAt             *time.Time     `json:"retryAt,omitempty"`
	ProbeAttemptCount   int            `json:"probeAttemptCount,omitempty"`
}

// PaginatedRunsResponse wraps a page of discovery run summaries.
type PaginatedRunsResponse struct {
	Data       []DiscoveryRunSummary `json:"data"`
	Pagination PaginationMeta        `json:"pagination"`
}

// PaginationMeta describes list pagination metadata.
type PaginationMeta struct {
	Total int `json:"total"`
	Page  int `json:"page"`
	Limit int `json:"limit"`
}

// ── WO-027: SNMP fingerprint models ──────────────────────────────────────────

// SNMPFingerprintStatus represents the outcome of a single SNMP fingerprinting attempt.
type SNMPFingerprintStatus string

const (
	SNMPFingerprintSuccess    SNMPFingerprintStatus = "success"
	SNMPFingerprintAuthFailed SNMPFingerprintStatus = "auth_failed"
	SNMPFingerprintTimeout    SNMPFingerprintStatus = "timeout"
	SNMPFingerprintMalformed  SNMPFingerprintStatus = "malformed"
	SNMPFingerprintPartial    SNMPFingerprintStatus = "partial"    // sysDescr returned but no sysObjectID
	SNMPFingerprintFailed     SNMPFingerprintStatus = "failed"     // generic failure — see FailureCategory for detail
)

// FingerprintFailureCategory classifies why an SNMP fingerprint attempt failed.
// Values align with the comment on SNMPFingerprintResult.FailureCategory.
type FingerprintFailureCategory string

const (
	FingerprintCategoryAuthFailed         FingerprintFailureCategory = "SNMP_AUTH_FAILED"
	FingerprintCategoryTimeout            FingerprintFailureCategory = "SNMP_TIMEOUT"
	FingerprintCategoryMalformedOID       FingerprintFailureCategory = "SNMP_MALFORMED_OID"
	FingerprintCategoryMissingDescr       FingerprintFailureCategory = "SNMP_MISSING_DESCR"
	FingerprintCategoryUnsupportedVersion FingerprintFailureCategory = "SNMP_UNSUPPORTED_VERSION"
	FingerprintCategoryInternal           FingerprintFailureCategory = "SNMP_INTERNAL"
)

// SNMPFingerprintResult holds the outcome of querying sysDescr and sysObjectID
// on a single host. Never contains credential material.
type SNMPFingerprintResult struct {
	IP            string                `json:"ip"`
	RunID         string                `json:"runId"`
	CorrelationID string                `json:"correlationId,omitempty"`
	Status        SNMPFingerprintStatus `json:"status"`
	SysObjectID   string                `json:"sysObjectID,omitempty"`
	SysDescr      string                `json:"sysDescr,omitempty"`
	SysName       string                `json:"sysName,omitempty"`
	SysContact    string                `json:"sysContact,omitempty"`
	SysLocation   string                `json:"sysLocation,omitempty"`
	SysUpTimeSec  int64                 `json:"sysUpTimeSeconds,omitempty"`
	// FailureCategory is one of: SNMP_AUTH_FAILED, SNMP_TIMEOUT, SNMP_MALFORMED_OID,
	// SNMP_MISSING_DESCR, SNMP_UNSUPPORTED_VERSION, SNMP_INTERNAL.
	// Never includes community strings or credentials.
	FailureCategory FingerprintFailureCategory `json:"failureCategory,omitempty"`
	// RetryCount records how many retry attempts were made before this result was produced.
	// Zero means the first attempt succeeded (or failed permanently).
	RetryCount      int                        `json:"retryCount,omitempty"`
	FingerprintedAt time.Time                  `json:"fingerprintedAt"`
}

// ── WO-026: Bootstrap onboarding state summary ────────────────────────────────

// OnboardingBootstrapState constants represent the stages a UBR device progresses
// through during call-home onboarding (WO-026).
const (
	OnboardingBootstrapStateBoot      = "BOOT"
	OnboardingBootstrapStateDiscovery = "DISCOVERY"
	OnboardingBootstrapStateAuth      = "AUTHENTICATION"
	OnboardingBootstrapStateOperation = "OPERATION"
)

// DeviceOnboardingState is the API response shape for a single device's bootstrap
// progress as returned by GET /api/v1/discovery/onboarding (WO-026).
// All sensitive authentication material is redacted — only state metadata is exposed.
type DeviceOnboardingState struct {
	DeviceID                   string    `json:"deviceId"`
	SerialNumber               string    `json:"serialNumber"`
	MACAddress                 string    `json:"macAddress"`
	DeviceType                 string    `json:"deviceType"`
	BootstrapState             string    `json:"bootstrapState"`
	OperationalStatus          string    `json:"operationalStatus,omitempty"`
	LastSuccessfulState        string    `json:"lastSuccessfulState,omitempty"`
	FailureReason              string    `json:"failureReason,omitempty"`
	RetryAfterSeconds          *int      `json:"retryAfterSeconds,omitempty"`
	RetryJitterMaxSeconds      *int      `json:"retryJitterMaxSeconds,omitempty"`
	AssignmentRequired         *bool     `json:"assignmentRequired,omitempty"`
	CommissioningPendingFields string    `json:"commissioningPendingFields,omitempty"`
	LastCheckInAt              *time.Time `json:"lastCheckInAt,omitempty"`
	LastRealtimeAt             *time.Time `json:"lastRealtimeAt,omitempty"`
	UpdatedAt                  *time.Time `json:"updatedAt,omitempty"`
}

// OnboardingStatesResponse wraps the paginated list of device onboarding states.
type OnboardingStatesResponse struct {
	Items  []DeviceOnboardingState `json:"items"`
	Total  int                     `json:"total"`
	Source string                  `json:"source"` // "discovery" or "inventory"
}

// ── WO-024: Management port probing ───────────────────────────────────────────

// PortProbeResult holds the result of a single TCP connect probe (WO-024).
type PortProbeResult struct {
	Port      int    `json:"port"`
	Open      bool   `json:"open"`
	LatencyMs int64  `json:"latencyMs,omitempty"`
	Error     string `json:"error,omitempty"`
}

// ── Provisioning: bridging discovery results into managed inventory ───────────

// ProvisionHost describes one discovered host that an admin wants to provision
// into the NMS-managed inventory.  The admin-supplied fields (DeviceType, SerialNumber,
// NetworkID, lat/lng) supplement the SNMP-fingerprinted data from discovery.
type ProvisionHost struct {
	IP           string  `json:"ip"`
	DeviceType   string  `json:"deviceType"`   // BTS | CPE | IDU (admin-chosen)
	SerialNumber string  `json:"serialNumber"`
	MACAddress   string  `json:"macAddress,omitempty"`
	NetworkID    string  `json:"networkId,omitempty"`
	Vendor       string  `json:"vendor,omitempty"`
	Model        string  `json:"model,omitempty"`
	SysName      string  `json:"sysName,omitempty"`
	SysLocation  string  `json:"sysLocation,omitempty"`
	SysObjectID  string  `json:"sysObjectID,omitempty"`
	SysDescr     string  `json:"sysDescr,omitempty"`
	Latitude     float64 `json:"latitude,omitempty"`
	Longitude    float64 `json:"longitude,omitempty"`
}

// ProvisionRequest is the body for POST /api/v1/discovery/runs/{runId}/provision.
type ProvisionRequest struct {
	Hosts []ProvisionHost `json:"hosts"`
}

// ProvisionHostResult is the per-host outcome included in ProvisionResponse.
type ProvisionHostResult struct {
	IP           string `json:"ip"`
	DeviceID     string `json:"deviceId,omitempty"`
	SerialNumber string `json:"serialNumber,omitempty"`
	Status       string `json:"status"` // "provisioned" | "failed"
	Error        string `json:"error,omitempty"`
}

// ProvisionResponse is returned by POST /api/v1/discovery/runs/{runId}/provision.
type ProvisionResponse struct {
	Results     []ProvisionHostResult `json:"results"`
	Provisioned int                   `json:"provisioned"`
	Failed      int                   `json:"failed"`
}

// InventoryCreateResponse is the minimal shape returned by the inventory-service
// POST /devices endpoint that we need for extracting the assigned deviceId.
type InventoryCreateResponse struct {
	ID       string `json:"id"`
	DeviceID string `json:"deviceId"`
}

// ── WO-008: Multi-mode deterministic discovery probe models ──────────────────

// TriggerMode identifies the source that initiated a discovery run.
type TriggerMode string

const (
	TriggerModeManual       TriggerMode = "MANUAL"
	TriggerModeScheduled    TriggerMode = "SCHEDULED"
	TriggerModeEventTrap    TriggerMode = "EVENT_SNMP_TRAP"
	TriggerModeEventSyslog  TriggerMode = "EVENT_SYSLOG"
	TriggerModeEventDHCP    TriggerMode = "EVENT_DHCP"
)

// ValidTriggerModes is the allowlist for trigger mode values.
var ValidTriggerModes = map[TriggerMode]bool{
	TriggerModeManual:      true,
	TriggerModeScheduled:   true,
	TriggerModeEventTrap:   true,
	TriggerModeEventSyslog: true,
	TriggerModeEventDHCP:   true,
}

// ProbeType identifies the protocol used in a single probe attempt.
type ProbeType string

const (
	ProbeTypeICMP     ProbeType = "ICMP"
	ProbeTypeSNMP     ProbeType = "SNMP"
	ProbeTypeSSH      ProbeType = "SSH"
	ProbeTypeHTTP     ProbeType = "HTTP"
	ProbeTypeHTTPS    ProbeType = "HTTPS"
	ProbeTypeGRPC     ProbeType = "GRPC_HEALTH"
)

// ProbeAttemptStatus is the outcome of a single probe attempt.
type ProbeAttemptStatus string

const (
	ProbeAttemptSuccess   ProbeAttemptStatus = "success"
	ProbeAttemptTimeout   ProbeAttemptStatus = "timeout"
	ProbeAttemptUnreachable ProbeAttemptStatus = "unreachable"
	ProbeAttemptAuthFailed ProbeAttemptStatus = "auth_failed"
	ProbeAttemptSkipped   ProbeAttemptStatus = "skipped"
	ProbeAttemptFailed    ProbeAttemptStatus = "failed"
)

// ProbeAttempt records the outcome of a single protocol probe against one target.
// Credential material (community strings, SSH passwords) is NEVER included.
type ProbeAttempt struct {
	// ProbeType is the protocol used (ICMP, SNMP, SSH, HTTP, HTTPS, GRPC_HEALTH).
	ProbeType ProbeType `json:"probeType"`
	// Status is the outcome of this probe attempt.
	Status ProbeAttemptStatus `json:"status"`
	// StartedAt is the ISO-8601 UTC timestamp when the probe started.
	StartedAt time.Time `json:"startedAt"`
	// CompletedAt is the ISO-8601 UTC timestamp when the probe ended.
	CompletedAt time.Time `json:"completedAt"`
	// LatencyMs is the round-trip latency in milliseconds. 0 if the probe failed immediately.
	LatencyMs int64 `json:"latencyMs"`
	// FailureCategory is a machine-readable reason code (e.g. TIMEOUT, AUTH_FAILED).
	// Empty when status is success.
	FailureCategory string `json:"failureCategory,omitempty"`
	// FailureReason is a human-readable message describing why the probe failed.
	// Never contains credential values.
	FailureReason string `json:"failureReason,omitempty"`
	// SafeEvidenceSummary is a credential-free summary of the probe evidence
	// (e.g. sysDescr snippet, SSH banner prefix, HTTP server header).
	SafeEvidenceSummary string `json:"safeEvidenceSummary,omitempty"`
	// Retryable indicates whether this probe type should be reattempted.
	Retryable bool `json:"retryable"`
}

// ── WO-011: Guided failure model ──────────────────────────────────────────────

// GuidedFailure is the structured failure detail attached to a failed or degraded
// discovery result. Every field is operator-visible; credential material must NEVER
// appear in any field of this struct.
type GuidedFailure struct {
	// Category is the top-level machine-readable failure class.
	Category string `json:"category"`
	// Code is a specific sub-category code within Category.
	Code string `json:"code"`
	// ExplicitReason is a human-readable, credential-free description of the failure.
	ExplicitReason string `json:"explicitReason"`
	// Retryable is true when submitting a new discovery run may resolve the issue.
	Retryable bool `json:"retryable"`
	// RetryAfter is the earliest UTC time the caller may retry, if known.
	RetryAfter *time.Time `json:"retryAfter,omitempty"`
	// LastSuccessfulProtocolAttempt is the last protocol that produced usable evidence.
	// Empty when no protocol has ever succeeded for this target.
	LastSuccessfulProtocolAttempt string `json:"lastSuccessfulProtocolAttempt,omitempty"`
	// LastAttemptedProtocol is the final protocol tried.
	LastAttemptedProtocol string `json:"lastAttemptedProtocol,omitempty"`
	// RecommendedNextAction is a human-readable guidance string for operators.
	RecommendedNextAction string `json:"recommendedNextAction"`
	// CorrelationID links this failure record to the backend log for this operation.
	CorrelationID string `json:"correlationId,omitempty"`
}

// PortProbeResultEvent is published to discovery.port.results after probing
// all management ports on a live host found by ICMP sweep (WO-024).
// ManagementProtocol is inferred from open ports:
//   NETCONF(830) > SNMP(161) > SSH(22) > HTTPS(443) > HTTP(80) > UNKNOWN
type PortProbeResultEvent struct {
	EventID            string            `json:"eventId"`
	RunID              string            `json:"runId"`
	IP                 string            `json:"ip"`
	OpenPorts          []int             `json:"openPorts"`
	PortResults        []PortProbeResult `json:"portResults"`
	ManagementProtocol string            `json:"managementProtocol"`
	Timestamp          time.Time         `json:"timestamp"`
}
