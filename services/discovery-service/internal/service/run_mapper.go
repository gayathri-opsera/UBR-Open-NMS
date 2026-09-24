package service

import (
	"strings"
	"time"

	"github.com/airtel-ubrnms/discovery-service/internal/model"
)

// ToRunSummary converts an internal DiscoveryRun to the API list-row shape.
func ToRunSummary(r *model.DiscoveryRun) model.DiscoveryRunSummary {
	if r == nil {
		return model.DiscoveryRunSummary{}
	}
	return model.DiscoveryRunSummary{
		RunID:           r.ID,
		Status:          r.Status,
		ScopeSummary:    scopeSummary(r.NormalizedScope),
		CreatedAt:       r.CreatedAt,
		CompletedAt:     r.CompletedAt,
		DevicesFound:    r.DevicesFound,
		CreatedBy:       r.CreatedBy,
		NormalizedScope: r.NormalizedScope,
	}
}

// ToRunDetail converts an internal DiscoveryRun to the API detail shape.
func ToRunDetail(r *model.DiscoveryRun) model.DiscoveryRunDetailResponse {
	if r == nil {
		return model.DiscoveryRunDetailResponse{}
	}
	var updatedAt *time.Time
	if r.CompletedAt != nil {
		updatedAt = r.CompletedAt
	}
	attempts, successes := snmpCounts(r.Results)

	// WO-008: propagate multi-mode probe fields (nil-safe for legacy runs).
	probeAttempts := r.ProbeAttempts
	if probeAttempts == nil {
		probeAttempts = []model.ProbeAttempt{}
	}
	return model.DiscoveryRunDetailResponse{
		RunID:               r.ID,
		Status:              r.Status,
		NormalizedScope:     r.NormalizedScope,
		CreatedBy:           r.CreatedBy,
		CreatedAt:           r.CreatedAt,
		UpdatedAt:           updatedAt,
		ValidationSummary:   r.ValidationNotes,
		Sweep:               r.Sweep,
		FailureReason:       r.FailureReason,
		Protocol:            r.Protocol,
		SnmpAttemptCount:    attempts,
		SnmpSuccessCount:    successes,
		TriggerMode:         r.TriggerMode,
		CorrelationID:       r.CorrelationID,
		ProbeAttempts:       probeAttempts,
		SuccessfulProbeType: r.SuccessfulProbeType,
		RetryAt:             r.RetryAt,
		ProbeAttemptCount:   len(probeAttempts),
	}
}

func scopeSummary(scope []model.ScopeEntry) string {
	if len(scope) == 0 {
		return ""
	}
	parts := make([]string, 0, len(scope))
	for _, s := range scope {
		parts = append(parts, s.Value)
	}
	return strings.Join(parts, ", ")
}

func snmpCounts(results []model.DiscoveryHostResult) (attempts, successes int) {
	for _, r := range results {
		if r.SnmpStatus != "not_attempted" {
			attempts++
		}
		if r.SnmpStatus == "success" || r.SnmpStatus == "partial" {
			successes++
		}
	}
	return attempts, successes
}
