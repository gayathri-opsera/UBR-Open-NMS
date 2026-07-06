package consumer_test

import (
	"encoding/json"
	"errors"
	"log/slog"
	"os"
	"testing"

	"github.com/ubrnms/mycom-forwarder/internal/consumer"
	"github.com/ubrnms/mycom-forwarder/internal/metrics"
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
		return errors.New("mycom unavailable")
	}
	m.published = append(m.published, data)
	return nil
}

func newLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(os.Stdout, nil))
}

// ── ToMycom format tests ──────────────────────────────────────────────────

func TestToMycomRequiredFields(t *testing.T) {
	p := consumer.KpiPayload{
		DeviceID:    "CPE-001",
		SerialNumber: "SN-ABC123",
		DeviceType:  "CPE",
		ModelNo:     "ENH200EXT",
		Timestamp:   "2026-07-05T10:00:00Z",
		Granularity: "5m",
		Metrics:     map[string]float64{"cpu_usage_pct": 42.5},
	}

	rec := consumer.ToMycom(p)

	if rec.SerialNumber != "SN-ABC123" {
		t.Errorf("expected SN-ABC123, got %s", rec.SerialNumber)
	}
	if rec.DeviceType != "CPE" {
		t.Errorf("expected CPE, got %s", rec.DeviceType)
	}
	if rec.ModelNo != "ENH200EXT" {
		t.Errorf("expected ENH200EXT, got %s", rec.ModelNo)
	}
	if rec.Timestamp != "2026-07-05T10:00:00Z" {
		t.Errorf("expected 2026-07-05T10:00:00Z, got %s", rec.Timestamp)
	}
}

func TestToMycomWirelessRadioPassthrough(t *testing.T) {
	radio := &consumer.RadioKpi{
		TxPowerDBm:   23.0,
		RxPowerDBm:   -65.0,
		SnrDB:        28.5,
		MCSIndex:     9,
		Modulation:   "256-QAM",
		AssocClients: 12,
	}
	p := consumer.KpiPayload{
		SerialNumber:      "SN-BTS001",
		DeviceType:        "BTS",
		ModelNo:           "ENS500EXT",
		Timestamp:         "2026-07-05T11:00:00Z",
		Granularity:       "1h",
		Metrics:           map[string]float64{},
		Wireless5GhzRadio: radio,
	}
	rec := consumer.ToMycom(p)
	if rec.Wireless5GhzRadio == nil {
		t.Fatal("expected wireless5GhzRadio to be non-nil")
	}
	if rec.Wireless5GhzRadio.AssocClients != 12 {
		t.Errorf("expected 12 assoc clients, got %d", rec.Wireless5GhzRadio.AssocClients)
	}
}

func TestToMycomEthernetPortsPassthrough(t *testing.T) {
	ports := []consumer.EthernetPortKpi{
		{Port: "eth0", TxBytes: 1024, RxBytes: 2048, Errors: 0},
		{Port: "eth1", TxBytes: 512, RxBytes: 256, Errors: 1},
	}
	p := consumer.KpiPayload{
		SerialNumber:  "SN-CPE002",
		DeviceType:    "CPE",
		ModelNo:       "EOA7530",
		Timestamp:     "2026-07-05T12:00:00Z",
		Granularity:   "15m",
		Metrics:       map[string]float64{},
		EthernetPorts: ports,
	}
	rec := consumer.ToMycom(p)
	if len(rec.EthernetPorts) != 2 {
		t.Errorf("expected 2 ethernet ports, got %d", len(rec.EthernetPorts))
	}
	if rec.EthernetPorts[0].Port != "eth0" {
		t.Errorf("expected eth0, got %s", rec.EthernetPorts[0].Port)
	}
}

func TestMarshalMycomValidJSON(t *testing.T) {
	p := consumer.KpiPayload{
		SerialNumber: "SN-001",
		DeviceType:   "BTS",
		ModelNo:      "ENS500EXT",
		Timestamp:    "2026-07-05T10:00:00Z",
		Granularity:  "5m",
		Metrics:      map[string]float64{"snr_db": 28.0},
	}
	b, err := consumer.MarshalMycom(p)
	if err != nil {
		t.Fatalf("marshal failed: %v", err)
	}
	var m map[string]interface{}
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	for _, key := range []string{"serialNumber", "deviceType", "modelNo", "timestamp", "granularity", "metrics"} {
		if _, ok := m[key]; !ok {
			t.Errorf("missing key in Mycom JSON: %s", key)
		}
	}
}

// ── Validate tests ──────────────────────────────────────────────────────

func TestValidateKpiPayload_MissingSerialNumber(t *testing.T) {
	p := consumer.KpiPayload{DeviceType: "CPE"}
	if err := consumer.ValidateKpiPayload(p); err == nil {
		t.Error("expected error for missing serialNumber")
	}
}

func TestValidateKpiPayload_MissingDeviceType(t *testing.T) {
	p := consumer.KpiPayload{SerialNumber: "SN-001"}
	if err := consumer.ValidateKpiPayload(p); err == nil {
		t.Error("expected error for missing deviceType")
	}
}

func TestValidateKpiPayload_Valid(t *testing.T) {
	p := consumer.KpiPayload{SerialNumber: "SN-001", DeviceType: "CPE"}
	if err := consumer.ValidateKpiPayload(p); err != nil {
		t.Errorf("unexpected error: %v", err)
	}
}

// ── ParseKpiPayload tests ────────────────────────────────────────────────

func TestParseKpiPayload_Valid(t *testing.T) {
	payload := `{"deviceId":"CPE-001","serialNumber":"SN-ABC","deviceType":"CPE","modelNo":"ENH200EXT","timestamp":"2026-07-05T10:00:00Z","granularity":"5m","metrics":{"cpu_usage_pct":42.5}}`
	p, err := consumer.ParseKpiPayload([]byte(payload))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if p.SerialNumber != "SN-ABC" {
		t.Errorf("expected SN-ABC, got %s", p.SerialNumber)
	}
	if p.Metrics["cpu_usage_pct"] != 42.5 {
		t.Errorf("expected 42.5, got %f", p.Metrics["cpu_usage_pct"])
	}
}

func TestParseKpiPayload_Invalid(t *testing.T) {
	_, err := consumer.ParseKpiPayload([]byte("not-json"))
	if err == nil {
		t.Error("expected parse error for invalid JSON")
	}
}

// ── Forwarder tests ──────────────────────────────────────────────────────

func validPayload() []byte {
	p := consumer.KpiPayload{
		DeviceID:    "CPE-001",
		SerialNumber: "SN-TEST1",
		DeviceType:  "CPE",
		ModelNo:     "ENH200EXT",
		Timestamp:   "2026-07-05T10:00:00Z",
		Granularity: "5m",
		Metrics:     map[string]float64{"cpu": 10},
	}
	b, _ := json.Marshal(p)
	return b
}

func TestForwarderProcessMessage_Success(t *testing.T) {
	cfg := consumer.LoadConfig()
	sink := &mockSink{}
	fwd := consumer.NewForwarderWithSink(cfg, newLogger(), sink)

	if err := fwd.ProcessMessage(validPayload()); err != nil {
		t.Errorf("expected no error, got %v", err)
	}
	if len(sink.published) != 1 {
		t.Errorf("expected 1 published message, got %d", len(sink.published))
	}
}

func TestForwarderProcessMessage_DLQOnParseFail(t *testing.T) {
	cfg := consumer.LoadConfig()
	dlqSink := &mockSink{}
	fwd := consumer.NewForwarderWithSink(cfg, newLogger(), &mockSink{})
	fwd.SetDLQSink(dlqSink)

	if err := fwd.ProcessMessage([]byte("not-json")); err != nil {
		t.Errorf("expected nil (DLQ absorbs), got %v", err)
	}
	if len(dlqSink.published) != 1 {
		t.Errorf("expected 1 DLQ message, got %d", len(dlqSink.published))
	}
}

func TestForwarderProcessMessage_DLQOnValidationFail(t *testing.T) {
	cfg := consumer.LoadConfig()
	dlqSink := &mockSink{}
	fwd := consumer.NewForwarderWithSink(cfg, newLogger(), &mockSink{})
	fwd.SetDLQSink(dlqSink)

	// Missing serialNumber → validation failure
	p, _ := json.Marshal(consumer.KpiPayload{DeviceType: "CPE", Granularity: "5m"})
	if err := fwd.ProcessMessage(p); err != nil {
		t.Errorf("expected nil (DLQ absorbs), got %v", err)
	}
	if len(dlqSink.published) != 1 {
		t.Errorf("expected 1 DLQ message, got %d", len(dlqSink.published))
	}
}

func TestForwarderRetry_SucceedsAfterTransientFailure(t *testing.T) {
	cfg := consumer.LoadConfig()
	sink := &mockSink{failUntil: 2}
	fwd := consumer.NewForwarderWithSink(cfg, newLogger(), sink)

	if err := fwd.ProcessMessage(validPayload()); err != nil {
		t.Errorf("expected nil after retry success, got %v", err)
	}
	if len(sink.published) != 1 {
		t.Errorf("expected 1 published message after retry, got %d", len(sink.published))
	}
}

func TestForwarderDLQ_WhenAllRetriesExhausted(t *testing.T) {
	cfg := consumer.LoadConfig()
	cfg.MaxRetries = 2
	mainSink := &mockSink{failUntil: 999}
	dlqSink := &mockSink{}
	fwd := consumer.NewForwarderWithSink(cfg, newLogger(), mainSink)
	fwd.SetDLQSink(dlqSink)

	_ = fwd.ProcessMessage(validPayload())

	if len(mainSink.published) > 0 {
		t.Errorf("expected 0 forwarded, got %d", len(mainSink.published))
	}
	if len(dlqSink.published) != 1 {
		t.Errorf("expected 1 DLQ message, got %d", len(dlqSink.published))
	}
}
