package consumer

import (
	"encoding/json"
	"fmt"
	"time"
)

// NetcoolAlarm is the exact JSON format required by IBM Netcool OMNIbus.
type NetcoolAlarm struct {
	AlarmID     string      `json:"alarmId"`
	AlarmName   string      `json:"alarmName"`
	Severity    string      `json:"severity"`
	Description string      `json:"alarmDescription"`
	State       string      `json:"state"`
	Time        string      `json:"Time"`
	Data        NetcoolData `json:"data"`
}

// NetcoolData contains device context fields in the Netcool format.
type NetcoolData struct {
	DeviceType string `json:"deviceType"`
	DeviceID   string `json:"deviceId"`
}

// RawAlarm is the internal alarm payload from 'netcool-alarms-forward' topic.
type RawAlarm struct {
	AlarmID     string `json:"alarmId"`
	AlarmName   string `json:"alarmName"`
	Severity    string `json:"severity"`
	Description string `json:"description"`
	State       string `json:"state"`
	Timestamp   string `json:"timestamp"`
	DeviceID    string `json:"deviceId"`
	DeviceType  string `json:"deviceType"`
}

// ToNetcool converts an internal RawAlarm to the Netcool wire format.
func ToNetcool(raw RawAlarm) NetcoolAlarm {
	ts := raw.Timestamp
	if ts == "" {
		ts = time.Now().UTC().Format(time.RFC3339)
	}
	return NetcoolAlarm{
		AlarmID:     raw.AlarmID,
		AlarmName:   raw.AlarmName,
		Severity:    raw.Severity,
		Description: raw.Description,
		State:       raw.State,
		Time:        ts,
		Data: NetcoolData{
			DeviceType: raw.DeviceType,
			DeviceID:   raw.DeviceID,
		},
	}
}

// MarshalNetcool serialises a RawAlarm to Netcool JSON bytes.
func MarshalNetcool(raw RawAlarm) ([]byte, error) {
	n := ToNetcool(raw)
	return json.Marshal(n)
}

// ParseRawAlarm deserialises the Kafka message payload.
func ParseRawAlarm(data []byte) (RawAlarm, error) {
	var a RawAlarm
	if err := json.Unmarshal(data, &a); err != nil {
		return a, fmt.Errorf("parse raw alarm: %w", err)
	}
	return a, nil
}
