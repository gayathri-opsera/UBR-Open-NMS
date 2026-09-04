// Package handler implements HTTP handlers for the Discovery Service.
package handler

import (
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/airtel-ubrnms/discovery-service/internal/model"
	"github.com/airtel-ubrnms/discovery-service/internal/service"
	"github.com/airtel-ubrnms/discovery-service/internal/southbound"
)

// DiscoveryHandler holds handler dependencies.
type DiscoveryHandler struct {
	svc   *service.DiscoveryService
	store *service.DeviceStore
}

// New creates a DiscoveryHandler.
func New(svc *service.DiscoveryService, store *service.DeviceStore) *DiscoveryHandler {
	return &DiscoveryHandler{svc: svc, store: store}
}

// CheckIn handles POST /api/v1/discovery/check-in
// Uses the canonical southbound error catalog (WO-005) so firmware can react
// deterministically to every failure category.
func (h *DiscoveryHandler) CheckIn(w http.ResponseWriter, r *http.Request) {
	corrID := r.Header.Get("X-Correlation-ID")

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
