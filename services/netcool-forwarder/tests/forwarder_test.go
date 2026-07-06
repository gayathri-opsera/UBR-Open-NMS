package consumer_test

import (
	"encoding/json"
	"errors"
	"testing"
	"log/slog"
	"os"

	"github.com/ubrnms/netcool-forwarder/internal/consumer"
	"github.com/ubrnms/netcool-forwarder/internal/metrics"
)

func TestMain(m *testing.M) {
	metrics.Register()
	os.Exit(m.Run())
}

// mockSink captures published messages and optionally returns errors.
type mockSink struct {
	published [][]byte
	failUntil int // fail this many calls, then succeed
	calls     int
}

func (m *mockSink) Publish(_ string, data []byte) error {
	m.calls++
	if m.calls <= m.failUntil {
		return errors.New("netcool unavailable")
	}
	m.published = append(m.published, data)
	return nil
}

func newLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(os.Stdout, nil))
}

// ── ToNetcool format tests ─────────────────────────────────────────────────

func TestToNetcoolFormat(t *testing.T) {
	raw := consumer.RawAlarm{
		AlarmID:    "AL-001",
		AlarmName:  "Link Down",
		Severity:   "CRITICAL",
		Description: "Interface down",
		State:      "ACTIVE",
		Timestamp:  "2026-07-05T12:00:00Z",
		DeviceID:   "CPE-001",
		DeviceType: "CPE",
	}

	n := consumer.ToNetcool(raw)
	if n.AlarmID != "AL-001" {
		t.Errorf("expected AlarmID AL-001, got %s", n.AlarmID)
	}
	if n.State != "ACTIVE" {
		t.Errorf("expected State ACTIVE, got %s", n.State)
	}
	if n.Data.DeviceID != "CPE-001" {
		t.Errorf("expected DeviceID CPE-001, got %s", n.Data.DeviceID)
	}
	if n.Time != "2026-07-05T12:00:00Z" {
		t.Errorf("expected Time 2026-07-05T12:00:00Z, got %s", n.Time)
	}
}

func TestToNetcoolClearState(t *testing.T) {
	raw := consumer.RawAlarm{
		AlarmID:    "AL-001",
		AlarmName:  "Link Down",
		Severity:   "CLEAR",
		State:      "CLEAR",
		DeviceID:   "CPE-001",
		DeviceType: "CPE",
	}
	n := consumer.ToNetcool(raw)
	if n.State != "CLEAR" {
		t.Errorf("clear alarm must have State=CLEAR, got %s", n.State)
	}
}

func TestMarshalNetcoolValidJSON(t *testing.T) {
	raw := consumer.RawAlarm{
		AlarmID: "AL-002", AlarmName: "High CPU", Severity: "MAJOR",
		State: "ACTIVE", DeviceID: "BTS-001", DeviceType: "BTS",
	}
	b, err := consumer.MarshalNetcool(raw)
	if err != nil {
		t.Fatalf("marshal failed: %v", err)
	}
	var m map[string]interface{}
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	// Check top-level keys
	for _, key := range []string{"alarmId", "alarmName", "severity", "alarmDescription", "state", "Time", "data"} {
		if _, ok := m[key]; !ok {
			t.Errorf("missing key in Netcool JSON: %s", key)
		}
	}
}

func TestParseRawAlarmValid(t *testing.T) {
	payload := `{"alarmId":"AL-003","alarmName":"Low SNR","severity":"MINOR","state":"ACTIVE","deviceId":"CPE-002","deviceType":"CPE"}`
	a, err := consumer.ParseRawAlarm([]byte(payload))
	if err != nil {
		t.Fatalf("parse failed: %v", err)
	}
	if a.AlarmID != "AL-003" {
		t.Errorf("expected AL-003, got %s", a.AlarmID)
	}
}

func TestParseRawAlarmInvalid(t *testing.T) {
	_, err := consumer.ParseRawAlarm([]byte("not-json"))
	if err == nil {
		t.Error("expected parse error for invalid JSON")
	}
}

// ── Forwarder with mock sink ────────────────────────────────────────────────

func TestForwarderProcessMessage_Success(t *testing.T) {
	cfg := consumer.LoadConfig()
	sink := &mockSink{}
	fwd := consumer.NewForwarderWithSink(cfg, newLogger(), sink)

	raw := consumer.RawAlarm{
		AlarmID: "AL-004", AlarmName: "Link Down", Severity: "CRITICAL",
		State: "ACTIVE", DeviceID: "CPE-003", DeviceType: "CPE",
	}
	payload, _ := json.Marshal(raw)

	err := fwd.ProcessMessage(payload)
	if err != nil {
		t.Errorf("expected no error, got %v", err)
	}
	if len(sink.published) != 1 {
		t.Errorf("expected 1 published message, got %d", len(sink.published))
	}
}

func TestForwarderProcessMessage_DLQOnParseFail(t *testing.T) {
	cfg := consumer.LoadConfig()
	dlqSink := &mockSink{}
	fwd := consumer.NewForwarderWithSink(cfg, newLogger(), dlqSink)
	fwd.SetDLQSink(dlqSink)

	err := fwd.ProcessMessage([]byte("not-json"))
	// Error goes to DLQ — function should return nil (no re-queue)
	if err != nil {
		t.Errorf("expected nil error on parse fail (DLQ), got %v", err)
	}
}

func TestForwarderRetry_SucceedsAfterTransientFailure(t *testing.T) {
	cfg := consumer.LoadConfig()
	sink := &mockSink{failUntil: 2} // fail 2 times, succeed on 3rd
	fwd := consumer.NewForwarderWithSink(cfg, newLogger(), sink)

	raw := consumer.RawAlarm{
		AlarmID: "AL-005", AlarmName: "High CPU", Severity: "MAJOR",
		State: "ACTIVE", DeviceID: "BTS-001", DeviceType: "BTS",
	}
	payload, _ := json.Marshal(raw)

	err := fwd.ProcessMessage(payload)
	if err != nil {
		t.Errorf("expected nil after retry success, got %v", err)
	}
	if len(sink.published) != 1 {
		t.Errorf("expected 1 published message after retry, got %d", len(sink.published))
	}
}

func TestForwarderDLQ_WhenAllRetriesExhausted(t *testing.T) {
	cfg := consumer.LoadConfig()
	cfg.MaxRetries = 2
	mainSink := &mockSink{failUntil: 999} // always fail
	dlqSink := &mockSink{}
	fwd := consumer.NewForwarderWithSink(cfg, newLogger(), mainSink)
	fwd.SetDLQSink(dlqSink)

	raw := consumer.RawAlarm{
		AlarmID: "AL-006", AlarmName: "Critical", Severity: "CRITICAL",
		State: "ACTIVE", DeviceID: "CPE-004", DeviceType: "CPE",
	}
	payload, _ := json.Marshal(raw)

	_ = fwd.ProcessMessage(payload)
	// Main sink should not have received the message
	if len(mainSink.published) > 0 {
		t.Errorf("expected 0 forwarded, got %d", len(mainSink.published))
	}
	// DLQ should have received the message
	if len(dlqSink.published) != 1 {
		t.Errorf("expected 1 DLQ message, got %d", len(dlqSink.published))
	}
}
