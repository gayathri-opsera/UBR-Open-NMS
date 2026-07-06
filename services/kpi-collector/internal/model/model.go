package model

import "time"

// Device is a minimal representation of an inventory device.
type Device struct {
	DeviceID     string  `json:"deviceId"`
	SerialNumber string  `json:"serialNumber"`
	IPAddress    string  `json:"ipAddress"`
	Type         string  `json:"type"` // BTS, CPE, IDU
	Model        string  `json:"model"`
	NetworkID    string  `json:"networkId"`
	Status       string  `json:"status"`
	SNMPVersion  string  `json:"snmpVersion"` // v2c, v3
	SNMPPort     uint16  `json:"snmpPort"`
}

// RawKPI is the canonical KPI payload published to raw-kpi Kafka topic.
type RawKPI struct {
	DeviceID           string            `json:"deviceId"`
	DeviceType         string            `json:"deviceType"`
	SerialNumber       string            `json:"serialNumber"`
	NetworkID          string            `json:"networkId"`
	Timestamp          time.Time         `json:"timestamp"`
	PollCycle          int64             `json:"pollCycle"`

	// RF metrics
	RSSI               *float64          `json:"rssi,omitempty"`
	SNR                *float64          `json:"snr,omitempty"`
	OperatingChannel   *int              `json:"operatingChannel,omitempty"`
	ChannelUtilization *float64          `json:"channelUtilization,omitempty"`
	Bandwidth          *int              `json:"bandwidth,omitempty"`
	MCS                *int              `json:"mcs,omitempty"`
	TxPower            *float64          `json:"txPower,omitempty"`

	// Traffic
	ThroughputUL       *float64          `json:"throughputUL,omitempty"`
	ThroughputDL       *float64          `json:"throughputDL,omitempty"`
	TxPackets          *int64            `json:"txPackets,omitempty"`
	RxPackets          *int64            `json:"rxPackets,omitempty"`
	TxBytes            *int64            `json:"txBytes,omitempty"`
	RxBytes            *int64            `json:"rxBytes,omitempty"`
	PacketsDropped     *int64            `json:"packetsDropped,omitempty"`
	PacketRetransmit   *int64            `json:"packetRetransmit,omitempty"`
	CRCErrors          *int64            `json:"crcErrors,omitempty"`
	Latency            *float64          `json:"latency,omitempty"`

	// System
	CPUUtilization     *float64          `json:"cpuUtilization,omitempty"`
	FreeMemory         *int64            `json:"freeMemory,omitempty"`
	RebootCount        *int64            `json:"rebootCount,omitempty"`
	DyingGaspCount     *int64            `json:"dyingGaspCount,omitempty"`

	// Ethernet port metrics (key = port name)
	EthernetPorts      map[string]PortMetric `json:"ethernetPorts,omitempty"`

	// Additional vendor OID values
	Raw                map[string]interface{} `json:"raw,omitempty"`
}

// PortMetric holds per-ethernet-port statistics.
type PortMetric struct {
	TxBytes    int64 `json:"txBytes"`
	RxBytes    int64 `json:"rxBytes"`
	Errors     int64 `json:"errors"`
	LinkStatus int   `json:"linkStatus"` // 1=up, 2=down
}

// MissingDataEvent is published to raw-alarms when a device fails to respond.
type MissingDataEvent struct {
	DeviceID   string    `json:"deviceId"`
	DeviceType string    `json:"deviceType"`
	Timestamp  time.Time `json:"timestamp"`
	PollCycle  int64     `json:"pollCycle"`
	AlarmType  string    `json:"alarmType"`
	Severity   string    `json:"severity"`
	Source     string    `json:"source"`
}
