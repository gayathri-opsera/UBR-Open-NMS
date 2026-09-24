// Package spal — SNMP read-only adapter (WO-009).
//
// SNMPAdapter implements DeviceClient for SNMP GET operations using OIDs
// from the Parameter Registry. Community strings and v3 credentials are
// accessed only via CredentialResolver — they are never stored or logged.
package spal

import (
	"context"
	"fmt"
	"log/slog"
	"strconv"
	"strings"
	"time"
)

const snmpAdapterVersion = "spal-snmp/1.0"

// SNMPGetClient is the minimal interface for SNMP GET operations.
// The real implementation uses gosnmp; tests inject a fake.
// Credential secrets are passed to the SDK implementation by the factory;
// this interface operates on already-authenticated sessions.
type SNMPGetClient interface {
	// GetOIDs retrieves string values for the given OIDs from the target host.
	// Returns a map of OID → string value or an error.
	GetOIDs(ctx context.Context, host string, oids []string) (map[string]string, error)
}

// SNMPAdapter reads device parameters via SNMP GET.
// It is read-only by design: SET operations are not implemented.
type SNMPAdapter struct {
	client   SNMPGetClient
	resolver CredentialResolver
	timeout  time.Duration
}

// NewSNMPAdapter creates an SNMPAdapter using the provided client and resolver.
// timeout controls the per-GET request deadline; ≤0 defaults to 5 s.
func NewSNMPAdapter(client SNMPGetClient, resolver CredentialResolver, timeout time.Duration) *SNMPAdapter {
	if timeout <= 0 {
		timeout = 5 * time.Second
	}
	return &SNMPAdapter{client: client, resolver: resolver, timeout: timeout}
}

func (a *SNMPAdapter) Protocol() Protocol     { return ProtocolSNMP }
func (a *SNMPAdapter) AdapterVersion() string { return snmpAdapterVersion }

// Ping verifies SNMP reachability by reading sysObjectID (.1.3.6.1.2.1.1.2.0).
// Credential material is never included in the result.
func (a *SNMPAdapter) Ping(ctx context.Context, device DeviceContext) PingResult {
	start := time.Now()
	result := PingResult{Protocol: ProtocolSNMP}

	// Verify the credential reference is resolvable before attempting the GET.
	if _, resolveErr := a.resolver.Resolve(ctx, device.CredentialRef); resolveErr != nil {
		result.Reachable = false
		result.FailureCategory = FailureCategoryCredentialResolution
		result.FailureReason = "SNMP credential resolution failed"
		slog.Warn("spal/snmp: ping credential resolution failed",
			"deviceId", device.DeviceID, "correlationId", device.CorrelationID)
		return result
	}

	dialCtx, cancel := context.WithTimeout(ctx, a.timeout)
	defer cancel()

	vals, err := a.client.GetOIDs(dialCtx, device.IPAddress, []string{".1.3.6.1.2.1.1.2.0"})
	result.LatencyMs = time.Since(start).Milliseconds()

	if err != nil {
		result.Reachable = false
		result.FailureCategory = categorizeSNMPError(err)
		result.FailureReason = categorizeSNMPErrorMsg(err)
		return result
	}
	if vals[".1.3.6.1.2.1.1.2.0"] == "" {
		result.Reachable = false
		result.FailureCategory = FailureCategoryParseError
		result.FailureReason = "SNMP sysObjectID GET returned empty response"
		return result
	}
	result.Reachable = true
	return result
}

// Get reads the requested parameters via SNMP GET.
// Each ParamRef must have a non-empty OID; parameters without OIDs are
// returned as UNSUPPORTED_PARAMETER failures.
func (a *SNMPAdapter) Get(ctx context.Context, device DeviceContext, params []ParamRef) GetResult {
	start := time.Now()
	result := GetResult{ActiveProtocol: ProtocolSNMP, ObservedAt: time.Now().UTC()}

	// Verify the credential reference is resolvable — fail closed if not.
	if _, resolveErr := a.resolver.Resolve(ctx, device.CredentialRef); resolveErr != nil {
		for _, p := range params {
			result.Failures = append(result.Failures, AdapterFailure{
				ParameterID:     p.ParameterID,
				Protocol:        ProtocolSNMP,
				FailureCategory: FailureCategoryCredentialResolution,
				FailureReason:   "SNMP credential resolution failed — cannot read parameters",
				Retryable:       false,
			})
		}
		slog.Warn("spal/snmp: get credential resolution failed",
			"deviceId", device.DeviceID, "correlationId", device.CorrelationID)
		return result
	}

	// Split params into OID-capable and unsupported.
	oids := make([]string, 0, len(params))
	oidToParam := make(map[string]ParamRef, len(params))
	for _, p := range params {
		if p.OID == "" {
			result.Failures = append(result.Failures, AdapterFailure{
				ParameterID:     p.ParameterID,
				Protocol:        ProtocolSNMP,
				FailureCategory: FailureCategoryUnsupportedParam,
				FailureReason:   fmt.Sprintf("parameter %s has no OID configured for SNMP", p.ParameterID),
				Retryable:       false,
			})
			continue
		}
		oids = append(oids, p.OID)
		oidToParam[p.OID] = p
	}

	if len(oids) == 0 {
		result.LatencyMs = time.Since(start).Milliseconds()
		return result
	}

	dialCtx, cancel := context.WithTimeout(ctx, a.timeout)
	defer cancel()

	vals, getErr := a.client.GetOIDs(dialCtx, device.IPAddress, oids)
	result.LatencyMs = time.Since(start).Milliseconds()

	if getErr != nil {
		cat := categorizeSNMPError(getErr)
		msg := categorizeSNMPErrorMsg(getErr)
		retryable := cat == FailureCategoryTimeout
		for _, p := range oidToParam {
			result.Failures = append(result.Failures, AdapterFailure{
				ParameterID:     p.ParameterID,
				Protocol:        ProtocolSNMP,
				FailureCategory: cat,
				FailureReason:   msg,
				Retryable:       retryable,
			})
		}
		return result
	}

	for oid, p := range oidToParam {
		raw, ok := vals[oid]
		if !ok || raw == "" {
			result.Failures = append(result.Failures, AdapterFailure{
				ParameterID:     p.ParameterID,
				Protocol:        ProtocolSNMP,
				FailureCategory: FailureCategoryParseError,
				FailureReason:   fmt.Sprintf("OID %s returned empty value", oid),
				Retryable:       false,
			})
			continue
		}
		rv := ReadValue{
			ParameterID:    p.ParameterID,
			Value:          raw,
			SourceProtocol: ProtocolSNMP,
			ObservedAt:     result.ObservedAt,
			LatencyMs:      result.LatencyMs,
			AdapterVersion: snmpAdapterVersion,
		}
		// Attempt numeric conversion so callers can skip string parsing.
		if f, parseErr := strconv.ParseFloat(strings.TrimSpace(raw), 64); parseErr == nil {
			rv.ValueNumeric = f
			rv.NumericValid = true
		}
		result.Values = append(result.Values, rv)
	}

	return result
}

// Set is explicitly disabled for the P0 read-only runtime.
// Calling this method will always return ErrReadOnly.
func (a *SNMPAdapter) Set(_ context.Context, _ DeviceContext, _ ParamRef, _ string) error {
	return NewReadOnlyError("SET", ProtocolSNMP)
}

// ── Internal helpers ──────────────────────────────────────────────────────────

func categorizeSNMPError(err error) AdapterFailureCategory {
	if err == nil {
		return ""
	}
	msg := strings.ToLower(err.Error())
	switch {
	case strings.Contains(msg, "timeout") || strings.Contains(msg, "deadline"):
		return FailureCategoryTimeout
	case strings.Contains(msg, "auth") || strings.Contains(msg, "community") || strings.Contains(msg, "credential"):
		return FailureCategoryAuthFailed
	default:
		return FailureCategoryInternal
	}
}

func categorizeSNMPErrorMsg(err error) string {
	switch categorizeSNMPError(err) {
	case FailureCategoryTimeout:
		return "SNMP GET timed out"
	case FailureCategoryAuthFailed:
		return "SNMP authentication failed — check credential reference"
	default:
		return "SNMP GET failed"
	}
}
