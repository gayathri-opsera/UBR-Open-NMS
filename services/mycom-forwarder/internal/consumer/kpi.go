package consumer

import (
	"encoding/json"
	"fmt"
	"time"
)

// ----- Internal payload (written by kpi-aggregation-service) -----

// KpiPayload is the internal KPI record from the 'mycom-kpi-export' topic.
type KpiPayload struct {
	DeviceID         string             `json:"deviceId"`
	SerialNumber     string             `json:"serialNumber"`
	DeviceType       string             `json:"deviceType"`
	ModelNo          string             `json:"modelNo"`
	Timestamp        string             `json:"timestamp"`
	Granularity      string             `json:"granularity"`
	Metrics          map[string]float64 `json:"metrics"`

	// Structured radio / port data (may be present)
	Wireless5GhzRadio *RadioKpi          `json:"wireless5GhzRadio,omitempty"`
	EthernetPorts     []EthernetPortKpi  `json:"ethernetPorts,omitempty"`
}

// RadioKpi holds 5 GHz radio statistics.
type RadioKpi struct {
	TxPowerDBm   float64 `json:"txPowerDbm"`
	RxPowerDBm   float64 `json:"rxPowerDbm"`
	SnrDB        float64 `json:"snrDb"`
	MCSIndex     int     `json:"mcsIndex"`
	Modulation   string  `json:"modulation"`
	AssocClients int     `json:"associatedClients"`
}

// EthernetPortKpi holds per-port Ethernet statistics.
type EthernetPortKpi struct {
	Port    string  `json:"port"`
	TxBytes float64 `json:"txBytes"`
	RxBytes float64 `json:"rxBytes"`
	Errors  int     `json:"errors"`
}

// ----- Mycom wire format -----

// MycomKpiRecord is the exact JSON format required by Mycom's KPI assurance platform.
type MycomKpiRecord struct {
	SerialNumber      string             `json:"serialNumber"`
	DeviceType        string             `json:"deviceType"`
	ModelNo           string             `json:"modelNo"`
	Timestamp         string             `json:"timestamp"`
	Granularity       string             `json:"granularity"`
	Metrics           map[string]float64 `json:"metrics"`
	Wireless5GhzRadio *RadioKpi          `json:"wireless5GhzRadio,omitempty"`
	EthernetPorts     []EthernetPortKpi  `json:"ethernetPorts,omitempty"`
}

// ToMycom converts an internal KpiPayload to the Mycom wire format.
func ToMycom(p KpiPayload) MycomKpiRecord {
	ts := p.Timestamp
	if ts == "" {
		ts = time.Now().UTC().Format(time.RFC3339)
	}
	return MycomKpiRecord{
		SerialNumber:      p.SerialNumber,
		DeviceType:        p.DeviceType,
		ModelNo:           p.ModelNo,
		Timestamp:         ts,
		Granularity:       p.Granularity,
		Metrics:           p.Metrics,
		Wireless5GhzRadio: p.Wireless5GhzRadio,
		EthernetPorts:     p.EthernetPorts,
	}
}

// MarshalMycom converts an internal KpiPayload to Mycom JSON bytes.
func MarshalMycom(p KpiPayload) ([]byte, error) {
	rec := ToMycom(p)
	return json.Marshal(rec)
}

// ValidateKpiPayload performs lightweight validation and returns an error for
// structurally invalid messages that should be routed to the DLQ.
func ValidateKpiPayload(p KpiPayload) error {
	if p.SerialNumber == "" {
		return fmt.Errorf("missing serialNumber")
	}
	if p.DeviceType == "" {
		return fmt.Errorf("missing deviceType")
	}
	return nil
}

// ParseKpiPayload deserialises the raw Kafka message.
func ParseKpiPayload(data []byte) (KpiPayload, error) {
	var p KpiPayload
	if err := json.Unmarshal(data, &p); err != nil {
		return p, fmt.Errorf("parse KPI payload: %w", err)
	}
	return p, nil
}
