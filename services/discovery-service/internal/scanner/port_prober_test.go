package scanner

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/airtel-ubrnms/discovery-service/internal/model"
)

// ── Fakes ─────────────────────────────────────────────────────────────────────

// fakeTCPDialer returns open/closed results based on a preconfigured map.
type fakeTCPDialer struct {
	mu       sync.Mutex
	results  map[string]error // "ip:port" → error (nil = open)
	calls    []string
	latency  int64
}

func newFakeDialer(openPorts map[string]bool) *fakeTCPDialer {
	results := make(map[string]error)
	for addr, open := range openPorts {
		if !open {
			results[addr] = errors.New("connection refused")
		}
	}
	return &fakeTCPDialer{results: results, latency: 5}
}

func (d *fakeTCPDialer) DialTCP(_ context.Context, addr string, _ time.Duration) (int64, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.calls = append(d.calls, addr)
	if err, found := d.results[addr]; found {
		return 0, err
	}
	// Default: open with configurable latency
	return d.latency, nil
}

// ─────────────────────────────────────────────────────────────────────────────

type fakePortPublisher struct {
	mu     sync.Mutex
	events []model.PortProbeResultEvent
	err    error
}

func (p *fakePortPublisher) PublishPortProbeResult(_ context.Context, ev model.PortProbeResultEvent) error {
	if p.err != nil {
		return p.err
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	p.events = append(p.events, ev)
	return nil
}

// ── Helpers ───────────────────────────────────────────────────────────────────

func newProber(dialer TCPDialer, pub PortResultPublisher, workers int, timeoutMs int) *PortProber {
	return NewPortProber(dialer, pub, PortProberConfig{
		Workers:      workers,
		ProbeTimeout: time.Duration(timeoutMs) * time.Millisecond,
	})
}

func containsPort(ports []int, port int) bool {
	for _, p := range ports {
		if p == port {
			return true
		}
	}
	return false
}

// ── Tests ─────────────────────────────────────────────────────────────────────

func TestPortProber_AllPortsOpen(t *testing.T) {
	dialer := newFakeDialer(map[string]bool{}) // all default to open
	pub := &fakePortPublisher{}
	prober := newProber(dialer, pub, 10, 1000)

	prober.ProbeHosts(context.Background(), "run-001", []string{"10.0.0.1"})

	pub.mu.Lock()
	defer pub.mu.Unlock()

	if len(pub.events) != 1 {
		t.Fatalf("expected 1 event, got %d", len(pub.events))
	}
	ev := pub.events[0]
	if ev.IP != "10.0.0.1" {
		t.Errorf("expected IP 10.0.0.1, got %q", ev.IP)
	}
	if len(ev.OpenPorts) != len(ManagementPorts) {
		t.Errorf("expected all %d ports open, got %d", len(ManagementPorts), len(ev.OpenPorts))
	}
}

func TestPortProber_AllPortsClosed(t *testing.T) {
	// Mark all management port addresses as closed
	closed := map[string]bool{
		"10.0.0.2:22":  false,
		"10.0.0.2:80":  false,
		"10.0.0.2:161": false,
		"10.0.0.2:443": false,
		"10.0.0.2:830": false,
	}
	dialer := newFakeDialer(closed)
	pub := &fakePortPublisher{}
	prober := newProber(dialer, pub, 10, 1000)

	prober.ProbeHosts(context.Background(), "run-002", []string{"10.0.0.2"})

	pub.mu.Lock()
	defer pub.mu.Unlock()

	if len(pub.events) != 1 {
		t.Fatalf("expected 1 event, got %d", len(pub.events))
	}
	ev := pub.events[0]
	if len(ev.OpenPorts) != 0 {
		t.Errorf("expected no open ports, got %v", ev.OpenPorts)
	}
	if ev.ManagementProtocol != "UNKNOWN" {
		t.Errorf("expected UNKNOWN protocol, got %q", ev.ManagementProtocol)
	}
}

func TestPortProber_OnlySSHOpen(t *testing.T) {
	// Close all but SSH (22)
	results := map[string]bool{
		"10.0.0.3:22":  true,
		"10.0.0.3:80":  false,
		"10.0.0.3:161": false,
		"10.0.0.3:443": false,
		"10.0.0.3:830": false,
	}
	dialer := newFakeDialer(results)
	pub := &fakePortPublisher{}
	prober := newProber(dialer, pub, 10, 1000)

	prober.ProbeHosts(context.Background(), "run-003", []string{"10.0.0.3"})

	pub.mu.Lock()
	defer pub.mu.Unlock()
	if len(pub.events) == 0 {
		t.Fatal("no events published")
	}
	ev := pub.events[0]
	if ev.ManagementProtocol != "SSH" {
		t.Errorf("expected SSH protocol, got %q", ev.ManagementProtocol)
	}
	if !containsPort(ev.OpenPorts, 22) {
		t.Error("expected port 22 in openPorts")
	}
}

func TestPortProber_MultipleHosts(t *testing.T) {
	dialer := newFakeDialer(map[string]bool{}) // all open
	pub := &fakePortPublisher{}
	prober := newProber(dialer, pub, 10, 1000)

	hosts := []string{"10.0.0.1", "10.0.0.2", "10.0.0.3"}
	prober.ProbeHosts(context.Background(), "run-004", hosts)

	pub.mu.Lock()
	count := len(pub.events)
	pub.mu.Unlock()

	if count != len(hosts) {
		t.Errorf("expected %d events, got %d", len(hosts), count)
	}
}

func TestPortProber_EmptyHosts_NoEvents(t *testing.T) {
	pub := &fakePortPublisher{}
	prober := newProber(newFakeDialer(nil), pub, 10, 1000)

	prober.ProbeHosts(context.Background(), "run-005", []string{})

	pub.mu.Lock()
	defer pub.mu.Unlock()
	if len(pub.events) != 0 {
		t.Error("expected no events for empty host list")
	}
}

func TestPortProber_EventID_IsUnique(t *testing.T) {
	dialer := newFakeDialer(map[string]bool{})
	pub := &fakePortPublisher{}
	prober := newProber(dialer, pub, 10, 1000)

	prober.ProbeHosts(context.Background(), "run-006", []string{"10.0.0.1", "10.0.0.2"})

	pub.mu.Lock()
	defer pub.mu.Unlock()
	if len(pub.events) < 2 {
		t.Fatal("need at least 2 events")
	}
	if pub.events[0].EventID == pub.events[1].EventID {
		t.Error("event IDs should be unique")
	}
}

func TestPortProber_RunIDPropagated(t *testing.T) {
	dialer := newFakeDialer(map[string]bool{})
	pub := &fakePortPublisher{}
	prober := newProber(dialer, pub, 10, 1000)

	prober.ProbeHosts(context.Background(), "run-007", []string{"10.0.0.5"})

	pub.mu.Lock()
	defer pub.mu.Unlock()
	if len(pub.events) == 0 {
		t.Fatal("no events")
	}
	if pub.events[0].RunID != "run-007" {
		t.Errorf("expected runId run-007, got %q", pub.events[0].RunID)
	}
}

func TestPortProber_PublishFailure_DoesNotPanic(t *testing.T) {
	dialer := newFakeDialer(map[string]bool{})
	pub := &fakePortPublisher{err: errors.New("kafka unavailable")}
	prober := newProber(dialer, pub, 10, 1000)

	// Should not panic even if publishing fails
	prober.ProbeHosts(context.Background(), "run-008", []string{"10.0.0.6"})
}

// ── InferManagementProtocol tests ─────────────────────────────────────────────

func TestInferManagementProtocol(t *testing.T) {
	cases := []struct {
		openPorts []int
		expected  string
	}{
		{[]int{830, 22, 161}, "NETCONF"},  // NETCONF wins
		{[]int{161, 22}, "SNMP"},           // SNMP over SSH
		{[]int{22, 443}, "SSH"},            // SSH over HTTPS
		{[]int{443, 80}, "HTTPS"},          // HTTPS over HTTP
		{[]int{80}, "HTTP"},
		{[]int{}, "UNKNOWN"},
		{nil, "UNKNOWN"},
	}

	for _, tc := range cases {
		got := inferManagementProtocol(tc.openPorts)
		if got != tc.expected {
			t.Errorf("inferManagementProtocol(%v) = %q, want %q", tc.openPorts, got, tc.expected)
		}
	}
}

// ── LoadPortProberConfig tests ────────────────────────────────────────────────

func TestLoadPortProberConfig_Defaults(t *testing.T) {
	t.Setenv("PORT_PROBE_WORKERS", "")
	t.Setenv("PORT_PROBE_TIMEOUT_MS", "")
	cfg := LoadPortProberConfig()
	if cfg.Workers != defaultProbeWorkers {
		t.Errorf("expected default workers %d, got %d", defaultProbeWorkers, cfg.Workers)
	}
	if cfg.ProbeTimeout != time.Duration(defaultProbeTimeoutMs)*time.Millisecond {
		t.Errorf("expected default timeout %dms, got %v", defaultProbeTimeoutMs, cfg.ProbeTimeout)
	}
}

func TestLoadPortProberConfig_EnvOverride(t *testing.T) {
	t.Setenv("PORT_PROBE_WORKERS", "64")
	t.Setenv("PORT_PROBE_TIMEOUT_MS", "500")
	cfg := LoadPortProberConfig()
	if cfg.Workers != 64 {
		t.Errorf("expected 64 workers, got %d", cfg.Workers)
	}
	if cfg.ProbeTimeout != 500*time.Millisecond {
		t.Errorf("expected 500ms timeout, got %v", cfg.ProbeTimeout)
	}
}
