package consumer_test

import (
	"encoding/json"
	"errors"
	"log/slog"
	"os"
	"testing"

	"github.com/ubrnms/mobinet-sync/internal/consumer"
	"github.com/ubrnms/mobinet-sync/internal/metrics"
)

func TestMain(m *testing.M) {
	metrics.Register()
	os.Exit(m.Run())
}

// mockSink captures published messages and optionally returns errors.
type mockSink struct {
	published [][]byte
	failUntil int
	calls     int
}

func (m *mockSink) Publish(_ string, data []byte) error {
	m.calls++
	if m.calls <= m.failUntil {
		return errors.New("mobinet unavailable")
	}
	m.published = append(m.published, data)
	return nil
}

func newLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(os.Stdout, nil))
}

// ── ToMobinet format tests ────────────────────────────────────────────────

func TestToMobinetRequiredFields(t *testing.T) {
	d := consumer.Device{
		SystemName:   "CPE-Nairobi-001",
		IPAddress:    "10.1.2.3",
		MacAddress:   "AA:BB:CC:DD:EE:FF",
		SerialNumber: "SN-001",
		Model:        "ENH200EXT",
		Firmware:     "2.1.3",
		DeviceStatus: "ACTIVE",
		LinkType:     "wireless",
		RadioMode:    "5GHz",
		SSID:         "UBR-Backhaul",
		Bandwidth:    "80MHz",
		Channel:      36,
		FrequencyMHz: 5180.0,
		Latitude:     -1.286389,
		Longitude:    36.817223,
	}

	rec := consumer.ToMobinet(d)

	if rec.SerialNumber != "SN-001" {
		t.Errorf("expected SN-001, got %s", rec.SerialNumber)
	}
	if rec.SystemName != "CPE-Nairobi-001" {
		t.Errorf("expected CPE-Nairobi-001, got %s", rec.SystemName)
	}
}

func TestToMobinetLatLonAreFloats(t *testing.T) {
	d := consumer.Device{
		SerialNumber: "SN-002",
		SystemName:   "BTS-001",
		Latitude:     -1.286389,
		Longitude:    36.817223,
	}
	rec := consumer.ToMobinet(d)

	// Verify latitude/longitude are non-zero and preserved as floats
	if rec.Latitude == 0 {
		t.Error("expected non-zero latitude")
	}
	if rec.Longitude == 0 {
		t.Error("expected non-zero longitude")
	}
	// Marshal and verify JSON number type (not string)
	b, _ := json.Marshal(rec)
	var m map[string]interface{}
	_ = json.Unmarshal(b, &m)
	if _, ok := m["latitude"].(float64); !ok {
		t.Errorf("latitude must be JSON number (float64), got %T", m["latitude"])
	}
	if _, ok := m["longitude"].(float64); !ok {
		t.Errorf("longitude must be JSON number (float64), got %T", m["longitude"])
	}
}

func TestMarshalMobinetValidJSON(t *testing.T) {
	d := consumer.Device{
		SystemName:   "BTS-001",
		IPAddress:    "10.0.0.1",
		MacAddress:   "00:11:22:33:44:55",
		SerialNumber: "SN-003",
		Model:        "ENS500EXT",
		Firmware:     "3.0.0",
		DeviceStatus: "ACTIVE",
		LinkType:     "wireless",
		RadioMode:    "5GHz",
		Bandwidth:    "80MHz",
		Channel:      149,
		FrequencyMHz: 5745.0,
		Latitude:     -1.3,
		Longitude:    36.8,
	}
	b, err := consumer.MarshalMobinet(d)
	if err != nil {
		t.Fatalf("marshal failed: %v", err)
	}
	var m map[string]interface{}
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	expectedKeys := []string{
		"systemName", "ipAddress", "macAddress", "serialNumber", "model",
		"firmware", "deviceStatus", "linkType", "radioMode", "ssid",
		"bandwidth", "channel", "frequencyMHz", "latitude", "longitude",
	}
	for _, key := range expectedKeys {
		if _, ok := m[key]; !ok {
			t.Errorf("missing key in Mobinet JSON: %s", key)
		}
	}
}

// ── Validate tests ────────────────────────────────────────────────────────

func TestValidateDevice_MissingSerialNumber(t *testing.T) {
	d := consumer.Device{SystemName: "BTS-001"}
	if err := consumer.ValidateDevice(d); err == nil {
		t.Error("expected error for missing serialNumber")
	}
}

func TestValidateDevice_MissingSystemName(t *testing.T) {
	d := consumer.Device{SerialNumber: "SN-001"}
	if err := consumer.ValidateDevice(d); err == nil {
		t.Error("expected error for missing systemName")
	}
}

func TestValidateDevice_Valid(t *testing.T) {
	d := consumer.Device{SerialNumber: "SN-001", SystemName: "BTS-001"}
	if err := consumer.ValidateDevice(d); err != nil {
		t.Errorf("unexpected error: %v", err)
	}
}

// ── ParseInventoryEvent tests ─────────────────────────────────────────────

func TestParseInventoryEvent_Valid(t *testing.T) {
	payload := `{"deviceId":"CPE-001","eventType":"UPSERT","device":{"serialNumber":"SN-001","systemName":"BTS-001"}}`
	e, err := consumer.ParseInventoryEvent([]byte(payload))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if e.DeviceID != "CPE-001" {
		t.Errorf("expected CPE-001, got %s", e.DeviceID)
	}
	if e.Device == nil {
		t.Fatal("expected non-nil device")
	}
}

func TestParseInventoryEvent_Invalid(t *testing.T) {
	_, err := consumer.ParseInventoryEvent([]byte("not-json"))
	if err == nil {
		t.Error("expected parse error for invalid JSON")
	}
}

// ── Syncer tests ──────────────────────────────────────────────────────────

func validUpsertPayload() []byte {
	e := consumer.InventoryEvent{
		DeviceID:  "CPE-001",
		EventType: "UPSERT",
		Device: &consumer.Device{
			SerialNumber: "SN-TEST1",
			SystemName:   "CPE-Nairobi-001",
			IPAddress:    "10.1.2.3",
			MacAddress:   "AA:BB:CC:DD:EE:FF",
			Model:        "ENH200EXT",
			Firmware:     "2.1.3",
			DeviceStatus: "ACTIVE",
			Latitude:     -1.286389,
			Longitude:    36.817223,
		},
	}
	b, _ := json.Marshal(e)
	return b
}

func TestSyncerProcessMessage_Success(t *testing.T) {
	cfg := consumer.LoadConfig()
	sink := &mockSink{}
	syncer := consumer.NewSyncerWithSink(cfg, newLogger(), sink)

	if err := syncer.ProcessMessage(validUpsertPayload()); err != nil {
		t.Errorf("expected no error, got %v", err)
	}
	if len(sink.published) != 1 {
		t.Errorf("expected 1 published message, got %d", len(sink.published))
	}
}

func TestSyncerProcessMessage_DLQOnParseFail(t *testing.T) {
	cfg := consumer.LoadConfig()
	dlqSink := &mockSink{}
	syncer := consumer.NewSyncerWithSink(cfg, newLogger(), &mockSink{})
	syncer.SetDLQSink(dlqSink)

	if err := syncer.ProcessMessage([]byte("not-json")); err != nil {
		t.Errorf("expected nil (DLQ absorbs), got %v", err)
	}
	if len(dlqSink.published) != 1 {
		t.Errorf("expected 1 DLQ message, got %d", len(dlqSink.published))
	}
}

func TestSyncerProcessMessage_DLQOnValidationFail(t *testing.T) {
	cfg := consumer.LoadConfig()
	dlqSink := &mockSink{}
	syncer := consumer.NewSyncerWithSink(cfg, newLogger(), &mockSink{})
	syncer.SetDLQSink(dlqSink)

	// Missing serialNumber → validation failure
	e := consumer.InventoryEvent{
		DeviceID:  "CPE-002",
		EventType: "UPSERT",
		Device:    &consumer.Device{SystemName: "CPE-002"},
	}
	payload, _ := json.Marshal(e)

	if err := syncer.ProcessMessage(payload); err != nil {
		t.Errorf("expected nil (DLQ absorbs), got %v", err)
	}
	if len(dlqSink.published) != 1 {
		t.Errorf("expected 1 DLQ message, got %d", len(dlqSink.published))
	}
}

func TestSyncerProcessMessage_DeleteEventIgnored(t *testing.T) {
	cfg := consumer.LoadConfig()
	mainSink := &mockSink{}
	syncer := consumer.NewSyncerWithSink(cfg, newLogger(), mainSink)

	e := consumer.InventoryEvent{
		DeviceID:  "CPE-003",
		EventType: "DELETE",
	}
	payload, _ := json.Marshal(e)

	if err := syncer.ProcessMessage(payload); err != nil {
		t.Errorf("expected nil for delete event stub, got %v", err)
	}
	// Delete events should not be forwarded to Mobinet
	if len(mainSink.published) > 0 {
		t.Errorf("delete events must not be forwarded, got %d", len(mainSink.published))
	}
}

func TestSyncerRetry_SucceedsAfterTransientFailure(t *testing.T) {
	cfg := consumer.LoadConfig()
	sink := &mockSink{failUntil: 2}
	syncer := consumer.NewSyncerWithSink(cfg, newLogger(), sink)

	if err := syncer.ProcessMessage(validUpsertPayload()); err != nil {
		t.Errorf("expected nil after retry success, got %v", err)
	}
	if len(sink.published) != 1 {
		t.Errorf("expected 1 published message after retry, got %d", len(sink.published))
	}
}

func TestSyncerDLQ_WhenAllRetriesExhausted(t *testing.T) {
	cfg := consumer.LoadConfig()
	cfg.MaxRetries = 2
	mainSink := &mockSink{failUntil: 999}
	dlqSink := &mockSink{}
	syncer := consumer.NewSyncerWithSink(cfg, newLogger(), mainSink)
	syncer.SetDLQSink(dlqSink)

	_ = syncer.ProcessMessage(validUpsertPayload())

	if len(mainSink.published) > 0 {
		t.Errorf("expected 0 forwarded, got %d", len(mainSink.published))
	}
	if len(dlqSink.published) != 1 {
		t.Errorf("expected 1 DLQ message, got %d", len(dlqSink.published))
	}
}
