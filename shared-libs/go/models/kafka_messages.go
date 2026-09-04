package models

import "time"

// RawAlarmMessage is the Kafka message on the raw-alarms topic.
// Field "Time" matches the exact BRD format.
type RawAlarmMessage struct {
	AlarmID          string     `json:"alarmId"`
	AlarmName        string     `json:"alarmName"`
	Severity         AlarmSeverity `json:"severity"`
	AlarmDescription string     `json:"alarmDescription,omitempty"`
	State            string     `json:"state"`
	Time             time.Time  `json:"Time"`
	Data             struct {
		DeviceType DeviceType `json:"deviceType"`
		DeviceID   string     `json:"deviceId"`
	} `json:"data"`
}

// NetcoolAlarmForwardMessage is the northbound message sent to Netcool OSS.
type NetcoolAlarmForwardMessage struct {
	AlarmID          string     `json:"alarmId"`
	AlarmName        string     `json:"alarmName"`
	Severity         AlarmSeverity `json:"severity"`
	AlarmDescription string     `json:"alarmDescription"`
	State            AlarmState `json:"state"`
	Time             time.Time  `json:"Time"`
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

// InventorySyncMessage is the message from Mobinet/Telemedia sync.
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
	CredentialRef        string    `json:"credentialRef,omitempty"`
	ConfigVersion        string    `json:"configVersion,omitempty"`

	// WO-004: sysObjectID for SNMP-discovered devices
	SysObjectID          string    `json:"sysObjectID,omitempty"`
}

// SouthboundErrorEvent is published to the audit/alarm Kafka topics when a
// southbound security or protocol error occurs (WO-005).
// Secrets, HMAC values, and private keys must never appear in this struct.
type SouthboundErrorEvent struct {
	EventID       string    `json:"eventId"`
	CorrelationID string    `json:"correlationId"`
	DeviceSerial  string    `json:"deviceSerial,omitempty"` // sanitised device identity only
	ErrorReason   string    `json:"errorReason"`             // e.g. HMAC_INVALID, MTLS_CERT_INVALID
	ErrorCategory string    `json:"errorCategory"`           // auth_failure, retryable, redirect, etc.
	HTTPStatus    int       `json:"httpStatus"`
	Timestamp     time.Time `json:"timestamp"`
	ServiceID     string    `json:"serviceId"`
}
