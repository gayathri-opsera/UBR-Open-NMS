// Package handler implements HTTP handlers for the Discovery Service.
package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/airtel-ubrnms/discovery-service/internal/auth"
	"github.com/airtel-ubrnms/discovery-service/internal/model"
	"github.com/airtel-ubrnms/discovery-service/internal/fingerprint"
	"github.com/airtel-ubrnms/discovery-service/internal/service"
	"github.com/airtel-ubrnms/discovery-service/internal/southbound"
)

// DiscoveryHandler holds handler dependencies.
type DiscoveryHandler struct {
	svc           *service.DiscoveryService
	store         *service.DeviceStore
	runStore      *service.DiscoveryRunStore  // WO-011
	runExecutor   *service.RunExecutor        // async ICMP/SNMP pipeline
	hmacValidator *auth.Validator             // WO-015: nil disables HMAC validation (dev/test)
	matcher       *fingerprint.Matcher        // WO-010: nil disables fingerprint matching
}

// New creates a DiscoveryHandler.
func New(svc *service.DiscoveryService, store *service.DeviceStore, runStore *service.DiscoveryRunStore) *DiscoveryHandler {
	return &DiscoveryHandler{svc: svc, store: store, runStore: runStore}
}

// WithHMACValidator attaches an HMAC Validator to the handler (WO-015).
// When set, CheckIn and other signed southbound endpoints require valid HMAC headers.
func (h *DiscoveryHandler) WithHMACValidator(v *auth.Validator) *DiscoveryHandler {
	h.hmacValidator = v
	return h
}

// WithRunExecutor wires async discovery run execution after create.
func (h *DiscoveryHandler) WithRunExecutor(e *service.RunExecutor) *DiscoveryHandler {
	h.runExecutor = e
	return h
}

// WithMatcher attaches a FingerprintMatcher (WO-010).
// When set, discovery run results are enriched with framework identity fields
// by matching probe evidence against the active Product Definition registry.
func (h *DiscoveryHandler) WithMatcher(m *fingerprint.Matcher) *DiscoveryHandler {
	h.matcher = m
	return h
}

// applyFingerprintMatch enriches a DiscoveryHostResult with the framework identity
// fields resolved by the FingerprintMatcher for this host. It is a no-op when the
// matcher is not configured. The host result is mutated in-place.
func (h *DiscoveryHandler) applyFingerprintMatch(ctx context.Context, result *model.DiscoveryHostResult, runID, correlationID string) {
	if h.matcher == nil {
		return
	}
	// Build credential-free evidence from the already-collected fingerprint fields.
	ev := fingerprint.ProbeEvidence{
		IP:                 result.IP,
		RunID:              runID,
		CorrelationID:      correlationID,
		SNMPOIDSysObjectID: result.SysObjectID,
		SNMPSysDescr:       result.SysDescr,
		// SSH banner, HTTP headers/body, and gRPC services are populated by the
		// probe orchestrator when non-SNMP probes are enabled (WO-008 future).
	}
	mr := h.matcher.Match(ctx, ev)
	if mr == nil {
		return
	}

	result.FingerprintStatus = string(mr.Status)
	switch mr.Status {
	case fingerprint.FingerprintStatusMatched:
		result.ProductDefinitionID = mr.ProductDefinitionID
		result.ProductDefinitionVersion = mr.ProductDefinitionVersion
		result.RegistryVersion = mr.RegistryVersion
		result.ActiveAdapterCandidate = mr.ActiveAdapterCandidate
		result.MatchConfidence = mr.MatchConfidence
		result.MatchEvidence = mr.MatchEvidence
	case fingerprint.FingerprintStatusConflict:
		result.FingerprintConflictReason = mr.ConflictReason
		result.RegistryVersion = mr.RegistryVersion
	case fingerprint.FingerprintStatusVersionMismatch:
		result.RegistryVersion = mr.RegistryVersion
		result.FingerprintConflictReason = fmt.Sprintf("firmware %q is outside the range accepted by %s", mr.FirmwareVersion, mr.VersionMismatchEntry)
	case fingerprint.FingerprintStatusRegistryUnavailable:
		// Registry read failed — leave other fields empty; callers can retry.
	}
}

// CheckIn handles POST /api/v1/discovery/check-in
// Uses the canonical southbound error catalog (WO-005) so firmware can react
// deterministically to every failure category.
// When an HMAC Validator is attached (WO-015), the Auth-Info and Auth-Signature
// headers are validated before any state mutation occurs.  The device identity
// (MAC address) is extracted from the Auth-Info id= field by the validator and
// returned for downstream correlation.
func (h *DiscoveryHandler) CheckIn(w http.ResponseWriter, r *http.Request) {
	corrID := r.Header.Get("X-Correlation-ID")

	// ── WO-015: HMAC validation before any state mutation ─────────────────────
	if h.hmacValidator != nil {
		// Read the raw body bytes so ValidatePreloaded can check the HMAC.
		// Device identity now comes from the Auth-Info header — no serial peek needed.
		rawBody, err := io.ReadAll(r.Body)
		if err != nil {
			southbound.InternalError(w, corrID)
			return
		}

		_, ok := h.hmacValidator.ValidatePreloaded(w, r, corrID, rawBody)
		if !ok {
			return // error already written by validator; body rewound on success only
		}
		// r.Body has been rewound to rawBody by ValidatePreloaded; the decode below reads it normally.
	}

	var req model.CheckInRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		southbound.BadRequest(w, "Invalid or malformed request body", corrID)
		return
	}
	if req.Timestamp.IsZero() {
		req.Timestamp = time.Now().UTC()
	}

	device, err := h.svc.ProcessCheckIn(&req)
	if err != nil {
		if errors.Is(err, service.ErrInvalidSignature) {
			// HMAC validation failure: 462, no retry headers, no signature in message
			southbound.HMACInvalid(w, corrID)
			return
		}
		if errors.Is(err, service.ErrMissingFields) {
			southbound.BadRequest(w, err.Error(), corrID)
			return
		}
		// Unexpected internal fault: 500, no secrets, no stack traces
		southbound.InternalError(w, corrID)
		return
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"status":              "accepted",
		"checkInIntervalSecs": device.CheckInInterval,
		"eventId":             device.EventID,
	})
}

// LookupBySerial handles GET /api/v1/discovery/devices?serial=XXX
func (h *DiscoveryHandler) LookupBySerial(w http.ResponseWriter, r *http.Request) {
	serial := r.URL.Query().Get("serial")
	if serial == "" {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "serial query param required")
		return
	}
	d, ok := h.store.FindBySerial(serial)
	if !ok {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "Device not found")
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"status": "ok", "device": d})
}

// LookupByMAC handles GET /api/v1/discovery/devices?mac=XXX
func (h *DiscoveryHandler) LookupByMAC(w http.ResponseWriter, r *http.Request) {
	mac := r.URL.Query().Get("mac")
	if mac == "" {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "mac query param required")
		return
	}
	d, ok := h.store.FindByMAC(mac)
	if !ok {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "Device not found")
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"status": "ok", "device": d})
}

// LookupByIP handles GET /api/v1/discovery/devices?ip=XXX
func (h *DiscoveryHandler) LookupByIP(w http.ResponseWriter, r *http.Request) {
	ip := r.URL.Query().Get("ip")
	if ip == "" {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "ip query param required")
		return
	}
	d, ok := h.store.FindByIP(ip)
	if !ok {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "Device not found")
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"status": "ok", "device": d})
}

// Lookup dispatches device lookup by serial, mac, or ip query param
func (h *DiscoveryHandler) Lookup(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	switch {
	case q.Get("serial") != "":
		h.LookupBySerial(w, r)
	case q.Get("mac") != "":
		h.LookupByMAC(w, r)
	case q.Get("ip") != "":
		h.LookupByIP(w, r)
	default:
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "Provide serial, mac, or ip query param")
	}
}

// TriggerScan handles POST /api/v1/discovery/scan
func (h *DiscoveryHandler) TriggerScan(w http.ResponseWriter, r *http.Request) {
	corrID := r.Header.Get("X-Correlation-ID")

	var req model.ScanRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		southbound.BadRequest(w, "Invalid scan request body", corrID)
		return
	}
	if req.IPRange == "" {
		southbound.BadRequest(w, "ipRange is required", corrID)
		return
	}
	// Scanning is async — return 202 Accepted immediately
	writeJSON(w, http.StatusAccepted, map[string]string{
		"status":  "scanning",
		"ipRange": req.IPRange,
		"message": "Network scan initiated asynchronously",
	})
}

// ServiceRegistry handles GET /discovery/v1/kv/services?recurse=1 (WO-009).
// Returns Consul-style KV entries for UBR call-home device bootstrap.
func (h *DiscoveryHandler) ServiceRegistry(w http.ResponseWriter, r *http.Request) {
	corrID := r.Header.Get("X-Correlation-ID")

	// Validate recurse=1 query parameter (exact firmware contract requirement)
	recurse := r.URL.Query().Get("recurse")
	if recurse != "1" {
		southbound.BadRequest(w, "recurse=1 query parameter is required", corrID)
		return
	}

	// Build service registry
	entries, err := h.svc.BuildServiceRegistry()
	if err != nil {
		if errors.Is(err, service.ErrServiceUnavailable) {
			// Service registry configuration incomplete: 503
			southbound.ServiceUnavailable(w, "Service registry configuration is incomplete.", corrID, southbound.DefaultRetryConfig)
			return
		}
		// Unexpected internal fault: 500
		southbound.InternalError(w, corrID)
		return
	}

	// Return Consul-style KV array
	writeJSON(w, http.StatusOK, entries)
}

// AuthenticateDevice handles POST /auth/v1/device (WO-010).
// Issues per-device HMAC secrets for authorized UBR call-home devices.
func (h *DiscoveryHandler) AuthenticateDevice(w http.ResponseWriter, r *http.Request) {
	corrID := r.Header.Get("X-Correlation-ID")

	var req model.DeviceAuthRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		southbound.BadRequest(w, "Invalid or malformed request body", corrID)
		return
	}

	// Authenticate device and issue secret
	response, err := h.svc.AuthenticateDevice(&req)
	if err != nil {
		if errors.Is(err, service.ErrDeviceNotFound) {
			// Device not found or not authorized: 404
			writeError(w, http.StatusNotFound, "DEVICE_NOT_FOUND", "Device not found or not authorized")
			return
		}
		if errors.Is(err, service.ErrSecretStoreUnavailable) {
			// Secret store unavailable: 503
			southbound.ServiceUnavailable(w, "Authentication service temporarily unavailable.", corrID, southbound.DefaultRetryConfig)
			return
		}
		if errors.Is(err, service.ErrMissingFields) || err.Error() == "invalid MAC address format: must be XX:XX:XX:XX:XX:XX" || err.Error() == "invalid serial number format: must be 8-32 alphanumeric characters" {
			// Validation error: 400
			southbound.BadRequest(w, err.Error(), corrID)
			return
		}
		// Unexpected internal fault: 500
		southbound.InternalError(w, corrID)
		return
	}

	// Return authentication response
	writeJSON(w, http.StatusOK, response)
}

func writeJSON(w http.ResponseWriter, code int, body interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(body) //nolint:errcheck
}

// writeError is kept for backward compatibility with lookup handlers.
// New handlers should use the southbound package helpers directly.
func writeError(w http.ResponseWriter, code int, errCode, message string) {
	writeJSON(w, code, map[string]interface{}{
		"status": "error",
		"error":  map[string]string{"code": errCode, "message": message},
	})
}

// GetOnboardingStates handles GET /api/v1/discovery/onboarding (WO-026).
// Returns bootstrap state summaries for all call-home-capable devices that have
// attempted onboarding. Sensitive authentication material is never included.
// Query params:
//   - limit  (int, optional, default 100)
//   - page   (int, optional, default 0)
//   - state  (string, optional) filter by bootstrapState value
func (h *DiscoveryHandler) GetOnboardingStates(w http.ResponseWriter, r *http.Request) {
	corrID := r.Header.Get("X-Correlation-ID")

	// Parse optional filter params
	stateFilter := r.URL.Query().Get("state")

	// Build onboarding states from the in-memory device store.
	// Production: this would query the inventory service, not the in-memory store.
	devices := h.store.All()
	items := make([]model.DeviceOnboardingState, 0, len(devices))

	for _, d := range devices {
		bState := d.BootstrapState
		if bState == "" {
			bState = model.BootstrapStatePending
		}
		if stateFilter != "" && bState != stateFilter {
			continue
		}
		item := model.DeviceOnboardingState{
			DeviceID:          d.SerialNumber, // serial as stable identifier for in-memory store
			SerialNumber:      d.SerialNumber,
			MACAddress:        d.MACAddress,
			DeviceType:        d.DeviceType,
			BootstrapState:    bState,
			OperationalStatus: d.OperationalStatus,
			FailureReason:     d.FailureReason,
			LastCheckInAt:     d.LastCheckInAt,
			LastRealtimeAt:    d.LastRealtimeAt,
		}
		if !d.DiscoveredAt.IsZero() {
			t := d.DiscoveredAt
			item.UpdatedAt = &t
		}
		items = append(items, item)
	}

	resp := model.OnboardingStatesResponse{
		Items:  items,
		Total:  len(items),
		Source: "discovery",
	}

	_ = corrID
	writeJSON(w, http.StatusOK, resp)
}

// ListDiscoveryRuns handles GET /api/v1/discovery/runs (WO-003).
// Returns a paginated, optionally status-filtered list of past and ongoing discovery runs.
//
// Query parameters:
//   - page   (int, optional, 1-indexed, default 1) — page number; out-of-range returns empty data
//   - limit  (int, optional, default 20, max 200)  — items per page
//   - status (string, optional)                    — filter by run status (e.g. COMPLETED, RUNNING, FAILED)
func (h *DiscoveryHandler) ListDiscoveryRuns(w http.ResponseWriter, r *http.Request) {
	corrID := r.Header.Get("X-Correlation-ID")

	q := r.URL.Query()

	// Parse page — must be a positive integer.
	page := 1
	if raw := q.Get("page"); raw != "" {
		v, err := strconv.Atoi(raw)
		if err != nil || v < 1 {
			southbound.BadRequest(w, "page must be a positive integer", corrID)
			return
		}
		page = v
	}

	// Parse limit — must be a positive integer.
	limit := 20
	if raw := q.Get("limit"); raw != "" {
		v, err := strconv.Atoi(raw)
		if err != nil || v < 1 {
			southbound.BadRequest(w, "limit must be a positive integer", corrID)
			return
		}
		limit = v
	}

	status := q.Get("status")

	result := h.runStore.ListRuns(service.ListRunsParams{
		Page:   page,
		Limit:  limit,
		Status: status,
	})

	summaries := make([]model.DiscoveryRunSummary, len(result.Data))
	for i, r := range result.Data {
		summaries[i] = service.ToRunSummary(r)
	}

	writeJSON(w, http.StatusOK, model.PaginatedRunsResponse{
		Data: summaries,
		Pagination: model.PaginationMeta{
			Total: result.Pagination.Total,
			Page:  result.Pagination.Page,
			Limit: result.Pagination.Limit,
		},
	})
}

// GetDiscoveryRun handles GET /api/v1/discovery/runs/{runId}.
func (h *DiscoveryHandler) GetDiscoveryRun(w http.ResponseWriter, r *http.Request) {
	runID := chi.URLParam(r, "runId")
	if runID == "" {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "runId path parameter is required")
		return
	}

	run, ok := h.runStore.Get(runID)
	if !ok {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "Discovery run not found")
		return
	}

	writeJSON(w, http.StatusOK, service.ToRunDetail(run))
}

// GetDiscoveryRunResults handles GET /api/v1/discovery/runs/{runId}/results.
func (h *DiscoveryHandler) GetDiscoveryRunResults(w http.ResponseWriter, r *http.Request) {
	runID := chi.URLParam(r, "runId")
	if runID == "" {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "runId path parameter is required")
		return
	}

	run, ok := h.runStore.Get(runID)
	if !ok {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "Discovery run not found")
		return
	}

	results := run.Results
	if results == nil {
		results = []model.DiscoveryHostResult{}
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"results": results})
}

// CreateDiscoveryRun handles POST /api/v1/discovery/runs (WO-011).
// Creates a validated discovery run from operator-provided scope.
func (h *DiscoveryHandler) CreateDiscoveryRun(w http.ResponseWriter, r *http.Request) {
	corrID := r.Header.Get("X-Correlation-ID")

	// Extract user identity from context/header (simplified for this implementation)
	createdBy := r.Header.Get("X-User-ID")
	if createdBy == "" {
		createdBy = "system" // Fallback
	}

	var req model.DiscoveryRunRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		southbound.BadRequest(w, "Invalid or malformed request body", corrID)
		return
	}

	// Create discovery run
	response, fieldErrors, err := h.svc.CreateDiscoveryRun(&req, createdBy, h.runStore)
	if err != nil {
		if errors.Is(err, service.ErrInvalidScope) || errors.Is(err, service.ErrScopeTooLarge) {
			// Validation error: 400
			validationErr := model.ScopeValidationError{
				Status:      "error",
				Reason:      "VALIDATION_ERROR",
				Message:     err.Error(),
				FieldErrors: fieldErrors,
			}
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusBadRequest)
			json.NewEncoder(w).Encode(validationErr)
			return
		}
		// WO-008: event-driven duplicate suppression — return existing run ID as 409 Conflict.
		if errors.Is(err, service.ErrDuplicateInFlightTarget) {
			writeJSON(w, http.StatusConflict, map[string]interface{}{
				"status": "error",
				"error": map[string]interface{}{
					"code":          "DUPLICATE_IN_FLIGHT_TARGET",
					"message":       "A discovery run is already in progress for one or more targets in this scope. Use the existing run ID.",
					"correlationId": corrID,
				},
			})
			return
		}
		// Unexpected internal fault: 500
		southbound.InternalError(w, corrID)
		return
	}

	// Kick off async execution (ICMP sweep + result aggregation).
	if h.runExecutor != nil {
		h.runExecutor.Start(response.RunID)
	}

	// Return 201 Created
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(response)
}

// ProvisionDiscoveredHosts handles POST /api/v1/discovery/runs/{runId}/provision.
//
// An admin calls this endpoint after reviewing discovery results to provision one
// or more discovered hosts as fully-managed devices in the inventory-service.
//
// Each host in the request is forwarded to the inventory-service via HTTP
// (INVENTORY_SERVICE_URL env var, defaulting to http://inventory-service:8082).
// The endpoint returns per-host provisioning results including the assigned deviceId.
func (h *DiscoveryHandler) ProvisionDiscoveredHosts(w http.ResponseWriter, r *http.Request) {
	corrID := r.Header.Get("X-Correlation-ID")

	runID := chi.URLParam(r, "runId")
	if runID == "" {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "runId path parameter is required")
		return
	}

	// Verify the discovery run exists (provision must follow a completed run).
	run, ok := h.runStore.Get(runID)
	if !ok {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "Discovery run not found")
		return
	}
	_ = run // run metadata available for future audit enrichment

	var req model.ProvisionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		southbound.BadRequest(w, "Invalid or malformed request body", corrID)
		return
	}

	if len(req.Hosts) == 0 {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "hosts array must not be empty")
		return
	}

	inventoryURL := os.Getenv("INVENTORY_SERVICE_URL")
	if inventoryURL == "" {
		inventoryURL = "http://inventory-service:8082"
	}

	httpClient := &http.Client{Timeout: 15 * time.Second}
	results := make([]model.ProvisionHostResult, 0, len(req.Hosts))
	provisioned, failed := 0, 0

	for _, host := range req.Hosts {
		result := provisionOneHost(httpClient, inventoryURL, runID, host)
		results = append(results, result)
		if result.Status == "provisioned" {
			provisioned++
		} else {
			failed++
		}
	}

	resp := model.ProvisionResponse{
		Results:     results,
		Provisioned: provisioned,
		Failed:      failed,
	}

	status := http.StatusOK
	if provisioned == 0 && failed > 0 {
		status = http.StatusBadGateway
	}

	writeJSON(w, status, resp)
}

// provisionOneHost attempts to create a single device in the inventory-service via HTTP.
// Returns a ProvisionHostResult describing the outcome (never panics).
func provisionOneHost(client *http.Client, inventoryURL, runID string, host model.ProvisionHost) model.ProvisionHostResult {
	result := model.ProvisionHostResult{
		IP:           host.IP,
		SerialNumber: host.SerialNumber,
		Status:       "failed",
	}

	payload := buildInventoryPayload(host)

	body, err := json.Marshal(payload)
	if err != nil {
		result.Error = fmt.Sprintf("failed to marshal inventory payload: %v", err)
		slog.Warn("provision: marshal error", "ip", host.IP, "err", err)
		return result
	}

	// Inventory-service exposes devices at /api/v1/devices (Spring Boot REST convention)
	url := inventoryURL + "/api/v1/devices"
	httpReq, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		result.Error = fmt.Sprintf("failed to build inventory request: %v", err)
		return result
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("X-Source", "discovery-service")
	httpReq.Header.Set("X-Discovery-Run-ID", runID)

	resp, err := client.Do(httpReq)
	if err != nil {
		result.Error = fmt.Sprintf("inventory-service unreachable: %v", err)
		slog.Error("provision: inventory call failed", "ip", host.IP, "err", err)
		return result
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusConflict {
		result.Error = "device with this serial number already exists in inventory"
		return result
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		result.Error = fmt.Sprintf("inventory-service returned HTTP %d", resp.StatusCode)
		slog.Warn("provision: non-2xx from inventory", "ip", host.IP, "status", resp.StatusCode)
		return result
	}

	// Parse response to extract the assigned deviceId.
	var created model.InventoryCreateResponse
	if decErr := json.NewDecoder(resp.Body).Decode(&created); decErr != nil {
		// Device was created (2xx) but we couldn't parse the ID — still success.
		result.Status = "provisioned"
		result.DeviceID = "unknown"
		slog.Warn("provision: could not parse inventory response", "ip", host.IP, "err", decErr)
		return result
	}

	deviceID := created.DeviceID
	if deviceID == "" {
		deviceID = created.ID
	}

	result.Status = "provisioned"
	result.DeviceID = deviceID
	slog.Info("provision: device created in inventory", "ip", host.IP, "deviceId", deviceID)
	return result
}

// buildInventoryPayload maps a ProvisionHost to the JSON payload expected by
// the inventory-service POST /devices endpoint.
func buildInventoryPayload(host model.ProvisionHost) map[string]interface{} {
	payload := map[string]interface{}{
		"deviceType":        host.DeviceType,
		"serialNumber":      host.SerialNumber,
		"macAddress":        host.MACAddress,
		"ipAddress":         host.IP,
		"manufacturer":      host.Vendor,
		"model":             host.Model,
		"firmwareVersion":   "Unknown",
		"status":            "ONLINE",
		"discoveryParadigm": "SNMP",
	}

	if host.NetworkID != "" {
		payload["networkId"] = host.NetworkID
	}
	if host.SysObjectID != "" {
		payload["sysObjectID"] = host.SysObjectID
	}
	if host.SysDescr != "" {
		payload["sysDescr"] = host.SysDescr
	}
	// GPS location: required for the topology map to place the device at the correct position.
	// When lat/lng are supplied, the inventory-service stores them as a GeoJSON Point.
	if host.Latitude != 0 || host.Longitude != 0 {
		payload["latitude"] = host.Latitude
		payload["longitude"] = host.Longitude
	}

	return payload
}
