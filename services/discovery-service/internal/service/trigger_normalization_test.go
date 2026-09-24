// Package service — unit tests for WO-008 trigger normalization and duplicate suppression.
package service

import (
	"errors"
	"testing"

	"github.com/airtel-ubrnms/discovery-service/internal/model"
)

// ── Trigger mode normalization tests ─────────────────────────────────────────

// TestCreateDiscoveryRun_TriggerMode_DefaultsToManual verifies that an absent
// triggerMode is normalized to MANUAL.
func TestCreateDiscoveryRun_TriggerMode_DefaultsToManual(t *testing.T) {
	store := NewDeviceStore()
	runStore := NewDiscoveryRunStore()
	svc := NewDiscoveryService("secret", 300, &noopPublisher{}, store)

	req := &model.DiscoveryRunRequest{
		Scope: []model.ScopeEntry{{Type: "IP", Value: "10.0.0.1"}},
		// TriggerMode intentionally absent
	}
	resp, _, err := svc.CreateDiscoveryRun(req, "user", runStore)
	if err != nil {
		t.Fatalf("CreateDiscoveryRun error=%v", err)
	}

	run, ok := runStore.Get(resp.RunID)
	if !ok {
		t.Fatal("run not found in store")
	}
	if run.TriggerMode != model.TriggerModeManual {
		t.Errorf("TriggerMode=%s, want MANUAL", run.TriggerMode)
	}
}

// TestCreateDiscoveryRun_TriggerMode_ValidValues verifies that all allowed trigger
// modes are accepted.
func TestCreateDiscoveryRun_TriggerMode_ValidValues(t *testing.T) {
	validModes := []model.TriggerMode{
		model.TriggerModeManual,
		model.TriggerModeScheduled,
		model.TriggerModeEventTrap,
		model.TriggerModeEventSyslog,
		model.TriggerModeEventDHCP,
	}
	for _, mode := range validModes {
		store := NewDeviceStore()
		runStore := NewDiscoveryRunStore()
		svc := NewDiscoveryService("secret", 300, &noopPublisher{}, store)

		req := &model.DiscoveryRunRequest{
			Scope:       []model.ScopeEntry{{Type: "IP", Value: "10.0.0.2"}},
			TriggerMode: mode,
		}
		_, _, err := svc.CreateDiscoveryRun(req, "user", runStore)
		if err != nil {
			t.Errorf("mode=%s: unexpected error: %v", mode, err)
		}
	}
}

// TestCreateDiscoveryRun_TriggerMode_InvalidValue verifies that unsupported trigger
// modes are rejected with ErrInvalidScope.
func TestCreateDiscoveryRun_TriggerMode_InvalidValue(t *testing.T) {
	store := NewDeviceStore()
	runStore := NewDiscoveryRunStore()
	svc := NewDiscoveryService("secret", 300, &noopPublisher{}, store)

	req := &model.DiscoveryRunRequest{
		Scope:       []model.ScopeEntry{{Type: "IP", Value: "10.0.0.3"}},
		TriggerMode: model.TriggerMode("WEBHOOK"),
	}
	_, fieldErrors, err := svc.CreateDiscoveryRun(req, "user", runStore)
	if !errors.Is(err, ErrInvalidScope) {
		t.Errorf("err=%v, want ErrInvalidScope", err)
	}
	if len(fieldErrors) == 0 {
		t.Error("expected fieldErrors for invalid triggerMode")
	}
	if len(fieldErrors) > 0 && fieldErrors[0].Field != "triggerMode" {
		t.Errorf("fieldErrors[0].Field=%s, want triggerMode", fieldErrors[0].Field)
	}
}

// TestCreateDiscoveryRun_CorrelationID_PropagatedToRun verifies that a caller-supplied
// correlationId is stored on the run record.
func TestCreateDiscoveryRun_CorrelationID_PropagatedToRun(t *testing.T) {
	store := NewDeviceStore()
	runStore := NewDiscoveryRunStore()
	svc := NewDiscoveryService("secret", 300, &noopPublisher{}, store)

	req := &model.DiscoveryRunRequest{
		Scope:         []model.ScopeEntry{{Type: "IP", Value: "10.0.0.4"}},
		CorrelationID: "test-corr-id-007",
	}
	resp, _, err := svc.CreateDiscoveryRun(req, "user", runStore)
	if err != nil {
		t.Fatalf("CreateDiscoveryRun error=%v", err)
	}

	run, ok := runStore.Get(resp.RunID)
	if !ok {
		t.Fatal("run not found in store")
	}
	if run.CorrelationID != "test-corr-id-007" {
		t.Errorf("CorrelationID=%s, want test-corr-id-007", run.CorrelationID)
	}
}

// TestCreateDiscoveryRun_CorrelationID_GeneratedWhenAbsent verifies that a
// correlation ID is auto-generated when the caller does not supply one.
func TestCreateDiscoveryRun_CorrelationID_GeneratedWhenAbsent(t *testing.T) {
	store := NewDeviceStore()
	runStore := NewDiscoveryRunStore()
	svc := NewDiscoveryService("secret", 300, &noopPublisher{}, store)

	req := &model.DiscoveryRunRequest{
		Scope: []model.ScopeEntry{{Type: "IP", Value: "10.0.0.5"}},
	}
	resp, _, err := svc.CreateDiscoveryRun(req, "user", runStore)
	if err != nil {
		t.Fatalf("CreateDiscoveryRun error=%v", err)
	}

	run, _ := runStore.Get(resp.RunID)
	if run.CorrelationID == "" {
		t.Error("CorrelationID should be auto-generated when absent")
	}
}

// ── Duplicate in-flight target suppression tests ──────────────────────────────

// TestHasActiveRunForTarget_ReturnsTrueForQueuedRun verifies detection of an
// in-flight QUEUED run for a specific target IP.
func TestHasActiveRunForTarget_ReturnsTrueForQueuedRun(t *testing.T) {
	runStore := NewDiscoveryRunStore()
	runStore.Create(&model.DiscoveryRun{
		ID:              "run-001",
		Status:          "QUEUED",
		NormalizedScope: []model.ScopeEntry{{Type: "IP", Value: "192.168.1.1"}},
	}) //nolint:errcheck

	if !runStore.HasActiveRunForTarget("192.168.1.1") {
		t.Error("HasActiveRunForTarget should return true for QUEUED run with matching target")
	}
}

// TestHasActiveRunForTarget_ReturnsTrueForRunningRun verifies detection of a
// RUNNING run.
func TestHasActiveRunForTarget_ReturnsTrueForRunningRun(t *testing.T) {
	runStore := NewDiscoveryRunStore()
	runStore.Create(&model.DiscoveryRun{
		ID:              "run-002",
		Status:          "RUNNING",
		NormalizedScope: []model.ScopeEntry{{Type: "IP", Value: "10.0.0.10"}},
	}) //nolint:errcheck

	if !runStore.HasActiveRunForTarget("10.0.0.10") {
		t.Error("HasActiveRunForTarget should return true for RUNNING run with matching target")
	}
}

// TestHasActiveRunForTarget_ReturnsFalseForCompletedRun verifies that completed
// runs do not block new event-driven runs for the same target.
func TestHasActiveRunForTarget_ReturnsFalseForCompletedRun(t *testing.T) {
	runStore := NewDiscoveryRunStore()
	runStore.Create(&model.DiscoveryRun{
		ID:              "run-003",
		Status:          "COMPLETED",
		NormalizedScope: []model.ScopeEntry{{Type: "IP", Value: "10.1.1.1"}},
	}) //nolint:errcheck

	if runStore.HasActiveRunForTarget("10.1.1.1") {
		t.Error("HasActiveRunForTarget should return false for COMPLETED run")
	}
}

// TestHasActiveRunForTarget_ReturnsFalseForUnrelatedTarget verifies that an in-flight
// run for a different target does not block the requested target.
func TestHasActiveRunForTarget_ReturnsFalseForUnrelatedTarget(t *testing.T) {
	runStore := NewDiscoveryRunStore()
	runStore.Create(&model.DiscoveryRun{
		ID:              "run-004",
		Status:          "RUNNING",
		NormalizedScope: []model.ScopeEntry{{Type: "IP", Value: "172.16.0.1"}},
	}) //nolint:errcheck

	if runStore.HasActiveRunForTarget("172.16.0.2") {
		t.Error("HasActiveRunForTarget should return false when target does not match any active run")
	}
}

// TestEventDrivenRun_DuplicateSuppression verifies that creating an event-driven
// run for an already-in-flight target returns ErrDuplicateInFlightTarget.
func TestEventDrivenRun_DuplicateSuppression(t *testing.T) {
	store := NewDeviceStore()
	runStore := NewDiscoveryRunStore()
	svc := NewDiscoveryService("secret", 300, &noopPublisher{}, store)

	// Create an initial QUEUED run for the target.
	runStore.Create(&model.DiscoveryRun{
		ID:              "existing-run-001",
		Status:          "QUEUED",
		NormalizedScope: []model.ScopeEntry{{Type: "IP", Value: "10.5.5.5"}},
	}) //nolint:errcheck

	// Attempt to create an event-driven run for the same target.
	req := &model.DiscoveryRunRequest{
		Scope:       []model.ScopeEntry{{Type: "IP", Value: "10.5.5.5"}},
		TriggerMode: model.TriggerModeEventTrap,
	}
	_, _, err := svc.CreateDiscoveryRun(req, "system", runStore)
	if !errors.Is(err, ErrDuplicateInFlightTarget) {
		t.Errorf("err=%v, want ErrDuplicateInFlightTarget", err)
	}
}

// TestEventDrivenRun_AllowedWhenNoPriorRun verifies that event-driven runs are
// created normally when no active run exists for the target.
func TestEventDrivenRun_AllowedWhenNoPriorRun(t *testing.T) {
	store := NewDeviceStore()
	runStore := NewDiscoveryRunStore()
	svc := NewDiscoveryService("secret", 300, &noopPublisher{}, store)

	req := &model.DiscoveryRunRequest{
		Scope:       []model.ScopeEntry{{Type: "IP", Value: "10.6.6.6"}},
		TriggerMode: model.TriggerModeEventSyslog,
	}
	_, _, err := svc.CreateDiscoveryRun(req, "system", runStore)
	if err != nil {
		t.Errorf("unexpected error for event-driven run without prior active run: %v", err)
	}
}

// TestManualRun_NotSubjectToDuplicateSuppression verifies that MANUAL runs are
// always allowed even when a prior active run exists for the same target.
func TestManualRun_NotSubjectToDuplicateSuppression(t *testing.T) {
	store := NewDeviceStore()
	runStore := NewDiscoveryRunStore()
	svc := NewDiscoveryService("secret", 300, &noopPublisher{}, store)

	// Existing active run for the same target.
	runStore.Create(&model.DiscoveryRun{
		ID:              "manual-existing-001",
		Status:          "RUNNING",
		NormalizedScope: []model.ScopeEntry{{Type: "IP", Value: "10.7.7.7"}},
	}) //nolint:errcheck

	req := &model.DiscoveryRunRequest{
		Scope:       []model.ScopeEntry{{Type: "IP", Value: "10.7.7.7"}},
		TriggerMode: model.TriggerModeManual,
	}
	_, _, err := svc.CreateDiscoveryRun(req, "admin", runStore)
	if err != nil {
		t.Errorf("MANUAL run should not be suppressed even if target is in flight: %v", err)
	}
}

// ── Validation edge cases (AC#3: malformed scope rejection) ──────────────────

// TestCreateDiscoveryRun_MalformedCIDR verifies 400-equivalent rejection.
func TestCreateDiscoveryRun_MalformedCIDR(t *testing.T) {
	store := NewDeviceStore()
	runStore := NewDiscoveryRunStore()
	svc := NewDiscoveryService("secret", 300, &noopPublisher{}, store)

	req := &model.DiscoveryRunRequest{
		Scope: []model.ScopeEntry{{Type: "CIDR", Value: "not-a-cidr"}},
	}
	_, _, err := svc.CreateDiscoveryRun(req, "user", runStore)
	if !errors.Is(err, ErrInvalidScope) {
		t.Errorf("err=%v, want ErrInvalidScope for malformed CIDR", err)
	}
}

// TestCreateDiscoveryRun_EmptyPortInFQDN does not apply (SEED type handles FQDNs);
// verify hostname with invalid chars is rejected.
func TestCreateDiscoveryRun_InvalidHostname(t *testing.T) {
	store := NewDeviceStore()
	runStore := NewDiscoveryRunStore()
	svc := NewDiscoveryService("secret", 300, &noopPublisher{}, store)

	req := &model.DiscoveryRunRequest{
		Scope: []model.ScopeEntry{{Type: "SEED", Value: "device!@#invalid"}},
	}
	_, _, err := svc.CreateDiscoveryRun(req, "user", runStore)
	if !errors.Is(err, ErrInvalidScope) {
		t.Errorf("err=%v, want ErrInvalidScope for invalid hostname", err)
	}
}
