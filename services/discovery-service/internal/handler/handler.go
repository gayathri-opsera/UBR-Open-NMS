// Package handler implements HTTP handlers for the Discovery Service.
package handler

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/airtel-ubrnms/discovery-service/internal/auth"
	"github.com/airtel-ubrnms/discovery-service/internal/model"
	"github.com/airtel-ubrnms/discovery-service/internal/service"
	"github.com/airtel-ubrnms/discovery-service/internal/southbound"
)

// DiscoveryHandler holds handler dependencies.
type DiscoveryHandler struct {
	svc           *service.DiscoveryService
	store         *service.DeviceStore
	runStore      *service.DiscoveryRunStore // WO-011
	runExecutor   *service.RunExecutor       // async ICMP/SNMP pipeline
	hmacValidator *auth.Validator            // WO-015: nil disables HMAC validation (dev/test)
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
