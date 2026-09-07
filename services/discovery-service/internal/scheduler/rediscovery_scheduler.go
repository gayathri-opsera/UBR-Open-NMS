// Package scheduler implements scheduled generic rediscovery with change-audit publication (WO-017).
//
// An operator creates a RediscoverySchedule referencing an existing approved scope run.
// At each cadence tick the scheduler re-runs the scope, compares results to the previous
// baseline, categorises new/removed/changed/unchanged devices, and emits an immutable
// audit event for each material change.
//
// Schedules are stored in memory for this implementation; swap ScheduleStore for a
// MongoDB-backed implementation in production.
//
// The github.com/robfig/cron/v3 library drives the cron scheduler.
package scheduler

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/airtel-ubrnms/discovery-service/internal/model"
	"github.com/airtel-ubrnms/discovery-service/internal/scanner"
	"github.com/google/uuid"
	"github.com/robfig/cron/v3"
)

// ── Error sentinels ───────────────────────────────────────────────────────────

var (
	ErrScheduleNotFound    = errors.New("schedule not found")
	ErrInvalidCron         = errors.New("invalid cron expression")
	ErrScopeRunNotFound    = errors.New("scope run not found")
	ErrScheduleConflict    = errors.New("schedule already running")
	ErrInsufficientPerms   = errors.New("insufficient permissions to modify schedule")
)

// ── Models ────────────────────────────────────────────────────────────────────

// RediscoverySchedule stores cadence, scope reference, and lifecycle metadata.
type RediscoverySchedule struct {
	ID             string    `json:"id"`
	ScopeRunID     string    `json:"scopeRunId"`
	CronExpression string    `json:"cronExpression"`
	Enabled        bool      `json:"enabled"`
	NotifyOnChange bool      `json:"notifyOnChange"`
	Description    string    `json:"description,omitempty"`
	CreatedBy      string    `json:"createdBy"`
	UpdatedBy      string    `json:"updatedBy,omitempty"`
	CreatedAt      time.Time `json:"createdAt"`
	UpdatedAt      time.Time `json:"updatedAt"`
	NextRunAt      *time.Time `json:"nextRunAt,omitempty"`
	LastRunID      string    `json:"lastRunId,omitempty"`
}

// DeviceSnapshot is a normalised point-in-time view of a discovered device
// used for baseline comparison.
type DeviceSnapshot struct {
	IP              string `json:"ip"`
	Status          string `json:"status"`
	LatencyMs       int64  `json:"latencyMs,omitempty"`
}

// ChangeCategory classifies how a device changed between runs.
type ChangeCategory string

const (
	ChangeNew       ChangeCategory = "new"
	ChangeRemoved   ChangeCategory = "removed"
	ChangeModified  ChangeCategory = "changed"
	ChangeUnchanged ChangeCategory = "unchanged"
)

// DeviceChange records a before/after comparison for one device.
type DeviceChange struct {
	IP       string         `json:"ip"`
	Category ChangeCategory `json:"category"`
	Before   *DeviceSnapshot `json:"before,omitempty"`
	After    *DeviceSnapshot `json:"after,omitempty"`
}

// RediscoveryHistoryEntry records one completed rediscovery run.
type RediscoveryHistoryEntry struct {
	ID              string         `json:"id"`
	ScheduleID      string         `json:"scheduleId"`
	BaselineRunID   string         `json:"baselineRunId"`
	CurrentRunID    string         `json:"currentRunId"`
	ChangeSummary   ChangeSummary  `json:"changeSummary"`
	DeviceChanges   []DeviceChange `json:"deviceChanges"`
	AuditEventIDs   []string       `json:"auditEventIds"`
	StartedAt       time.Time      `json:"startedAt"`
	CompletedAt     time.Time      `json:"completedAt"`
}

// ChangeSummary is the top-level tally for a rediscovery comparison.
type ChangeSummary struct {
	NewDevices       int `json:"newDevices"`
	RemovedDevices   int `json:"removedDevices"`
	ChangedDevices   int `json:"changedDevices"`
	UnchangedDevices int `json:"unchangedDevices"`
}

// AuditEvent is the immutable record emitted for each material change.
type AuditEvent struct {
	ID         string          `json:"id"`
	Type       string          `json:"type"`
	ScheduleID string          `json:"scheduleId"`
	RunID      string          `json:"runId"`
	Change     *DeviceChange   `json:"change,omitempty"`
	Actor      string          `json:"actor"`
	Timestamp  time.Time       `json:"timestamp"`
}

// ── Interfaces ────────────────────────────────────────────────────────────────

// DiscoveryRunSource retrieves stored discovery runs by ID.
type DiscoveryRunSource interface {
	Get(id string) (*model.DiscoveryRun, bool)
}

// SweepRunner executes an ICMP sweep for a discovery run and returns results.
type SweepRunner interface {
	Sweep(ctx context.Context, run *model.DiscoveryRun) (*scanner.SweepResult, error)
}

// AuditPublisher emits immutable audit events.
type AuditPublisher interface {
	Publish(evt AuditEvent) error
}

// ── In-memory stores ──────────────────────────────────────────────────────────

// InMemoryScheduleStore stores schedules in memory.
type InMemoryScheduleStore struct {
	mu        sync.RWMutex
	schedules map[string]*RediscoverySchedule
	history   map[string][]*RediscoveryHistoryEntry // scheduleID -> entries
	baselines map[string][]DeviceSnapshot            // runID -> snapshot
}

func NewInMemoryScheduleStore() *InMemoryScheduleStore {
	return &InMemoryScheduleStore{
		schedules: make(map[string]*RediscoverySchedule),
		history:   make(map[string][]*RediscoveryHistoryEntry),
		baselines: make(map[string][]DeviceSnapshot),
	}
}

func (s *InMemoryScheduleStore) Create(sched *RediscoverySchedule) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.schedules[sched.ID] = sched
	return nil
}

func (s *InMemoryScheduleStore) Get(id string) (*RediscoverySchedule, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	v, ok := s.schedules[id]
	return v, ok
}

func (s *InMemoryScheduleStore) Update(sched *RediscoverySchedule) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.schedules[sched.ID]; !ok {
		return ErrScheduleNotFound
	}
	s.schedules[sched.ID] = sched
	return nil
}

func (s *InMemoryScheduleStore) Delete(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.schedules[id]; !ok {
		return ErrScheduleNotFound
	}
	delete(s.schedules, id)
	return nil
}

func (s *InMemoryScheduleStore) List() []*RediscoverySchedule {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]*RediscoverySchedule, 0, len(s.schedules))
	for _, v := range s.schedules {
		out = append(out, v)
	}
	return out
}

func (s *InMemoryScheduleStore) SaveBaseline(runID string, snapshots []DeviceSnapshot) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.baselines[runID] = snapshots
}

func (s *InMemoryScheduleStore) GetBaseline(runID string) ([]DeviceSnapshot, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	v, ok := s.baselines[runID]
	return v, ok
}

func (s *InMemoryScheduleStore) AppendHistory(entry *RediscoveryHistoryEntry) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.history[entry.ScheduleID] = append(s.history[entry.ScheduleID], entry)
}

func (s *InMemoryScheduleStore) GetHistory(scheduleID string) []*RediscoveryHistoryEntry {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.history[scheduleID]
}

// noopAuditPublisher satisfies AuditPublisher without emitting anything.
type noopAuditPublisher struct{}

func (n *noopAuditPublisher) Publish(evt AuditEvent) error {
	slog.Info("audit event (noop)", "type", evt.Type, "scheduleId", evt.ScheduleID)
	return nil
}

// ── RediscoveryScheduler ──────────────────────────────────────────────────────

// RediscoveryScheduler manages cron-driven rediscovery of approved discovery scopes.
type RediscoveryScheduler struct {
	store     *InMemoryScheduleStore
	runs      DiscoveryRunSource
	sweeper   SweepRunner
	audit     AuditPublisher
	cron      *cron.Cron
	cronIDs   map[string]cron.EntryID // scheduleID -> cron entry ID
	mu        sync.Mutex
}

// NewRediscoveryScheduler constructs a RediscoveryScheduler.
func NewRediscoveryScheduler(
	store *InMemoryScheduleStore,
	runs DiscoveryRunSource,
	sweeper SweepRunner,
	audit AuditPublisher,
) *RediscoveryScheduler {
	if audit == nil {
		audit = &noopAuditPublisher{}
	}
	return &RediscoveryScheduler{
		store:   store,
		runs:    runs,
		sweeper: sweeper,
		audit:   audit,
		cron:    cron.New(cron.WithSeconds()),
		cronIDs: make(map[string]cron.EntryID),
	}
}

// Start begins the cron scheduler. Call once at startup.
func (s *RediscoveryScheduler) Start() {
	s.cron.Start()
}

// Stop gracefully shuts down the cron scheduler.
func (s *RediscoveryScheduler) Stop() context.Context {
	return s.cron.Stop()
}

// CreateSchedule validates and stores a new rediscovery schedule.
func (s *RediscoveryScheduler) CreateSchedule(req CreateScheduleRequest) (*RediscoverySchedule, error) {
	if req.CreatedBy == "" {
		return nil, fmt.Errorf("createdBy is required")
	}

	// Validate cron expression
	if _, err := cron.ParseStandard(req.CronExpression); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrInvalidCron, err)
	}

	// Verify the scope run exists
	if _, ok := s.runs.Get(req.ScopeRunID); !ok {
		return nil, ErrScopeRunNotFound
	}

	now := time.Now().UTC()
	sched := &RediscoverySchedule{
		ID:             uuid.NewString(),
		ScopeRunID:     req.ScopeRunID,
		CronExpression: req.CronExpression,
		Enabled:        true,
		NotifyOnChange: req.NotifyOnChange,
		Description:    req.Description,
		CreatedBy:      req.CreatedBy,
		CreatedAt:      now,
		UpdatedAt:      now,
	}

	if err := s.store.Create(sched); err != nil {
		return nil, fmt.Errorf("failed to persist schedule: %w", err)
	}

	// Register with the cron scheduler
	if err := s.registerCron(sched); err != nil {
		return nil, fmt.Errorf("cron registration failed: %w", err)
	}

	s.emitAudit("schedule.created", sched.ID, "", req.CreatedBy, nil)
	slog.Info("Rediscovery schedule created", "scheduleId", sched.ID, "cron", sched.CronExpression)
	return sched, nil
}

// CreateScheduleRequest carries the input for CreateSchedule.
type CreateScheduleRequest struct {
	ScopeRunID     string
	CronExpression string
	NotifyOnChange bool
	Description    string
	CreatedBy      string
}

// UpdateSchedule updates an existing schedule's cron expression or enabled state.
func (s *RediscoveryScheduler) UpdateSchedule(id string, req UpdateScheduleRequest) (*RediscoverySchedule, error) {
	sched, ok := s.store.Get(id)
	if !ok {
		return nil, ErrScheduleNotFound
	}

	if req.CronExpression != "" {
		if _, err := cron.ParseStandard(req.CronExpression); err != nil {
			return nil, fmt.Errorf("%w: %v", ErrInvalidCron, err)
		}
		sched.CronExpression = req.CronExpression
	}
	if req.EnabledSet {
		sched.Enabled = req.Enabled
	}
	if req.NotifyOnChangeSet {
		sched.NotifyOnChange = req.NotifyOnChange
	}
	if req.Description != "" {
		sched.Description = req.Description
	}
	sched.UpdatedBy = req.UpdatedBy
	sched.UpdatedAt = time.Now().UTC()

	if err := s.store.Update(sched); err != nil {
		return nil, err
	}

	// Re-register with updated cron expression (or remove if disabled)
	s.deregisterCron(id)
	if sched.Enabled {
		if err := s.registerCron(sched); err != nil {
			return nil, fmt.Errorf("cron re-registration failed: %w", err)
		}
	}

	s.emitAudit("schedule.updated", sched.ID, "", req.UpdatedBy, nil)
	return sched, nil
}

// UpdateScheduleRequest carries update fields for UpdateSchedule.
type UpdateScheduleRequest struct {
	CronExpression    string
	Enabled           bool
	EnabledSet        bool // distinguishes "set to false" from "not provided"
	NotifyOnChange    bool
	NotifyOnChangeSet bool
	Description       string
	UpdatedBy         string
}

// DeleteSchedule removes a schedule. In-flight runs are not interrupted.
func (s *RediscoveryScheduler) DeleteSchedule(id, actor string) error {
	if _, ok := s.store.Get(id); !ok {
		return ErrScheduleNotFound
	}
	s.deregisterCron(id)
	if err := s.store.Delete(id); err != nil {
		return err
	}
	s.emitAudit("schedule.deleted", id, "", actor, nil)
	return nil
}

// ListSchedules returns all stored schedules.
func (s *RediscoveryScheduler) ListSchedules() []*RediscoverySchedule {
	return s.store.List()
}

// TriggerNow runs a rediscovery immediately for the given schedule.
func (s *RediscoveryScheduler) TriggerNow(ctx context.Context, scheduleID, actor string) (*RediscoveryHistoryEntry, error) {
	sched, ok := s.store.Get(scheduleID)
	if !ok {
		return nil, ErrScheduleNotFound
	}
	return s.executeRediscovery(ctx, sched, actor)
}

// GetHistory returns rediscovery history for a schedule.
func (s *RediscoveryScheduler) GetHistory(scheduleID string) []*RediscoveryHistoryEntry {
	return s.store.GetHistory(scheduleID)
}

// ── Internal execution ────────────────────────────────────────────────────────

// registerCron adds the schedule to the cron runner.
func (s *RediscoveryScheduler) registerCron(sched *RediscoverySchedule) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	id, err := s.cron.AddFunc(sched.CronExpression, func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
		defer cancel()
		if _, err := s.executeRediscovery(ctx, sched, "scheduler"); err != nil {
			slog.Error("Scheduled rediscovery failed", "scheduleId", sched.ID, "error", err)
		}
	})
	if err != nil {
		return err
	}
	s.cronIDs[sched.ID] = id
	// Update NextRunAt from the cron entry
	entry := s.cron.Entry(id)
	next := entry.Next
	if !next.IsZero() {
		s.mu.Unlock()
		sched.NextRunAt = &next
		_ = s.store.Update(sched)
		s.mu.Lock()
	}
	return nil
}

// deregisterCron removes the schedule from the cron runner.
func (s *RediscoveryScheduler) deregisterCron(scheduleID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if id, ok := s.cronIDs[scheduleID]; ok {
		s.cron.Remove(id)
		delete(s.cronIDs, scheduleID)
	}
}

// executeRediscovery runs the discovery scope, compares with baseline, and emits audit events.
func (s *RediscoveryScheduler) executeRediscovery(ctx context.Context, sched *RediscoverySchedule, actor string) (*RediscoveryHistoryEntry, error) {
	startedAt := time.Now().UTC()

	// Resolve the scope run
	run, ok := s.runs.Get(sched.ScopeRunID)
	if !ok {
		return nil, fmt.Errorf("%w: %s", ErrScopeRunNotFound, sched.ScopeRunID)
	}

	s.emitAudit("schedule.run.started", sched.ID, "", actor, nil)

	// Execute the sweep
	sweepResult, err := s.sweeper.Sweep(ctx, run)
	if err != nil {
		s.emitAudit("schedule.run.failed", sched.ID, "", actor, nil)
		return nil, fmt.Errorf("sweep failed: %w", err)
	}

	// Build current snapshot
	currentSnapshots := buildSnapshot(sweepResult)

	// Load previous baseline (if any)
	baselineRunID := sched.LastRunID
	prevSnapshots, _ := s.store.GetBaseline(baselineRunID)

	// Compare
	changes := compareSnapshots(prevSnapshots, currentSnapshots)

	// Persist current as new baseline
	currentRunID := uuid.NewString()
	s.store.SaveBaseline(currentRunID, currentSnapshots)

	// Build change summary
	summary := summarise(changes)

	// Emit per-change audit events
	auditIDs := make([]string, 0)
	for i := range changes {
		if changes[i].Category == ChangeUnchanged {
			continue
		}
		evt := AuditEvent{
			ID:         uuid.NewString(),
			Type:       "discovery.mode.changed",
			ScheduleID: sched.ID,
			RunID:      currentRunID,
			Change:     &changes[i],
			Actor:      actor,
			Timestamp:  time.Now().UTC(),
		}
		if err := s.audit.Publish(evt); err != nil {
			slog.Error("Failed to publish audit event", "scheduleId", sched.ID, "error", err)
		}
		auditIDs = append(auditIDs, evt.ID)
	}

	completedAt := time.Now().UTC()
	entry := &RediscoveryHistoryEntry{
		ID:            uuid.NewString(),
		ScheduleID:    sched.ID,
		BaselineRunID: baselineRunID,
		CurrentRunID:  currentRunID,
		ChangeSummary: summary,
		DeviceChanges: changes,
		AuditEventIDs: auditIDs,
		StartedAt:     startedAt,
		CompletedAt:   completedAt,
	}
	s.store.AppendHistory(entry)

	// Update schedule with last run info
	sched.LastRunID = currentRunID
	sched.UpdatedAt = completedAt
	_ = s.store.Update(sched)

	s.emitAudit("schedule.run.completed", sched.ID, currentRunID, actor, nil)
	slog.Info("Rediscovery run completed",
		"scheduleId", sched.ID,
		"new", summary.NewDevices,
		"removed", summary.RemovedDevices,
		"changed", summary.ChangedDevices,
	)
	return entry, nil
}

// ── Change detection ──────────────────────────────────────────────────────────

func buildSnapshot(result *scanner.SweepResult) []DeviceSnapshot {
	snapshots := make([]DeviceSnapshot, 0, len(result.HostResults))
	for _, hr := range result.HostResults {
		snapshots = append(snapshots, DeviceSnapshot{
			IP:        hr.IP,
			Status:    hr.Status,
			LatencyMs: hr.LatencyMs,
		})
	}
	return snapshots
}

func compareSnapshots(prev, curr []DeviceSnapshot) []DeviceChange {
	prevMap := make(map[string]*DeviceSnapshot, len(prev))
	for i := range prev {
		prevMap[prev[i].IP] = &prev[i]
	}
	currMap := make(map[string]*DeviceSnapshot, len(curr))
	for i := range curr {
		currMap[curr[i].IP] = &curr[i]
	}

	var changes []DeviceChange

	// Current devices
	for ip, currSnap := range currMap {
		if prevSnap, exists := prevMap[ip]; !exists {
			// New device
			changes = append(changes, DeviceChange{
				IP:       ip,
				Category: ChangeNew,
				After:    currSnap,
			})
		} else if deviceChanged(prevSnap, currSnap) {
			changes = append(changes, DeviceChange{
				IP:       ip,
				Category: ChangeModified,
				Before:   prevSnap,
				After:    currSnap,
			})
		} else {
			changes = append(changes, DeviceChange{
				IP:       ip,
				Category: ChangeUnchanged,
				Before:   prevSnap,
				After:    currSnap,
			})
		}
	}

	// Removed devices (present in prev, absent in curr)
	for ip, prevSnap := range prevMap {
		if _, exists := currMap[ip]; !exists {
			changes = append(changes, DeviceChange{
				IP:       ip,
				Category: ChangeRemoved,
				Before:   prevSnap,
			})
		}
	}

	return changes
}

func deviceChanged(prev, curr *DeviceSnapshot) bool {
	// A device is considered changed if its reachability status differs
	return prev.Status != curr.Status
}

func summarise(changes []DeviceChange) ChangeSummary {
	var s ChangeSummary
	for _, c := range changes {
		switch c.Category {
		case ChangeNew:
			s.NewDevices++
		case ChangeRemoved:
			s.RemovedDevices++
		case ChangeModified:
			s.ChangedDevices++
		case ChangeUnchanged:
			s.UnchangedDevices++
		}
	}
	return s
}

// emitAudit is a helper to emit lifecycle audit events without blocking the scheduler.
func (s *RediscoveryScheduler) emitAudit(evtType, scheduleID, runID, actor string, change *DeviceChange) {
	evt := AuditEvent{
		ID:         uuid.NewString(),
		Type:       evtType,
		ScheduleID: scheduleID,
		RunID:      runID,
		Actor:      actor,
		Change:     change,
		Timestamp:  time.Now().UTC(),
	}
	if err := s.audit.Publish(evt); err != nil {
		slog.Error("Failed to emit audit event", "type", evtType, "scheduleId", scheduleID)
	}
}
