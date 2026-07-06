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
}
