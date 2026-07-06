package consumer_test

import (
	"encoding/json"
	"errors"
	"log/slog"
	"os"
	"strings"
	"testing"

	"github.com/ubrnms/syslog-forwarder/internal/consumer"
	syslogfmt "github.com/ubrnms/syslog-forwarder/internal/syslog"
	"github.com/ubrnms/syslog-forwarder/internal/metrics"
)

func TestMain(m *testing.M) {
	metrics.Register()
	os.Exit(m.Run())
}

// mockWriter captures written messages and optionally simulates failures.
type mockWriter struct {
	written   []string
	failUntil int
	calls     int
	closed    bool
}

func (w *mockWriter) Write(msg string) error {
	w.calls++
	if w.calls <= w.failUntil {
		return errors.New("syslog unreachable")
	}
	w.written = append(w.written, msg)
	return nil
}

func (w *mockWriter) Close() error {
	w.closed = true
	return nil
}

func newLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(os.Stdout, nil))
}

// ── RFC 5424 formatting tests ─────────────────────────────────────────────

func TestFormatRFC5424_StructuredFormat(t *testing.T) {
	e := syslogfmt.OperationalEvent{
		EventID:   "EVT-001",
		EventType: "ALARM",
		Severity:  "CRITICAL",
		Message:   "Link down on CPE-001",
		DeviceID:  "CPE-001",
		Timestamp: "2026-07-05T10:00:00Z",
		AppName:   "alarm-service",
	}
	msg := syslogfmt.FormatRFC5424(16, e) // facility 16 = local0

	// PRI = facility(16)*8 + severity(2=critical) = 130
	if !strings.HasPrefix(msg, "<130>1 ") {
		t.Errorf("expected <130>1 prefix, got: %s", msg[:min(20, len(msg))])
	}
	if !strings.Contains(msg, "CPE-001") {
		t.Error("expected hostname CPE-001 in message")
	}
	if !strings.Contains(msg, "alarm-service") {
		t.Error("expected app-name alarm-service in message")
	}
	if !strings.Contains(msg, "EVT-001") {
		t.Error("expected event ID in message")
	}
	if !strings.Contains(msg, "Link down on CPE-001") {
		t.Error("expected message body in output")
	}
}

func TestFormatRFC5424_DefaultsWhenFieldsMissing(t *testing.T) {
	e := syslogfmt.OperationalEvent{
		EventID:  "EVT-002",
		Message:  "test message",
		Severity: "INFO",
	}
	msg := syslogfmt.FormatRFC5424(16, e)
	// hostname should be "-"
	if !strings.Contains(msg, " - ") {
		t.Errorf("expected '-' hostname in message: %s", msg)
	}
	// appName defaults to "ubr-nms"
	if !strings.Contains(msg, "ubr-nms") {
		t.Errorf("expected default appName ubr-nms: %s", msg)
	}
}

// ── Severity mapping tests ────────────────────────────────────────────────

func TestMapSeverity_KnownNMSSeverities(t *testing.T) {
	tests := []struct {
		severity string
		expected int
	}{
		{"CRITICAL", syslogfmt.SevCritical},
		{"MAJOR", syslogfmt.SevError},
		{"MINOR", syslogfmt.SevWarning},
		{"WARNING", syslogfmt.SevWarning},
		{"INFO", syslogfmt.SevInfo},
		{"CLEAR", syslogfmt.SevNotice},
	}
	for _, tc := range tests {
		got := syslogfmt.MapSeverity(tc.severity, "")
		if got != tc.expected {
			t.Errorf("MapSeverity(%q, '') = %d, want %d", tc.severity, got, tc.expected)
		}
	}
}

func TestMapSeverity_FallsBackToEventType(t *testing.T) {
	got := syslogfmt.MapSeverity("", "STATE_CHANGE")
	if got != syslogfmt.SevNotice {
		t.Errorf("expected SevNotice for STATE_CHANGE, got %d", got)
	}
}

func TestMapSeverity_UnknownDefaultsToInfo(t *testing.T) {
	got := syslogfmt.MapSeverity("", "")
	if got != syslogfmt.SevInfo {
		t.Errorf("expected SevInfo for unknown severity, got %d", got)
	}
}

// ── Forwarder tests ───────────────────────────────────────────────────────

func validEventPayload() []byte {
	e := syslogfmt.OperationalEvent{
		EventID:   "EVT-100",
		EventType: "ALARM",
		Severity:  "MAJOR",
		Message:   "High CPU detected",
		DeviceID:  "BTS-001",
		Timestamp: "2026-07-05T10:00:00Z",
		AppName:   "kpi-service",
	}
	b, _ := json.Marshal(e)
	return b
}

func TestForwarderProcessMessage_WritesToSyslog(t *testing.T) {
	cfg := consumer.LoadConfig()
	writer := &mockWriter{}
	fwd := consumer.NewForwarderWithWriter(cfg, newLogger(), writer)

	fwd.ProcessMessage(validEventPayload())

	if len(writer.written) != 1 {
		t.Errorf("expected 1 written message, got %d", len(writer.written))
	}
	if !strings.Contains(writer.written[0], "High CPU detected") {
		t.Errorf("message body not found in syslog output: %s", writer.written[0])
	}
}

func TestForwarderProcessMessage_BuffersOnWriteFailure(t *testing.T) {
	cfg := consumer.LoadConfig()
	writer := &mockWriter{failUntil: 999} // always fail
	fwd := consumer.NewForwarderWithWriter(cfg, newLogger(), writer)

	fwd.ProcessMessage(validEventPayload())
	fwd.ProcessMessage(validEventPayload())

	if fwd.BufferDepth() != 2 {
		t.Errorf("expected 2 buffered messages, got %d", fwd.BufferDepth())
	}
}

func TestForwarderProcessMessage_FlushesBufferOnReconnect(t *testing.T) {
	cfg := consumer.LoadConfig()
	writer := &mockWriter{failUntil: 1} // fail first write, then succeed
	fwd := consumer.NewForwarderWithWriter(cfg, newLogger(), writer)

	// First message goes to buffer (writer fails)
	fwd.ProcessMessage(validEventPayload())
	if fwd.BufferDepth() != 1 {
		t.Errorf("expected 1 buffered message, got %d", fwd.BufferDepth())
	}

	// Second message triggers flush attempt: buffer flushed first, then new message written
	fwd.ProcessMessage(validEventPayload())
	if fwd.BufferDepth() != 0 {
		t.Errorf("expected buffer empty after reconnect, got %d", fwd.BufferDepth())
	}
	// Both messages should be written
	if len(writer.written) != 2 {
		t.Errorf("expected 2 written messages after flush, got %d", len(writer.written))
	}
}

func TestForwarderProcessMessage_DropsOldestWhenBufferFull(t *testing.T) {
	cfg := consumer.LoadConfig()
	cfg.BufferSize = 3
	writer := &mockWriter{failUntil: 999}
	fwd := consumer.NewForwarderWithWriter(cfg, newLogger(), writer)

	for i := 0; i < 5; i++ {
		fwd.ProcessMessage(validEventPayload())
	}

	if fwd.BufferDepth() != 3 {
		t.Errorf("expected buffer capped at 3, got %d", fwd.BufferDepth())
	}
}

func TestForwarderProcessMessage_ParseErrorDropped(t *testing.T) {
	cfg := consumer.LoadConfig()
	writer := &mockWriter{}
	fwd := consumer.NewForwarderWithWriter(cfg, newLogger(), writer)

	fwd.ProcessMessage([]byte("not-json"))

	if len(writer.written) > 0 {
		t.Errorf("expected 0 written messages for parse failure, got %d", len(writer.written))
	}
	if fwd.BufferDepth() != 0 {
		t.Errorf("expected 0 buffered messages for parse failure, got %d", fwd.BufferDepth())
	}
}

// min is a helper for Go <1.21 compatibility.
func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
