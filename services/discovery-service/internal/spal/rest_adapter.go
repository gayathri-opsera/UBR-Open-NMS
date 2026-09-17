// Package spal — REST read-only adapter (WO-009).
//
// RESTAdapter implements DeviceClient for HTTP/HTTPS GET operations.
// Auth tokens and API keys are resolved via CredentialResolver and
// attached as headers — they are never logged or marshalled into results.
package spal

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"
)

const restAdapterVersion = "spal-rest/1.0"

// HTTPDoer is the minimal HTTP interface used by RESTAdapter.
// The real implementation wraps *http.Client; tests inject a fake.
type HTTPDoer interface {
	Do(req *http.Request) (*http.Response, error)
}

// RESTAdapter reads device parameters via HTTP/HTTPS GET endpoints.
// It is read-only: only GET is ever issued against the device.
type RESTAdapter struct {
	httpClient HTTPDoer
	resolver   CredentialResolver
	timeout    time.Duration
}

// NewRESTAdapter creates a RESTAdapter with the provided HTTP client and resolver.
func NewRESTAdapter(httpClient HTTPDoer, resolver CredentialResolver, timeout time.Duration) *RESTAdapter {
	if timeout <= 0 {
		timeout = 10 * time.Second
	}
	return &RESTAdapter{httpClient: httpClient, resolver: resolver, timeout: timeout}
}

func (a *RESTAdapter) Protocol() Protocol     { return ProtocolREST }
func (a *RESTAdapter) AdapterVersion() string { return restAdapterVersion }

// Ping verifies reachability by issuing an HTTP GET to the device's base URL
// (BaseURL field on DeviceContext). A 2xx or 4xx response is considered reachable
// (the device is alive); 5xx or network errors indicate failure.
func (a *RESTAdapter) Ping(ctx context.Context, device DeviceContext) PingResult {
	start := time.Now()
	result := PingResult{Protocol: ProtocolREST}

	// Resolve auth header — token goes to header only, never to result.
	authHeader, err := a.buildAuthHeader(ctx, device)
	if err != nil {
		result.Reachable = false
		result.FailureCategory = FailureCategoryCredentialResolution
		result.FailureReason = "REST credential resolution failed"
		slog.Warn("spal/rest: ping credential resolution failed", "deviceId", device.DeviceID)
		return result
	}

	if device.BaseURL == "" {
		result.Reachable = false
		result.FailureCategory = FailureCategoryInternal
		result.FailureReason = "DeviceContext.BaseURL is empty — cannot determine REST ping endpoint"
		return result
	}

	reqCtx, cancel := context.WithTimeout(ctx, a.timeout)
	defer cancel()

	req, buildErr := http.NewRequestWithContext(reqCtx, http.MethodGet, device.BaseURL, nil)
	if buildErr != nil {
		result.LatencyMs = time.Since(start).Milliseconds()
		result.Reachable = false
		result.FailureCategory = FailureCategoryInternal
		result.FailureReason = "failed to build HTTP ping request"
		return result
	}
	if authHeader != "" {
		req.Header.Set("Authorization", authHeader)
	}
	req.Header.Set("User-Agent", restAdapterVersion)

	resp, doErr := a.httpClient.Do(req)
	result.LatencyMs = time.Since(start).Milliseconds()

	if doErr != nil {
		result.Reachable = false
		result.FailureCategory = categorizeHTTPError(doErr)
		result.FailureReason = "REST GET failed: " + categorizeSafeMsg(doErr)
		return result
	}
	defer func() { _ = resp.Body.Close() }()
	_, _ = io.Copy(io.Discard, resp.Body)

	// 5xx → unreachable; 2xx/3xx/4xx → reachable (device answered).
	if resp.StatusCode >= 500 {
		result.Reachable = false
		result.FailureCategory = FailureCategoryInternal
		result.FailureReason = fmt.Sprintf("REST ping returned HTTP %d", resp.StatusCode)
		return result
	}
	result.Reachable = true
	return result
}

// Get issues HTTP GET requests to each parameter's configured REST endpoint
// (ParamRef.URLPath relative to DeviceContext.BaseURL) and returns the raw
// response body as the value.
// Parameters without a URLPath are returned as UNSUPPORTED_PARAMETER failures.
func (a *RESTAdapter) Get(ctx context.Context, device DeviceContext, params []ParamRef) GetResult {
	start := time.Now()
	result := GetResult{ActiveProtocol: ProtocolREST, ObservedAt: time.Now().UTC()}

	authHeader, err := a.buildAuthHeader(ctx, device)
	if err != nil {
		for _, p := range params {
			result.Failures = append(result.Failures, AdapterFailure{
				ParameterID:     p.ParameterID,
				Protocol:        ProtocolREST,
				FailureCategory: FailureCategoryCredentialResolution,
				FailureReason:   "REST credential resolution failed",
				Retryable:       false,
			})
		}
		return result
	}

	for _, p := range params {
		if p.URLPath == "" {
			result.Failures = append(result.Failures, AdapterFailure{
				ParameterID:     p.ParameterID,
				Protocol:        ProtocolREST,
				FailureCategory: FailureCategoryUnsupportedParam,
				FailureReason:   fmt.Sprintf("parameter %s has no URLPath configured for REST", p.ParameterID),
				Retryable:       false,
			})
			continue
		}

		url := strings.TrimRight(device.BaseURL, "/") + "/" + strings.TrimLeft(p.URLPath, "/")

		reqCtx, cancel := context.WithTimeout(ctx, a.timeout)
		req, buildErr := http.NewRequestWithContext(reqCtx, http.MethodGet, url, nil)
		if buildErr != nil {
			cancel()
			result.Failures = append(result.Failures, AdapterFailure{
				ParameterID:     p.ParameterID,
				Protocol:        ProtocolREST,
				FailureCategory: FailureCategoryInternal,
				FailureReason:   "failed to build HTTP request",
				Retryable:       false,
			})
			continue
		}
		if authHeader != "" {
			req.Header.Set("Authorization", authHeader)
		}
		req.Header.Set("User-Agent", restAdapterVersion)

		resp, doErr := a.httpClient.Do(req)
		cancel()
		if doErr != nil {
			result.Failures = append(result.Failures, AdapterFailure{
				ParameterID:     p.ParameterID,
				Protocol:        ProtocolREST,
				FailureCategory: categorizeHTTPError(doErr),
				FailureReason:   "REST GET failed: " + categorizeSafeMsg(doErr),
				Retryable:       true,
			})
			continue
		}

		body, readErr := io.ReadAll(resp.Body)
		_ = resp.Body.Close()
		if readErr != nil {
			result.Failures = append(result.Failures, AdapterFailure{
				ParameterID:     p.ParameterID,
				Protocol:        ProtocolREST,
				FailureCategory: FailureCategoryParseError,
				FailureReason:   "failed to read REST response body",
				Retryable:       false,
			})
			continue
		}
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			result.Failures = append(result.Failures, AdapterFailure{
				ParameterID:     p.ParameterID,
				Protocol:        ProtocolREST,
				FailureCategory: FailureCategoryInternal,
				FailureReason:   fmt.Sprintf("REST GET returned HTTP %d for %s", resp.StatusCode, p.ParameterID),
				Retryable:       resp.StatusCode >= 500,
			})
			continue
		}

		result.Values = append(result.Values, ReadValue{
			ParameterID:    p.ParameterID,
			Value:          strings.TrimSpace(string(body)),
			SourceProtocol: ProtocolREST,
			ObservedAt:     result.ObservedAt,
			LatencyMs:      time.Since(start).Milliseconds(),
			AdapterVersion: restAdapterVersion,
		})
	}

	result.LatencyMs = time.Since(start).Milliseconds()
	return result
}

// Set is explicitly disabled for the P0 read-only runtime.
func (a *RESTAdapter) Set(_ context.Context, _ DeviceContext, _ ParamRef, _ string) error {
	return NewReadOnlyError("PUT/POST/PATCH/DELETE", ProtocolREST)
}

// ── Internal helpers ──────────────────────────────────────────────────────────

// buildAuthHeader resolves the credential and constructs a Bearer authorization
// header without leaking secret material into logs or results.
func (a *RESTAdapter) buildAuthHeader(ctx context.Context, device DeviceContext) (string, error) {
	if device.CredentialRef == "" {
		return "", nil
	}
	cred, err := a.resolver.Resolve(ctx, device.CredentialRef)
	if err != nil {
		return "", err
	}
	// Use the password field as a Bearer token (API key or OAuth token).
	if cred.Password != "" {
		return "Bearer " + cred.Password, nil
	}
	return "", nil
}

func categorizeHTTPError(err error) AdapterFailureCategory {
	if err == nil {
		return ""
	}
	msg := strings.ToLower(err.Error())
	switch {
	case strings.Contains(msg, "timeout") || strings.Contains(msg, "deadline"):
		return FailureCategoryTimeout
	case strings.Contains(msg, "refused") || strings.Contains(msg, "no route") || strings.Contains(msg, "unreachable"):
		return FailureCategoryUnreachable
	default:
		return FailureCategoryInternal
	}
}
