package service

import (
	"testing"
	"time"

	"github.com/airtel-ubrnms/discovery-service/internal/model"
)

func TestToRunSummary(t *testing.T) {
	completed := time.Now().UTC()
	run := &model.DiscoveryRun{
		ID:              "run-abc",
		Status:          "COMPLETED",
		NormalizedScope: []model.ScopeEntry{{Type: "IP", Value: "10.0.0.1"}},
		CreatedAt:       time.Now().UTC(),
		CompletedAt:     &completed,
		DevicesFound:    3,
		CreatedBy:       "operator",
	}

	summary := ToRunSummary(run)
	if summary.RunID != "run-abc" {
		t.Fatalf("RunID = %q, want run-abc", summary.RunID)
	}
	if summary.ScopeSummary != "10.0.0.1" {
		t.Fatalf("ScopeSummary = %q", summary.ScopeSummary)
	}
	if summary.DevicesFound != 3 {
		t.Fatalf("DevicesFound = %d", summary.DevicesFound)
	}
}

func TestToRunDetail_SnmpCounts(t *testing.T) {
	run := &model.DiscoveryRun{
		ID:     "run-1",
		Status: "COMPLETED",
		Results: []model.DiscoveryHostResult{
			{SnmpStatus: "success"},
			{SnmpStatus: "partial"},
			{SnmpStatus: "not_attempted"},
			{SnmpStatus: "auth_failed"},
		},
	}

	detail := ToRunDetail(run)
	if detail.SnmpAttemptCount != 3 {
		t.Fatalf("SnmpAttemptCount = %d, want 3", detail.SnmpAttemptCount)
	}
	if detail.SnmpSuccessCount != 2 {
		t.Fatalf("SnmpSuccessCount = %d, want 2", detail.SnmpSuccessCount)
	}
}
