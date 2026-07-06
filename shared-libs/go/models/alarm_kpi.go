package models

import "time"

type AlarmSeverity string
type AlarmState string

const (
	AlarmSeverityCritical      AlarmSeverity = "CRITICAL"
	AlarmSeverityMajor         AlarmSeverity = "MAJOR"
	AlarmSeverityMinor         AlarmSeverity = "MINOR"
	AlarmSeverityWarning       AlarmSeverity = "WARNING"
	AlarmSeverityIndeterminate AlarmSeverity = "INDETERMINATE"
	AlarmSeverityCleared       AlarmSeverity = "CLEARED"

	AlarmStateRaised       AlarmState = "RAISED"
	AlarmStateAcknowledged AlarmState = "ACKNOWLEDGED"
	AlarmStateCleared      AlarmState = "CLEARED"
)

type AlarmRecord struct {
	AlarmID          string        `json:"alarmId"`
	DeviceID         string        `json:"deviceId"`
	DeviceType       DeviceType    `json:"deviceType,omitempty"`
	AlarmName        string        `json:"alarmName"`
	AlarmDescription string        `json:"alarmDescription,omitempty"`
	Severity         AlarmSeverity `json:"severity"`
	State            AlarmState    `json:"state"`
	CorrelationGroup string        `json:"correlationGroup,omitempty"`
	RootCause        string        `json:"rootCause,omitempty"`
	Acknowledged     bool          `json:"acknowledged"`
	AcknowledgedBy   *string       `json:"acknowledgedBy"`
	RaisedAt         time.Time     `json:"raisedAt"`
	ClearedAt        *time.Time    `json:"clearedAt"`
	TTLExpiry        *time.Time    `json:"ttlExpiry,omitempty"`
}

type KPIGranularity string

const (
	KPIGranularityRaw    KPIGranularity = "raw"
	KPIGranularity15Min  KPIGranularity = "15min"
	KPIGranularity1Hour  KPIGranularity = "1hour"
	KPIGranularityDaily  KPIGranularity = "daily"
)

type KPIDataPoint struct {
	DeviceID     string         `json:"deviceId"`
	SerialNumber string         `json:"serialNumber,omitempty"`
	DeviceType   DeviceType     `json:"deviceType,omitempty"`
	KPIName      string         `json:"kpiName"`
	Value        float64        `json:"value"`
	Unit         string         `json:"unit,omitempty"`
	PollInterval int            `json:"pollInterval,omitempty"`
	Timestamp    time.Time      `json:"timestamp"`
	Granularity  KPIGranularity `json:"granularity,omitempty"`
}
