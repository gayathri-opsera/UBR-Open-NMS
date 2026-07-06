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
