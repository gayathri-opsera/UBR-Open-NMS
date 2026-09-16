// Package scanner — Prometheus-compatible metrics for ICMP sweeps (WO-016).
//
// SweepMetrics defines the counters and histograms that must be emitted on
// every sweep.  The NoopSweepMetrics implementation satisfies the interface
// in tests and when no Prometheus registry is wired.
//
// In production, register a PrometheusSweepMetrics that wraps the real
// prometheus client (prometheus.io/client_golang) and mount the /metrics
// endpoint on the service's management port.  No external dependency is
// introduced here so the package compiles without prometheus in go.mod;
// the adapter lives in cmd/discovery-service/metrics.go.
//
// Metric names (WO-016 acceptance criteria):
//
//	ubr_nms_hosts_scanned_total      counter  — incremented once per probed host
//	ubr_nms_reachable_hosts_total    counter  — incremented for each reachable result
//	ubr_nms_sweep_duration_seconds   histogram — full sweep wall-clock duration
package scanner

import (
	"sync/atomic"
	"time"
)

// SweepMetrics is the observability port for the ICMP sweep service.
// All implementations must be safe for concurrent use.
type SweepMetrics interface {
	// IncrHostsScanned increments the ubr_nms_hosts_scanned_total counter by n.
	IncrHostsScanned(n int64)
	// IncrReachableHosts increments the ubr_nms_reachable_hosts_total counter by n.
	IncrReachableHosts(n int64)
	// ObserveSweepDuration records the sweep wall-clock duration.
	ObserveSweepDuration(d time.Duration)
}

// ── NoopSweepMetrics ──────────────────────────────────────────────────────────

// NoopSweepMetrics satisfies SweepMetrics with zero-cost no-ops.
// Used in tests and when no Prometheus registry is configured.
type NoopSweepMetrics struct{}

func (NoopSweepMetrics) IncrHostsScanned(_ int64)          {}
func (NoopSweepMetrics) IncrReachableHosts(_ int64)        {}
func (NoopSweepMetrics) ObserveSweepDuration(_ time.Duration) {}

// ── AtomicSweepMetrics ────────────────────────────────────────────────────────

// AtomicSweepMetrics is a thread-safe, in-process implementation of SweepMetrics
// backed by atomic int64 counters.  Suitable for unit tests that need to assert
// on emitted values, and for deployments without a Prometheus pull endpoint.
type AtomicSweepMetrics struct {
	hostsScanned    atomic.Int64
	reachableHosts  atomic.Int64
	sweepDurationsNs atomic.Int64 // sum of observed durations in nanoseconds
	sweepCount      atomic.Int64
}

func (m *AtomicSweepMetrics) IncrHostsScanned(n int64) {
	m.hostsScanned.Add(n)
}

func (m *AtomicSweepMetrics) IncrReachableHosts(n int64) {
	m.reachableHosts.Add(n)
}

func (m *AtomicSweepMetrics) ObserveSweepDuration(d time.Duration) {
	m.sweepDurationsNs.Add(d.Nanoseconds())
	m.sweepCount.Add(1)
}

// HostsScanned returns the total hosts scanned counter value.
func (m *AtomicSweepMetrics) HostsScanned() int64 { return m.hostsScanned.Load() }

// ReachableHosts returns the total reachable hosts counter value.
func (m *AtomicSweepMetrics) ReachableHosts() int64 { return m.reachableHosts.Load() }

// AverageSweepDurationSecs returns the average observed sweep duration in seconds.
// Returns 0 if no sweeps have been observed.
func (m *AtomicSweepMetrics) AverageSweepDurationSecs() float64 {
	count := m.sweepCount.Load()
	if count == 0 {
		return 0
	}
	return float64(m.sweepDurationsNs.Load()) / float64(count) / 1e9
}
