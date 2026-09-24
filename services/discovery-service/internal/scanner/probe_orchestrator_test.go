// Package scanner — unit tests for WO-008 multi-mode probe orchestration.
package scanner

import (
	"context"
	"testing"
	"time"

	"github.com/airtel-ubrnms/discovery-service/internal/model"
)

// ── ProbeOrchestrator unit tests ──────────────────────────────────────────────

func TestProbeOrchestrator_StopsOnFirstSuccess(t *testing.T) {
	icmp := NewFakeProbeExecutor(model.ProbeTypeICMP, model.ProbeAttemptSuccess, "host reachable")
	snmp := NewFakeProbeExecutor(model.ProbeTypeSNMP, model.ProbeAttemptSuccess, "sysObjectID=.1.3.6.1")
	ssh := NewFakeProbeExecutor(model.ProbeTypeSSH, model.ProbeAttemptSuccess, "SSH-2.0-OpenSSH")

	orch := NewProbeOrchestrator(icmp, snmp, ssh)
	attempts, successType := orch.RunAll(context.Background(), "192.168.1.1", "corr-001")

	// Should stop after ICMP (first success).
	if len(attempts) != 1 {
		t.Errorf("expected 1 attempt (stop on first success), got %d", len(attempts))
	}
	if attempts[0].ProbeType != model.ProbeTypeICMP {
		t.Errorf("expected first attempt probeType=ICMP, got %s", attempts[0].ProbeType)
	}
	if successType != model.ProbeTypeICMP {
		t.Errorf("successType=%s, want ICMP", successType)
	}
}

func TestProbeOrchestrator_ContinuesAfterFailure(t *testing.T) {
	icmp := NewFakeProbeExecutor(model.ProbeTypeICMP, model.ProbeAttemptUnreachable, "")
	snmp := NewFakeProbeExecutor(model.ProbeTypeSNMP, model.ProbeAttemptAuthFailed, "")
	ssh := NewFakeProbeExecutor(model.ProbeTypeSSH, model.ProbeAttemptSuccess, "SSH-2.0-OpenSSH")

	orch := NewProbeOrchestrator(icmp, snmp, ssh)
	attempts, successType := orch.RunAll(context.Background(), "10.0.0.1", "corr-002")

	if len(attempts) != 3 {
		t.Errorf("expected 3 attempts (ICMP fail, SNMP fail, SSH success), got %d", len(attempts))
	}
	if successType != model.ProbeTypeSSH {
		t.Errorf("successType=%s, want SSH", successType)
	}
	if attempts[0].Status != model.ProbeAttemptUnreachable {
		t.Errorf("attempt[0].Status=%s, want unreachable", attempts[0].Status)
	}
	if attempts[2].Status != model.ProbeAttemptSuccess {
		t.Errorf("attempt[2].Status=%s, want success", attempts[2].Status)
	}
}

func TestProbeOrchestrator_AllFail_NoSuccessType(t *testing.T) {
	icmp := NewFakeProbeExecutor(model.ProbeTypeICMP, model.ProbeAttemptUnreachable, "")
	snmp := NewFakeProbeExecutor(model.ProbeTypeSNMP, model.ProbeAttemptTimeout, "")
	ssh := NewFakeProbeExecutor(model.ProbeTypeSSH, model.ProbeAttemptFailed, "")

	orch := NewProbeOrchestrator(icmp, snmp, ssh)
	attempts, successType := orch.RunAll(context.Background(), "10.1.1.1", "corr-003")

	if len(attempts) != 3 {
		t.Errorf("expected 3 attempts when all fail, got %d", len(attempts))
	}
	if successType != "" {
		t.Errorf("successType=%q, want empty (no success)", successType)
	}
}

func TestProbeOrchestrator_ICMPSuccessButSNMPTimeout_StopsAfterICMP(t *testing.T) {
	// ICMP succeeds → orchestrator should stop; SNMP timeout doesn't execute.
	icmp := NewFakeProbeExecutor(model.ProbeTypeICMP, model.ProbeAttemptSuccess, "reachable")
	snmp := NewFakeProbeExecutor(model.ProbeTypeSNMP, model.ProbeAttemptTimeout, "")

	orch := NewProbeOrchestrator(icmp, snmp)
	attempts, successType := orch.RunAll(context.Background(), "172.16.0.1", "corr-004")

	if len(attempts) != 1 {
		t.Errorf("expected 1 attempt when ICMP succeeds first, got %d", len(attempts))
	}
	if successType != model.ProbeTypeICMP {
		t.Errorf("successType=%s, want ICMP", successType)
	}
	// SNMP attempt should never appear in the chain.
	for _, a := range attempts {
		if a.ProbeType == model.ProbeTypeSNMP {
			t.Error("SNMP attempt should not have been executed (stop-on-first-success)")
		}
	}
}

func TestProbeOrchestrator_ContextCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel() // cancel immediately

	icmp := NewFakeProbeExecutor(model.ProbeTypeICMP, model.ProbeAttemptSuccess, "reachable")
	snmp := NewFakeProbeExecutor(model.ProbeTypeSNMP, model.ProbeAttemptSuccess, "fingerprinted")

	orch := NewProbeOrchestrator(icmp, snmp)
	attempts, _ := orch.RunAll(ctx, "10.10.10.1", "corr-005")

	// Context is already cancelled at entry; no probes should run.
	if len(attempts) != 0 {
		t.Errorf("expected 0 attempts when context is pre-cancelled, got %d", len(attempts))
	}
}

func TestProbeOrchestrator_EmptyExecutors(t *testing.T) {
	orch := NewProbeOrchestrator() // no executors
	attempts, successType := orch.RunAll(context.Background(), "10.0.0.5", "corr-006")

	if len(attempts) != 0 {
		t.Errorf("expected 0 attempts for empty executor list, got %d", len(attempts))
	}
	if successType != "" {
		t.Errorf("successType=%q, want empty", successType)
	}
}

// ── FakeProbeExecutor unit tests ──────────────────────────────────────────────

func TestFakeProbeExecutor_ReturnsConfiguredStatus(t *testing.T) {
	tests := []struct {
		status   model.ProbeAttemptStatus
		retryable bool
	}{
		{model.ProbeAttemptSuccess, false},
		{model.ProbeAttemptTimeout, true},
		{model.ProbeAttemptUnreachable, true},
		{model.ProbeAttemptAuthFailed, false},
		{model.ProbeAttemptFailed, false},
	}

	for _, tc := range tests {
		exec := NewFakeProbeExecutor(model.ProbeTypeICMP, tc.status, "evidence")
		attempt := exec.Execute(context.Background(), "1.2.3.4", "corr")

		if attempt.Status != tc.status {
			t.Errorf("status=%s, want %s", attempt.Status, tc.status)
		}
		if attempt.Retryable != tc.retryable {
			t.Errorf("status=%s: retryable=%v, want %v", tc.status, attempt.Retryable, tc.retryable)
		}
		if attempt.ProbeType != model.ProbeTypeICMP {
			t.Errorf("probeType=%s, want ICMP", attempt.ProbeType)
		}
	}
}

func TestFakeProbeExecutor_EvidenceIsIncluded(t *testing.T) {
	exec := NewFakeProbeExecutor(model.ProbeTypeSNMP, model.ProbeAttemptSuccess, "sysObjectID=.1.3.6.1")
	attempt := exec.Execute(context.Background(), "10.0.0.1", "corr-007")

	if attempt.SafeEvidenceSummary != "sysObjectID=.1.3.6.1" {
		t.Errorf("SafeEvidenceSummary=%q, want %q", attempt.SafeEvidenceSummary, "sysObjectID=.1.3.6.1")
	}
}

func TestFakeProbeExecutor_TimestampsPopulated(t *testing.T) {
	before := time.Now()
	exec := NewFakeProbeExecutor(model.ProbeTypeHTTP, model.ProbeAttemptSuccess, "HTTP 200")
	attempt := exec.Execute(context.Background(), "10.0.0.2", "corr-008")
	after := time.Now()

	if attempt.StartedAt.Before(before) || attempt.StartedAt.After(after) {
		t.Errorf("StartedAt %v out of expected range [%v, %v]", attempt.StartedAt, before, after)
	}
	if attempt.CompletedAt.IsZero() {
		t.Error("CompletedAt should be populated")
	}
}

// ── Safe evidence redaction tests ─────────────────────────────────────────────

// TestSanitiseBanner_RemovesNonPrintable verifies that control chars are stripped.
func TestSanitiseBanner_RemovesNonPrintable(t *testing.T) {
	raw := "SSH-2.0-OpenSSH_8.4\x00\x01\r\n"
	result := sanitiseBanner(raw)
	for _, r := range result {
		if r < 0x20 || r > 0x7E {
			t.Errorf("sanitiseBanner result contains non-printable char %q (%d)", r, r)
		}
	}
}

func TestSanitiseBanner_TruncatesLongBanners(t *testing.T) {
	long := make([]byte, 200)
	for i := range long {
		long[i] = 'A'
	}
	result := sanitiseBanner(string(long))
	if len(result) > 120 {
		t.Errorf("sanitiseBanner result length=%d, want ≤120", len(result))
	}
}

func TestSanitiseBanner_ExtractsFirstLine(t *testing.T) {
	raw := "SSH-2.0-OpenSSH_8.4\nsome continuation\nextra"
	result := sanitiseBanner(raw)
	if result != "SSH-2.0-OpenSSH_8.4" {
		t.Errorf("sanitiseBanner=%q, want %q", result, "SSH-2.0-OpenSSH_8.4")
	}
}

// ── Deterministic probe ordering (AC#1) ──────────────────────────────────────

// TestDeterministicProbeOrder verifies the 6-probe sequence when all probes fail.
func TestDeterministicProbeOrder_AllFail(t *testing.T) {
	expectedOrder := []model.ProbeType{
		model.ProbeTypeICMP,
		model.ProbeTypeSNMP,
		model.ProbeTypeSSH,
		model.ProbeTypeHTTP,
		model.ProbeTypeHTTPS,
		model.ProbeTypeGRPC,
	}

	executors := make([]ProbeExecutor, len(expectedOrder))
	for i, pt := range expectedOrder {
		executors[i] = NewFakeProbeExecutor(pt, model.ProbeAttemptFailed, "")
	}

	orch := NewProbeOrchestrator(executors...)
	attempts, _ := orch.RunAll(context.Background(), "10.0.0.1", "corr-order")

	if len(attempts) != len(expectedOrder) {
		t.Fatalf("expected %d attempts, got %d", len(expectedOrder), len(attempts))
	}
	for i, expected := range expectedOrder {
		if attempts[i].ProbeType != expected {
			t.Errorf("attempt[%d].ProbeType=%s, want %s", i, attempts[i].ProbeType, expected)
		}
	}
}
