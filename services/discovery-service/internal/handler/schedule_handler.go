// Package handler — schedule handler implements the HTTP API for managing
// rediscovery schedules (WO-017).
package handler

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/airtel-ubrnms/discovery-service/internal/scheduler"
	"github.com/airtel-ubrnms/discovery-service/internal/southbound"
)

// ScheduleHandler handles HTTP requests for rediscovery schedule management.
type ScheduleHandler struct {
	sched *scheduler.RediscoveryScheduler
}

// NewScheduleHandler creates a ScheduleHandler.
func NewScheduleHandler(sched *scheduler.RediscoveryScheduler) *ScheduleHandler {
	return &ScheduleHandler{sched: sched}
}

// ── POST /api/v1/discovery/schedules ─────────────────────────────────────────

// CreateSchedule handles POST /api/v1/discovery/schedules.
// Requires admin role (enforced by RBAC middleware upstream).
func (h *ScheduleHandler) CreateSchedule(w http.ResponseWriter, r *http.Request) {
	corrID := r.Header.Get("X-Correlation-ID")

	var body struct {
		ScopeRunID     string `json:"scopeRunId"`
		CronExpression string `json:"cronExpression"`
		NotifyOnChange bool   `json:"notifyOnChange"`
		Description    string `json:"description"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		southbound.BadRequest(w, "Invalid or malformed request body", corrID)
		return
	}
	if body.ScopeRunID == "" || body.CronExpression == "" {
		southbound.BadRequest(w, "scopeRunId and cronExpression are required", corrID)
		return
	}

	actor := r.Header.Get("X-User-ID")
	if actor == "" {
		actor = "system"
	}

	sched, err := h.sched.CreateSchedule(scheduler.CreateScheduleRequest{
		ScopeRunID:     body.ScopeRunID,
		CronExpression: body.CronExpression,
		NotifyOnChange: body.NotifyOnChange,
		Description:    body.Description,
		CreatedBy:      actor,
	})
	if err != nil {
		switch {
		case isErr(err, scheduler.ErrInvalidCron):
			southbound.BadRequest(w, err.Error(), corrID)
		case isErr(err, scheduler.ErrScopeRunNotFound):
			writeError(w, http.StatusNotFound, "SCOPE_RUN_NOT_FOUND", "Scope run not found")
		default:
			southbound.InternalError(w, corrID)
		}
		return
	}

	writeJSONStatus(w, http.StatusCreated, sched)
}

// ── GET /api/v1/discovery/schedules ──────────────────────────────────────────

// ListSchedules handles GET /api/v1/discovery/schedules.
func (h *ScheduleHandler) ListSchedules(w http.ResponseWriter, r *http.Request) {
	schedules := h.sched.ListSchedules()
	writeJSONStatus(w, http.StatusOK, map[string]interface{}{
		"status":    "ok",
		"schedules": schedules,
	})
}

// ── DELETE /api/v1/discovery/schedules/{scheduleId} ───────────────────────────

// DeleteSchedule handles DELETE /api/v1/discovery/schedules/{scheduleId}.
func (h *ScheduleHandler) DeleteSchedule(w http.ResponseWriter, r *http.Request) {
	corrID := r.Header.Get("X-Correlation-ID")
	scheduleID := chi.URLParam(r, "scheduleId")
	if scheduleID == "" {
		southbound.BadRequest(w, "scheduleId path parameter is required", corrID)
		return
	}

	actor := r.Header.Get("X-User-ID")
	if actor == "" {
		actor = "system"
	}

	if err := h.sched.DeleteSchedule(scheduleID, actor); err != nil {
		if isErr(err, scheduler.ErrScheduleNotFound) {
			writeError(w, http.StatusNotFound, "SCHEDULE_NOT_FOUND", "Schedule not found")
			return
		}
		southbound.InternalError(w, corrID)
		return
	}

	writeJSONStatus(w, http.StatusOK, map[string]string{"status": "deleted"})
}

// ── POST /api/v1/discovery/schedules/{scheduleId}/run ─────────────────────────

// TriggerScheduleRun handles POST /api/v1/discovery/schedules/{scheduleId}/run.
// Triggers an immediate rediscovery run for the given schedule.
func (h *ScheduleHandler) TriggerScheduleRun(w http.ResponseWriter, r *http.Request) {
	corrID := r.Header.Get("X-Correlation-ID")
	scheduleID := chi.URLParam(r, "scheduleId")
	if scheduleID == "" {
		southbound.BadRequest(w, "scheduleId path parameter is required", corrID)
		return
	}

	actor := r.Header.Get("X-User-ID")
	if actor == "" {
		actor = "system"
	}

	entry, err := h.sched.TriggerNow(r.Context(), scheduleID, actor)
	if err != nil {
		if isErr(err, scheduler.ErrScheduleNotFound) {
			writeError(w, http.StatusNotFound, "SCHEDULE_NOT_FOUND", "Schedule not found")
			return
		}
		if isErr(err, scheduler.ErrScopeRunNotFound) {
			writeError(w, http.StatusNotFound, "SCOPE_RUN_NOT_FOUND", "Scope run no longer exists")
			return
		}
		southbound.InternalError(w, corrID)
		return
	}

	writeJSONStatus(w, http.StatusOK, entry)
}

// ── GET /api/v1/discovery/schedules/{scheduleId}/history ─────────────────────

// GetScheduleHistory handles GET /api/v1/discovery/schedules/{scheduleId}/history.
func (h *ScheduleHandler) GetScheduleHistory(w http.ResponseWriter, r *http.Request) {
	corrID := r.Header.Get("X-Correlation-ID")
	scheduleID := chi.URLParam(r, "scheduleId")
	if scheduleID == "" {
		southbound.BadRequest(w, "scheduleId path parameter is required", corrID)
		return
	}

	history := h.sched.GetHistory(scheduleID)
	writeJSONStatus(w, http.StatusOK, map[string]interface{}{
		"scheduleId": scheduleID,
		"history":    history,
	})
}

// ── Helpers ───────────────────────────────────────────────────────────────────

func writeJSONStatus(w http.ResponseWriter, code int, body interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(body) //nolint:errcheck
}

// isErr checks whether an error wraps or equals a target sentinel.
func isErr(err, target error) bool {
	if err == target {
		return true
	}
	// Check string prefix for wrapped errors
	if err != nil && target != nil {
		return len(err.Error()) >= len(target.Error()) &&
			err.Error()[:len(target.Error())] == target.Error()
	}
	return false
}
