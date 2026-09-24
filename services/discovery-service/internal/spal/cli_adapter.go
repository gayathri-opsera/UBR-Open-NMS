// Package spal — CLI read-only adapter (SSH/Telnet) (WO-009).
//
// CLIAdapter executes show-commands over SSH (preferred) or Telnet using
// device credentials sourced exclusively via CredentialResolver.
// It is read-only by design; any write-class commands are blocked at the
// interface boundary by enforcing only one public surface: Get and Ping.
package spal

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"time"
)

const cliAdapterVersion = "spal-cli/1.0"

// CLISession is the minimal interface for interacting with a device via CLI.
// An SSH-backed implementation uses golang.org/x/crypto/ssh.
// Tests inject a fake.
type CLISession interface {
	// RunCommand executes a single read-only show-command and returns the
	// trimmed output.  The implementation MUST NOT issue configuration commands.
	RunCommand(ctx context.Context, cmd string) (string, error)
	// Close releases the session and its underlying connection.
	Close() error
}

// CLIDialer opens a CLI session to the device.
// The proto argument is ProtocolSSH or ProtocolTelnet.
type CLIDialer interface {
	Dial(ctx context.Context, host string, cred ResolvedCredential, proto Protocol) (CLISession, error)
}

// CLIAdapter reads device parameters via SSH or Telnet show-commands.
type CLIAdapter struct {
	dialer   CLIDialer
	resolver CredentialResolver
	proto    Protocol
	timeout  time.Duration
}

// NewCLIAdapter creates a CLIAdapter for the given protocol (SSH or Telnet).
// timeout controls the session dial and per-command deadline.
func NewCLIAdapter(dialer CLIDialer, resolver CredentialResolver, proto Protocol, timeout time.Duration) *CLIAdapter {
	if proto != ProtocolSSH && proto != ProtocolTelnet {
		proto = ProtocolSSH
	}
	if timeout <= 0 {
		timeout = 10 * time.Second
	}
	return &CLIAdapter{dialer: dialer, resolver: resolver, proto: proto, timeout: timeout}
}

func (a *CLIAdapter) Protocol() Protocol     { return a.proto }
func (a *CLIAdapter) AdapterVersion() string { return cliAdapterVersion }

// Ping verifies CLI reachability by dialing and running "show version" (or
// equivalent minimal command). Credential material is never included in the result.
func (a *CLIAdapter) Ping(ctx context.Context, device DeviceContext) PingResult {
	start := time.Now()
	result := PingResult{Protocol: a.proto}

	cred, err := a.resolver.Resolve(ctx, device.CredentialRef)
	if err != nil {
		result.Reachable = false
		result.FailureCategory = FailureCategoryCredentialResolution
		result.FailureReason = "CLI credential resolution failed"
		slog.Warn("spal/cli: ping credential resolution failed",
			"deviceId", device.DeviceID, "proto", a.proto)
		return result
	}

	dialCtx, cancel := context.WithTimeout(ctx, a.timeout)
	defer cancel()

	sess, err := a.dialer.Dial(dialCtx, device.IPAddress, cred, a.proto)
	if err != nil {
		result.LatencyMs = time.Since(start).Milliseconds()
		result.Reachable = false
		result.FailureCategory = categorizeDialError(err)
		result.FailureReason = fmt.Sprintf("CLI dial failed: %v", categorizeSafeMsg(err))
		return result
	}
	defer func() {
		if closeErr := sess.Close(); closeErr != nil {
			slog.Debug("spal/cli: session close error", "deviceId", device.DeviceID, "err", closeErr)
		}
	}()

	if _, runErr := sess.RunCommand(dialCtx, "show version"); runErr != nil {
		result.LatencyMs = time.Since(start).Milliseconds()
		result.Reachable = false
		result.FailureCategory = FailureCategoryTimeout
		result.FailureReason = "CLI ping command timed out or failed"
		return result
	}

	result.LatencyMs = time.Since(start).Milliseconds()
	result.Reachable = true
	return result
}

// Get executes the CLICommand for each ParamRef and returns parsed values.
// Parameters that have no CLICommand configured are returned as UNSUPPORTED_PARAMETER failures.
func (a *CLIAdapter) Get(ctx context.Context, device DeviceContext, params []ParamRef) GetResult {
	start := time.Now()
	result := GetResult{ActiveProtocol: a.proto, ObservedAt: time.Now().UTC()}

	cred, err := a.resolver.Resolve(ctx, device.CredentialRef)
	if err != nil {
		for _, p := range params {
			result.Failures = append(result.Failures, AdapterFailure{
				ParameterID:     p.ParameterID,
				Protocol:        a.proto,
				FailureCategory: FailureCategoryCredentialResolution,
				FailureReason:   "CLI credential resolution failed",
				Retryable:       false,
			})
		}
		return result
	}

	dialCtx, cancel := context.WithTimeout(ctx, a.timeout)
	defer cancel()

	sess, dialErr := a.dialer.Dial(dialCtx, device.IPAddress, cred, a.proto)
	if dialErr != nil {
		cat := categorizeDialError(dialErr)
		msg := fmt.Sprintf("CLI dial failed: %v", categorizeSafeMsg(dialErr))
		for _, p := range params {
			result.Failures = append(result.Failures, AdapterFailure{
				ParameterID:     p.ParameterID,
				Protocol:        a.proto,
				FailureCategory: cat,
				FailureReason:   msg,
				Retryable:       cat == FailureCategoryTimeout,
			})
		}
		result.LatencyMs = time.Since(start).Milliseconds()
		return result
	}
	defer func() {
		if closeErr := sess.Close(); closeErr != nil {
			slog.Debug("spal/cli: session close", "deviceId", device.DeviceID)
		}
	}()

	// Execute each parameter's configured show-command.
	for _, p := range params {
		if p.CLICommand == "" {
			result.Failures = append(result.Failures, AdapterFailure{
				ParameterID:     p.ParameterID,
				Protocol:        a.proto,
				FailureCategory: FailureCategoryUnsupportedParam,
				FailureReason:   fmt.Sprintf("parameter %s has no CLICommand configured", p.ParameterID),
				Retryable:       false,
			})
			continue
		}
		raw, runErr := sess.RunCommand(dialCtx, p.CLICommand)
		if runErr != nil {
			result.Failures = append(result.Failures, AdapterFailure{
				ParameterID:     p.ParameterID,
				Protocol:        a.proto,
				FailureCategory: FailureCategoryTimeout,
				FailureReason:   "CLI command execution failed or timed out",
				Retryable:       true,
			})
			continue
		}
		result.Values = append(result.Values, ReadValue{
			ParameterID:    p.ParameterID,
			Value:          strings.TrimSpace(raw),
			SourceProtocol: a.proto,
			ObservedAt:     result.ObservedAt,
			LatencyMs:      time.Since(start).Milliseconds(),
			AdapterVersion: cliAdapterVersion,
		})
	}

	result.LatencyMs = time.Since(start).Milliseconds()
	return result
}

// Set is explicitly disabled for the P0 read-only runtime.
func (a *CLIAdapter) Set(_ context.Context, _ DeviceContext, _ ParamRef, _ string) error {
	return NewReadOnlyError("SET", a.proto)
}

// ── Internal helpers ──────────────────────────────────────────────────────────

func categorizeDialError(err error) AdapterFailureCategory {
	if err == nil {
		return ""
	}
	msg := strings.ToLower(err.Error())
	switch {
	case strings.Contains(msg, "timeout") || strings.Contains(msg, "deadline"):
		return FailureCategoryTimeout
	case strings.Contains(msg, "auth") || strings.Contains(msg, "password") || strings.Contains(msg, "denied"):
		return FailureCategoryAuthFailed
	case strings.Contains(msg, "refused") || strings.Contains(msg, "unreachable") || strings.Contains(msg, "no route"):
		return FailureCategoryUnreachable
	default:
		return FailureCategoryInternal
	}
}

// categorizeSafeMsg returns an error message safe for logging — no credential data.
func categorizeSafeMsg(err error) string {
	if err == nil {
		return ""
	}
	// Strip anything that could be a password or key from the message.
	msg := err.Error()
	if len(msg) > 120 {
		msg = msg[:120] + "…"
	}
	return msg
}
