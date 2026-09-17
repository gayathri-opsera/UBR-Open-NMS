// Package alarm provides a client for sending framework threshold evaluation
// requests to the alarm service from the parameter poller.
//
// The client is intentionally minimal for the P0 release: it posts a
// FrameworkThresholdEvaluationRequest JSON payload to the alarm-service HTTP
// endpoint and logs the outcome. Production deployments may replace this with
// a Kafka-based publisher to decouple the poller from the alarm service.
//
// Security: credential material is never included in alarm payloads.
// The client only forwards the correlation ID, device identifier, parameter ID,
// value, and threshold bounds — all from the parameter store record.
package alarm

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"time"
)

// ThresholdEvaluationRequest matches the FrameworkThresholdEvaluationRequest
// DTO in the alarm service. Only safe, non-credential fields are included.
type ThresholdEvaluationRequest struct {
	DeviceID            string     `json:"deviceId"`
	DeviceType          string     `json:"deviceType"`
	ProductDefinitionID string     `json:"productDefinitionId"`
	RegistryVersion     string     `json:"registryVersion"`
	GroupID             string     `json:"groupId"`
	ParameterID         string     `json:"parameterId"`
	ValueNumeric        float64    `json:"valueNumeric"`
	CollectedAt         time.Time  `json:"collectedAt"`
	ThresholdHigh       *float64   `json:"thresholdHigh,omitempty"`
	ThresholdLow        *float64   `json:"thresholdLow,omitempty"`
	CorrelationID       string     `json:"correlationId"`
}

// Client submits threshold evaluation requests to the alarm service.
// It is safe for concurrent use.
type Client struct {
	baseURL    string
	httpClient *http.Client
	log        *slog.Logger
}

// NewClient creates a new alarm service HTTP client.
// baseURL should point to the alarm-service base URL (e.g. "http://alarm-service:8084").
func NewClient(baseURL string, log *slog.Logger) *Client {
	return &Client{
		baseURL: baseURL,
		httpClient: &http.Client{
			Timeout: 10 * time.Second,
		},
		log: log,
	}
}

// EvaluateThreshold posts a threshold evaluation request to the alarm service.
// It returns nil when the request is delivered successfully (whether or not a
// threshold alarm was raised — the alarm service decides that).
//
// Non-2xx responses are treated as delivery failures and are logged; the poller
// continues with the next parameter rather than failing the entire poll cycle.
func (c *Client) EvaluateThreshold(ctx context.Context, req ThresholdEvaluationRequest) error {
	// Skip evaluation when both thresholds are nil — no metadata configured.
	if req.ThresholdHigh == nil && req.ThresholdLow == nil {
		return nil
	}

	body, err := json.Marshal(req)
	if err != nil {
		return fmt.Errorf("marshal threshold request: %w", err)
	}

	url := c.baseURL + "/api/v1/alarms/framework-threshold/evaluate"
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("build alarm request: %w", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("X-Correlation-Id", req.CorrelationID)

	resp, err := c.httpClient.Do(httpReq)
	if err != nil {
		c.log.Warn("alarm service unreachable",
			slog.String("deviceID", req.DeviceID),
			slog.String("parameterId", req.ParameterID),
			slog.String("correlationId", req.CorrelationID),
			slog.Any("err", err),
		)
		// Non-fatal: threshold evaluation failure does not stop polling.
		return nil
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, resp.Body)

	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		c.log.Debug("threshold evaluation delivered",
			slog.String("deviceID", req.DeviceID),
			slog.String("parameterId", req.ParameterID),
			slog.Int("status", resp.StatusCode),
		)
		return nil
	}

	// Non-2xx: log and continue — alarm service may be temporarily degraded.
	c.log.Warn("alarm service returned non-2xx",
		slog.String("deviceID", req.DeviceID),
		slog.String("parameterId", req.ParameterID),
		slog.Int("status", resp.StatusCode),
	)
	return nil
}

// NoOpClient is an alarm client that silently discards all requests.
// Used in local development and tests when no alarm service is running.
type NoOpClient struct{}

// EvaluateThreshold implements Client for NoOpClient — always returns nil.
func (n *NoOpClient) EvaluateThreshold(_ context.Context, _ ThresholdEvaluationRequest) error {
	return nil
}
