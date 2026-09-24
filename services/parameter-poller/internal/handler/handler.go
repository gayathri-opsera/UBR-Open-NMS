// Package handler implements the HTTP handler for the framework parameter
// current-value API endpoint exposed by the parameter-poller service.
package handler

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"sort"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/airtel-ubrnms/parameter-poller/internal/model"
	"github.com/airtel-ubrnms/parameter-poller/internal/registry"
	"github.com/airtel-ubrnms/parameter-poller/internal/store"
)

// Handler serves the framework parameter current-value API.
type Handler struct {
	store    store.Store
	registry registry.Reader
	log      *slog.Logger
	clock    func() time.Time
}

// New creates a Handler.
func New(st store.Store, reg registry.Reader, log *slog.Logger) *Handler {
	return &Handler{
		store:    st,
		registry: reg,
		log:      log,
		clock:    time.Now,
	}
}

// WithClock replaces the default clock. Used in tests only.
func (h *Handler) WithClock(fn func() time.Time) *Handler {
	h.clock = fn
	return h
}

// Routes registers handler routes onto a chi router.
//
//	GET /devices/{deviceId}/parameters/current
func (h *Handler) Routes() http.Handler {
	r := chi.NewRouter()
	r.Get("/{deviceId}/parameters/current", h.getCurrentValues)
	return r
}

// getCurrentValues handles GET /devices/{deviceId}/parameters/current.
//
// Response shape (success):
//
//	{
//	  "status": "ok",
//	  "data": {
//	    "deviceId":            "<id>",
//	    "productDefinitionId": "<pd-id>",
//	    "registryVersion":     "<version>",
//	    "groups": [
//	      {
//	        "groupId":    "<group>",
//	        "label":      "<label>",
//	        "parameters": [ { ...ParameterValue } ]
//	      }
//	    ]
//	  }
//	}
//
// Error responses follow the same shape as frameworkParameters.routes.js.
func (h *Handler) getCurrentValues(w http.ResponseWriter, r *http.Request) {
	corrID := correlationID(r)
	deviceID := chi.URLParam(r, "deviceId")
	if deviceID == "" {
		h.writeError(w, http.StatusBadRequest, "INVALID_REQUEST", "deviceId path parameter is required", corrID)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	// Check whether the device has an active Product Definition.
	profile, err := h.registry.GetDeviceProfile(ctx, deviceID)
	if err != nil {
		h.log.Error("registry unavailable", slog.String("deviceID", deviceID), slog.Any("err", err))
		h.writeError(w, http.StatusServiceUnavailable, "SERVICE_UNAVAILABLE",
			"parameter registry is temporarily unavailable — please retry", corrID)
		return
	}
	if profile == nil {
		h.writeError(w, http.StatusNotFound, "DEVICE_NOT_FOUND",
			"device is not associated with any active Product Definition", corrID)
		return
	}

	values, err := h.store.GetByDevice(ctx, deviceID)
	if err != nil {
		h.log.Error("store read failed", slog.String("deviceID", deviceID), slog.Any("err", err))
		h.writeError(w, http.StatusServiceUnavailable, "SERVICE_UNAVAILABLE",
			"current-value store is temporarily unavailable — please retry", corrID)
		return
	}

	now := h.clock()
	resp := h.buildResponse(deviceID, profile, values, now)
	h.writeJSON(w, http.StatusOK, resp)
}

// buildResponse groups raw ParameterValue records into the CurrentValueResponse shape.
// It also recalculates freshness at read time so stale values are correctly classified
// even if the last poll cycle wrote FRESH.
func (h *Handler) buildResponse(
	deviceID string,
	profile *model.RegistryDeviceProfile,
	values []model.ParameterValue,
	now time.Time,
) model.CurrentValueResponse {
	// Index values by (groupID, parameterID).
	index := make(map[string]map[string]model.ParameterValue)
	for _, v := range values {
		if index[v.GroupID] == nil {
			index[v.GroupID] = make(map[string]model.ParameterValue)
		}
		// Recalculate freshness at read time.
		v.FreshnessState = store.CalculateFreshness(v, now)
		index[v.GroupID][v.ParameterID] = v
	}

	// Build ordered group list following the registry group order.
	var groups []model.ParameterGroup
	for _, regGroup := range profile.Groups {
		var params []model.ParameterValue
		for _, regParam := range regGroup.Parameters {
			if byParam, ok := index[regGroup.GroupID]; ok {
				if v, ok := byParam[regParam.ParameterID]; ok {
					params = append(params, v)
					continue
				}
			}
			// Parameter exists in registry but was never polled — return unmapped.
			params = append(params, model.ParameterValue{
				DeviceID:            deviceID,
				GroupID:             regGroup.GroupID,
				ParameterID:         regParam.ParameterID,
				Label:               regParam.Label,
				DataType:            regParam.DataType,
				Unit:                regParam.Unit,
				CollectedAt:         now,
				PollIntervalSeconds: regGroup.PollIntervalSeconds,
				FreshnessState:      model.FreshnessStateUnmapped,
				ReadStatus:          model.ParameterReadStatusUnmapped,
				FailureCategory:     model.PollFailureCategoryUnmapped,
				FailureReason:       "parameter has not been polled yet",
				RegistryVersion:     profile.RegistryVersion,
				ProductDefinitionID: profile.ProductDefinitionID,
			})
		}
		groups = append(groups, model.ParameterGroup{
			GroupID:    regGroup.GroupID,
			Label:      regGroup.Label,
			Parameters: params,
		})
	}

	// Sort groups alphabetically for deterministic API responses.
	sort.Slice(groups, func(i, j int) bool { return groups[i].GroupID < groups[j].GroupID })

	registryVersion := ""
	pdID := ""
	if profile != nil {
		registryVersion = profile.RegistryVersion
		pdID = profile.ProductDefinitionID
	}

	return model.CurrentValueResponse{
		Status: "ok",
		Data: &model.CurrentValueData{
			DeviceID:            deviceID,
			ProductDefinitionID: pdID,
			RegistryVersion:     registryVersion,
			Groups:              groups,
		},
	}
}

// writeJSON marshals v as JSON and writes it with the given status code.
func (h *Handler) writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		h.log.Error("failed to encode response", slog.Any("err", err))
	}
}

// writeError constructs a CurrentValueResponse error envelope and writes it.
func (h *Handler) writeError(w http.ResponseWriter, status int, code, message, corrID string) {
	resp := model.CurrentValueResponse{
		Status: "error",
		Error: &model.CurrentValueError{
			Code:          code,
			Message:       message,
			CorrelationID: corrID,
		},
	}
	h.writeJSON(w, status, resp)
}

// correlationID extracts the correlation ID from the request header, or generates one.
func correlationID(r *http.Request) string {
	if id := r.Header.Get("X-Correlation-Id"); id != "" {
		return id
	}
	return uuid.NewString()
}
