// Package handler — UBR check-in payload processor (WO-021).
//
// After HMAC validation, this processor:
//   1. Validates the check-in payload (device type, required fields, idempotency)
//   2. Maps fields to the inventory-service upsert contract
//   3. Transitions bootstrapState PENDING → CHECK_IN_RECEIVED
//   4. Compares reported config version against current version
//   5. Publishes a Kafka event for downstream consumers
//   6. Returns a deterministic NO_CHANGE | CONFIG_AVAILABLE | ASSIGNMENT_REQUIRED response
//
// Call-home is authoritative for identity and online-state fields — this processor
// must not overwrite those with data from generic discovery sources.
package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/airtel-ubrnms/discovery-service/internal/model"
	"github.com/airtel-ubrnms/discovery-service/internal/southbound"
)

// InventoryClient abstracts calls to the inventory-service.
// The production implementation uses HTTP; tests inject a fake.
type InventoryClient interface {
	// UpsertCheckIn sends a device check-in upsert to inventory-service.
	// Returns the assigned deviceId and current config version.
	UpsertCheckIn(ctx context.Context, req *CheckInUpsertRequest) (*CheckInUpsertResponse, error)
}

// CheckInPublisher abstracts Kafka event publication.
type CheckInPublisher interface {
	PublishCheckInEvent(ctx context.Context, event CheckInKafkaEvent) error
}

// CheckInUpsertRequest is the payload sent to inventory-service PUT /api/v1/devices/{serial}/checkin.
type CheckInUpsertRequest struct {
	SerialNumber        string    `json:"serialNumber"`
	MACAddress          string    `json:"macAddress"`
	ManagementIP        string    `json:"managementIp"`
	DeviceType          string    `json:"deviceType"`
	FirmwareVersion     string    `json:"firmwareVersion,omitempty"`
	SoftwareVersion     string    `json:"softwareVersion,omitempty"`
	OperationalStatus   string    `json:"operationalStatus,omitempty"`
	Latitude            *float64  `json:"latitude,omitempty"`
	Longitude           *float64  `json:"longitude,omitempty"`
	Azimuth             *float64  `json:"azimuth,omitempty"`
	UptimeSeconds       int64     `json:"uptimeSeconds"`
	CapabilityProfileID string    `json:"capabilityProfileId,omitempty"`
	ConfigVersion       string    `json:"configVersion,omitempty"`
	BootstrapState      string    `json:"bootstrapState"`
	LastCheckInAt       time.Time `json:"lastCheckInAt"`
	IdentityAuthority   string    `json:"identityAuthority"`   // always "call-home"
	DiscoveryParadigm   string    `json:"discoveryParadigm"`   // always "call-home"
}

// CheckInUpsertResponse is the inventory-service response.
type CheckInUpsertResponse struct {
	DeviceID             string `json:"deviceId"`
	Assigned             bool   `json:"assigned"`
	CurrentConfigVersion string `json:"currentConfigVersion"`
	PendingCommand       string `json:"pendingCommand,omitempty"`
}

// CheckInKafkaEvent is published on each successful check-in (WO-021).
type CheckInKafkaEvent struct {
	EventID             string    `json:"eventId"`
	CorrelationID       string    `json:"correlationId"`
	SerialNumber        string    `json:"serialNumber"`
	DeviceID            string    `json:"deviceId"`
	BootstrapState      string    `json:"bootstrapState"`
	ConfigAction        string    `json:"configAction"`
	Timestamp           time.Time `json:"timestamp"`
	SourceService       string    `json:"sourceService"`
}

// CheckInProcessor handles post-HMAC UBR check-in processing.
type CheckInProcessor struct {
	inventory   InventoryClient
	publisher   CheckInPublisher
	checkInSecs int
}

// NewCheckInProcessor constructs a CheckInProcessor.
func NewCheckInProcessor(inventory InventoryClient, publisher CheckInPublisher, checkInSecs int) *CheckInProcessor {
	return &CheckInProcessor{
		inventory:   inventory,
		publisher:   publisher,
		checkInSecs: checkInSecs,
	}
}

// Process validates and persists a check-in payload, returning the HTTP response body.
// It must only be called after HMAC validation has succeeded.
func (p *CheckInProcessor) Process(ctx context.Context, w http.ResponseWriter, req *model.CheckInRequest, corrID string) {
	// Validate device type — only BTS, CPE, IDU are accepted for call-home (WO-021)
	if !model.SupportedDeviceTypes[strings.ToUpper(req.DeviceType)] {
		southbound.BadRequest(w, fmt.Sprintf("deviceType %q is not supported for call-home check-in", req.DeviceType), corrID)
		return
	}

	// Validate required identity fields
	if req.SerialNumber == "" || req.MACAddress == "" {
		southbound.BadRequest(w, "serialNumber and macAddress are required", corrID)
		return
	}

	now := time.Now().UTC()
	upsertReq := buildUpsertRequest(req, now)

	// Call inventory-service to upsert the device state
	upsertResp, err := p.inventory.UpsertCheckIn(ctx, &upsertReq)
	if err != nil {
		if isRetryable(err) {
			slog.Warn("inventory upsert retryable failure", "serial", req.SerialNumber, "error", err)
			w.Header().Set("Retry-After", "30")
			southbound.ServiceUnavailable(w, "Inventory service temporarily unavailable", corrID, southbound.DefaultRetryConfig)
			return
		}
		slog.Error("inventory upsert failed", "serial", req.SerialNumber, "error", err)
		southbound.InternalError(w, corrID)
		return
	}

	// Determine config action
	configAction := determineConfigAction(req.ConfigVersion, upsertResp)

	// Publish Kafka event (non-blocking — failure is logged but does not fail the check-in)
	go func() {
		ev := CheckInKafkaEvent{
			EventID:        uuid.New().String(),
			CorrelationID:  corrID,
			SerialNumber:   req.SerialNumber,
			DeviceID:       upsertResp.DeviceID,
			BootstrapState: model.BootstrapStateCheckInReceived,
			ConfigAction:   configAction,
			Timestamp:      now,
			SourceService:  "discovery-service",
		}
		if pubErr := p.publisher.PublishCheckInEvent(context.Background(), ev); pubErr != nil {
			slog.Warn("check-in Kafka publish failed", "serial", req.SerialNumber, "error", pubErr)
		}
	}()

	// Build response
	resp := model.CheckInResponse{
		Result:              "accepted",
		DeviceID:            upsertResp.DeviceID,
		CurrentConfigVersion: upsertResp.CurrentConfigVersion,
		ConfigAction:        configAction,
		CheckInIntervalSecs: p.checkInSecs,
		EventID:             uuid.New().String(),
	}
	if upsertResp.PendingCommand != "" {
		resp.PendingCommand = &upsertResp.PendingCommand
	}

	slog.Info("check-in processed",
		"serial", req.SerialNumber,
		"deviceId", upsertResp.DeviceID,
		"configAction", configAction,
		"corrID", corrID)

	writeJSON(w, http.StatusOK, resp)
}

// ── Helpers ────────────────────────────────────────────────────────────────────

func buildUpsertRequest(req *model.CheckInRequest, now time.Time) CheckInUpsertRequest {
	upsert := CheckInUpsertRequest{
		SerialNumber:      req.SerialNumber,
		MACAddress:        req.MACAddress,
		ManagementIP:      req.IPAddress,
		DeviceType:        strings.ToUpper(req.DeviceType),
		FirmwareVersion:   req.FirmwareVersion,
		SoftwareVersion:   req.SoftwareVersion,
		OperationalStatus: req.OperationalStatus,
		UptimeSeconds:     req.UptimeSeconds,
		CapabilityProfileID: req.CapabilityProfileID,
		ConfigVersion:     req.ConfigVersion,
		BootstrapState:    model.BootstrapStateCheckInReceived,
		LastCheckInAt:     now,
		IdentityAuthority: "call-home",
		DiscoveryParadigm: "call-home",
	}

	// GPS and azimuth: record only when non-zero (zero values indicate pending commissioning)
	if req.Latitude != 0 || req.Longitude != 0 {
		lat, lon := req.Latitude, req.Longitude
		upsert.Latitude = &lat
		upsert.Longitude = &lon
	}
	if req.Azimuth != 0 {
		az := req.Azimuth
		upsert.Azimuth = &az
	}

	return upsert
}

// determineConfigAction decides which action the device should take based on config version.
func determineConfigAction(reportedVersion string, resp *CheckInUpsertResponse) string {
	if !resp.Assigned {
		return "ASSIGNMENT_REQUIRED"
	}
	if resp.CurrentConfigVersion == "" || reportedVersion == resp.CurrentConfigVersion {
		return "NO_CHANGE"
	}
	return "CONFIG_AVAILABLE"
}

// isRetryable classifies an inventory error as transient (network, timeout).
func isRetryable(err error) bool {
	if err == nil {
		return false
	}
	msg := err.Error()
	return strings.Contains(msg, "connection refused") ||
		strings.Contains(msg, "timeout") ||
		strings.Contains(msg, "503") ||
		strings.Contains(msg, "temporarily unavailable")
}

// ── HTTP inventory client ──────────────────────────────────────────────────────

// HTTPInventoryClient sends check-in upserts to inventory-service via HTTP.
type HTTPInventoryClient struct {
	BaseURL    string
	HTTPClient *http.Client
}

func NewHTTPInventoryClient(baseURL string) *HTTPInventoryClient {
	return &HTTPInventoryClient{
		BaseURL: strings.TrimSuffix(baseURL, "/"),
		HTTPClient: &http.Client{Timeout: 10 * time.Second},
	}
}

func (c *HTTPInventoryClient) UpsertCheckIn(ctx context.Context, req *CheckInUpsertRequest) (*CheckInUpsertResponse, error) {
	body, err := json.Marshal(req)
	if err != nil {
		return nil, fmt.Errorf("marshal upsert request: %w", err)
	}

	url := fmt.Sprintf("%s/api/v1/devices/%s/checkin", c.BaseURL, req.SerialNumber)
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPut, url, bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("build inventory request: %w", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")

	resp, err := c.HTTPClient.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("inventory request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNotFound {
		// Unknown device — return a synthetic unassigned response
		return &CheckInUpsertResponse{DeviceID: req.SerialNumber, Assigned: false}, nil
	}

	if resp.StatusCode >= 500 {
		return nil, fmt.Errorf("inventory service error: %d", resp.StatusCode)
	}

	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("read inventory response: %w", err)
	}

	var upsertResp CheckInUpsertResponse
	if err := json.Unmarshal(data, &upsertResp); err != nil {
		return nil, fmt.Errorf("decode inventory response: %w", err)
	}
	return &upsertResp, nil
}
