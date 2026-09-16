package models

import "time"

// RawAlarmMessage is the Kafka message on the raw-alarms topic.
// Field "Time" matches the exact BRD format.
type RawAlarmMessage struct {
	AlarmID          string        `json:"alarmId"`
	AlarmName        string        `json:"alarmName"`
	Severity         AlarmSeverity `json:"severity"`
	AlarmDescription string        `json:"alarmDescription,omitempty"`
	State            string        `json:"state"`
	Time             time.Time     `json:"Time"`
	Data             struct {
		DeviceType DeviceType `json:"deviceType"`
		DeviceID   string     `json:"deviceId"`
	} `json:"data"`
}

// NetcoolAlarmForwardMessage is the northbound message sent to Netcool OSS.
type NetcoolAlarmForwardMessage struct {
	AlarmID          string        `json:"alarmId"`
	AlarmName        string        `json:"alarmName"`
	Severity         AlarmSeverity `json:"severity"`
	AlarmDescription string        `json:"alarmDescription"`
	State            AlarmState    `json:"state"`
	Time             time.Time     `json:"Time"`
	Data             struct {
		DeviceType DeviceType `json:"deviceType"`
		DeviceID   string     `json:"deviceId"`
	} `json:"data"`
}

type EthernetPort struct {
	PortID       string  `json:"portId,omitempty"`
	TxBytesTotal int64   `json:"txBytesTotal,omitempty"`
	RxBytesTotal int64   `json:"rxBytesTotal,omitempty"`
	TxErrorsPct  float64 `json:"txErrorsPct,omitempty"`
	RxErrorsPct  float64 `json:"rxErrorsPct,omitempty"`
	LinkUptime   int64   `json:"linkUptime,omitempty"`
}

// MycomKPIExportMessage is the northbound KPI export to Mycom OST.
type MycomKPIExportMessage struct {
	DeviceID     string    `json:"deviceId"`
	SerialNumber string    `json:"serialNumber"`
	IPAddress    string    `json:"ipAddress,omitempty"`
	Timestamp    time.Time `json:"timestamp"`
	Wireless5GhzRadio *struct {
		TxPowerDBm            float64 `json:"txPowerDbm,omitempty"`
		RxSignalStrengthDBm   float64 `json:"rxSignalStrengthDbm,omitempty"`
		ChannelUtilizationPct float64 `json:"channelUtilizationPct,omitempty"`
		SNRDb                 float64 `json:"snrDb,omitempty"`
		ConnectedClients      int     `json:"connectedClients,omitempty"`
		Modulation            string  `json:"modulation,omitempty"`
		ThroughputMbps        float64 `json:"throughputMbps,omitempty"`
	} `json:"wireless5GhzRadio,omitempty"`
	EthernetPorts []EthernetPort `json:"ethernetPorts,omitempty"`
}

// SouthboundErrorEvent is published to the audit/alarm Kafka topics when a
// southbound security or protocol error occurs (WO-005).
//
// SECURITY: Secrets, HMAC values, private keys, and raw signatures must never
// appear in this struct. Only sanitised identity and correlation context is included.
type SouthboundErrorEvent struct {
	EventID       string    `json:"eventId"`
	CorrelationID string    `json:"correlationId"`
	DeviceSerial  string    `json:"deviceSerial,omitempty"` // sanitised device identity only
	ErrorReason   string    `json:"errorReason"`             // e.g. HMAC_INVALID, MTLS_CERT_INVALID
	ErrorCategory string    `json:"errorCategory"`           // auth_failure, retryable, redirect, etc.
	HTTPStatus    int       `json:"httpStatus"`
	Timestamp     time.Time `json:"timestamp"`
	ServiceID     string    `json:"serviceId"`

	// Legacy aliases — kept for backward compatibility with older alarm consumers.
	Reason   string `json:"reason,omitempty"`   // same as ErrorReason
	Category string `json:"category,omitempty"` // same as ErrorCategory
}

// InventorySyncMessage is the Kafka message for device inventory synchronisation.
// Published when a device is discovered or updated through any discovery paradigm.
type InventorySyncMessage struct {
	SystemName     string     `json:"systemName,omitempty"`
	IPAddress      string     `json:"ipAddress"`
	MacAddress     string     `json:"macAddress"`
	SerialNumber   string     `json:"serialNumber"`
	Model          string     `json:"model"`
	Firmware       string     `json:"firmware"`
	DeviceType     DeviceType `json:"deviceType,omitempty"`
	Latitude       float64    `json:"latitude,omitempty"`
	Longitude      float64    `json:"longitude,omitempty"`
	Region         string     `json:"region,omitempty"`
	OrganizationID string     `json:"organizationId,omitempty"`
	SyncSource     string     `json:"syncSource,omitempty"`
	SyncedAt       time.Time  `json:"syncedAt,omitempty"`

	// WO-002: authority, bootstrap, capability, and credential reference fields
	SchemaVersion        string    `json:"schemaVersion,omitempty"`
	DiscoveryParadigm    string    `json:"discoveryParadigm,omitempty"`
	IdentityAuthority    string    `json:"identityAuthority,omitempty"`
	OnlineStateAuthority string    `json:"onlineStateAuthority,omitempty"`
	BootstrapState       string    `json:"bootstrapState,omitempty"`
	LastCheckInAt        time.Time `json:"lastCheckInAt,omitempty"`
	LastRealtimeAt       time.Time `json:"lastRealtimeAt,omitempty"`
	CapabilityProfileID  string    `json:"capabilityProfileId,omitempty"`
	// CredentialRef is an opaque reference only — never the credential value.
	CredentialRef string `json:"credentialRef,omitempty"`
	ConfigVersion string `json:"configVersion,omitempty"`

	// WO-027: SNMP fingerprint fields
	SysObjectID string `json:"sysObjectID,omitempty"`
	SysDescr    string `json:"sysDescr,omitempty"`
}

// ── WO-031: Post-registration orchestration events ─────────────────────────

// InitialKpiCollectionTriggerEvent is published to kpi.initial.collection.trigger (WO-031).
// Requests that the KPI collector schedule an immediate one-time collection cycle for
// a newly registered generic device. Idempotency key prevents duplicate collection jobs
// on repeated rediscovery runs.
//
// Authority: only emitted for GENERIC_SNMP devices; never for UBR call-home devices
// (which have their own collection scheduling path).
type InitialKpiCollectionTriggerEvent struct {
	EventID           string    `json:"eventId"`
	RunID             string    `json:"runId"`
	InventoryDeviceID string    `json:"inventoryDeviceId"`
	IP                string    `json:"ip"`
	CorrelationID     string    `json:"correlationId"`
	IdempotencyKey    string    `json:"idempotencyKey"`  // runId:deviceId — prevents duplicate jobs
	SysObjectID       string    `json:"sysObjectID,omitempty"`
	DiscoveryParadigm string    `json:"discoveryParadigm"` // always GENERIC_SNMP
	DriverID          string    `json:"driverId,omitempty"`
	CapabilityProfileID string  `json:"capabilityProfileId,omitempty"`
	// ProtocolHints guides the collector on which protocol to use for this device.
	// Values: SNMP, NETCONF, SSH, HTTP, HTTPS, UNKNOWN.
	ProtocolHints     []string  `json:"protocolHints,omitempty"`
	IsRediscovery     bool      `json:"isRediscovery"` // true when device already existed in inventory
	Timestamp         time.Time `json:"timestamp"`
}

// InitialTopologyWalkTriggerEvent is published to topology.initial.walk.trigger (WO-031).
// Requests an initial LLDP/CDP topology walk for a newly registered generic device.
// Idempotency key prevents duplicate walk jobs on repeated rediscovery runs.
//
// Authority: only emitted for GENERIC_SNMP devices with SNMP management access.
type InitialTopologyWalkTriggerEvent struct {
	EventID           string    `json:"eventId"`
	RunID             string    `json:"runId"`
	InventoryDeviceID string    `json:"inventoryDeviceId"`
	IP                string    `json:"ip"`
	CorrelationID     string    `json:"correlationId"`
	IdempotencyKey    string    `json:"idempotencyKey"` // runId:deviceId
	SysObjectID       string    `json:"sysObjectID,omitempty"`
	DiscoveryParadigm string    `json:"discoveryParadigm"` // always GENERIC_SNMP
	// SupportedProtocols lists protocols available for topology discovery.
	// An empty slice means topology walk cannot be triggered (SKIPPED).
	SupportedProtocols []string `json:"supportedProtocols,omitempty"` // LLDP, CDP, SNMP_NEIGHBOR
	IsRediscovery      bool     `json:"isRediscovery"`
	Timestamp          time.Time `json:"timestamp"`
}

// PostRegistrationActionResult records the outcome of a single post-registration
// action (initial KPI collection or initial topology walk). Embedded in
// GenericInventoryRegisteredEvent and discovery run result API responses.
type PostRegistrationActionResult struct {
	ActionType           string    `json:"actionType"`    // INITIAL_KPI_COLLECTION | INITIAL_TOPOLOGY_WALK
	Status               string    `json:"status"`        // ACCEPTED | SKIPPED | FAILED | PENDING
	Reason               string    `json:"reason,omitempty"` // skip/fail reason
	DownstreamReferenceID string   `json:"downstreamReferenceId,omitempty"`
	IdempotencyKey       string    `json:"idempotencyKey,omitempty"`
	AttemptedAt          time.Time `json:"attemptedAt"`
	CorrelationID        string    `json:"correlationId,omitempty"`
}

// ICMPSweepResultEvent is published to the discovery.icmp.results Kafka topic (WO-016).
// It carries per-host ICMP probe outcomes from a discovery run sweep stage.
type ICMPSweepResultEvent struct {
	EventID      string    `json:"eventId"`
	RunID        string    `json:"runId"`
	IP           string    `json:"ip"`
	Status       string    `json:"status"`   // "reachable", "unreachable", "timeout", "error", "cancelled"
	LatencyMs    int64     `json:"latencyMs,omitempty"`
	ErrorMsg     string    `json:"errorMsg,omitempty"`
	SourceLabels []string  `json:"sourceLabels,omitempty"`
	Timestamp    time.Time `json:"timestamp"`
}

// PortProbeResult holds the result of a TCP connect probe against one port (WO-024).
type PortProbeResult struct {
	Port      int    `json:"port"`
	Open      bool   `json:"open"`
	LatencyMs int64  `json:"latencyMs,omitempty"`
	Error     string `json:"error,omitempty"`
}

// PortProbeResultEvent is published to the discovery.port.results Kafka topic (WO-024).
// One event is emitted per live host after all management ports have been probed.
// ManagementProtocol is inferred from open ports: NETCONF if 830, SNMP if 161,
// SSH if 22, HTTP/S if 80/443.
type PortProbeResultEvent struct {
	EventID            string            `json:"eventId"`
	RunID              string            `json:"runId"`
	IP                 string            `json:"ip"`
	OpenPorts          []int             `json:"openPorts"`
	PortResults        []PortProbeResult `json:"portResults"`
	ManagementProtocol string            `json:"managementProtocol"` // NETCONF | SNMP | SSH | HTTP | HTTPS | UNKNOWN
	Timestamp          time.Time         `json:"timestamp"`
}

// SNMPFingerprintResultEvent is published after SNMP GET fingerprinting (WO-027).
// Never includes community strings, SNMP credentials, or authentication material.
type SNMPFingerprintResultEvent struct {
	EventID       string    `json:"eventId"`
	RunID         string    `json:"runId"`
	IP            string    `json:"ip"`
	CorrelationID string    `json:"correlationId"`
	Status        string    `json:"status"`              // "success" | "auth_failed" | "timeout" | "malformed" | "partial"
	SysObjectID   string    `json:"sysObjectID,omitempty"`
	SysDescr      string    `json:"sysDescr,omitempty"`
	FailureReason string    `json:"failureReason,omitempty"` // categorised — no credential material
	Timestamp     time.Time `json:"timestamp"`
}

// GenericDeviceClassifiedEvent is published after SNMP fingerprint classification (WO-030).
// Published to the discovery.classification.results topic.
// Authority rules: this event carries generic-discovery fields only.
// UBR call-home authoritative fields (serial, mac, deviceType) are NEVER set here.
type GenericDeviceClassifiedEvent struct {
	EventID              string    `json:"eventId"`
	RunID                string    `json:"runId"`
	IP                   string    `json:"ip"`
	CorrelationID        string    `json:"correlationId"`

	// Classification outcome.
	ClassificationStatus string `json:"classificationStatus"` // RECOGNISED | DEFERRED_UNSUPPORTED | CLASSIFICATION_ERROR
	DeferReason          string `json:"deferReason,omitempty"`

	// Populated when ClassificationStatus == RECOGNISED.
	Vendor              string `json:"vendor,omitempty"`
	Model               string `json:"model,omitempty"`
	GenericDeviceType   string `json:"genericDeviceType,omitempty"` // ROUTER | SWITCH | FIREWALL | SERVER
	CapabilityProfileID string `json:"capabilityProfileId,omitempty"`
	DriverID            string `json:"driverId,omitempty"`

	// Fingerprint evidence included for downstream audit (no credential material).
	SysObjectID string `json:"sysObjectID,omitempty"`
	SysDescr    string `json:"sysDescr,omitempty"`

	// Authority metadata for downstream services.
	DiscoveryParadigm    string `json:"discoveryParadigm"`    // always GENERIC_SNMP
	IdentityAuthority    string `json:"identityAuthority"`    // always GENERIC
	OnlineStateAuthority string `json:"onlineStateAuthority"` // always GENERIC

	Timestamp time.Time `json:"timestamp"`
}

// GenericInventoryRegisteredEvent is published after a generic device is persisted in inventory (WO-030).
// Downstream services (topology, KPI, configuration) consume this to start monitoring the device.
type GenericInventoryRegisteredEvent struct {
	EventID              string    `json:"eventId"`
	RunID                string    `json:"runId"`
	InventoryDeviceID    string    `json:"inventoryDeviceId"`
	IP                   string    `json:"ip"`
	CorrelationID        string    `json:"correlationId"`
	RegistrationStatus   string    `json:"registrationStatus"` // REGISTERED | DEFERRED
	ClassificationStatus string    `json:"classificationStatus"`
	DeferReason          string    `json:"deferReason,omitempty"`
	Vendor               string    `json:"vendor,omitempty"`
	Model                string    `json:"model,omitempty"`
	GenericDeviceType    string    `json:"genericDeviceType,omitempty"`
	CapabilityProfileID  string    `json:"capabilityProfileId,omitempty"`
	DriverID             string    `json:"driverId,omitempty"`
	SysObjectID          string    `json:"sysObjectID,omitempty"`
	SysDescr             string    `json:"sysDescr,omitempty"`
	DiscoveryParadigm    string    `json:"discoveryParadigm"`
	IdentityAuthority    string    `json:"identityAuthority"`
	OnlineStateAuthority string    `json:"onlineStateAuthority"`
	Timestamp            time.Time `json:"timestamp"`
}
