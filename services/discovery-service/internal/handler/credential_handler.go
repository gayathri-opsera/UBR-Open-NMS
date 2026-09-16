// Package handler — CredentialHandler implements the SNMP credential CRUD API (WO-014).
//
// All endpoints under /api/v1/discovery/credentials are protected by an RBAC
// check on the X-User-Role header.  Only users with role "Admin" are permitted
// to create, update, or delete credentials.  GET (list/get) operations are
// permitted for authenticated users of any role but still require a non-empty role.
//
// Sensitive credential fields (community strings, auth keys, privacy keys) are
// NEVER included in any HTTP response.  All responses use SNMPCredentialSummary.
package handler

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/airtel-ubrnms/discovery-service/internal/repository"
	"github.com/airtel-ubrnms/discovery-service/internal/service"
	"github.com/airtel-ubrnms/discovery-service/internal/southbound"
)

const (
	// adminRole is the required X-User-Role value for mutating credential operations.
	adminRole = "Admin"
	// headerUserRole is the HTTP header name carrying the requestor's role.
	headerUserRole = "X-User-Role"
	// headerUserID carries the actor identity for audit events.
	headerUserID = "X-User-ID"
	// headerCorrelationID carries the correlation ID for distributed tracing.
	headerCorrelationID = "X-Correlation-ID"
)

// CredentialHandler holds dependencies for the credential CRUD API.
type CredentialHandler struct {
	svc *service.CredentialService
}

// NewCredentialHandler constructs a CredentialHandler.
func NewCredentialHandler(svc *service.CredentialService) *CredentialHandler {
	return &CredentialHandler{svc: svc}
}

// requireAdmin checks the X-User-Role header and writes a 403 if the caller is not an Admin.
// Returns false when access is denied (response already written); true when the caller may proceed.
func requireAdmin(w http.ResponseWriter, r *http.Request) bool {
	role := r.Header.Get(headerUserRole)
	if !strings.EqualFold(role, adminRole) {
		corrID := r.Header.Get(headerCorrelationID)
		southbound.Forbidden(w, "Admin role required for this operation", corrID)
		return false
	}
	return true
}

// actorID extracts the user identity from the X-User-ID header, defaulting to "system".
func actorID(r *http.Request) string {
	if id := r.Header.Get(headerUserID); id != "" {
		return id
	}
	return "system"
}

// CreateCredential handles POST /api/v1/discovery/credentials
//
//	Request:  JSON body — CreateCredentialRequest (plaintext sensitive fields)
//	Response: 201 Created — SNMPCredentialSummary (no sensitive fields)
//	          400 Bad Request  — validation error
//	          403 Forbidden    — non-Admin caller
func (h *CredentialHandler) CreateCredential(w http.ResponseWriter, r *http.Request) {
	if !requireAdmin(w, r) {
		return
	}
	corrID := r.Header.Get(headerCorrelationID)

	var req service.CreateCredentialRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		southbound.BadRequest(w, "Invalid or malformed request body", corrID)
		return
	}
	req.CreatedBy = actorID(r)
	req.CorrelationID = corrID

	summary, err := h.svc.Create(r.Context(), req)
	if err != nil {
		if isValidationError(err) {
			southbound.BadRequest(w, err.Error(), corrID)
			return
		}
		if errors.Is(err, repository.ErrDuplicateCredentialName) {
			writeCredentialError(w, http.StatusBadRequest, "DUPLICATE_NAME", err.Error())
			return
		}
		southbound.InternalError(w, corrID)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(summary) //nolint:errcheck
}

// ListCredentials handles GET /api/v1/discovery/credentials
//
//	Response: 200 OK — array of SNMPCredentialSummary
//	          403 Forbidden — unauthenticated caller (no role header)
func (h *CredentialHandler) ListCredentials(w http.ResponseWriter, r *http.Request) {
	// List is read-only but still requires a recognised user role.
	corrID := r.Header.Get(headerCorrelationID)
	if r.Header.Get(headerUserRole) == "" {
		southbound.Forbidden(w, "Authentication required", corrID)
		return
	}

	summaries, err := h.svc.List(r.Context())
	if err != nil {
		southbound.InternalError(w, corrID)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(summaries) //nolint:errcheck
}

// GetCredential handles GET /api/v1/discovery/credentials/{credentialId}
//
//	Response: 200 OK — SNMPCredentialSummary
//	          404 Not Found — no matching credential
//	          403 Forbidden — no role header
func (h *CredentialHandler) GetCredential(w http.ResponseWriter, r *http.Request) {
	corrID := r.Header.Get(headerCorrelationID)
	if r.Header.Get(headerUserRole) == "" {
		southbound.Forbidden(w, "Authentication required", corrID)
		return
	}

	id := chi.URLParam(r, "credentialId")
	summary, err := h.svc.GetByID(r.Context(), id)
	if err != nil {
		if errors.Is(err, repository.ErrCredentialNotFound) || errors.Is(err, repository.ErrInvalidCredentialID) {
			writeCredentialError(w, http.StatusNotFound, "NOT_FOUND", "Credential not found")
			return
		}
		southbound.InternalError(w, corrID)
		return
	}

	writeJSON(w, http.StatusOK, summary)
}

// UpdateCredential handles PUT /api/v1/discovery/credentials/{credentialId}
//
//	Request:  JSON body — UpdateCredentialRequest
//	Response: 200 OK — updated SNMPCredentialSummary
//	          400 Bad Request  — validation error
//	          403 Forbidden    — non-Admin caller
//	          404 Not Found    — no matching credential
func (h *CredentialHandler) UpdateCredential(w http.ResponseWriter, r *http.Request) {
	if !requireAdmin(w, r) {
		return
	}
	corrID := r.Header.Get(headerCorrelationID)

	id := chi.URLParam(r, "credentialId")

	var req service.UpdateCredentialRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		southbound.BadRequest(w, "Invalid or malformed request body", corrID)
		return
	}
	req.CorrelationID = corrID

	summary, err := h.svc.Update(r.Context(), id, req, actorID(r))
	if err != nil {
		switch {
		case isValidationError(err):
			southbound.BadRequest(w, err.Error(), corrID)
		case errors.Is(err, repository.ErrCredentialNotFound) || errors.Is(err, repository.ErrInvalidCredentialID):
			writeCredentialError(w, http.StatusNotFound, "NOT_FOUND", "Credential not found")
		case errors.Is(err, repository.ErrDuplicateCredentialName):
			writeCredentialError(w, http.StatusBadRequest, "DUPLICATE_NAME", err.Error())
		default:
			southbound.InternalError(w, corrID)
		}
		return
	}

	writeJSON(w, http.StatusOK, summary)
}

// DeleteCredential handles DELETE /api/v1/discovery/credentials/{credentialId}
//
//	Response: 204 No Content — credential soft-deleted
//	          403 Forbidden  — non-Admin caller
//	          404 Not Found  — no matching credential
func (h *CredentialHandler) DeleteCredential(w http.ResponseWriter, r *http.Request) {
	if !requireAdmin(w, r) {
		return
	}
	corrID := r.Header.Get(headerCorrelationID)
	id := chi.URLParam(r, "credentialId")

	err := h.svc.Delete(r.Context(), id, actorID(r), corrID)
	if err != nil {
		if errors.Is(err, repository.ErrCredentialNotFound) || errors.Is(err, repository.ErrInvalidCredentialID) {
			writeCredentialError(w, http.StatusNotFound, "NOT_FOUND", "Credential not found")
			return
		}
		southbound.InternalError(w, corrID)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// isValidationError returns true for known domain validation sentinel errors.
func isValidationError(err error) bool {
	return errors.Is(err, service.ErrCredentialNameRequired) ||
		errors.Is(err, service.ErrCredentialVersionRequired) ||
		errors.Is(err, service.ErrInvalidSNMPVersion) ||
		errors.Is(err, service.ErrCommunityRequired) ||
		errors.Is(err, service.ErrV3SecurityNameRequired)
}

// writeCredentialError writes a structured JSON error response.
func writeCredentialError(w http.ResponseWriter, code int, errCode, message string) {
	writeJSON(w, code, map[string]interface{}{
		"status": "error",
		"error":  map[string]string{"code": errCode, "message": message},
	})
}
