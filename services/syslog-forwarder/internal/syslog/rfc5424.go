package syslog

import (
	"encoding/json"
	"fmt"
	"time"
)

// RFC 5424 syslog severity levels.
const (
	SevEmergency = 0
	SevAlert     = 1
	SevCritical  = 2
	SevError     = 3
	SevWarning   = 4
	SevNotice    = 5
	SevInfo      = 6
	SevDebug     = 7
)

// NMSSeverityMap maps NMS alarm severity names to RFC 5424 severity numbers.
var NMSSeverityMap = map[string]int{
	"CRITICAL": SevCritical,
	"MAJOR":    SevError,
	"MINOR":    SevWarning,
	"WARNING":  SevWarning,
	"INFO":     SevInfo,
	"CLEAR":    SevNotice,
	"DEBUG":    SevDebug,
}

// NMSEventTypeMap maps NMS event types to RFC 5424 severities when no alarm
// severity is present.
var NMSEventTypeMap = map[string]int{
	"ALARM":         SevError,
	"STATE_CHANGE":  SevNotice,
	"CONFIG_CHANGE": SevNotice,
	"HEARTBEAT":     SevInfo,
}

// OperationalEvent is the internal payload from the 'operational-events' topic.
type OperationalEvent struct {
	EventID   string `json:"eventId"`
	EventType string `json:"eventType"`
	Severity  string `json:"severity,omitempty"`
	Message   string `json:"message"`
	DeviceID  string `json:"deviceId,omitempty"`
	Timestamp string `json:"timestamp,omitempty"`
	AppName   string `json:"appName,omitempty"`
}

// ParseEvent deserialises the raw Kafka message.
func ParseEvent(data []byte) (OperationalEvent, error) {
	var e OperationalEvent
	if err := json.Unmarshal(data, &e); err != nil {
		return e, fmt.Errorf("parse operational event: %w", err)
	}
	return e, nil
}

// MapSeverity returns the RFC 5424 severity for the given NMS severity and
// event type, falling back to SevInfo if unknown.
func MapSeverity(nmsSeverity, eventType string) int {
	if sev, ok := NMSSeverityMap[nmsSeverity]; ok {
		return sev
	}
	if sev, ok := NMSEventTypeMap[eventType]; ok {
		return sev
	}
	return SevInfo
}

// FormatRFC5424 formats an OperationalEvent as an RFC 5424 syslog message.
//
// Format: <PRI>VERSION TIMESTAMP HOSTNAME APP-NAME PROCID MSGID STRUCTURED-DATA MSG
func FormatRFC5424(facility int, e OperationalEvent) string {
	severity := MapSeverity(e.Severity, e.EventType)
	pri := facility*8 + severity

	ts := e.Timestamp
	if ts == "" {
		ts = time.Now().UTC().Format(time.RFC3339)
	}

	hostname := e.DeviceID
	if hostname == "" {
		hostname = "-"
	}

	appName := e.AppName
	if appName == "" {
		appName = "ubr-nms"
	}

	// RFC 5424: <PRI>1 TIMESTAMP HOSTNAME APP-NAME PROCID MSGID STRUCTURED-DATA MSG
	return fmt.Sprintf("<%d>1 %s %s %s - %s - %s",
		pri, ts, hostname, appName, e.EventID, e.Message)
}
