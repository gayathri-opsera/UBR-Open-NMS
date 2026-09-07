// Package scanner — SNMP fingerprinting for generic device discovery (WO-027).
//
// SNMPFingerprinter queries sysDescr (.1.3.6.1.2.1.1.1.0) and sysObjectID
// (.1.3.6.1.2.1.1.2.0) from management-port-probed hosts. The results are
// used downstream to classify devices by vendor and model.
//
// Security constraints:
//   - Community strings and credentials are NEVER stored in result structs or logs.
//   - Only categorised failure reasons are surfaced to operators.
//   - OIDs are validated before being persisted as sysObjectID.
package scanner

import (
	"context"
	"fmt"
	"log/slog"
	"regexp"
	"strings"
	"time"

	"github.com/airtel-ubrnms/discovery-service/internal/model"
)

// Standard SNMP system OIDs used for fingerprinting.
const (
	OIDSysDescr    = ".1.3.6.1.2.1.1.1.0"
	OIDSysObjectID = ".1.3.6.1.2.1.1.2.0"
)

// validOIDPattern matches a numeric OID string such as ".1.3.6.1.2.1.1.2.0".
var validOIDPattern = regexp.MustCompile(`^\.?[0-9]+(\.[0-9]+)+$`)

// SNMPClient abstracts SNMP GET operations so the fingerprinter is testable.
// The real implementation uses gosnmp; tests inject a fake.
type SNMPClient interface {
	// GetOIDs retrieves the string values of the requested OIDs from the target host.
	// Returns a map of OID → string value.
	// Errors: timeout, auth failure, version mismatch, or unreachable host.
	GetOIDs(ctx context.Context, host string, oids []string) (map[string]string, error)
}

// SNMPCredentialResolver resolves the SNMP community string (or v3 credentials)
// for a given host without exposing the actual values to callers.
type SNMPCredentialResolver interface {
	// ResolveCredential returns an opaque credential reference for the host.
	// The returned value is only meaningful to SNMPClient implementations.
	// Returns ("", false, nil) if no credentials are configured for this host.
	ResolveCredential(host string) (credentialRef string, found bool, err error)
}

// SNMPFingerprinter runs sysDescr + sysObjectID GET queries against a list of hosts.
type SNMPFingerprinter struct {
	client   SNMPClient
	credResolver SNMPCredentialResolver
	timeout  time.Duration
}

// NewSNMPFingerprinter constructs a Fingerprinter.
// timeout applies per SNMP GET request; zero uses the default (5 s).
func NewSNMPFingerprinter(client SNMPClient, credResolver SNMPCredentialResolver, timeout time.Duration) *SNMPFingerprinter {
	if timeout <= 0 {
		timeout = 5 * time.Second
	}
	return &SNMPFingerprinter{client: client, credResolver: credResolver, timeout: timeout}
}

// Fingerprint queries sysDescr and sysObjectID for a single host.
// The runID and correlationID are attached to the result for traceability.
// Credential material is NEVER included in the returned result.
func (f *SNMPFingerprinter) Fingerprint(ctx context.Context, host, runID, correlationID string) model.SNMPFingerprintResult {
	now := time.Now().UTC()
	base := model.SNMPFingerprintResult{
		IP:            host,
		RunID:         runID,
		CorrelationID: correlationID,
		FingerprintedAt: now,
	}

	// Resolve credentials — log opaque reference only, never the value.
	credRef, found, err := f.credResolver.ResolveCredential(host)
	if err != nil {
		slog.Warn("snmp: credential resolution error",
			"host", host, "runId", runID, "error", err)
		base.Status = model.SNMPFingerprintAuthFailed
		base.FailureCategory = "SNMP_AUTH_FAILED"
		return base
	}
	if !found {
		slog.Debug("snmp: no credentials for host", "host", host, "runId", runID)
		base.Status = model.SNMPFingerprintAuthFailed
		base.FailureCategory = "SNMP_AUTH_FAILED"
		return base
	}
	_ = credRef // passed to client implicitly through the SNMPClient implementation

	ctx, cancel := context.WithTimeout(ctx, f.timeout)
	defer cancel()

	values, err := f.client.GetOIDs(ctx, host, []string{OIDSysDescr, OIDSysObjectID})
	if err != nil {
		cat := classifyError(err)
		slog.Info("snmp: fingerprint failed",
			"host", host, "runId", runID, "category", cat)
		base.Status = fingerprintStatusFromCategory(cat)
		base.FailureCategory = cat
		return base
	}

	sysDescr := strings.TrimSpace(values[OIDSysDescr])
	rawOID := strings.TrimSpace(values[OIDSysObjectID])

	// Validate OID before persisting — reject non-numeric strings.
	if rawOID != "" && !validOIDPattern.MatchString(rawOID) {
		slog.Warn("snmp: malformed sysObjectID received",
			"host", host, "runId", runID, "rawOid", "REDACTED")
		base.Status = model.SNMPFingerprintMalformed
		base.FailureCategory = "SNMP_MALFORMED_OID"
		if sysDescr != "" {
			// Partial: preserve sysDescr evidence even if OID is invalid.
			base.SysDescr = sysDescr
			base.Status = model.SNMPFingerprintPartial
			base.FailureCategory = "SNMP_MALFORMED_OID"
		}
		return base
	}

	if rawOID == "" && sysDescr == "" {
		base.Status = model.SNMPFingerprintMalformed
		base.FailureCategory = "SNMP_MISSING_DESCR"
		return base
	}

	if rawOID == "" {
		// sysDescr present but no OID — partial success.
		base.Status = model.SNMPFingerprintPartial
		base.SysDescr = sysDescr
		base.FailureCategory = "SNMP_MISSING_OID"
		return base
	}

	base.Status = model.SNMPFingerprintSuccess
	base.SysObjectID = normaliseOID(rawOID)
	base.SysDescr = sysDescr
	slog.Info("snmp: fingerprint success",
		"host", host, "runId", runID, "sysObjectID", base.SysObjectID)
	return base
}

// FingerprintBatch fingerprints a list of hosts concurrently (up to maxConcurrency at once).
// Results are returned in arbitrary order.
func (f *SNMPFingerprinter) FingerprintBatch(
	ctx context.Context,
	hosts []string,
	runID string,
	maxConcurrency int,
) []model.SNMPFingerprintResult {
	if maxConcurrency <= 0 {
		maxConcurrency = 10
	}

	sem := make(chan struct{}, maxConcurrency)
	resultCh := make(chan model.SNMPFingerprintResult, len(hosts))

	for _, h := range hosts {
		host := h
		sem <- struct{}{}
		go func() {
			defer func() { <-sem }()
			res := f.Fingerprint(ctx, host, runID, "")
			resultCh <- res
		}()
	}

	// Drain the semaphore to wait for all goroutines.
	for i := 0; i < maxConcurrency; i++ {
		sem <- struct{}{}
	}
	close(resultCh)

	results := make([]model.SNMPFingerprintResult, 0, len(hosts))
	for r := range resultCh {
		results = append(results, r)
	}
	return results
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// classifyError maps an SNMP client error to a category string.
// SECURITY: Never include the error message verbatim if it might contain credentials.
func classifyError(err error) string {
	if err == nil {
		return ""
	}
	msg := strings.ToLower(err.Error())
	switch {
	case strings.Contains(msg, "timeout") || strings.Contains(msg, "deadline exceeded"):
		return "SNMP_TIMEOUT"
	case strings.Contains(msg, "authentication") || strings.Contains(msg, "auth") ||
		strings.Contains(msg, "community") || strings.Contains(msg, "credential"):
		// Log only the category — community string must NOT appear in logs.
		return "SNMP_AUTH_FAILED"
	case strings.Contains(msg, "version") || strings.Contains(msg, "unsupported"):
		return "SNMP_UNSUPPORTED_VERSION"
	case strings.Contains(msg, "malformed") || strings.Contains(msg, "parse"):
		return "SNMP_MALFORMED_OID"
	default:
		return "SNMP_INTERNAL"
	}
}

func fingerprintStatusFromCategory(cat string) model.SNMPFingerprintStatus {
	switch cat {
	case "SNMP_TIMEOUT":
		return model.SNMPFingerprintTimeout
	case "SNMP_AUTH_FAILED":
		return model.SNMPFingerprintAuthFailed
	case "SNMP_MALFORMED_OID":
		return model.SNMPFingerprintMalformed
	default:
		return model.SNMPFingerprintAuthFailed
	}
}

// normaliseOID ensures the OID begins with a leading dot (.1.3.6...).
func normaliseOID(oid string) string {
	if !strings.HasPrefix(oid, ".") {
		return fmt.Sprintf(".%s", oid)
	}
	return oid
}
