// Package handler implements HTTP handlers for the Discovery Service.
package handler

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"time"

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

// CheckIn handles POST /api/v1/discovery/check-in
// Uses the canonical southbound error catalog (WO-005) so firmware can react
// deterministically to every failure category.
// When an HMAC Validator is attached (WO-015), the X-UBR-Signature, X-UBR-Timestamp,
// and X-UBR-Nonce headers are validated before any state mutation occurs.
func (h *DiscoveryHandler) CheckIn(w http.ResponseWriter, r *http.Request) {
	corrID := r.Header.Get("X-Correlation-ID")

	// ── WO-015: HMAC validation before any state mutation ─────────────────────
	if h.hmacValidator != nil {
		// Read the raw body bytes first so we can peek the serial number for
		// per-device secret resolution, then pass the bytes to the validator.
		rawBody, err := io.ReadAll(r.Body)
		if err != nil {
			southbound.InternalError(w, corrID)
			return
		}

		// Peek only the serial number — the full decode happens below after validation.
		var peek struct {
			SerialNumber string `json:"serialNumber"`
		}
		_ = json.Unmarshal(rawBody, &peek) // best-effort; validator handles empty serial

		if !h.hmacValidator.ValidatePreloaded(w, r, peek.SerialNumber, corrID, rawBody) {
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

	// Return 201 Created
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(response)
}
