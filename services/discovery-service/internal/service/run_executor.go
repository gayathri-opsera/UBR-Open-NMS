package service

import (
	"context"
	"log/slog"
	"time"

	"github.com/airtel-ubrnms/discovery-service/internal/classifier"
	"github.com/airtel-ubrnms/discovery-service/internal/model"
	"github.com/airtel-ubrnms/discovery-service/internal/scanner"
)

// SweepRunner executes ICMP sweeps for discovery runs.
type SweepRunner interface {
	Sweep(ctx context.Context, run *model.DiscoveryRun) (*scanner.SweepResult, error)
}

// RunExecutor orchestrates async discovery run execution after scope validation.
type RunExecutor struct {
	store   *DiscoveryRunStore
	sweeper SweepRunner
}

// NewRunExecutor constructs a RunExecutor.
func NewRunExecutor(store *DiscoveryRunStore, sweeper SweepRunner) *RunExecutor {
	return &RunExecutor{store: store, sweeper: sweeper}
}

// Start launches discovery execution in a background goroutine.
func (e *RunExecutor) Start(runID string) {
	go e.execute(runID)
}

func (e *RunExecutor) execute(runID string) {
	ctx := context.Background()

	run, ok := e.store.Get(runID)
	if !ok {
		return
	}

	now := time.Now().UTC()
	e.store.Update(runID, func(r *model.DiscoveryRun) {
		r.Status = "RUNNING"
		r.Sweep = &model.SweepProgress{
			SweepStartedAt: &now,
		}
	})

	if e.sweeper == nil {
		e.store.Update(runID, func(r *model.DiscoveryRun) {
			r.Status = "FAILED"
			r.FailureReason = "ICMP sweep service not configured"
			completed := time.Now().UTC()
			r.CompletedAt = &completed
		})
		return
	}

	sweepResult, err := e.sweeper.Sweep(ctx, run)
	completed := time.Now().UTC()

	if err != nil {
		slog.Error("discovery run sweep failed", "runId", runID, "error", err)
		e.store.Update(runID, func(r *model.DiscoveryRun) {
			r.Status = "FAILED"
			r.FailureReason = err.Error()
			r.CompletedAt = &completed
		})
		return
	}

	results := hostResultsFromSweep(sweepResult)
	reachable := sweepResult.ReachableCount
	var durationMs int64
	if sweepResult.CompletedAt != nil {
		durationMs = sweepResult.CompletedAt.Sub(sweepResult.StartedAt).Milliseconds()
	} else {
		durationMs = completed.Sub(sweepResult.StartedAt).Milliseconds()
	}

	e.store.Update(runID, func(r *model.DiscoveryRun) {
		r.Status = "COMPLETED"
		r.CompletedAt = &completed
		r.Results = results
		r.DevicesFound = len(results)
		startedAt := r.Sweep.SweepStartedAt
		r.Sweep = &model.SweepProgress{
			TotalHosts:       sweepResult.TotalCandidates,
			HostsScanned:     sweepResult.ScannedCount,
			ReachableHosts:   reachable,
			SweepStartedAt:   startedAt,
			SweepCompletedAt: &completed,
			SweepDurationMs:  durationMs,
		}
	})

	slog.Info("discovery run completed",
		"runId", runID,
		"hosts", sweepResult.ScannedCount,
		"reachable", reachable)
}

func hostResultsFromSweep(sweep *scanner.SweepResult) []model.DiscoveryHostResult {
	if sweep == nil {
		return nil
	}
	out := make([]model.DiscoveryHostResult, 0, len(sweep.HostResults))
	for _, h := range sweep.HostResults {
		icmp := mapICMPStatus(h.Status)
		snmp := "not_attempted"
		if icmp == "reachable" {
			snmp = "not_attempted"
		}
		out = append(out, model.DiscoveryHostResult{
			IP:                   h.IP,
			IcmpStatus:           icmp,
			SnmpStatus:           snmp,
			ClassificationStatus: "DEFERRED_UNSUPPORTED",
			DeferReason:          "SNMP_NOT_CONFIGURED",
		})
	}
	return out
}

func mapICMPStatus(status string) string {
	switch status {
	case scanner.StatusReachable:
		return "reachable"
	case scanner.StatusTimeout:
		return "timeout"
	default:
		return "unreachable"
	}
}

// mapFingerprintToHostResult converts SNMP fingerprint + classification to API result.
func mapFingerprintToHostResult(
	fp model.SNMPFingerprintResult,
	cl classifier.ClassificationResult,
	icmp string,
) model.DiscoveryHostResult {
	snmp := string(fp.Status)
	if snmp == "auth_failed" {
		snmp = "auth_failed"
	} else if snmp == "timeout" {
		snmp = "timeout"
	} else if snmp == "success" || snmp == "partial" {
		snmp = "success"
	}
	return model.DiscoveryHostResult{
		IP:                   fp.IP,
		IcmpStatus:           icmp,
		SnmpStatus:           snmp,
		Vendor:               cl.Vendor,
		Model:                cl.Model,
		GenericDeviceType:    cl.GenericDeviceType,
		SysObjectID:          fp.SysObjectID,
		SysDescr:             fp.SysDescr,
		SysName:              fp.SysName,
		SysContact:           fp.SysContact,
		SysLocation:          fp.SysLocation,
		SysUpTimeSeconds:     fp.SysUpTimeSec,
		ClassificationStatus: string(cl.Status),
		DeferReason:          cl.DeferReason,
		CorrelationID:        fp.CorrelationID,
	}
}
