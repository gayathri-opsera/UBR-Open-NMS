package service

import (
	"context"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/airtel-ubrnms/discovery-service/internal/audit"
	"github.com/airtel-ubrnms/discovery-service/internal/classifier"
	"github.com/airtel-ubrnms/discovery-service/internal/crypto"
	"github.com/airtel-ubrnms/discovery-service/internal/fingerprint"
	"github.com/airtel-ubrnms/discovery-service/internal/model"
	"github.com/airtel-ubrnms/discovery-service/internal/repository"
	"github.com/airtel-ubrnms/discovery-service/internal/scanner"
)

// SweepRunner executes ICMP sweeps for discovery runs.
type SweepRunner interface {
	Sweep(ctx context.Context, run *model.DiscoveryRun) (*scanner.SweepResult, error)
}

// RunExecutor orchestrates async discovery run execution: ICMP sweep → SNMP fingerprint → classify.
type RunExecutor struct {
	store            *DiscoveryRunStore
	sweeper          SweepRunner
	audit            audit.Publisher
	// SNMP pipeline dependencies — optional; set via WithSNMP.
	credRepo         repository.CredentialRepository
	enc              *crypto.Encryptor
	snmpConcurrency  int
	// snmpPort overrides the default UDP port 161. Useful in dev/test environments
	// where the SNMP simulator runs on a non-privileged port (e.g. 1161).
	snmpPort         uint16
	// defaultCommunity is used when no credential is configured on the run.
	// Intended for dev/testing only (e.g. community "public" against snmpsim).
	// Empty means SNMP stage is skipped when no credential is provided.
	defaultCommunity string
	// fpMatcher is the registry-driven fingerprint matcher (product-definition-service).
	// When set, it is consulted FIRST during OID classification; the hardcoded
	// classifier.Classify() is used only as a fallback for unknown OIDs.
	fpMatcher *fingerprint.Matcher
}

// NewRunExecutor constructs a RunExecutor with a no-op audit publisher.
func NewRunExecutor(store *DiscoveryRunStore, sweeper SweepRunner) *RunExecutor {
	return NewRunExecutorWithAudit(store, sweeper, &audit.NoopPublisher{})
}

// NewRunExecutorWithAudit constructs a RunExecutor with an explicit audit publisher.
func NewRunExecutorWithAudit(store *DiscoveryRunStore, sweeper SweepRunner, auditPub audit.Publisher) *RunExecutor {
	if auditPub == nil {
		auditPub = &audit.NoopPublisher{}
	}
	return &RunExecutor{store: store, sweeper: sweeper, audit: auditPub, snmpConcurrency: 10, snmpPort: 161}
}

// WithSNMPPort overrides the UDP port used for SNMP GET requests.
// Default is 161. Set to 1161 when targeting the local snmpsim test container.
func (e *RunExecutor) WithSNMPPort(port uint16) *RunExecutor {
	if port > 0 {
		e.snmpPort = port
	}
	return e
}

// WithFingerprintMatcher wires in the registry-driven fingerprint.Matcher so that
// newly uploaded product definitions are recognised during OID classification
// without any code changes to the discovery service. When the matcher is absent
// (nil) the service falls back to the hardcoded classifier.Classify() map.
func (e *RunExecutor) WithFingerprintMatcher(m *fingerprint.Matcher) *RunExecutor {
	e.fpMatcher = m
	return e
}

// WithSNMP enables the SNMP fingerprint + classification pipeline stage.
// credRepo and enc are used to decrypt stored SNMP credentials referenced by the run.
// concurrency controls how many parallel SNMP GET requests are made (default 10).
// defaultCommunity is used when the run carries no credentialId or ephemeral community;
// leave empty to skip SNMP in that case (safe default for production).
func (e *RunExecutor) WithSNMP(
	credRepo repository.CredentialRepository,
	enc *crypto.Encryptor,
	concurrency int,
	defaultCommunity string,
) *RunExecutor {
	e.credRepo = credRepo
	e.enc = enc
	if concurrency > 0 {
		e.snmpConcurrency = concurrency
	}
	e.defaultCommunity = defaultCommunity
	return e
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

	// Emit discovery.run.started audit event.
	e.emitAudit(ctx, "discovery.run.started", runID, "success", "")

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
		e.emitAudit(ctx, "discovery.run.failed", runID, "failure", "ICMP sweep service not configured")
		return
	}

	// ── Stage 1: ICMP sweep ───────────────────────────────────────────────────

	sweepResult, err := e.sweeper.Sweep(ctx, run)
	completed := time.Now().UTC()

	if err != nil {
		slog.Error("discovery run sweep failed", "runId", runID, "error", err)
		e.store.Update(runID, func(r *model.DiscoveryRun) {
			r.Status = "FAILED"
			r.FailureReason = err.Error()
			r.CompletedAt = &completed
		})
		e.emitAudit(ctx, "discovery.run.failed", runID, "failure", err.Error())
		return
	}

	// Build initial host results from ICMP sweep.
	results := hostResultsFromSweep(sweepResult)
	reachable := sweepResult.ReachableCount
	var durationMs int64
	if sweepResult.CompletedAt != nil {
		durationMs = sweepResult.CompletedAt.Sub(sweepResult.StartedAt).Milliseconds()
	} else {
		durationMs = completed.Sub(sweepResult.StartedAt).Milliseconds()
	}

	// ── Stage 2: SNMP fingerprint + classify (reachable hosts only) ───────────

	// Reload the run to get the latest credential/protocol settings (in case
	// they were updated between creation and execution).
	if latestRun, stillOK := e.store.Get(runID); stillOK {
		run = latestRun
	}
	results = e.runSNMPStage(ctx, runID, run, sweepResult, results)

	// ── Persist final results ─────────────────────────────────────────────────

	snmpSuccess, snmpAttempts := countSNMPStats(results)
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
		"reachable", reachable,
		"snmpAttempts", snmpAttempts,
		"snmpSuccess", snmpSuccess)
	e.emitAudit(ctx, "discovery.run.completed", runID, "success",
		fmt.Sprintf("hosts=%d reachable=%d snmpSuccess=%d", sweepResult.ScannedCount, reachable, snmpSuccess))
}

// runSNMPStage fingerprints reachable hosts via SNMP, classifies each result,
// and merges the enriched entries back into the host results slice.
// Returns the (potentially enriched) results slice; callers must use the returned value.
func (e *RunExecutor) runSNMPStage(
	ctx context.Context,
	runID string,
	run *model.DiscoveryRun,
	sweepResult *scanner.SweepResult,
	results []model.DiscoveryHostResult,
) []model.DiscoveryHostResult {
	// Collect reachable hosts and build an ICMP status index for later merging.
	var reachableHosts []string
	icmpStatusByIP := make(map[string]string, len(sweepResult.HostResults))
	for _, h := range sweepResult.HostResults {
		st := mapICMPStatus(h.Status)
		icmpStatusByIP[h.IP] = st
		if st == "reachable" {
			reachableHosts = append(reachableHosts, h.IP)
		}
	}

	if len(reachableHosts) == 0 {
		slog.Info("snmp: no reachable hosts — skipping SNMP stage", "runId", runID)
		return results
	}

	// Resolve credentials and build the SNMP client.
	credResolver, community, resolveErr := e.buildCredentialResolver(ctx, run)
	if resolveErr != nil {
		slog.Warn("snmp: credential setup failed — SNMP stage skipped",
			"runId", runID, "err", resolveErr)
		return results
	}
	if credResolver == nil {
		slog.Info("snmp: no credentials configured — SNMP stage skipped", "runId", runID)
		return results
	}

	// Per-GET timeout: use run value if > 0, otherwise fall back to 5 s.
	snmpTimeout := time.Duration(run.TimeoutSeconds) * time.Second
	if snmpTimeout <= 0 {
		snmpTimeout = 5 * time.Second
	}

	// Retry budget: run.Retries is total attempts; fingerprinter takes MaxRetries =
	// additional retries after the first attempt.
	maxRetries := run.Retries - 1
	if maxRetries < 0 {
		maxRetries = 1 // default: 1 retry
	}
	retryCfg := scanner.RetryConfig{
		MaxRetries:   maxRetries,
		InitialDelay: 2 * time.Second,
		MaxDelay:     15 * time.Second,
	}

	port := e.snmpPort
	if port == 0 {
		port = 161
	}
	snmpClient := scanner.NewGoSNMPClient(community, run.Protocol, port, snmpTimeout)
	fingerprinter := scanner.NewSNMPFingerprinterWithRetry(snmpClient, credResolver, snmpTimeout, retryCfg)

	concurrency := e.snmpConcurrency
	if concurrency <= 0 {
		concurrency = 10
	}

	slog.Info("snmp: starting fingerprint batch",
		"runId", runID, "reachableHosts", len(reachableHosts), "concurrency", concurrency)

	fpResults := fingerprinter.FingerprintBatch(ctx, reachableHosts, runID, concurrency)

	// Classify each fingerprint result and index by IP for merging.
	// Priority:
	//   1. fingerprint.Matcher (registry-driven — zero-code for new vendors)
	//   2. classifier.Classify() (hardcoded release-1 map — fallback)
	enrichedByIP := make(map[string]model.DiscoveryHostResult, len(fpResults))
	for _, fp := range fpResults {
		cl := e.classifyFingerprint(ctx, fp)
		icmp := icmpStatusByIP[fp.IP]
		if icmp == "" {
			icmp = "reachable"
		}
		enrichedByIP[fp.IP] = mapFingerprintToHostResult(fp, cl, icmp)
	}

	// Replace the initial sweep-only entries with SNMP-enriched ones.
	for i, r := range results {
		if enriched, found := enrichedByIP[r.IP]; found {
			results[i] = enriched
		}
	}

	// ── Best-effort MAC address walk ──────────────────────────────────────────
	// Walk ifPhysAddress (IF-MIB 1.3.6.1.2.1.2.2.1.6) on hosts that had a
	// successful SNMP fingerprint — the scalar GET phase only covers MIB-2
	// scalars and doesn't collect interface-table data.
	// This is intentionally best-effort: failure to walk doesn't block the run
	// and doesn't change the fingerprint status of the host.
	macCtx, macCancel := context.WithTimeout(ctx, 30*time.Second)
	defer macCancel()
	macByIP := fetchMACAddresses(macCtx, snmpClient, results, concurrency)
	for i, r := range results {
		if mac, ok := macByIP[r.IP]; ok && mac != "" {
			results[i].MACAddress = mac
		}
	}

	success, _ := countSNMPStats(results)
	slog.Info("snmp: fingerprint batch complete",
		"runId", runID, "attempted", len(fpResults), "success", success)
	return results
}

// classifyFingerprint resolves a ClassificationResult for one SNMP fingerprint.
//
// Strategy (highest precedence first):
//  1. fingerprint.Matcher — queries the product-definition-service registry so any
//     uploaded product definition is automatically recognised (zero-code onboarding).
//  2. classifier.Classify() — hardcoded release-1 OID map (Cisco, Juniper, HP …).
//     Used only when the registry matcher returns UNKNOWN or is unavailable.
func (e *RunExecutor) classifyFingerprint(ctx context.Context, fp model.SNMPFingerprintResult) classifier.ClassificationResult {
	if e.fpMatcher != nil && fp.SysObjectID != "" {
		evidence := fingerprint.ProbeEvidence{
			IP:                 fp.IP,
			RunID:              fp.RunID,
			CorrelationID:      fp.CorrelationID,
			SNMPOIDSysObjectID: fp.SysObjectID,
			SNMPSysDescr:       fp.SysDescr,
			// FirmwareVersion is not available from SNMPFingerprintResult directly;
			// it is parsed upstream if present in sysDescr by the snmp_fingerprinter.
		}
		mr := e.fpMatcher.Match(ctx, evidence)
		if mr != nil && mr.Status == fingerprint.FingerprintStatusMatched {
			slog.Info("classify: registry match",
				"ip", fp.IP, "pd", mr.ProductDefinitionID, "vendor", mr.Vendor, "model", mr.Model,
				"confidence", mr.MatchConfidence, "evidence", mr.MatchEvidence)
			vendor := mr.Vendor
			if vendor == "" {
				vendor = mr.ProductDefinitionID // safe fallback: PD ID is always set
			}
			model := mr.Model
			if model == "" {
				model = mr.ProductDefinitionID
			}
			deviceType := mr.DeviceType
			if deviceType == "" {
				deviceType = "SWITCH"
			}
			return classifier.ClassificationResult{
				Status:              classifier.ClassificationRecognised,
				Vendor:              vendor,
				Model:               model,
				GenericDeviceType:   deviceType,
				CapabilityProfileID: "cap-registry-" + mr.ProductDefinitionID,
				DriverID:            "drv-registry-" + mr.ProductDefinitionID,
				CorrelationID:       fp.CorrelationID,
			}
		}
		if mr != nil && mr.Status != fingerprint.FingerprintStatusUnknown &&
			mr.Status != fingerprint.FingerprintStatusRegistryUnavailable {
			slog.Debug("classify: registry non-match", "ip", fp.IP, "status", mr.Status)
		}
	}
	// Fallback: hardcoded release-1 classifier.
	return classifier.Classify(fp, fp.CorrelationID)
}

// fetchMACAddresses walks ifPhysAddress on all hosts that returned a successful
// SNMP fingerprint.  Runs concurrently up to maxWorkers goroutines.
// Results are keyed by IP; missing or failed hosts are simply absent from the map.
func fetchMACAddresses(
	ctx context.Context,
	client scanner.SNMPClient,
	results []model.DiscoveryHostResult,
	maxWorkers int,
) map[string]string {
	out := make(map[string]string, len(results))
	var mu sync.Mutex

	sem := make(chan struct{}, maxWorkers)
	var wg sync.WaitGroup

	for _, r := range results {
		if r.SnmpStatus != "success" {
			continue // skip hosts with failed SNMP — walk would also fail
		}
		ip := r.IP
		wg.Add(1)
		sem <- struct{}{}
		go func() {
			defer wg.Done()
			defer func() { <-sem }()
			mac := scanner.FetchChassisMAC(ctx, client, ip)
			if mac != "" {
				mu.Lock()
				out[ip] = mac
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	return out
}

// buildCredentialResolver selects and initialises the SNMPCredentialResolver for a run.
// Resolution priority:
//  1. Stored credential referenced by run.CredentialID (decrypted via credRepo + enc).
//  2. Ephemeral community string supplied in the run request (never persisted).
//  3. defaultCommunity from RunExecutor configuration (dev/test fallback).
//
// Returns (nil, "", nil) when no credentials are available — callers must skip SNMP.
func (e *RunExecutor) buildCredentialResolver(
	ctx context.Context,
	run *model.DiscoveryRun,
) (scanner.SNMPCredentialResolver, string, error) {
	// Priority 1: stored credential.
	if e.credRepo != nil && e.enc != nil && run.CredentialID != "" {
		resolver, err := NewStoredCredentialResolver(ctx, e.credRepo, e.enc, run.CredentialID)
		if err != nil {
			return nil, "", fmt.Errorf("stored credential resolve: %w", err)
		}
		return resolver, resolver.Community(), nil
	}

	// Priority 2: ephemeral community on the run (not persisted).
	if run.EphemeralCommunity != "" {
		r := &StaticCommunityResolver{Community: run.EphemeralCommunity}
		return r, run.EphemeralCommunity, nil
	}

	// Priority 3: executor-level default (dev/test use only).
	if e.defaultCommunity != "" {
		r := &StaticCommunityResolver{Community: e.defaultCommunity}
		return r, e.defaultCommunity, nil
	}

	return nil, "", nil // no credentials — skip SNMP
}

// emitAudit publishes an audit event; failures are logged but never propagate
// so that audit publishing never blocks or breaks the primary discovery flow.
func (e *RunExecutor) emitAudit(ctx context.Context, action, runID, outcome, detail string) {
	evt := audit.NewEvent("discovery-service", action, "DiscoveryRun", runID, outcome)
	evt.Detail = detail
	if err := e.audit.Publish(ctx, evt); err != nil {
		slog.Warn("audit publish failed", "action", action, "runId", runID, "err", err)
	}
}

// hostResultsFromSweep builds the initial per-host result slice from ICMP sweep data.
// All SNMP fields are left empty here; runSNMPStage fills them in for reachable hosts.
func hostResultsFromSweep(sweep *scanner.SweepResult) []model.DiscoveryHostResult {
	if sweep == nil {
		return nil
	}
	out := make([]model.DiscoveryHostResult, 0, len(sweep.HostResults))
	for _, h := range sweep.HostResults {
		icmp := mapICMPStatus(h.Status)
		snmpStatus := "not_attempted"
		deferReason := ""
		if icmp == "reachable" {
			snmpStatus = "pending"
			deferReason = "SNMP_PENDING"
		}
		out = append(out, model.DiscoveryHostResult{
			IP:                   h.IP,
			IcmpStatus:           icmp,
			SnmpStatus:           snmpStatus,
			ClassificationStatus: "DEFERRED_UNSUPPORTED",
			DeferReason:          deferReason,
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

// mapFingerprintToHostResult converts an SNMP fingerprint + classification result
// into the API-level DiscoveryHostResult.
func mapFingerprintToHostResult(
	fp model.SNMPFingerprintResult,
	cl classifier.ClassificationResult,
	icmp string,
) model.DiscoveryHostResult {
	snmp := string(fp.Status)
	if snmp == "" {
		snmp = "failed"
	}
	// Normalise partial success to "success" at the API level — callers see the
	// actual retrieved fields; partial means some OIDs were missing but we got data.
	if fp.Status == model.SNMPFingerprintPartial {
		snmp = "success"
	}

	// Fill "Not Available" for vendor/model when classification was attempted but
	// didn't yield a vendor/model — matches spec FR-07 requirement.
	vendor := cl.Vendor
	if vendor == "" && (cl.Status == classifier.ClassificationDeferred || cl.Status == classifier.ClassificationError) {
		vendor = "Not Available"
	}
	deviceModel := cl.Model
	if deviceModel == "" && (cl.Status == classifier.ClassificationDeferred || cl.Status == classifier.ClassificationError) {
		deviceModel = "Not Available"
	}

	return model.DiscoveryHostResult{
		IP:                   fp.IP,
		IcmpStatus:           icmp,
		SnmpStatus:           snmp,
		Vendor:               vendor,
		Model:                deviceModel,
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

// countSNMPStats returns (successCount, attemptCount) from a host results slice.
func countSNMPStats(results []model.DiscoveryHostResult) (success, attempted int) {
	for _, r := range results {
		if r.SnmpStatus != "not_attempted" && r.SnmpStatus != "pending" {
			attempted++
		}
		if r.SnmpStatus == "success" {
			success++
		}
	}
	return
}
