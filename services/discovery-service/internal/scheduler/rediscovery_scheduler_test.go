package scheduler_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/airtel-ubrnms/discovery-service/internal/model"
	"github.com/airtel-ubrnms/discovery-service/internal/scanner"
	"github.com/airtel-ubrnms/discovery-service/internal/scheduler"
)

// ── Test doubles ──────────────────────────────────────────────────────────────

type fakeRunSource struct {
	runs map[string]*model.DiscoveryRun
}

func (f *fakeRunSource) Get(id string) (*model.DiscoveryRun, bool) {
	r, ok := f.runs[id]
	return r, ok
}

type fakeSweepRunner struct {
	result *scanner.SweepResult
	err    error
}

func (f *fakeSweepRunner) Sweep(_ context.Context, run *model.DiscoveryRun) (*scanner.SweepResult, error) {
	if f.err != nil {
		return nil, f.err
	}
	if f.result != nil {
		return f.result, nil
	}
	return &scanner.SweepResult{
		RunID:           run.ID,
		Status:          "SWEEP_COMPLETE",
		TotalCandidates: 0,
		HostResults:     []scanner.HostResult{},
	}, nil
}

type captureAuditPublisher struct {
	events []scheduler.AuditEvent
}

func (c *captureAuditPublisher) Publish(evt scheduler.AuditEvent) error {
	c.events = append(c.events, evt)
	return nil
}

type failingAuditPublisher struct{}

func (f *failingAuditPublisher) Publish(_ scheduler.AuditEvent) error {
	return errors.New("audit publish failed")
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const testRunID = "run-001"
const testScopeRunID = "scope-run-001"

func newTestRun() *model.DiscoveryRun {
	return &model.DiscoveryRun{
		ID:    testScopeRunID,
		Status: "CREATED",
		NormalizedScope: []model.ScopeEntry{
			{Type: "IP", Value: "10.0.0.1", Label: "host-a"},
		},
		CreatedBy: "test",
		CreatedAt: time.Now().UTC(),
	}
}

func newSched(t *testing.T, runSource scheduler.DiscoveryRunSource, sweeper scheduler.SweepRunner, audit scheduler.AuditPublisher) *scheduler.RediscoveryScheduler {
	t.Helper()
	store := scheduler.NewInMemoryScheduleStore()
	s := scheduler.NewRediscoveryScheduler(store, runSource, sweeper, audit)
	s.Start()
	t.Cleanup(func() { s.Stop() })
	return s
}

func newScheds(t *testing.T, run *model.DiscoveryRun, sweepResult *scanner.SweepResult) (*scheduler.RediscoveryScheduler, *captureAuditPublisher) {
	t.Helper()
	runs := &fakeRunSource{runs: map[string]*model.DiscoveryRun{run.ID: run}}
	sweeper := &fakeSweepRunner{result: sweepResult}
	audit := &captureAuditPublisher{}
	s := newSched(t, runs, sweeper, audit)
	return s, audit
}

// ── Tests ─────────────────────────────────────────────────────────────────────

func TestCreateSchedule_ValidInput(t *testing.T) {
	sched, audit := newScheds(t, newTestRun(), nil)
	created, err := sched.CreateSchedule(scheduler.CreateScheduleRequest{
		ScopeRunID:     testScopeRunID,
		CronExpression: "0 * * * *", // every hour
		NotifyOnChange: true,
		Description:    "Hourly rediscovery",
		CreatedBy:      "admin-user",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if created.ID == "" {
		t.Error("expected schedule ID to be set")
	}
	if created.Enabled != true {
		t.Error("new schedules should be enabled by default")
	}
	// Audit event should be emitted
	if len(audit.events) == 0 {
		t.Error("expected audit event on schedule creation")
	}
	found := false
	for _, e := range audit.events {
		if e.Type == "schedule.created" {
			found = true
			break
		}
	}
	if !found {
		t.Error("expected 'schedule.created' audit event")
	}
}

func TestCreateSchedule_InvalidCron(t *testing.T) {
	sched, _ := newScheds(t, newTestRun(), nil)
	_, err := sched.CreateSchedule(scheduler.CreateScheduleRequest{
		ScopeRunID:     testScopeRunID,
		CronExpression: "not-a-valid-cron",
		CreatedBy:      "admin",
	})
	if err == nil {
		t.Fatal("expected error for invalid cron expression")
	}
	if !errors.Is(err, scheduler.ErrInvalidCron) {
		t.Errorf("expected ErrInvalidCron, got: %v", err)
	}
}

func TestCreateSchedule_MissingScopeRun(t *testing.T) {
	runs := &fakeRunSource{runs: map[string]*model.DiscoveryRun{}}
	sched := newSched(t, runs, &fakeSweepRunner{}, nil)
	_, err := sched.CreateSchedule(scheduler.CreateScheduleRequest{
		ScopeRunID:     "nonexistent-run",
		CronExpression: "0 * * * *",
		CreatedBy:      "admin",
	})
	if err == nil {
		t.Fatal("expected error for missing scope run")
	}
	if !errors.Is(err, scheduler.ErrScopeRunNotFound) {
		t.Errorf("expected ErrScopeRunNotFound, got: %v", err)
	}
}

func TestListSchedules(t *testing.T) {
	sched, _ := newScheds(t, newTestRun(), nil)
	if got := sched.ListSchedules(); len(got) != 0 {
		t.Errorf("expected empty list initially, got %d", len(got))
	}
	sched.CreateSchedule(scheduler.CreateScheduleRequest{ //nolint:errcheck
		ScopeRunID:     testScopeRunID,
		CronExpression: "0 * * * *",
		CreatedBy:      "admin",
	})
	if got := sched.ListSchedules(); len(got) != 1 {
		t.Errorf("expected 1 schedule, got %d", len(got))
	}
}

func TestUpdateSchedule_DisableSchedule(t *testing.T) {
	sched, _ := newScheds(t, newTestRun(), nil)
	created, _ := sched.CreateSchedule(scheduler.CreateScheduleRequest{
		ScopeRunID:     testScopeRunID,
		CronExpression: "0 * * * *",
		CreatedBy:      "admin",
	})

	updated, err := sched.UpdateSchedule(created.ID, scheduler.UpdateScheduleRequest{
		Enabled:    false,
		EnabledSet: true,
		UpdatedBy:  "admin",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if updated.Enabled {
		t.Error("expected schedule to be disabled")
	}
}

func TestUpdateSchedule_NotFound(t *testing.T) {
	sched, _ := newScheds(t, newTestRun(), nil)
	_, err := sched.UpdateSchedule("nonexistent-id", scheduler.UpdateScheduleRequest{UpdatedBy: "admin"})
	if !errors.Is(err, scheduler.ErrScheduleNotFound) {
		t.Errorf("expected ErrScheduleNotFound, got: %v", err)
	}
}

func TestDeleteSchedule(t *testing.T) {
	sched, _ := newScheds(t, newTestRun(), nil)
	created, _ := sched.CreateSchedule(scheduler.CreateScheduleRequest{
		ScopeRunID:     testScopeRunID,
		CronExpression: "0 * * * *",
		CreatedBy:      "admin",
	})

	if err := sched.DeleteSchedule(created.ID, "admin"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got := sched.ListSchedules(); len(got) != 0 {
		t.Errorf("expected 0 schedules after delete, got %d", len(got))
	}
}

func TestTriggerNow_NewDevicesDetected(t *testing.T) {
	sweepResult := &scanner.SweepResult{
		RunID:  testScopeRunID,
		Status: "SWEEP_COMPLETE",
		HostResults: []scanner.HostResult{
			{IP: "10.0.0.1", Status: scanner.StatusReachable, LatencyMs: 5},
			{IP: "10.0.0.2", Status: scanner.StatusReachable, LatencyMs: 8},
		},
	}
	sched, audit := newScheds(t, newTestRun(), sweepResult)

	created, _ := sched.CreateSchedule(scheduler.CreateScheduleRequest{
		ScopeRunID:     testScopeRunID,
		CronExpression: "0 0 * * *",
		CreatedBy:      "admin",
	})

	history, err := sched.TriggerNow(context.Background(), created.ID, "admin")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if history == nil {
		t.Fatal("expected history entry")
	}
	// First run — no baseline yet, so both hosts are "new"
	if history.ChangeSummary.NewDevices != 2 {
		t.Errorf("expected 2 new devices on first run, got %d", history.ChangeSummary.NewDevices)
	}

	// Audit events for material changes should have been emitted
	changeEventCount := 0
	for _, e := range audit.events {
		if e.Type == "discovery.mode.changed" {
			changeEventCount++
		}
	}
	if changeEventCount != 2 {
		t.Errorf("expected 2 change audit events (new devices), got %d", changeEventCount)
	}
}

func TestTriggerNow_RemovedDeviceDetected(t *testing.T) {
	// First run: two hosts
	sweepResult1 := &scanner.SweepResult{
		Status: "SWEEP_COMPLETE",
		HostResults: []scanner.HostResult{
			{IP: "10.0.0.1", Status: scanner.StatusReachable},
			{IP: "10.0.0.2", Status: scanner.StatusReachable},
		},
	}
	// Second run: only one host
	sweepResult2 := &scanner.SweepResult{
		Status: "SWEEP_COMPLETE",
		HostResults: []scanner.HostResult{
			{IP: "10.0.0.1", Status: scanner.StatusReachable},
		},
	}

	run := newTestRun()
	runs := &fakeRunSource{runs: map[string]*model.DiscoveryRun{run.ID: run}}
	sweeper := &switchableSweeper{results: []*scanner.SweepResult{sweepResult1, sweepResult2}}
	audit := &captureAuditPublisher{}
	store := scheduler.NewInMemoryScheduleStore()
	s := scheduler.NewRediscoveryScheduler(store, runs, sweeper, audit)
	s.Start()
	defer s.Stop()

	created, _ := s.CreateSchedule(scheduler.CreateScheduleRequest{
		ScopeRunID:     testScopeRunID,
		CronExpression: "0 0 * * *",
		CreatedBy:      "admin",
	})

	// First run: establishes baseline
	h1, err := s.TriggerNow(context.Background(), created.ID, "admin")
	if err != nil {
		t.Fatalf("first run error: %v", err)
	}
	if h1.ChangeSummary.NewDevices != 2 {
		t.Errorf("first run: expected 2 new devices, got %d", h1.ChangeSummary.NewDevices)
	}

	// Second run: should detect removed device
	h2, err := s.TriggerNow(context.Background(), created.ID, "admin")
	if err != nil {
		t.Fatalf("second run error: %v", err)
	}
	if h2.ChangeSummary.RemovedDevices != 1 {
		t.Errorf("second run: expected 1 removed device, got %d", h2.ChangeSummary.RemovedDevices)
	}
}

func TestTriggerNow_NoChangeRun(t *testing.T) {
	sweepResult := &scanner.SweepResult{
		Status: "SWEEP_COMPLETE",
		HostResults: []scanner.HostResult{
			{IP: "10.0.0.1", Status: scanner.StatusReachable},
		},
	}
	sched, audit := newScheds(t, newTestRun(), sweepResult)
	created, _ := sched.CreateSchedule(scheduler.CreateScheduleRequest{
		ScopeRunID:     testScopeRunID,
		CronExpression: "0 0 * * *",
		CreatedBy:      "admin",
	})

	// Run twice with same results
	sched.TriggerNow(context.Background(), created.ID, "admin") //nolint:errcheck
	auditCountAfterFirst := len(audit.events)

	sched.TriggerNow(context.Background(), created.ID, "admin") //nolint:errcheck
	auditCountAfterSecond := len(audit.events)

	// Second run should not produce more "discovery.mode.changed" events than first
	firstChangeCount := countByType(audit.events[:auditCountAfterFirst], "discovery.mode.changed")
	secondChangeCount := countByType(audit.events[auditCountAfterFirst:auditCountAfterSecond], "discovery.mode.changed")
	if secondChangeCount > 0 && secondChangeCount >= firstChangeCount {
		t.Errorf("second identical run should not emit more change events; first=%d, second=%d", firstChangeCount, secondChangeCount)
	}
}

func TestTriggerNow_ScheduleNotFound(t *testing.T) {
	sched, _ := newScheds(t, newTestRun(), nil)
	_, err := sched.TriggerNow(context.Background(), "nonexistent-id", "admin")
	if !errors.Is(err, scheduler.ErrScheduleNotFound) {
		t.Errorf("expected ErrScheduleNotFound, got: %v", err)
	}
}

func TestGetHistory_Empty(t *testing.T) {
	sched, _ := newScheds(t, newTestRun(), nil)
	created, _ := sched.CreateSchedule(scheduler.CreateScheduleRequest{
		ScopeRunID:     testScopeRunID,
		CronExpression: "0 0 * * *",
		CreatedBy:      "admin",
	})
	if got := sched.GetHistory(created.ID); len(got) != 0 {
		t.Errorf("expected empty history before any runs, got %d", len(got))
	}
}

func TestGetHistory_AfterRun(t *testing.T) {
	sched, _ := newScheds(t, newTestRun(), nil)
	created, _ := sched.CreateSchedule(scheduler.CreateScheduleRequest{
		ScopeRunID:     testScopeRunID,
		CronExpression: "0 0 * * *",
		CreatedBy:      "admin",
	})
	sched.TriggerNow(context.Background(), created.ID, "admin") //nolint:errcheck
	if got := sched.GetHistory(created.ID); len(got) != 1 {
		t.Errorf("expected 1 history entry after run, got %d", len(got))
	}
}

func TestTriggerNow_AuditPublisherFailureIsLogged(t *testing.T) {
	run := newTestRun()
	runs := &fakeRunSource{runs: map[string]*model.DiscoveryRun{run.ID: run}}
	sweeper := &fakeSweepRunner{}
	// Audit publisher always fails
	store := scheduler.NewInMemoryScheduleStore()
	s := scheduler.NewRediscoveryScheduler(store, runs, sweeper, &failingAuditPublisher{})
	s.Start()
	defer s.Stop()

	// CreateSchedule emits an audit event internally; it should NOT bubble up as an error
	created, err := s.CreateSchedule(scheduler.CreateScheduleRequest{
		ScopeRunID:     testScopeRunID,
		CronExpression: "0 0 * * *",
		CreatedBy:      "admin",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// TriggerNow should succeed even if audit publishing fails
	_, err = s.TriggerNow(context.Background(), created.ID, "admin")
	if err != nil {
		t.Fatalf("expected success even with failing audit publisher, got: %v", err)
	}
}

// ── switchableSweeper: cycles through a list of results ──────────────────────

type switchableSweeper struct {
	results []*scanner.SweepResult
	call    int
}

func (s *switchableSweeper) Sweep(_ context.Context, run *model.DiscoveryRun) (*scanner.SweepResult, error) {
	if s.call >= len(s.results) {
		return nil, nil
	}
	r := s.results[s.call]
	s.call++
	if r != nil {
		r.RunID = run.ID
	}
	return r, nil
}

// ── Utility ───────────────────────────────────────────────────────────────────

func countByType(events []scheduler.AuditEvent, evtType string) int {
	count := 0
	for _, e := range events {
		if e.Type == evtType {
			count++
		}
	}
	return count
}
