// Package model defines the Discovery Service domain types.
package model

import "time"

// CheckInRequest is the device self-registration payload.
type CheckInRequest struct {
	SerialNumber    string    `json:"serialNumber"`
	MACAddress      string    `json:"macAddress"`
	IPAddress       string    `json:"ipAddress"`
	DeviceType      string    `json:"deviceType"`
	SoftwareVersion string    `json:"softwareVersion"`
	Latitude        float64   `json:"latitude"`
	Longitude       float64   `json:"longitude"`
	Azimuth         float64   `json:"azimuth"`
	UptimeSeconds   int64     `json:"uptimeSeconds"`
	Timestamp       time.Time `json:"timestamp"`
	Signature       string    `json:"signature"` // HMAC-SHA256 hex of canonical request body
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
