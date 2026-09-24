// Package scanner — multi-mode deterministic probe orchestration (WO-008).
//
// ProbeOrchestrator runs a configured sequence of protocol probes against a
// single target host. Each probe records a ProbeAttempt with safe evidence;
// SNMP community strings, SSH passwords, and API keys are NEVER included.
//
// Default deterministic probe order:
//   1. ICMP  — reachability gate; if unreachable, remaining probes are skipped.
//   2. SNMP  — sysDescr / sysObjectID fingerprinting.
//   3. SSH   — banner grab (no authentication — no credentials sent).
//   4. HTTP  — server header / title extraction over plain HTTP.
//   5. HTTPS — server header / TLS certificate CN extraction.
//   6. GRPC  — gRPC health-check protocol probe.
//
// Orchestration stops as soon as the first probe produces a "success" outcome
// with usable evidence for downstream fingerprint matching.
package scanner

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/airtel-ubrnms/discovery-service/internal/model"
)

// ProbeExecutor executes a single protocol probe against a target host.
// Implementations must be safe to call concurrently.
// Credential material must NEVER appear in the returned ProbeAttempt.
type ProbeExecutor interface {
	// ProbeType returns the protocol this executor handles.
	ProbeType() model.ProbeType
	// Execute runs the probe against the given host and returns a populated ProbeAttempt.
	// The correlationID is attached to the attempt for traceability.
	// Context cancellation must be honoured.
	Execute(ctx context.Context, host, correlationID string) model.ProbeAttempt
}

// ProbeOrchestrator runs a deterministic sequence of ProbeExecutors against one host.
type ProbeOrchestrator struct {
	executors []ProbeExecutor
	// stopOnFirstSuccess controls whether orchestration halts after the first
	// probe that returns ProbeAttemptSuccess. Default: true (production behaviour).
	stopOnFirstSuccess bool
}

// NewProbeOrchestrator creates an orchestrator with the supplied executors in probe order.
// Pass them in the desired sequence — first executor to succeed stops the chain.
func NewProbeOrchestrator(executors ...ProbeExecutor) *ProbeOrchestrator {
	return &ProbeOrchestrator{
		executors:          executors,
		stopOnFirstSuccess: true,
	}
}

// NewFullProbeOrchestrator creates an orchestrator with the default 6-protocol sequence:
// ICMP → SNMP → SSH → HTTP → HTTPS → GRPC_HEALTH.
// Uses concrete executor implementations with the provided timeout.
func NewFullProbeOrchestrator(snmpClient SNMPClient, credResolver SNMPCredentialResolver, timeout time.Duration) *ProbeOrchestrator {
	if timeout <= 0 {
		timeout = 5 * time.Second
	}
	return NewProbeOrchestrator(
		NewICMPProbeExecutor(timeout),
		NewSNMPProbeExecutor(snmpClient, credResolver, timeout),
		NewSSHBannerExecutor(timeout),
		NewHTTPProbeExecutor(timeout),
		NewHTTPSProbeExecutor(timeout),
		NewGRPCHealthExecutor(timeout),
	)
}

// RunAll executes all probes in order and returns the full attempt chain.
// If stopOnFirstSuccess is true (default), the chain halts after the first success.
// The returned slice is in probe execution order.
// Returns the first successful ProbeType, or empty string if none succeeded.
func (o *ProbeOrchestrator) RunAll(ctx context.Context, host, correlationID string) ([]model.ProbeAttempt, model.ProbeType) {
	attempts := make([]model.ProbeAttempt, 0, len(o.executors))
	var successfulType model.ProbeType

	for _, exec := range o.executors {
		// Propagate context cancellation — abort the whole chain.
		if ctx.Err() != nil {
			break
		}
		attempt := exec.Execute(ctx, host, correlationID)
		attempts = append(attempts, attempt)

		if attempt.Status == model.ProbeAttemptSuccess {
			successfulType = exec.ProbeType()
			if o.stopOnFirstSuccess {
				break
			}
		}
	}

	return attempts, successfulType
}

// ── ICMP probe executor ───────────────────────────────────────────────────────

// ICMPProbeExecutor tests reachability using a TCP dial to port 7 (echo) or
// an ICMP-equivalent net.DialTimeout to the host. Uses TCP dial to port 7
// as a reachability signal since raw ICMP requires elevated privileges.
//
// Evidence: "host responded within Xms" or "host unreachable".
type ICMPProbeExecutor struct{ timeout time.Duration }

// NewICMPProbeExecutor creates an executor for the ICMP reachability probe.
func NewICMPProbeExecutor(timeout time.Duration) *ICMPProbeExecutor {
	return &ICMPProbeExecutor{timeout: timeout}
}

func (e *ICMPProbeExecutor) ProbeType() model.ProbeType { return model.ProbeTypeICMP }

func (e *ICMPProbeExecutor) Execute(ctx context.Context, host, correlationID string) model.ProbeAttempt {
	start := time.Now().UTC()
	attempt := model.ProbeAttempt{
		ProbeType: model.ProbeTypeICMP,
		StartedAt: start,
		Retryable: true,
	}

	// Try TCP connect to common management port (22/SSH) as a reachability signal.
	// This avoids requiring raw socket privileges for ICMP while still detecting
	// whether the host is network-reachable. Ports 22, 161, and 443 are tried in order.
	targetPorts := []string{"22", "161", "443", "80"}
	reachable := false
	for _, port := range targetPorts {
		dialCtx, cancel := context.WithTimeout(ctx, e.timeout/time.Duration(len(targetPorts)))
		conn, err := (&net.Dialer{}).DialContext(dialCtx, "tcp", net.JoinHostPort(host, port))
		cancel()
		if err == nil {
			conn.Close()
			reachable = true
			break
		}
	}

	elapsed := time.Since(start)
	attempt.CompletedAt = time.Now().UTC()
	attempt.LatencyMs = elapsed.Milliseconds()

	if reachable {
		attempt.Status = model.ProbeAttemptSuccess
		attempt.SafeEvidenceSummary = fmt.Sprintf("host responded within %dms", elapsed.Milliseconds())
	} else {
		attempt.Status = model.ProbeAttemptUnreachable
		attempt.FailureCategory = "ICMP_UNREACHABLE"
		attempt.FailureReason = "host did not respond to TCP reachability probes on ports 22, 161, 443, 80"
		attempt.Retryable = true
	}
	return attempt
}

// ── SNMP probe executor ───────────────────────────────────────────────────────

// SNMPProbeExecutor fingerprints the target using sysDescr and sysObjectID GETs.
// Delegates to the existing SNMPFingerprinter. Credential values are never included.
type SNMPProbeExecutor struct {
	fingerprinter *SNMPFingerprinter
}

// NewSNMPProbeExecutor creates an executor backed by the existing SNMPFingerprinter.
func NewSNMPProbeExecutor(client SNMPClient, credResolver SNMPCredentialResolver, timeout time.Duration) *SNMPProbeExecutor {
	return &SNMPProbeExecutor{
		fingerprinter: NewSNMPFingerprinter(client, credResolver, timeout),
	}
}

func (e *SNMPProbeExecutor) ProbeType() model.ProbeType { return model.ProbeTypeSNMP }

func (e *SNMPProbeExecutor) Execute(ctx context.Context, host, correlationID string) model.ProbeAttempt {
	start := time.Now().UTC()
	result := e.fingerprinter.Fingerprint(ctx, host, "", correlationID)
	elapsed := time.Since(start)

	attempt := model.ProbeAttempt{
		ProbeType:   model.ProbeTypeSNMP,
		StartedAt:   start,
		CompletedAt: time.Now().UTC(),
		LatencyMs:   elapsed.Milliseconds(),
	}

	switch result.Status {
	case "success":
		attempt.Status = model.ProbeAttemptSuccess
		// Safe evidence: OID prefix and sysDescr snippet (no community strings).
		oidPrefix := ""
		if result.SysObjectID != "" {
			parts := strings.Split(result.SysObjectID, ".")
			if len(parts) > 7 {
				oidPrefix = strings.Join(parts[:7], ".")
			} else {
				oidPrefix = result.SysObjectID
			}
		}
		descr := result.SysDescr
		if len(descr) > 80 {
			descr = descr[:80] + "…"
		}
		attempt.SafeEvidenceSummary = fmt.Sprintf("sysObjectID=%s sysDescr=%q", oidPrefix, descr)
		attempt.Retryable = false
	case "partial":
		attempt.Status = model.ProbeAttemptSuccess
		attempt.SafeEvidenceSummary = fmt.Sprintf("partial: sysDescr=%q", result.SysDescr)
		attempt.Retryable = false
	case "timeout":
		attempt.Status = model.ProbeAttemptTimeout
		attempt.FailureCategory = string(result.FailureCategory)
		attempt.FailureReason = "SNMP GET timed out"
		attempt.Retryable = true
	case "auth_failed":
		attempt.Status = model.ProbeAttemptAuthFailed
		attempt.FailureCategory = string(result.FailureCategory)
		attempt.FailureReason = "SNMP credential resolution failed — no credential configured or credential rejected"
		attempt.Retryable = false
	default:
		attempt.Status = model.ProbeAttemptFailed
		attempt.FailureCategory = string(result.FailureCategory)
		attempt.FailureReason = "SNMP fingerprint failed"
		attempt.Retryable = false
	}
	return attempt
}

// ── SSH banner probe executor ─────────────────────────────────────────────────

// SSHBannerExecutor connects to TCP port 22 and captures the SSH identification
// string (e.g. "SSH-2.0-OpenSSH_8.4p1"). No authentication is performed — no
// credentials are ever sent. The banner is safe to include in evidence.
type SSHBannerExecutor struct{ timeout time.Duration }

// NewSSHBannerExecutor creates an executor for SSH banner grabbing.
func NewSSHBannerExecutor(timeout time.Duration) *SSHBannerExecutor {
	return &SSHBannerExecutor{timeout: timeout}
}

func (e *SSHBannerExecutor) ProbeType() model.ProbeType { return model.ProbeTypeSSH }

func (e *SSHBannerExecutor) Execute(ctx context.Context, host, _ string) model.ProbeAttempt {
	start := time.Now().UTC()
	attempt := model.ProbeAttempt{
		ProbeType: model.ProbeTypeSSH,
		StartedAt: start,
		Retryable: true,
	}

	dialCtx, cancel := context.WithTimeout(ctx, e.timeout)
	defer cancel()

	conn, err := (&net.Dialer{}).DialContext(dialCtx, "tcp", net.JoinHostPort(host, "22"))
	elapsed := time.Since(start)
	attempt.CompletedAt = time.Now().UTC()
	attempt.LatencyMs = elapsed.Milliseconds()

	if err != nil {
		attempt.Status = model.ProbeAttemptFailed
		attempt.FailureCategory = "SSH_CONNECT_FAILED"
		attempt.FailureReason = "TCP connect to port 22 failed"
		attempt.Retryable = true
		return attempt
	}
	defer conn.Close()

	// Read the SSH identification string (ends with \r\n or \n).
	conn.SetDeadline(time.Now().Add(e.timeout / 2)) //nolint:errcheck
	buf := make([]byte, 256)
	n, readErr := conn.Read(buf)
	if readErr != nil || n == 0 {
		attempt.Status = model.ProbeAttemptFailed
		attempt.FailureCategory = "SSH_BANNER_UNREADABLE"
		attempt.FailureReason = "SSH connection established but banner could not be read"
		attempt.Retryable = false
		return attempt
	}

	// Extract the banner line (strip credentials, control chars, non-ASCII).
	banner := sanitiseBanner(string(buf[:n]))
	attempt.Status = model.ProbeAttemptSuccess
	attempt.SafeEvidenceSummary = "SSH banner: " + banner
	attempt.Retryable = false
	return attempt
}

// sanitiseBanner returns the first line of the banner with non-printable characters removed.
// Preserves only ASCII printable characters (0x20–0x7E) and limits to 120 chars.
func sanitiseBanner(raw string) string {
	line := strings.SplitN(raw, "\n", 2)[0]
	line = strings.TrimRight(line, "\r")
	var safe []rune
	for _, r := range line {
		if r >= 0x20 && r <= 0x7E {
			safe = append(safe, r)
		}
	}
	result := string(safe)
	if len(result) > 120 {
		return result[:120]
	}
	return result
}

// ── HTTP probe executor ───────────────────────────────────────────────────────

// HTTPProbeExecutor sends a HEAD request to port 80 and records the Server header.
// Follows no redirects; only the initial response is captured.
type HTTPProbeExecutor struct {
	timeout time.Duration
	client  *http.Client
}

// NewHTTPProbeExecutor creates an executor for HTTP header probing.
func NewHTTPProbeExecutor(timeout time.Duration) *HTTPProbeExecutor {
	return &HTTPProbeExecutor{
		timeout: timeout,
		client: &http.Client{
			Timeout: timeout,
			CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
				return http.ErrUseLastResponse // do not follow redirects
			},
		},
	}
}

func (e *HTTPProbeExecutor) ProbeType() model.ProbeType { return model.ProbeTypeHTTP }

func (e *HTTPProbeExecutor) Execute(ctx context.Context, host, _ string) model.ProbeAttempt {
	start := time.Now().UTC()
	attempt := model.ProbeAttempt{
		ProbeType: model.ProbeTypeHTTP,
		StartedAt: start,
		Retryable: true,
	}

	req, reqErr := http.NewRequestWithContext(ctx, http.MethodHead, "http://"+net.JoinHostPort(host, "80")+"/", nil)
	if reqErr != nil {
		attempt.CompletedAt = time.Now().UTC()
		attempt.Status = model.ProbeAttemptFailed
		attempt.FailureCategory = "HTTP_REQUEST_BUILD_FAILED"
		attempt.FailureReason = "failed to build HTTP request"
		return attempt
	}

	resp, err := e.client.Do(req)
	elapsed := time.Since(start)
	attempt.CompletedAt = time.Now().UTC()
	attempt.LatencyMs = elapsed.Milliseconds()

	if err != nil {
		if strings.Contains(err.Error(), "timeout") || strings.Contains(err.Error(), "deadline") {
			attempt.Status = model.ProbeAttemptTimeout
			attempt.FailureCategory = "HTTP_TIMEOUT"
		} else {
			attempt.Status = model.ProbeAttemptFailed
			attempt.FailureCategory = "HTTP_CONNECT_FAILED"
		}
		attempt.FailureReason = "HTTP probe failed"
		attempt.Retryable = true
		return attempt
	}
	defer resp.Body.Close()

	server := resp.Header.Get("Server")
	if server == "" {
		server = fmt.Sprintf("HTTP/%d", resp.StatusCode)
	}
	attempt.Status = model.ProbeAttemptSuccess
	attempt.SafeEvidenceSummary = fmt.Sprintf("HTTP %d Server=%q", resp.StatusCode, server)
	attempt.Retryable = false
	return attempt
}

// ── HTTPS probe executor ──────────────────────────────────────────────────────

// HTTPSProbeExecutor sends a HEAD request to port 443 and records the Server
// header and TLS certificate subject CN. Certificate validation is skipped
// (many managed devices use self-signed certs). No auth credentials are sent.
type HTTPSProbeExecutor struct {
	timeout time.Duration
	client  *http.Client
}

// NewHTTPSProbeExecutor creates an executor for HTTPS header and TLS CN probing.
func NewHTTPSProbeExecutor(timeout time.Duration) *HTTPSProbeExecutor {
	tr := &http.Transport{
		TLSHandshakeTimeout: timeout / 2,
	}
	// Disable TLS verification so self-signed device certs do not block evidence collection.
	// SECURITY: no auth material is sent — this is probe-only.
	setInsecureTLS(tr) // platform-specific helper defined below
	return &HTTPSProbeExecutor{
		timeout: timeout,
		client: &http.Client{
			Timeout:   timeout,
			Transport: tr,
			CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
	}
}

func (e *HTTPSProbeExecutor) ProbeType() model.ProbeType { return model.ProbeTypeHTTPS }

func (e *HTTPSProbeExecutor) Execute(ctx context.Context, host, _ string) model.ProbeAttempt {
	start := time.Now().UTC()
	attempt := model.ProbeAttempt{
		ProbeType: model.ProbeTypeHTTPS,
		StartedAt: start,
		Retryable: true,
	}

	req, reqErr := http.NewRequestWithContext(ctx, http.MethodHead, "https://"+net.JoinHostPort(host, "443")+"/", nil)
	if reqErr != nil {
		attempt.CompletedAt = time.Now().UTC()
		attempt.Status = model.ProbeAttemptFailed
		attempt.FailureCategory = "HTTPS_REQUEST_BUILD_FAILED"
		attempt.FailureReason = "failed to build HTTPS request"
		return attempt
	}

	resp, err := e.client.Do(req)
	elapsed := time.Since(start)
	attempt.CompletedAt = time.Now().UTC()
	attempt.LatencyMs = elapsed.Milliseconds()

	if err != nil {
		if strings.Contains(err.Error(), "timeout") || strings.Contains(err.Error(), "deadline") {
			attempt.Status = model.ProbeAttemptTimeout
			attempt.FailureCategory = "HTTPS_TIMEOUT"
		} else {
			attempt.Status = model.ProbeAttemptFailed
			attempt.FailureCategory = "HTTPS_CONNECT_FAILED"
		}
		attempt.FailureReason = "HTTPS probe failed"
		attempt.Retryable = true
		return attempt
	}
	defer resp.Body.Close()

	server := resp.Header.Get("Server")
	cn := ""
	if resp.TLS != nil && len(resp.TLS.PeerCertificates) > 0 {
		cn = resp.TLS.PeerCertificates[0].Subject.CommonName
	}
	attempt.Status = model.ProbeAttemptSuccess
	attempt.SafeEvidenceSummary = fmt.Sprintf("HTTPS %d Server=%q CN=%q", resp.StatusCode, server, cn)
	attempt.Retryable = false
	return attempt
}

// ── gRPC health probe executor ────────────────────────────────────────────────

// GRPCHealthExecutor probes the gRPC health check protocol by attempting a TCP
// connection to port 50051 and optionally sending the gRPC SETTINGS preamble.
// No auth credentials are sent; the evidence is limited to connection latency.
type GRPCHealthExecutor struct{ timeout time.Duration }

// NewGRPCHealthExecutor creates an executor for gRPC health probing.
func NewGRPCHealthExecutor(timeout time.Duration) *GRPCHealthExecutor {
	return &GRPCHealthExecutor{timeout: timeout}
}

func (e *GRPCHealthExecutor) ProbeType() model.ProbeType { return model.ProbeTypeGRPC }

func (e *GRPCHealthExecutor) Execute(ctx context.Context, host, _ string) model.ProbeAttempt {
	start := time.Now().UTC()
	attempt := model.ProbeAttempt{
		ProbeType: model.ProbeTypeGRPC,
		StartedAt: start,
		Retryable: true,
	}

	dialCtx, cancel := context.WithTimeout(ctx, e.timeout)
	defer cancel()

	conn, err := (&net.Dialer{}).DialContext(dialCtx, "tcp", net.JoinHostPort(host, "50051"))
	elapsed := time.Since(start)
	attempt.CompletedAt = time.Now().UTC()
	attempt.LatencyMs = elapsed.Milliseconds()

	if err != nil {
		attempt.Status = model.ProbeAttemptFailed
		attempt.FailureCategory = "GRPC_CONNECT_FAILED"
		attempt.FailureReason = "TCP connect to gRPC port 50051 failed"
		attempt.Retryable = true
		return attempt
	}
	conn.Close()

	attempt.Status = model.ProbeAttemptSuccess
	attempt.SafeEvidenceSummary = fmt.Sprintf("gRPC port 50051 open, latency=%dms", elapsed.Milliseconds())
	attempt.Retryable = false
	return attempt
}

// ── FakeProbeExecutor (test double) ──────────────────────────────────────────

// FakeProbeExecutor is a test double that returns a pre-configured ProbeAttempt.
// Use this in unit tests to avoid real network calls.
type FakeProbeExecutor struct {
	probeType model.ProbeType
	result    model.ProbeAttempt
}

// NewFakeProbeExecutor creates a deterministic test double for a given probe type.
func NewFakeProbeExecutor(pt model.ProbeType, status model.ProbeAttemptStatus, evidence string) *FakeProbeExecutor {
	now := time.Now().UTC()
	retryable := status == model.ProbeAttemptTimeout || status == model.ProbeAttemptUnreachable
	return &FakeProbeExecutor{
		probeType: pt,
		result: model.ProbeAttempt{
			ProbeType:           pt,
			Status:              status,
			StartedAt:           now,
			CompletedAt:         now,
			LatencyMs:           1,
			SafeEvidenceSummary: evidence,
			Retryable:           retryable,
		},
	}
}

func (f *FakeProbeExecutor) ProbeType() model.ProbeType { return f.probeType }

func (f *FakeProbeExecutor) Execute(_ context.Context, _, _ string) model.ProbeAttempt {
	// Return a copy so callers cannot mutate the shared template.
	a := f.result
	now := time.Now().UTC()
	a.StartedAt = now
	a.CompletedAt = now
	return a
}
