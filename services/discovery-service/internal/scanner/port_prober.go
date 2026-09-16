// Package scanner — TCP management port prober for live hosts found by ICMP sweep (WO-024).
//
// After ICMP sweep identifies reachable hosts, PortProber probes each host's
// management ports (SNMP 161, SSH 22, NETCONF 830, HTTP 80, HTTPS 443) in
// parallel to determine access methods. Results are published to the Kafka topic
// discovery.port.results (one event per host).
//
// Concurrency: up to 512 simultaneous TCP connect probes (configurable via
// PORT_PROBE_WORKERS env var). Each probe uses a configurable timeout
// (PORT_PROBE_TIMEOUT_MS, default 2000 ms).
//
// ManagementProtocol inference priority:
//   NETCONF (830) > SNMP (161) > SSH (22) > HTTPS (443) > HTTP (80) > UNKNOWN
package scanner

import (
	"context"
	"fmt"
	"log/slog"
	"net"
	"os"
	"strconv"
	"sync"
	"time"

	"github.com/airtel-ubrnms/discovery-service/internal/model"
	"github.com/google/uuid"
)

// ── Constants ─────────────────────────────────────────────────────────────────

// ManagementPorts is the ordered list of ports probed for each live host.
// Order does not affect results but is used for deterministic test assertions.
var ManagementPorts = []int{22, 80, 161, 443, 830}

// Default settings (overridden by environment variables)
const (
	defaultProbeWorkers    = 512
	defaultProbeTimeoutMs  = 2000
)

// ── Dependency interfaces ─────────────────────────────────────────────────────

// TCPDialer abstracts TCP connect probes so tests can inject fakes.
type TCPDialer interface {
	// DialTCP attempts a TCP connection to addr with the given timeout.
	// Returns the open latency in milliseconds and any error.
	DialTCP(ctx context.Context, addr string, timeout time.Duration) (latencyMs int64, err error)
}

// PortResultPublisher abstracts Kafka publication of probe results.
type PortResultPublisher interface {
	PublishPortProbeResult(ctx context.Context, event model.PortProbeResultEvent) error
}

// ── Prober ────────────────────────────────────────────────────────────────────

// PortProberConfig holds tunable probe parameters.
type PortProberConfig struct {
	// Workers is the maximum number of concurrent TCP connect probes.
	Workers int
	// ProbeTimeout is the TCP connect timeout per port per host.
	ProbeTimeout time.Duration
}

// LoadPortProberConfig reads configuration from environment variables.
func LoadPortProberConfig() PortProberConfig {
	workers := defaultProbeWorkers
	if v := os.Getenv("PORT_PROBE_WORKERS"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			workers = n
		}
	}
	timeoutMs := defaultProbeTimeoutMs
	if v := os.Getenv("PORT_PROBE_TIMEOUT_MS"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			timeoutMs = n
		}
	}
	return PortProberConfig{
		Workers:      workers,
		ProbeTimeout: time.Duration(timeoutMs) * time.Millisecond,
	}
}

// PortProber probes management ports on a set of live hosts.
type PortProber struct {
	dialer    TCPDialer
	publisher PortResultPublisher
	cfg       PortProberConfig
}

// NewPortProber creates a new PortProber.
func NewPortProber(dialer TCPDialer, publisher PortResultPublisher, cfg PortProberConfig) *PortProber {
	return &PortProber{dialer: dialer, publisher: publisher, cfg: cfg}
}

// ProbeHosts probes all management ports on each IP in the liveHosts slice.
// Each host is processed by the worker pool; results are published to Kafka.
func (p *PortProber) ProbeHosts(ctx context.Context, runID string, liveHosts []string) {
	if len(liveHosts) == 0 {
		return
	}

	workers := p.cfg.Workers
	if workers <= 0 {
		workers = defaultProbeWorkers
	}

	type job struct{ ip string }
	jobs := make(chan job, len(liveHosts))
	for _, ip := range liveHosts {
		jobs <- job{ip: ip}
	}
	close(jobs)

	var wg sync.WaitGroup
	// Cap goroutines to the number of hosts if fewer than workers
	actual := workers
	if actual > len(liveHosts) {
		actual = len(liveHosts)
	}

	for i := 0; i < actual; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := range jobs {
				if err := ctx.Err(); err != nil {
					return
				}
				event := p.probeHost(ctx, runID, j.ip)
				if pubErr := p.publisher.PublishPortProbeResult(ctx, event); pubErr != nil {
					slog.Warn("port probe publish failed", "ip", j.ip, "error", pubErr)
				}
			}
		}()
	}
	wg.Wait()
}

// probeHost probes all management ports on a single host and builds the Kafka event.
func (p *PortProber) probeHost(ctx context.Context, runID, ip string) model.PortProbeResultEvent {
	type portResult struct {
		port      int
		latencyMs int64
		err       error
	}

	results := make([]portResult, len(ManagementPorts))
	var mu sync.Mutex
	var wg sync.WaitGroup

	for i, port := range ManagementPorts {
		wg.Add(1)
		go func(idx, port int) {
			defer wg.Done()
			addr := fmt.Sprintf("%s:%d", ip, port)
			lat, err := p.dialer.DialTCP(ctx, addr, p.cfg.ProbeTimeout)
			mu.Lock()
			results[idx] = portResult{port: port, latencyMs: lat, err: err}
			mu.Unlock()
		}(i, port)
	}
	wg.Wait()

	var openPorts []int
	var portProbeResults []model.PortProbeResult
	for _, r := range results {
		pr := model.PortProbeResult{
			Port:      r.port,
			Open:      r.err == nil,
			LatencyMs: r.latencyMs,
		}
		if r.err != nil {
			pr.Error = r.err.Error()
		}
		portProbeResults = append(portProbeResults, pr)
		if r.err == nil {
			openPorts = append(openPorts, r.port)
		}
	}

	return model.PortProbeResultEvent{
		EventID:            uuid.New().String(),
		RunID:              runID,
		IP:                 ip,
		OpenPorts:          openPorts,
		PortResults:        portProbeResults,
		ManagementProtocol: inferManagementProtocol(openPorts),
		Timestamp:          time.Now().UTC(),
	}
}

// inferManagementProtocol selects the primary management protocol from open ports.
// Priority: NETCONF (830) > SNMP (161) > SSH (22) > HTTPS (443) > HTTP (80).
func inferManagementProtocol(openPorts []int) string {
	open := make(map[int]bool, len(openPorts))
	for _, p := range openPorts {
		open[p] = true
	}
	switch {
	case open[830]:
		return "NETCONF"
	case open[161]:
		return "SNMP"
	case open[22]:
		return "SSH"
	case open[443]:
		return "HTTPS"
	case open[80]:
		return "HTTP"
	default:
		return "UNKNOWN"
	}
}

// ── Real TCP dialer ───────────────────────────────────────────────────────────

// NetTCPDialer is the production TCPDialer using net.DialTimeout.
type NetTCPDialer struct{}

func (d *NetTCPDialer) DialTCP(ctx context.Context, addr string, timeout time.Duration) (int64, error) {
	start := time.Now()

	// Honour context cancellation by using the shorter of ctx deadline and timeout
	deadline, ok := ctx.Deadline()
	if ok {
		remaining := time.Until(deadline)
		if remaining < timeout {
			timeout = remaining
		}
	}

	conn, err := net.DialTimeout("tcp", addr, timeout)
	if err != nil {
		return 0, err
	}
	_ = conn.Close()
	return time.Since(start).Milliseconds(), nil
}
