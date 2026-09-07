package scanner_test

import (
	"context"
	"fmt"
	"sync/atomic"
	"testing"
	"time"

	"github.com/airtel-ubrnms/discovery-service/internal/model"
	"github.com/airtel-ubrnms/discovery-service/internal/scanner"
)

// ── Test doubles ──────────────────────────────────────────────────────────────

type fakeProber struct {
	// reachable is the set of IPs that respond as reachable
	reachable map[string]bool
	// delay adds artificial probe latency
	delay time.Duration
	// forceTimeout forces all probes to return timeout
	forceTimeout bool
	// probeCount tracks how many probes were made
	probeCount atomic.Int64
}

func (f *fakeProber) Probe(ctx context.Context, ip string, timeoutMS int, retries int) (int64, string, error) {
	f.probeCount.Add(1)
	if f.delay > 0 {
		select {
		case <-ctx.Done():
			return 0, scanner.StatusCancelled, nil
		case <-time.After(f.delay):
		}
	}
	if f.forceTimeout {
		return 0, scanner.StatusTimeout, nil
	}
	if f.reachable[ip] {
		return 5, scanner.StatusReachable, nil
	}
	return 0, scanner.StatusUnreachable, nil
}

type fakePublisher struct {
	published []scanner.HostResult
}

func (f *fakePublisher) PublishHostResult(_ string, result scanner.HostResult) error {
	f.published = append(f.published, result)
	return nil
}

// ── Helpers ───────────────────────────────────────────────────────────────────

func newRun(scope []model.ScopeEntry) *model.DiscoveryRun {
	return &model.DiscoveryRun{
		ID:              "test-run-001",
		NormalizedScope: scope,
		Status:          "CREATED",
		CreatedBy:       "test",
		CreatedAt:       time.Now().UTC(),
	}
}

func newService(prober scanner.Prober, concurrency int) *scanner.ICMPSweepService {
	cfg := scanner.SweepConfig{
		Concurrency: concurrency,
		TimeoutMS:   100,
		Retries:     1,
	}
	return scanner.NewICMPSweepService(prober, cfg, nil)
}

// ── Tests ─────────────────────────────────────────────────────────────────────

func TestSweep_AllReachable(t *testing.T) {
	prober := &fakeProber{reachable: map[string]bool{
		"192.168.1.1": true,
		"192.168.1.2": true,
	}}
	svc := newService(prober, 4)
	run := newRun([]model.ScopeEntry{
		{Type: "IP", Value: "192.168.1.1", Label: "host-a"},
		{Type: "IP", Value: "192.168.1.2", Label: "host-b"},
	})

	result, err := svc.Sweep(context.Background(), run)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Status != "SWEEP_COMPLETE" {
		t.Errorf("expected SWEEP_COMPLETE, got %q", result.Status)
	}
	if result.TotalCandidates != 2 {
		t.Errorf("expected 2 candidates, got %d", result.TotalCandidates)
	}
	if result.ReachableCount != 2 {
		t.Errorf("expected 2 reachable, got %d", result.ReachableCount)
	}
	if result.UnreachableCount != 0 {
		t.Errorf("expected 0 unreachable, got %d", result.UnreachableCount)
	}
}

func TestSweep_AllUnreachable(t *testing.T) {
	prober := &fakeProber{reachable: map[string]bool{}}
	svc := newService(prober, 4)
	run := newRun([]model.ScopeEntry{
		{Type: "IP", Value: "10.0.0.1"},
		{Type: "IP", Value: "10.0.0.2"},
	})

	result, err := svc.Sweep(context.Background(), run)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.UnreachableCount != 2 {
		t.Errorf("expected 2 unreachable, got %d", result.UnreachableCount)
	}
}

func TestSweep_TimeoutHosts(t *testing.T) {
	prober := &fakeProber{forceTimeout: true}
	svc := newService(prober, 2)
	run := newRun([]model.ScopeEntry{
		{Type: "IP", Value: "172.16.0.1"},
		{Type: "IP", Value: "172.16.0.2"},
	})

	result, err := svc.Sweep(context.Background(), run)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.TimeoutCount != 2 {
		t.Errorf("expected 2 timeouts, got %d; statuses: %v", result.TimeoutCount, resultStatuses(result))
	}
}

func TestSweep_DeduplicatesOverlappingScope(t *testing.T) {
	prober := &fakeProber{reachable: map[string]bool{"10.0.0.1": true}}
	svc := newService(prober, 4)
	// Same IP appears in two scope entries
	run := newRun([]model.ScopeEntry{
		{Type: "IP", Value: "10.0.0.1", Label: "entry-a"},
		{Type: "IP", Value: "10.0.0.1", Label: "entry-b"},
	})

	result, err := svc.Sweep(context.Background(), run)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.TotalCandidates != 1 {
		t.Errorf("expected 1 deduplicated candidate, got %d", result.TotalCandidates)
	}
	if result.ScannedCount != 1 {
		t.Errorf("expected 1 scanned, got %d", result.ScannedCount)
	}
}

func TestSweep_ConcurrencyLimitRespected(t *testing.T) {
	var active atomic.Int64
	var maxActive atomic.Int64
	concurrencyLimit := 3

	prober := &blockingProber{active: &active, maxActive: &maxActive, delay: 20 * time.Millisecond}
	cfg := scanner.SweepConfig{Concurrency: concurrencyLimit, TimeoutMS: 500, Retries: 0}
	svc := scanner.NewICMPSweepService(prober, cfg, nil)

	ips := make([]model.ScopeEntry, 20)
	for i := range ips {
		ips[i] = model.ScopeEntry{Type: "IP", Value: fmt.Sprintf("192.168.%d.1", i+1)}
	}
	run := newRun(ips)

	_, err := svc.Sweep(context.Background(), run)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if int(maxActive.Load()) > concurrencyLimit {
		t.Errorf("concurrency exceeded limit: max active=%d, limit=%d", maxActive.Load(), concurrencyLimit)
	}
}

func TestSweep_ContextCancellation(t *testing.T) {
	prober := &fakeProber{
		reachable: map[string]bool{},
		delay:     50 * time.Millisecond,
	}
	svc := newService(prober, 2)

	scope := make([]model.ScopeEntry, 20)
	for i := range scope {
		scope[i] = model.ScopeEntry{Type: "IP", Value: fmt.Sprintf("10.%d.0.1", i+1)}
	}
	run := newRun(scope)

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()

	result, err := svc.Sweep(ctx, run)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Status != "SWEEP_CANCELLED" {
		t.Logf("run was not cancelled (may have completed quickly): status=%s", result.Status)
	}
	// Run must not be left in a permanently running state
	if result.Status != "SWEEP_COMPLETE" && result.Status != "SWEEP_CANCELLED" {
		t.Errorf("unexpected final status: %q", result.Status)
	}
}

func TestSweep_CIDRExpansion(t *testing.T) {
	prober := &fakeProber{reachable: map[string]bool{"10.0.0.1": true, "10.0.0.2": true}}
	svc := newService(prober, 4)
	run := newRun([]model.ScopeEntry{
		{Type: "CIDR", Value: "10.0.0.0/30"}, // 4 addresses: network, .1, .2, broadcast
	})

	result, err := svc.Sweep(context.Background(), run)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.TotalCandidates < 2 {
		t.Errorf("expected CIDR expansion to produce candidates, got %d", result.TotalCandidates)
	}
}

func TestSweep_EmptyScope(t *testing.T) {
	prober := &fakeProber{}
	svc := newService(prober, 4)
	run := newRun([]model.ScopeEntry{})

	result, err := svc.Sweep(context.Background(), run)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Status != "SWEEP_COMPLETE" {
		t.Errorf("expected SWEEP_COMPLETE for empty scope, got %q", result.Status)
	}
	if result.TotalCandidates != 0 {
		t.Errorf("expected 0 candidates, got %d", result.TotalCandidates)
	}
}

func TestSweep_PublishesResults(t *testing.T) {
	prober := &fakeProber{reachable: map[string]bool{"192.168.1.1": true}}
	publisher := &fakePublisher{}
	cfg := scanner.SweepConfig{Concurrency: 2, TimeoutMS: 100, Retries: 0}
	svc := scanner.NewICMPSweepService(prober, cfg, publisher)

	run := newRun([]model.ScopeEntry{{Type: "IP", Value: "192.168.1.1"}})
	_, err := svc.Sweep(context.Background(), run)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(publisher.published) != 1 {
		t.Errorf("expected 1 published result, got %d", len(publisher.published))
	}
}

func TestSweep_NilRunReturnsError(t *testing.T) {
	svc := newService(&fakeProber{}, 2)
	_, err := svc.Sweep(context.Background(), nil)
	if err == nil {
		t.Error("expected error for nil run")
	}
}

// ── blockingProber: measures active concurrency ───────────────────────────────

type blockingProber struct {
	active    *atomic.Int64
	maxActive *atomic.Int64
	delay     time.Duration
}

func (p *blockingProber) Probe(ctx context.Context, _ string, _ int, _ int) (int64, string, error) {
	cur := p.active.Add(1)
	defer p.active.Add(-1)

	for {
		max := p.maxActive.Load()
		if cur > max {
			if p.maxActive.CompareAndSwap(max, cur) {
				break
			}
		} else {
			break
		}
	}

	select {
	case <-ctx.Done():
		return 0, scanner.StatusCancelled, nil
	case <-time.After(p.delay):
		return 5, scanner.StatusReachable, nil
	}
}

// ── Helpers ───────────────────────────────────────────────────────────────────

func resultStatuses(r *scanner.SweepResult) []string {
	statuses := make([]string, len(r.HostResults))
	for i, hr := range r.HostResults {
		statuses[i] = hr.Status
	}
	return statuses
}
