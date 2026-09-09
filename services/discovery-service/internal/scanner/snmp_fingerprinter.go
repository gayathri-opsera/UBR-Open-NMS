// Package scanner — SNMP fingerprinting for generic device discovery (WO-027, WO-010).
//
// SNMPFingerprinter queries sysDescr (.1.3.6.1.2.1.1.1.0) and sysObjectID
// (.1.3.6.1.2.1.1.2.0) from management-port-probed hosts. The results are
// used downstream to classify devices by vendor and model.
//
// Security constraints:
//   - Community strings and credentials are NEVER stored in result structs or logs.
//   - Only categorised failure reasons are surfaced to operators.
//   - OIDs are validated before being persisted as sysObjectID.
//
// Retry behaviour (WO-010):
//   - Transient errors (SNMP_TIMEOUT, SNMP_INTERNAL) are retried with exponential
//     backoff and jitter up to RetryConfig.MaxRetries times.
//   - Permanent errors (SNMP_AUTH_FAILED, SNMP_UNSUPPORTED_VERSION, SNMP_MALFORMED_OID)
//     are never retried.
package scanner

import (
	"context"
	"fmt"
	"log/slog"
	"math/rand"
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

// RetryConfig configures the exponential backoff behaviour for transient SNMP errors.
// All durations must be positive; zero or negative values are replaced with safe defaults.
type RetryConfig struct {
	// MaxRetries is the number of additional attempts after the first failure.
	// 0 means no retries (single attempt only); negative values are treated as 0.
	MaxRetries int
	// InitialDelay is the base wait duration before the first retry attempt.
	// Must be positive; values ≤ 0 are replaced with 1 second.
	InitialDelay time.Duration
	// MaxDelay caps the computed backoff delay so retries never wait longer than this.
	// Must be positive; values ≤ 0 are replaced with 60 seconds.
	MaxDelay time.Duration
}

// defaultRetryConfig is the production-safe retry configuration (WO-010).
// Provides two retries with 5 s / 10 s delays plus jitter.
var defaultRetryConfig = RetryConfig{
	MaxRetries:   2,
	InitialDelay: 5 * time.Second,
	MaxDelay:     30 * time.Second,
}

// sanitise returns a RetryConfig with safe default values substituted for
// zero or negative fields, and logs a warning when a correction is applied.
func sanitise(rc RetryConfig) RetryConfig {
	if rc.MaxRetries < 0 {
		slog.Warn("snmp: MaxRetries is negative; defaulting to 0")
		rc.MaxRetries = 0
	}
	if rc.InitialDelay <= 0 {
		slog.Warn("snmp: InitialDelay is non-positive; defaulting to 1s")
		rc.InitialDelay = 1 * time.Second
	}
	if rc.MaxDelay <= 0 {
		slog.Warn("snmp: MaxDelay is non-positive; defaulting to 60s")
		rc.MaxDelay = 60 * time.Second
	}
	return rc
}

// isRetryableCategory returns true when the error category represents a transient
// condition that may resolve on a subsequent attempt.
//
// Permanent categories (auth failure, unsupported version, malformed OID) are not
// retried because repeating the request will not change the outcome.
func isRetryableCategory(cat model.FingerprintFailureCategory) bool {
	return cat == model.FingerprintCategoryTimeout || cat == model.FingerprintCategoryInternal
}

// SNMPFingerprinter runs sysDescr + sysObjectID GET queries against a list of hosts.
type SNMPFingerprinter struct {
	client       SNMPClient
	credResolver SNMPCredentialResolver
	timeout      time.Duration
	retry        RetryConfig
	// sleepFn is the delay primitive used between retries. Tests inject a no-op
	// to make retry tests run instantly; production code uses time.Sleep.
	sleepFn func(time.Duration)
}

// NewSNMPFingerprinter constructs a Fingerprinter with the default retry config.
// timeout applies per SNMP GET request; zero uses the default (5 s).
func NewSNMPFingerprinter(client SNMPClient, credResolver SNMPCredentialResolver, timeout time.Duration) *SNMPFingerprinter {
	if timeout <= 0 {
		timeout = 5 * time.Second
	}
	return &SNMPFingerprinter{
		client:       client,
		credResolver: credResolver,
		timeout:      timeout,
		retry:        sanitise(defaultRetryConfig),
		sleepFn:      time.Sleep,
	}
}

// NewSNMPFingerprinterWithRetry constructs a Fingerprinter with a custom retry config.
// Use this when callers need to override backoff parameters (e.g., CI/CD pipeline with
// tighter deadlines, or integration tests with instant delays).
func NewSNMPFingerprinterWithRetry(
	client SNMPClient,
	credResolver SNMPCredentialResolver,
	timeout time.Duration,
	retry RetryConfig,
) *SNMPFingerprinter {
	if timeout <= 0 {
		timeout = 5 * time.Second
	}
	fp := NewSNMPFingerprinter(client, credResolver, timeout)
	fp.retry = sanitise(retry)
	return fp
}

// backoffDelay returns the capped exponential delay for the given attempt index (0-based).
// Jitter of up to 10 % of the computed delay is added to spread retry storms.
func (f *SNMPFingerprinter) backoffDelay(attempt int) time.Duration {
	// delay = InitialDelay * 2^attempt
	shift := attempt
	if shift > 30 {
		shift = 30 // prevent overflow when MaxDelay is very high
	}
	delay := f.retry.InitialDelay * (1 << shift)
	if delay > f.retry.MaxDelay || delay < 0 {
		delay = f.retry.MaxDelay
	}
	// Add up to 10 % jitter to avoid thundering herd.
	jitter := time.Duration(rand.Int63n(int64(delay/10 + 1)))
	return delay + jitter
}

// Fingerprint queries sysDescr and sysObjectID for a single host.
// Transient errors trigger automatic retries according to the configured RetryConfig.
// The runID and correlationID are attached to the result for traceability.
// Credential material is NEVER included in the returned result.
func (f *SNMPFingerprinter) Fingerprint(ctx context.Context, host, runID, correlationID string) model.SNMPFingerprintResult {
	now := time.Now().UTC()
	base := model.SNMPFingerprintResult{
		IP:              host,
		RunID:           runID,
		CorrelationID:   correlationID,
		FingerprintedAt: now,
	}

	// Resolve credentials — log opaque reference only, never the value.
	credRef, found, err := f.credResolver.ResolveCredential(host)
	if err != nil {
		slog.Warn("snmp: credential resolution error",
			"host", host, "runId", runID, "error", err)
		base.Status = model.SNMPFingerprintAuthFailed
		base.FailureCategory = model.FingerprintCategoryAuthFailed
		return base
	}
	if !found {
		slog.Debug("snmp: no credentials for host", "host", host, "runId", runID)
		base.Status = model.SNMPFingerprintAuthFailed
		base.FailureCategory = model.FingerprintCategoryAuthFailed
		return base
	}
	_ = credRef // passed to client implicitly through the SNMPClient implementation

	// Attempt the SNMP query with retry on transient errors.
	var (
		values    map[string]string
		queryErr  error
		retryCount int
	)
	for attempt := 0; attempt <= f.retry.MaxRetries; attempt++ {
		queryCtx, cancel := context.WithTimeout(ctx, f.timeout)
		values, queryErr = f.client.GetOIDs(queryCtx, host, []string{OIDSysDescr, OIDSysObjectID})
		cancel()

		if queryErr == nil {
			// Success — exit retry loop.
			break
		}

		cat := classifyError(queryErr)
		if !isRetryableCategory(cat) || attempt == f.retry.MaxRetries {
			// Permanent error or exhausted retries.
			retryCount = attempt
			break
		}

		// Transient error — wait then retry.
		slog.Info("snmp: transient error; retrying",
			"host", host, "runId", runID, "attempt", attempt+1, "category", cat)
		delay := f.backoffDelay(attempt)
		f.sleepFn(delay)
		retryCount = attempt + 1
	}

	base.RetryCount = retryCount

	if queryErr != nil {
		cat := classifyError(queryErr)
		slog.Info("snmp: fingerprint failed",
			"host", host, "runId", runID, "category", cat, "retries", retryCount)
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
		base.FailureCategory = model.FingerprintCategoryMalformedOID
		if sysDescr != "" {
			// Partial: preserve sysDescr evidence even if OID is invalid.
			base.SysDescr = sysDescr
			base.Status = model.SNMPFingerprintPartial
		}
		return base
	}

	if rawOID == "" && sysDescr == "" {
		base.Status = model.SNMPFingerprintMalformed
		base.FailureCategory = model.FingerprintCategoryMissingDescr
		return base
	}

	if rawOID == "" {
		// sysDescr present but no OID — partial success.
		base.Status = model.SNMPFingerprintPartial
		base.SysDescr = sysDescr
		base.FailureCategory = model.FingerprintCategoryMissingDescr
		return base
	}

	base.Status = model.SNMPFingerprintSuccess
	base.SysObjectID = normaliseOID(rawOID)
	base.SysDescr = sysDescr
	slog.Info("snmp: fingerprint success",
		"host", host, "runId", runID, "sysObjectID", base.SysObjectID, "retries", retryCount)
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

// classifyError maps an SNMP client error to a FingerprintFailureCategory.
// SECURITY: Never include the error message verbatim if it might contain credentials.
func classifyError(err error) model.FingerprintFailureCategory {
	if err == nil {
		return ""
	}
	msg := strings.ToLower(err.Error())
	switch {
	case strings.Contains(msg, "timeout") || strings.Contains(msg, "deadline exceeded"):
		return model.FingerprintCategoryTimeout
	case strings.Contains(msg, "authentication") || strings.Contains(msg, "auth") ||
		strings.Contains(msg, "community") || strings.Contains(msg, "credential"):
		// Log only the category — community string must NOT appear in logs.
		return model.FingerprintCategoryAuthFailed
	case strings.Contains(msg, "version") || strings.Contains(msg, "unsupported"):
		return model.FingerprintCategoryUnsupportedVersion
	case strings.Contains(msg, "malformed") || strings.Contains(msg, "parse"):
		return model.FingerprintCategoryMalformedOID
	default:
		return model.FingerprintCategoryInternal
	}
}

func fingerprintStatusFromCategory(cat model.FingerprintFailureCategory) model.SNMPFingerprintStatus {
	switch cat {
	case model.FingerprintCategoryTimeout:
		return model.SNMPFingerprintTimeout
	case model.FingerprintCategoryAuthFailed:
		return model.SNMPFingerprintAuthFailed
	case model.FingerprintCategoryMalformedOID:
		return model.SNMPFingerprintMalformed
	default:
		return model.SNMPFingerprintFailed
	}
}

// normaliseOID ensures the OID begins with a leading dot (.1.3.6...).
func normaliseOID(oid string) string {
	if !strings.HasPrefix(oid, ".") {
		return fmt.Sprintf(".%s", oid)
	}
	return oid
}
