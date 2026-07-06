package consumer

import (
	"encoding/json"
	"fmt"
)

// ----- Internal payload (written by inventory-service) -----

// InventoryEvent is the internal device record from the 'inventory-sync' topic.
type InventoryEvent struct {
	DeviceID   string   `json:"deviceId"`
	EventType  string   `json:"eventType"` // "UPSERT" | "DELETE"
	Device     *Device  `json:"device,omitempty"`
}

// Device holds full device inventory fields.
type Device struct {
	SystemName   string  `json:"systemName"`
	IPAddress    string  `json:"ipAddress"`
	MacAddress   string  `json:"macAddress"`
	SerialNumber string  `json:"serialNumber"`
	Model        string  `json:"model"`
	Firmware     string  `json:"firmware"`
	DeviceStatus string  `json:"deviceStatus"`
	LinkType     string  `json:"linkType"`
	RadioMode    string  `json:"radioMode"`
	SSID         string  `json:"ssid"`
	Bandwidth    string  `json:"bandwidth"`
	Channel      int     `json:"channel"`
	FrequencyMHz float64 `json:"frequencyMHz"`
	Latitude     float64 `json:"latitude"`  // must be float per spec
	Longitude    float64 `json:"longitude"` // must be float per spec
	NetworkID    string  `json:"networkId"`
	OrganizationID string `json:"organizationId"`
}

// ----- Mobinet wire format -----

// MobinetInventoryRecord is the exact JSON format required by Mobinet/Telemedia.
type MobinetInventoryRecord struct {
	SystemName   string  `json:"systemName"`
	IPAddress    string  `json:"ipAddress"`
	MacAddress   string  `json:"macAddress"`
	SerialNumber string  `json:"serialNumber"`
	Model        string  `json:"model"`
	Firmware     string  `json:"firmware"`
	DeviceStatus string  `json:"deviceStatus"`
	LinkType     string  `json:"linkType"`
	RadioMode    string  `json:"radioMode"`
	SSID         string  `json:"ssid"`
	Bandwidth    string  `json:"bandwidth"`
	Channel      int     `json:"channel"`
	FrequencyMHz float64 `json:"frequencyMHz"`
	// Latitude and longitude sent as floats per requirements note
	Latitude  float64 `json:"latitude"`
	Longitude float64 `json:"longitude"`
}

// ToMobinet converts an internal Device to the Mobinet wire format.
func ToMobinet(d Device) MobinetInventoryRecord {
	return MobinetInventoryRecord{
		SystemName:   d.SystemName,
		IPAddress:    d.IPAddress,
		MacAddress:   d.MacAddress,
		SerialNumber: d.SerialNumber,
		Model:        d.Model,
		Firmware:     d.Firmware,
		DeviceStatus: d.DeviceStatus,
		LinkType:     d.LinkType,
		RadioMode:    d.RadioMode,
		SSID:         d.SSID,
		Bandwidth:    d.Bandwidth,
		Channel:      d.Channel,
		FrequencyMHz: d.FrequencyMHz,
		Latitude:     d.Latitude,
		Longitude:    d.Longitude,
	}
}

// MarshalMobinet converts a Device to Mobinet JSON bytes.
func MarshalMobinet(d Device) ([]byte, error) {
	rec := ToMobinet(d)
	return json.Marshal(rec)
}

// ValidateDevice performs lightweight validation and returns an error for
// structurally invalid messages that should be routed to the DLQ.
func ValidateDevice(d Device) error {
	if d.SerialNumber == "" {
		return fmt.Errorf("missing serialNumber")
	}
	if d.SystemName == "" {
		return fmt.Errorf("missing systemName")
	}
	return nil
}

// ParseInventoryEvent deserialises the raw Kafka message.
func ParseInventoryEvent(data []byte) (InventoryEvent, error) {
	var e InventoryEvent
	if err := json.Unmarshal(data, &e); err != nil {
		return e, fmt.Errorf("parse inventory event: %w", err)
	}
	return e, nil
}
