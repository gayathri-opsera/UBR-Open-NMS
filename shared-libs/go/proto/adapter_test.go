package proto

import (
	"testing"
	"time"

	"github.com/airtel-ubrnms/shared-libs/models"
)

// ── DeviceEntity ──────────────────────────────────────────────────────────────

func TestDeviceEntityRoundTrip(t *testing.T) {
	bts := "BTS-001"
	original := models.DeviceEntity{
		DeviceID:           "dev-001",
		SerialNumber:       "SN-001",
		MacAddress:         "AA:BB:CC:DD:EE:FF",
		IPAddress:          "10.0.0.1",
		DeviceType:         models.DeviceTypeBTS,
		Status:             models.DeviceStatusOnline,
		Model:              "NR-3500",
		Region:             "North",
		UptimeSeconds:      3600,
		ConnectedBTSSerial: &bts,
		ConnectedCPECount:  5,
		OrganizationID:     "org-001",
		CreatedAt:          time.UnixMilli(1_700_000_000_000).UTC(),
		UpdatedAt:          time.UnixMilli(1_700_000_001_000).UTC(),
	}

	proto := DeviceEntityToProtoMap(original)
	result := DeviceEntityFromProtoMap(proto)

	if result.DeviceID != original.DeviceID {
		t.Errorf("DeviceID: got %q want %q", result.DeviceID, original.DeviceID)
	}
	if result.IPAddress != original.IPAddress {
		t.Errorf("IPAddress: got %q want %q", result.IPAddress, original.IPAddress)
	}
	if result.UptimeSeconds != original.UptimeSeconds {
		t.Errorf("UptimeSeconds: got %d want %d", result.UptimeSeconds, original.UptimeSeconds)
	}
	if result.ConnectedBTSSerial == nil || *result.ConnectedBTSSerial != *original.ConnectedBTSSerial {
		t.Errorf("ConnectedBTSSerial: got %v want %v", result.ConnectedBTSSerial, original.ConnectedBTSSerial)
	}
	if !result.CreatedAt.Equal(original.CreatedAt) {
		t.Errorf("CreatedAt: got %v want %v", result.CreatedAt, original.CreatedAt)
	}
	if result.ConnectedCPECount != original.ConnectedCPECount {
		t.Errorf("ConnectedCPECount: got %d want %d", result.ConnectedCPECount, original.ConnectedCPECount)
	}
}

func TestDeviceEntityToProtoMap_NilConnectedBTS_BecomesEmptyString(t *testing.T) {
	d := models.DeviceEntity{
		DeviceID:     "dev-002",
		SerialNumber: "SN-002",
		MacAddress:   "AA:BB:CC:DD:EE:02",
		DeviceType:   models.DeviceTypeCPE,
		Status:       models.DeviceStatusOffline,
		// ConnectedBTSSerial intentionally nil
	}
	m := DeviceEntityToProtoMap(d)
	if m.ConnectedBTSSerial != "" {
		t.Errorf("expected empty string for nil ConnectedBTSSerial, got %q", m.ConnectedBTSSerial)
	}
}

func TestDeviceEntityFromProtoMap_EmptyBTSSerial_BecomesNilPointer(t *testing.T) {
	// Proto map with empty string for ConnectedBTSSerial (proto default).
	m := DeviceProtoMap{
		DeviceID:           "dev-003",
		SerialNumber:       "SN-003",
		MacAddress:         "AA:BB:CC:DD:EE:03",
		Status:             "online",
		ConnectedBTSSerial: "", // proto absent / default
	}
	result := DeviceEntityFromProtoMap(m)
	if result.ConnectedBTSSerial != nil {
		t.Errorf("expected nil pointer for empty proto string, got %v", *result.ConnectedBTSSerial)
	}
}

func TestDeviceEntityToProtoMap_ZeroTimestamp_ResultsInZeroMilli(t *testing.T) {
	d := models.DeviceEntity{
		DeviceID:   "dev-004",
		MacAddress: "AA:BB:CC:DD:EE:04",
		// CreatedAt and UpdatedAt are zero values
	}
	m := DeviceEntityToProtoMap(d)
	if m.CreatedAtMilli != 0 {
		t.Errorf("zero CreatedAt should produce 0 milli, got %d", m.CreatedAtMilli)
	}
	if m.UpdatedAtMilli != 0 {
		t.Errorf("zero UpdatedAt should produce 0 milli, got %d", m.UpdatedAtMilli)
	}
}

func TestDeviceEntityFromProtoMap_ZeroMilli_ResultsInZeroTime(t *testing.T) {
	m := DeviceProtoMap{
		DeviceID:       "dev-005",
		MacAddress:     "AA:BB:CC:DD:EE:05",
		CreatedAtMilli: 0, // proto absent
	}
	result := DeviceEntityFromProtoMap(m)
	if !result.CreatedAt.IsZero() {
		t.Errorf("milli=0 should produce zero time.Time, got %v", result.CreatedAt)
	}
}

// ── AlarmRecord ───────────────────────────────────────────────────────────────

func TestAlarmRecordRoundTrip(t *testing.T) {
	ackBy := "operator@example.com"
	clearedAt := time.UnixMilli(1_700_000_002_000).UTC()
	original := models.AlarmRecord{
		AlarmID:          "alarm-001",
		DeviceID:         "dev-001",
		AlarmName:        "LINK_DOWN",
		AlarmDescription: "Link is down",
		Severity:         models.AlarmSeverityCritical,
		State:            models.AlarmStateRaised,
		Acknowledged:     true,
		AcknowledgedBy:   &ackBy,
		RaisedAt:         time.UnixMilli(1_700_000_000_000).UTC(),
		ClearedAt:        &clearedAt,
	}

	proto := AlarmRecordToProtoMap(original)
	result := AlarmRecordFromProtoMap(proto)

	if result.AlarmID != original.AlarmID {
		t.Errorf("AlarmID: got %q want %q", result.AlarmID, original.AlarmID)
	}
	if result.Severity != original.Severity {
		t.Errorf("Severity: got %q want %q", result.Severity, original.Severity)
	}
	if result.AcknowledgedBy == nil || *result.AcknowledgedBy != ackBy {
		t.Errorf("AcknowledgedBy: got %v want %q", result.AcknowledgedBy, ackBy)
	}
	if !result.RaisedAt.Equal(original.RaisedAt) {
		t.Errorf("RaisedAt: got %v want %v", result.RaisedAt, original.RaisedAt)
	}
	if result.ClearedAt == nil || !result.ClearedAt.Equal(clearedAt) {
		t.Errorf("ClearedAt: got %v want %v", result.ClearedAt, clearedAt)
	}
}

func TestAlarmRecordFromProtoMap_NilAcknowledgedBy_WhenEmpty(t *testing.T) {
	m := AlarmProtoMap{
		AlarmID:        "alarm-002",
		DeviceID:       "dev-001",
		AlarmName:      "CPU_HIGH",
		Severity:       "MAJOR",
		State:          "RAISED",
		AcknowledgedBy: "", // proto absent / default
		RaisedAtMilli:  1_700_000_000_000,
	}
	result := AlarmRecordFromProtoMap(m)
	if result.AcknowledgedBy != nil {
		t.Errorf("empty acknowledgedBy should be nil pointer, got %v", *result.AcknowledgedBy)
	}
	if result.ClearedAt != nil {
		t.Errorf("zero clearedAtMilli should produce nil ClearedAt, got %v", result.ClearedAt)
	}
}
