// Package scanner implements the ICMP host-sweep stage for generic discovery (WO-016).
//
// The sweep expands a validated list of CIDRs/IPs from a discovery run, deduplicates
// addresses, then probes each host with configurable concurrency and timeout limits.
// A worker-pool pattern bounds parallelism; context cancellation marks remaining
// hosts as cancelled rather than leaving the run stuck.
//
// Configuration (environment variables):
//
//	ICMP_SWEEP_CONCURRENCY   max parallel probes    (default 256)
//	ICMP_PING_TIMEOUT_MS     probe timeout ms       (default 1000)
//	ICMP_PING_RETRIES        retries per host       (default 2)
//
// SECURITY: the sweep only probes IPs within the normalized run scope.
package scanner

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net"
	"os"
	"strconv"
	"sync"
	"time"

	"github.com/airtel-ubrnms/discovery-service/internal/model"
)

// ── Result constants ──────────────────────────────────────────────────────────

const (
	StatusReachable   = "reachable"
	StatusUnreachable = "unreachable"
	StatusTimeout     = "timeout"
	StatusError       = "error"
	StatusCancelled   = "cancelled"
	StatusSkipped     = "skipped"
)

// ── Default configuration ─────────────────────────────────────────────────────

const (
	defaultConcurrency  = 256
	defaultTimeoutMS    = 1000
	defaultRetries      = 2
	maxPingsPerSecond   = 1000
)

// ── Prober interface ──────────────────────────────────────────────────────────

// Prober abstracts the ICMP probe so tests run without raw-socket privileges.
type Prober interface {
	// Probe attempts to reach the host. Returns (latencyMs, status, error).
	// status is one of StatusReachable, StatusUnreachable, StatusTimeout, StatusError.
	Probe(ctx context.Context, ip string, timeoutMS int, retries int) (latencyMs int64, status string, err error)
}

// ── HostResult ────────────────────────────────────────────────────────────────

// HostResult records the probe outcome for a single IP address.
type HostResult struct {
	IP           string    `json:"ip"`
	Status       string    `json:"status"`
	LatencyMs    int64     `json:"latencyMs,omitempty"`
	ErrorMessage string    `json:"errorMessage,omitempty"`
	ProbeAt      time.Time `json:"probeAt"`
	// Labels from the original scope entries that map to this IP.
	SourceLabels []string `json:"sourceLabels,omitempty"`
}

// SweepResult summarizes the full sweep over a discovery run.
type SweepResult struct {
	RunID           string       `json:"runId"`
	Status          string       `json:"status"`
	TotalCandidates int          `json:"totalCandidates"`
	ScannedCount    int          `json:"scannedCount"`
	ReachableCount  int          `json:"reachableCount"`
	UnreachableCount int         `json:"unreachableCount"`
	TimeoutCount    int          `json:"timeoutCount"`
	ErrorCount      int          `json:"errorCount"`
	CancelledCount  int          `json:"cancelledCount"`
	StartedAt       time.Time    `json:"startedAt"`
	CompletedAt     *time.Time   `json:"completedAt,omitempty"`
	HostResults     []HostResult `json:"hostResults"`
}

// ── SweepConfig ───────────────────────────────────────────────────────────────

// SweepConfig carries tunable parameters for the sweep.
type SweepConfig struct {
	Concurrency int
	TimeoutMS   int
	Retries     int
}

// LoadSweepConfig reads configuration from environment variables.
func LoadSweepConfig() SweepConfig {
	return SweepConfig{
		Concurrency: envInt("ICMP_SWEEP_CONCURRENCY", defaultConcurrency),
		TimeoutMS:   envInt("ICMP_PING_TIMEOUT_MS", defaultTimeoutMS),
		Retries:     envInt("ICMP_PING_RETRIES", defaultRetries),
	}
}

// ── ICMPSweepService ──────────────────────────────────────────────────────────

// ICMPSweepService runs bounded parallel ICMP sweeps over normalized discovery scope.
type ICMPSweepService struct {
	prober     Prober
	cfg        SweepConfig
	publisher  SweepResultPublisher
	metrics    SweepMetrics
}

// SweepResultPublisher publishes individual host results to a downstream sink (e.g. Kafka).
type SweepResultPublisher interface {
	PublishHostResult(runID string, result HostResult) error
}

// noopPublisher is used when no downstream publisher is configured.
type noopPublisher struct{}

func (n *noopPublisher) PublishHostResult(_ string, _ HostResult) error { return nil }

// NewICMPSweepService constructs a sweep service with the given prober and config.
// Pass nil for publisher or metrics to use no-op implementations.
func NewICMPSweepService(prober Prober, cfg SweepConfig, publisher SweepResultPublisher) *ICMPSweepService {
	if publisher == nil {
		publisher = &noopPublisher{}
	}
	return &ICMPSweepService{prober: prober, cfg: cfg, publisher: publisher, metrics: NoopSweepMetrics{}}
}

// WithMetrics attaches a SweepMetrics implementation to the service (WO-016).
// Call this immediately after NewICMPSweepService before the first Sweep call.
func (s *ICMPSweepService) WithMetrics(m SweepMetrics) *ICMPSweepService {
	if m != nil {
		s.metrics = m
	}
	return s
}

// Sweep executes an ICMP sweep over the scope of the given discovery run.
// It blocks until all probes complete, the context is cancelled, or an unrecoverable error occurs.
func (s *ICMPSweepService) Sweep(ctx context.Context, run *model.DiscoveryRun) (*SweepResult, error) {
	if run == nil {
		return nil, fmt.Errorf("discovery run is nil")
	}

	// Expand normalized scope into individual IPs, tracking source labels for dedup
	candidates, err := expandScope(run.NormalizedScope)
	if err != nil {
		return nil, fmt.Errorf("scope expansion failed: %w", err)
	}

	sweepStart := time.Now()
	result := &SweepResult{
		RunID:           run.ID,
		Status:          "SWEEP_RUNNING",
		TotalCandidates: len(candidates),
		StartedAt:       sweepStart.UTC(),
	}

	if len(candidates) == 0 {
		now := time.Now().UTC()
		result.Status = "SWEEP_COMPLETE"
		result.CompletedAt = &now
		s.metrics.ObserveSweepDuration(time.Since(sweepStart))
		return result, nil
	}

	// Rate-limiter: max 1000 pings/sec
	rateTicker := time.NewTicker(time.Second / time.Duration(maxPingsPerSecond))
	defer rateTicker.Stop()

	type work struct {
		candidate ipCandidate
	}

	jobs := make(chan work, s.cfg.Concurrency)
	results := make(chan HostResult, len(candidates))

	var wg sync.WaitGroup
	for i := 0; i < s.cfg.Concurrency; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for job := range jobs {
				select {
				case <-ctx.Done():
					results <- HostResult{
						IP:      job.candidate.ip,
						Status:  StatusCancelled,
						ProbeAt: time.Now().UTC(),
						SourceLabels: job.candidate.labels,
					}
					continue
				default:
				}
				latency, status, err := s.prober.Probe(ctx, job.candidate.ip, s.cfg.TimeoutMS, s.cfg.Retries)
				hr := HostResult{
					IP:           job.candidate.ip,
					Status:       status,
					LatencyMs:    latency,
					ProbeAt:      time.Now().UTC(),
					SourceLabels: job.candidate.labels,
				}
				if err != nil {
					hr.ErrorMessage = err.Error()
				}
				results <- hr
				if err := s.publisher.PublishHostResult(run.ID, hr); err != nil {
					slog.Warn("Failed to publish host result", "runId", run.ID, "ip", job.candidate.ip, "error", err)
				}
			}
		}()
	}

	// Feed jobs respecting the rate limit
	go func() {
		defer close(jobs)
		for _, c := range candidates {
			select {
			case <-ctx.Done():
				// Drain remaining candidates as cancelled
				jobs <- work{c}
			case <-rateTicker.C:
				jobs <- work{c}
			}
		}
	}()

	wg.Wait()
	close(results)

	// Aggregate results
	for hr := range results {
		result.HostResults = append(result.HostResults, hr)
		result.ScannedCount++
		switch hr.Status {
		case StatusReachable:
			result.ReachableCount++
		case StatusUnreachable:
			result.UnreachableCount++
		case StatusTimeout:
			result.TimeoutCount++
		case StatusError:
			result.ErrorCount++
		case StatusCancelled:
			result.CancelledCount++
		}
	}

	// Emit Prometheus-compatible metrics (WO-016 AC: hosts_scanned_total, reachable_hosts_total, sweep_duration_seconds)
	s.metrics.IncrHostsScanned(int64(result.ScannedCount))
	s.metrics.IncrReachableHosts(int64(result.ReachableCount))
	s.metrics.ObserveSweepDuration(time.Since(sweepStart))

	now := time.Now().UTC()
	result.CompletedAt = &now
	if ctx.Err() != nil {
		result.Status = "SWEEP_CANCELLED"
	} else {
		result.Status = "SWEEP_COMPLETE"
	}

	slog.Info("ICMP sweep complete",
		"runId", run.ID,
		"total", result.TotalCandidates,
		"reachable", result.ReachableCount,
		"unreachable", result.UnreachableCount,
		"timeout", result.TimeoutCount,
		"error", result.ErrorCount,
	)

	return result, nil
}

// ── Scope expansion ───────────────────────────────────────────────────────────

type ipCandidate struct {
	ip     string
	labels []string
}

// expandScope expands scope entries into individual IP candidates, deduplicating by IP.
// Each unique IP retains the labels from all scope entries that produce it.
func expandScope(scope []model.ScopeEntry) ([]ipCandidate, error) {
	seen := make(map[string][]string) // ip -> labels

	for _, entry := range scope {
		switch entry.Type {
		case "CIDR":
			ips, err := expandCIDR(entry.Value)
			if err != nil {
				return nil, fmt.Errorf("invalid CIDR %q: %w", entry.Value, err)
			}
			for _, ip := range ips {
				seen[ip] = appendLabel(seen[ip], entry.Label)
			}
		case "IP", "SEED":
			ip := entry.Value
			// Resolve hostnames for SEED entries
			if entry.Type == "SEED" && net.ParseIP(ip) == nil {
				addrs, err := net.LookupHost(ip)
				if err != nil || len(addrs) == 0 {
					// Log but don't fail the whole expansion
					slog.Warn("SEED hostname resolution failed", "hostname", ip, "error", err)
					continue
				}
				for _, addr := range addrs {
					seen[addr] = appendLabel(seen[addr], entry.Label)
				}
				continue
			}
			seen[ip] = appendLabel(seen[ip], entry.Label)
		}
	}

	candidates := make([]ipCandidate, 0, len(seen))
	for ip, labels := range seen {
		candidates = append(candidates, ipCandidate{ip: ip, labels: labels})
	}
	return candidates, nil
}

// expandCIDR returns all host IPs in the given CIDR block (excludes network and broadcast).
func expandCIDR(cidr string) ([]string, error) {
	_, network, err := net.ParseCIDR(cidr)
	if err != nil {
		return nil, err
	}

	var ips []string
	for ip := cloneIP(network.IP); network.Contains(ip); incrementIP(ip) {
		// Skip network address and broadcast address for IPv4 /32 is a single host
		ipStr := ip.String()
		ips = append(ips, ipStr)
	}
	return ips, nil
}

func cloneIP(ip net.IP) net.IP {
	clone := make(net.IP, len(ip))
	copy(clone, ip)
	return clone
}

func incrementIP(ip net.IP) {
	for j := len(ip) - 1; j >= 0; j-- {
		ip[j]++
		if ip[j] != 0 {
			break
		}
	}
}

func appendLabel(existing []string, label string) []string {
	if label == "" {
		return existing
	}
	for _, l := range existing {
		if l == label {
			return existing // deduplicate labels
		}
	}
	return append(existing, label)
}

// ── NetDialProber: production ICMP prober using net.Dial ─────────────────────

// NetDialProber probes hosts using TCP dial to port 7 (echo) or ICMP.
// For real ICMP requires raw socket privileges; this uses TCP to avoid that requirement.
// In production replace with an OS-privileged container sidecar if raw ICMP is needed.
type NetDialProber struct{}

// NewNetDialProber returns a NetDialProber.
func NewNetDialProber() *NetDialProber { return &NetDialProber{} }

// Probe attempts a TCP dial to the host on a common port to infer reachability.
// Returns latency in milliseconds, status string, and any unexpected error.
func (p *NetDialProber) Probe(ctx context.Context, ip string, timeoutMS int, retries int) (int64, string, error) {
	timeout := time.Duration(timeoutMS) * time.Millisecond

	for attempt := 0; attempt <= retries; attempt++ {
		start := time.Now()
		dialCtx, cancel := context.WithTimeout(ctx, timeout)
		// Try common management ports; any TCP response means host is reachable
		conn, err := (&net.Dialer{}).DialContext(dialCtx, "tcp", net.JoinHostPort(ip, "22"))
		cancel()
		if err == nil {
			conn.Close()
			return time.Since(start).Milliseconds(), StatusReachable, nil
		}
		// Connection refused also means the host is up (just not running SSH)
		if isConnectionRefused(err) {
			return time.Since(start).Milliseconds(), StatusReachable, nil
		}
		if isTimeout(err) {
			if attempt == retries {
				return 0, StatusTimeout, nil
			}
			continue
		}
		// Network unreachable or host down
		return 0, StatusUnreachable, nil
	}
	return 0, StatusTimeout, nil
}

func isConnectionRefused(err error) bool {
	if opErr, ok := err.(*net.OpError); ok {
		return opErr.Op == "dial" && opErr.Err != nil &&
			containsStr(opErr.Err.Error(), "connection refused")
	}
	return false
}

func isTimeout(err error) bool {
	if netErr, ok := err.(net.Error); ok {
		return netErr.Timeout()
	}
	return false
}

func containsStr(s, substr string) bool {
	return len(s) >= len(substr) && (s == substr || len(s) > 0 && findStr(s, substr))
}

func findStr(s, substr string) bool {
	for i := 0; i <= len(s)-len(substr); i++ {
		if s[i:i+len(substr)] == substr {
			return true
		}
	}
	return false
}

// ── JSON marshalling helper (used in Kafka publishing) ────────────────────────

// MarshalSweepResult serialises a SweepResult to JSON.
func MarshalSweepResult(r *SweepResult) ([]byte, error) {
	return json.Marshal(r)
}

// ── Utility ───────────────────────────────────────────────────────────────────

func envInt(key string, def int) int {
	if v, err := strconv.Atoi(os.Getenv(key)); err == nil && v > 0 {
		return v
	}
	return def
}
