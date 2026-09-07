// Package service — GenericRegistrationService wires fingerprint results,
// classification, and remote inventory upsert together (WO-030).
//
// Pipeline:
//   SNMPFingerprintResult → Classify → Build payload → POST /inventory/devices/generic
//   → Publish GenericDeviceClassifiedEvent (classification.results)
//   → Publish GenericInventoryRegisteredEvent (inventory.device.registered)
//
// Inventory publication failure is logged and surfaced in the result; it is
// retryable (not silently swallowed). Classification failure yields a
// DEFERRED_UNSUPPORTED result — no managed device is created.
package service

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"time"

	"github.com/airtel-ubrnms/discovery-service/internal/classifier"
	"github.com/airtel-ubrnms/discovery-service/internal/model"
	sharedmodels "github.com/airtel-ubrnms/shared-libs/go/models"
	"github.com/google/uuid"
)

// InventoryRegistrar abstracts the remote inventory-service upsert operation.
// The real implementation posts to /api/v1/inventory/devices/generic.
// Tests inject a fake.
type InventoryRegistrar interface {
	UpsertGenericDevice(ctx context.Context, payload classifier.RegistrationPayload) (inventoryDeviceID string, err error)
}

// ClassificationPublisher abstracts Kafka publication for classification events (WO-030).
type ClassificationPublisher interface {
	PublishClassificationResult(sharedmodels.GenericDeviceClassifiedEvent) error
	PublishInventoryRegistered(sharedmodels.GenericInventoryRegisteredEvent) error
}

// RegistrationResult is the combined outcome of a single fingerprint-to-registration run.
type RegistrationResult struct {
	IP                   string
	CorrelationID        string
	ClassificationStatus classifier.ClassificationStatus
	RegistrationStatus   string // REGISTERED | DEFERRED | ERROR
	InventoryDeviceID    string
	DeferReason          string
	Vendor               string
	Model                string
	GenericDeviceType    string
	CapabilityProfileID  string
	DriverID             string
	EventPublishErr      error // non-nil when Kafka publication failed; device was still registered
}

// GenericRegistrationService processes fingerprint results and registers
// recognised generic devices in inventory (WO-030).
type GenericRegistrationService struct {
	registrar InventoryRegistrar
	publisher ClassificationPublisher
}

// NewGenericRegistrationService constructs a GenericRegistrationService.
func NewGenericRegistrationService(r InventoryRegistrar, pub ClassificationPublisher) *GenericRegistrationService {
	return &GenericRegistrationService{registrar: r, publisher: pub}
}

// Register classifies a fingerprint result and, if recognised, registers the device
// in inventory. It always publishes classification and registration events for
// observability, even for deferred devices.
func (s *GenericRegistrationService) Register(ctx context.Context, fp model.SNMPFingerprintResult, runID string) RegistrationResult {
	correlationID := fp.CorrelationID
	if correlationID == "" {
		correlationID = uuid.NewString()
	}

	cl := classifier.Classify(fp, correlationID)

	result := RegistrationResult{
		IP:                   fp.IP,
		CorrelationID:        correlationID,
		ClassificationStatus: cl.Status,
		DeferReason:          cl.DeferReason,
		Vendor:               cl.Vendor,
		Model:                cl.Model,
		GenericDeviceType:    cl.GenericDeviceType,
		CapabilityProfileID:  cl.CapabilityProfileID,
		DriverID:             cl.DriverID,
	}

	// Publish classification event regardless of outcome.
	classifiedEvt := buildClassifiedEvent(fp, cl, correlationID, runID)
	if err := s.publisher.PublishClassificationResult(classifiedEvt); err != nil {
		slog.Warn("WO-030: failed to publish classification event",
			"correlationId", correlationID, "err", err)
		result.EventPublishErr = err
	}

	if cl.Status != classifier.ClassificationRecognised {
		result.RegistrationStatus = "DEFERRED"
		s.publishInventoryRegistered(result, runID, "")
		return result
	}

	// Build merged payload and upsert into inventory.
	payload := classifier.MergeRegistrationPayload(fp, cl, "")
	inventoryDeviceID, err := s.registrar.UpsertGenericDevice(ctx, payload)
	if err != nil {
		slog.Error("WO-030: inventory upsert failed — device not registered",
			"ip", "[redacted]", "correlationId", correlationID, "err", err)
		result.RegistrationStatus = "ERROR"
		result.DeferReason = "INVENTORY_UPSERT_FAILED"
		s.publishInventoryRegistered(result, runID, "")
		return result
	}

	result.InventoryDeviceID = inventoryDeviceID
	result.RegistrationStatus = "REGISTERED"

	slog.Info("WO-030: generic device registered",
		"inventoryDeviceId", inventoryDeviceID,
		"genericDeviceType", cl.GenericDeviceType,
		"vendor", cl.Vendor,
		"correlationId", correlationID)

	s.publishInventoryRegistered(result, runID, inventoryDeviceID)
	return result
}

func (s *GenericRegistrationService) publishInventoryRegistered(r RegistrationResult, runID, inventoryDeviceID string) {
	evt := sharedmodels.GenericInventoryRegisteredEvent{
		EventID:              uuid.NewString(),
		RunID:                runID,
		InventoryDeviceID:    inventoryDeviceID,
		IP:                   r.IP,
		CorrelationID:        r.CorrelationID,
		RegistrationStatus:   r.RegistrationStatus,
		ClassificationStatus: string(r.ClassificationStatus),
		DeferReason:          r.DeferReason,
		Vendor:               r.Vendor,
		Model:                r.Model,
		GenericDeviceType:    r.GenericDeviceType,
		CapabilityProfileID:  r.CapabilityProfileID,
		DriverID:             r.DriverID,
		DiscoveryParadigm:    "GENERIC_SNMP",
		IdentityAuthority:    "GENERIC",
		OnlineStateAuthority: "GENERIC",
		Timestamp:            time.Now().UTC(),
	}
	if err := s.publisher.PublishInventoryRegistered(evt); err != nil {
		slog.Warn("WO-030: failed to publish inventory-registered event",
			"correlationId", r.CorrelationID, "err", err)
	}
}

func buildClassifiedEvent(
	fp model.SNMPFingerprintResult,
	cl classifier.ClassificationResult,
	correlationID, runID string,
) sharedmodels.GenericDeviceClassifiedEvent {
	return sharedmodels.GenericDeviceClassifiedEvent{
		EventID:              uuid.NewString(),
		RunID:                runID,
		IP:                   fp.IP,
		CorrelationID:        correlationID,
		ClassificationStatus: string(cl.Status),
		DeferReason:          cl.DeferReason,
		Vendor:               cl.Vendor,
		Model:                cl.Model,
		GenericDeviceType:    cl.GenericDeviceType,
		CapabilityProfileID:  cl.CapabilityProfileID,
		DriverID:             cl.DriverID,
		SysObjectID:          fp.SysObjectID,
		SysDescr:             fp.SysDescr,
		DiscoveryParadigm:    "GENERIC_SNMP",
		IdentityAuthority:    "GENERIC",
		OnlineStateAuthority: "GENERIC",
		Timestamp:            time.Now().UTC(),
	}
}

// ── HTTP-backed InventoryRegistrar ───────────────────────────────────────────

// HTTPInventoryRegistrar posts classified device payloads to the inventory-service
// REST API (/api/v1/inventory/devices/generic) and returns the assigned deviceId.
type HTTPInventoryRegistrar struct {
	baseURL    string
	httpClient *http.Client
}

// NewHTTPInventoryRegistrar constructs a registrar pointing at inventoryBaseURL.
func NewHTTPInventoryRegistrar(inventoryBaseURL string, timeout time.Duration) *HTTPInventoryRegistrar {
	return &HTTPInventoryRegistrar{
		baseURL: inventoryBaseURL,
		httpClient: &http.Client{
			Timeout: timeout,
		},
	}
}

// UpsertGenericDevice posts the payload to the inventory service and returns the device ID.
func (r *HTTPInventoryRegistrar) UpsertGenericDevice(ctx context.Context, payload classifier.RegistrationPayload) (string, error) {
	body, err := json.Marshal(payload)
	if err != nil {
		return "", fmt.Errorf("marshal error: %w", err)
	}

	url := r.baseURL + "/api/v1/inventory/devices/generic"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return "", fmt.Errorf("request creation error: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := r.httpClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("http post error: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusOK || resp.StatusCode == http.StatusCreated {
		var out struct {
			DeviceID string `json:"deviceId"`
			ID       string `json:"id"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
			return "", fmt.Errorf("response decode error: %w", err)
		}
		if out.DeviceID != "" {
			return out.DeviceID, nil
		}
		return out.ID, nil
	}

	errBody, _ := io.ReadAll(resp.Body)
	return "", fmt.Errorf("inventory service returned %d: %s", resp.StatusCode, sanitiseInventoryError(errBody))
}

// sanitiseInventoryError strips any credential material from inventory error responses.
func sanitiseInventoryError(body []byte) string {
	if len(body) == 0 {
		return "(empty body)"
	}
	if len(body) > 256 {
		body = body[:256]
	}
	return string(body)
}
