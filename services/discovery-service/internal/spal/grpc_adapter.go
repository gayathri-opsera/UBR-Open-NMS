// Package spal — gRPC read-only adapter (WO-009).
//
// GRPCAdapter implements DeviceClient using a gRPC GenericClient for
// device telemetry reads. Credentials are resolved via CredentialResolver
// and injected as per-RPC metadata — they are never logged or stored.
package spal

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"time"
)

const grpcAdapterVersion = "spal-grpc/1.0"

// GRPCGenericClient is the minimal interface for reading device state via gRPC.
// The real implementation wraps a generated gRPC stub; tests inject a fake.
type GRPCGenericClient interface {
	// HealthCheck verifies that the device's gRPC endpoint is reachable.
	// Returns (latencyMs, error).
	HealthCheck(ctx context.Context, host string, token string) (int64, error)
	// GetParameter retrieves a single named parameter from the device.
	// Returns the raw string value or an error.
	GetParameter(ctx context.Context, host string, paramName string, token string) (string, error)
}

// GRPCAdapter reads device parameters via gRPC.
// It is read-only by design.
type GRPCAdapter struct {
	client   GRPCGenericClient
	resolver CredentialResolver
	timeout  time.Duration
}

// NewGRPCAdapter creates a GRPCAdapter with the given gRPC client and credential resolver.
func NewGRPCAdapter(client GRPCGenericClient, resolver CredentialResolver, timeout time.Duration) *GRPCAdapter {
	if timeout <= 0 {
		timeout = 10 * time.Second
	}
	return &GRPCAdapter{client: client, resolver: resolver, timeout: timeout}
}

func (a *GRPCAdapter) Protocol() Protocol     { return ProtocolGRPC }
func (a *GRPCAdapter) AdapterVersion() string { return grpcAdapterVersion }

// Ping verifies gRPC health using the standard Health service.
// Credential material is never included in the result.
func (a *GRPCAdapter) Ping(ctx context.Context, device DeviceContext) PingResult {
	start := time.Now()
	result := PingResult{Protocol: ProtocolGRPC}

	token, err := a.resolveToken(ctx, device)
	if err != nil {
		result.Reachable = false
		result.FailureCategory = FailureCategoryCredentialResolution
		result.FailureReason = "gRPC credential resolution failed"
		slog.Warn("spal/grpc: ping credential resolution failed",
			"deviceId", device.DeviceID)
		return result
	}

	reqCtx, cancel := context.WithTimeout(ctx, a.timeout)
	defer cancel()

	latencyMs, err := a.client.HealthCheck(reqCtx, device.IPAddress, token)
	result.LatencyMs = latencyMs
	if result.LatencyMs == 0 {
		result.LatencyMs = time.Since(start).Milliseconds()
	}

	if err != nil {
		result.Reachable = false
		result.FailureCategory = categorizeGRPCError(err)
		result.FailureReason = "gRPC health check failed"
		return result
	}

	result.Reachable = true
	return result
}

// Get retrieves device parameters via gRPC using the parameter name as the key.
// Parameters without a ParameterID are returned as UNSUPPORTED_PARAMETER failures.
func (a *GRPCAdapter) Get(ctx context.Context, device DeviceContext, params []ParamRef) GetResult {
	start := time.Now()
	result := GetResult{ActiveProtocol: ProtocolGRPC, ObservedAt: time.Now().UTC()}

	token, err := a.resolveToken(ctx, device)
	if err != nil {
		for _, p := range params {
			result.Failures = append(result.Failures, AdapterFailure{
				ParameterID:     p.ParameterID,
				Protocol:        ProtocolGRPC,
				FailureCategory: FailureCategoryCredentialResolution,
				FailureReason:   "gRPC credential resolution failed",
				Retryable:       false,
			})
		}
		return result
	}

	for _, p := range params {
		if p.ParameterID == "" {
			result.Failures = append(result.Failures, AdapterFailure{
				ParameterID:     p.ParameterID,
				Protocol:        ProtocolGRPC,
				FailureCategory: FailureCategoryUnsupportedParam,
				FailureReason:   "parameter has no ParameterID configured",
				Retryable:       false,
			})
			continue
		}

		reqCtx, cancel := context.WithTimeout(ctx, a.timeout)
		raw, getErr := a.client.GetParameter(reqCtx, device.IPAddress, p.ParameterID, token)
		cancel()

		if getErr != nil {
			cat := categorizeGRPCError(getErr)
			result.Failures = append(result.Failures, AdapterFailure{
				ParameterID:     p.ParameterID,
				Protocol:        ProtocolGRPC,
				FailureCategory: cat,
				FailureReason:   fmt.Sprintf("gRPC GetParameter failed for %s", p.ParameterID),
				Retryable:       cat == FailureCategoryTimeout,
			})
			continue
		}

		result.Values = append(result.Values, ReadValue{
			ParameterID:    p.ParameterID,
			Value:          strings.TrimSpace(raw),
			SourceProtocol: ProtocolGRPC,
			ObservedAt:     result.ObservedAt,
			LatencyMs:      time.Since(start).Milliseconds(),
			AdapterVersion: grpcAdapterVersion,
		})
	}

	result.LatencyMs = time.Since(start).Milliseconds()
	return result
}

// Set is explicitly disabled for the P0 read-only runtime.
func (a *GRPCAdapter) Set(_ context.Context, _ DeviceContext, _ ParamRef, _ string) error {
	return NewReadOnlyError("RPC write", ProtocolGRPC)
}

// ── Internal helpers ──────────────────────────────────────────────────────────

func (a *GRPCAdapter) resolveToken(ctx context.Context, device DeviceContext) (string, error) {
	if device.CredentialRef == "" {
		return "", nil
	}
	cred, err := a.resolver.Resolve(ctx, device.CredentialRef)
	if err != nil {
		return "", err
	}
	// Use the password field as a Bearer token for gRPC metadata injection.
	return cred.Password, nil
}

func categorizeGRPCError(err error) AdapterFailureCategory {
	if err == nil {
		return ""
	}
	msg := strings.ToLower(err.Error())
	switch {
	case strings.Contains(msg, "deadline") || strings.Contains(msg, "timeout"):
		return FailureCategoryTimeout
	case strings.Contains(msg, "unauthenticated") || strings.Contains(msg, "permission denied"):
		return FailureCategoryAuthFailed
	case strings.Contains(msg, "unavailable") || strings.Contains(msg, "no route") || strings.Contains(msg, "refused"):
		return FailureCategoryUnreachable
	default:
		return FailureCategoryInternal
	}
}
