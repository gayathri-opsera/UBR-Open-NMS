// Package southbound provides the canonical error catalog and response builder for
// the UBR NMS discovery service southbound interface (WO-005).
//
// Error categories:
//   - auth_failure  (462, 495, 496) — NO retry headers; never log secrets or signatures
//   - retryable     (429, 503)      — Retry-After + X-Retry-Jitter-Max headers
//   - redirect      (302)           — Location header pointing to alternate NMS endpoint
//   - client_error  (400)
//   - server_error  (500)
//
// SECURITY: Callers must never pass credential values, HMAC signatures, private keys,
// or certificate data into any field of a response body or log entry.
package southbound

import (
	"encoding/json"
	"fmt"
	"net/http"
	"time"
	"strconv"
)

// ── HTTP status codes for UBR protocol-specific errors ───────────────────────

const (
	// StatusMTLSCertInvalid is returned when the client's mTLS certificate is invalid or revoked.
	StatusMTLSCertInvalid = 495

	// StatusMTLSNoCert is returned when no mTLS client certificate was presented.
	StatusMTLSNoCert = 496

	// StatusHMACInvalid is returned when HMAC-SHA256 message integrity verification fails.
	// Auth failure — no retry headers.
	StatusHMACInvalid = 462
)

// ── Reason constants ──────────────────────────────────────────────────────────

const (
	ReasonBadRequest     = "BAD_REQUEST"
	ReasonMTLSCertInvalid = "MTLS_CERT_INVALID"
	ReasonMTLSNoCert     = "MTLS_NO_CERT"
	ReasonHMACInvalid    = "HMAC_INVALID"
	ReasonRateLimited    = "RATE_LIMITED"        // HTTP 429
	ReasonNMSFailover    = "NMS_FAILOVER"        // HTTP 302 + Location header
	ReasonInternalError  = "INTERNAL_ERROR"      // HTTP 500
	ReasonServiceUnavail = "SERVICE_UNAVAILABLE" // HTTP 503
)

// ── Error category constants ──────────────────────────────────────────────────

const (
	CategoryAuthFailure = "auth_failure"  // 462, 495, 496 — no retry hints
	CategoryRetryable   = "retryable"     // 429, 503
	CategoryRedirect    = "redirect"      // 302
	CategoryClientError = "client_error"  // 400
	CategoryServerError = "server_error"  // 500
)

// Aliases for backwards compatibility with package-level constants referenced in other files.
const (
	CategoryAuth = CategoryAuthFailure
)

// ── Action constants (WO-029) ─────────────────────────────────────────────────

// Action constants tell firmware what to do after receiving an error response.
const (
	ActionFixRequest       = "fix_request"          // BAD_REQUEST — client must correct the payload
	ActionReAuthenticate   = "re_authenticate"       // HMAC/mTLS failures — device must re-enroll
	ActionRetryWithBackoff = "retry_with_backoff"    // RATE_LIMITED, SERVICE_UNAVAILABLE — retry after Retry-After
	ActionConnectAlternate = "connect_to_alternate"  // NMS_FAILOVER — connect to Location header endpoint
	ActionContactSupport   = "contact_support"       // INTERNAL_ERROR — escalate to NMS support
)

// ── Response body shape ───────────────────────────────────────────────────────

// ErrorBody is the canonical southbound error response body.
// Shape: { reason, category, action, message, correlationId, timestamp }
// All five fields are always present; firmware relies on them for routing decisions.
type ErrorBody struct {
	Reason        string `json:"reason"`
	Category      string `json:"category"`
	Action        string `json:"action"`
	Message       string `json:"message"`
	CorrelationID string `json:"correlationId"`
	Timestamp     string `json:"timestamp"`
}

// ActionForReason derives the recommended device action from a reason string.
func ActionForReason(reason string) string {
	switch reason {
	case ReasonBadRequest:
		return ActionFixRequest
	case ReasonHMACInvalid, ReasonMTLSCertInvalid, ReasonMTLSNoCert:
		return ActionReAuthenticate
	case ReasonRateLimited, ReasonServiceUnavail:
		return ActionRetryWithBackoff
	case ReasonNMSFailover:
		return ActionConnectAlternate
	default:
		return ActionContactSupport
	}
}

// ── Configuration types ───────────────────────────────────────────────────────

// RetryConfig carries the retry hint values for retryable errors.
type RetryConfig struct {
	// RetryAfterSecs is the number of seconds the client should wait before retrying.
	RetryAfterSecs int
	// JitterMaxSecs is the maximum jitter the client should add to the retry delay.
	JitterMaxSecs int
}

// DefaultRetryConfig is the default retry config used when no custom values are specified.
// Per WO-029 spec: Retry-After 15 s, X-Retry-Jitter-Max 30 s.
var DefaultRetryConfig = RetryConfig{
	RetryAfterSecs: 15,
	JitterMaxSecs:  30,
}

// FailoverConfig carries the failover redirect parameters.
type FailoverConfig struct {
	// Location is the URI of the alternate NMS discovery endpoint.
	// If empty, WriteFailoverError falls back to a 500 INTERNAL_ERROR response.
	Location string
}

// ── Low-level response builders ───────────────────────────────────────────────

// WriteError writes a standardised southbound error body with the given status, reason,
// category, message, and correlationId. This is the lowest-level builder; prefer the
// typed helpers below for common cases. The action field is derived from the reason.
//
// SECURITY: caller must never pass credentials, secrets, or signatures in any argument.
func WriteError(w http.ResponseWriter, status int, reason, category, message, correlationID string) {
	body := ErrorBody{
		Reason:        reason,
		Category:      category,
		Action:        ActionForReason(reason),
		Message:       message,
		CorrelationID: correlationID,
		Timestamp:     time.Now().UTC().Format(time.RFC3339),
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

// WriteRetryableError writes a retryable error response with Retry-After and X-Retry-Jitter-Max headers.
func WriteRetryableError(w http.ResponseWriter, status int, reason, message, correlationID string, cfg RetryConfig) {
	if cfg.RetryAfterSecs > 0 {
		w.Header().Set("Retry-After", itoa(cfg.RetryAfterSecs))
		w.Header().Set("X-Retry-Jitter-Max", itoa(cfg.JitterMaxSecs))
	}
	WriteError(w, status, reason, CategoryRetryable, message, correlationID)
}

// WriteFailoverError writes a 302 NMS_FAILOVER redirect response with a Location header.
// If cfg.Location is empty, falls back to a 500 INTERNAL_ERROR (safe default — never redirect to nowhere).
func WriteFailoverError(w http.ResponseWriter, correlationID string, cfg FailoverConfig) {
	if cfg.Location == "" {
		WriteError(w, http.StatusInternalServerError, ReasonInternalError, CategoryServerError,
			"NMS failover requested but no alternate endpoint is configured.", correlationID)
		return
	}
	w.Header().Set("Location", cfg.Location)
	WriteError(w, http.StatusFound, ReasonNMSFailover, CategoryRedirect,
		"This NMS instance is failing over. Connect to the alternate endpoint indicated by the Location header.",
		correlationID)
}

// ── Typed helper functions ────────────────────────────────────────────────────

// BadRequest writes a 400 BAD_REQUEST response. No retry headers.
func BadRequest(w http.ResponseWriter, message, correlationID string) {
	WriteError(w, http.StatusBadRequest, ReasonBadRequest, CategoryClientError, message, correlationID)
}

// HMACInvalid writes a 462 HMAC_INVALID response. Auth failure — no retry headers.
// SECURITY: the message is static; no HMAC values, secrets, or keys must appear.
func HMACInvalid(w http.ResponseWriter, correlationID string) {
	WriteError(w, StatusHMACInvalid, ReasonHMACInvalid, CategoryAuthFailure,
		"HMAC-SHA256 message integrity check failed. Device must re-enrol to obtain a new credential.",
		correlationID)
}

// MTLSCertInvalid writes a 495 MTLS_CERT_INVALID response. Auth failure — no retry headers.
func MTLSCertInvalid(w http.ResponseWriter, correlationID string) {
	WriteError(w, StatusMTLSCertInvalid, ReasonMTLSCertInvalid, CategoryAuthFailure,
		"The client mTLS certificate is invalid or has been revoked.",
		correlationID)
}

// MTLSNoCert writes a 496 MTLS_NO_CERT response. Auth failure — no retry headers.
func MTLSNoCert(w http.ResponseWriter, correlationID string) {
	WriteError(w, StatusMTLSNoCert, ReasonMTLSNoCert, CategoryAuthFailure,
		"No mTLS client certificate was presented. A valid certificate is required.",
		correlationID)
}

// RateLimited writes a 429 RATE_LIMITED response with Retry-After and X-Retry-Jitter-Max headers.
func RateLimited(w http.ResponseWriter, message, correlationID string, cfg RetryConfig) {
	WriteRetryableError(w, http.StatusTooManyRequests, ReasonRateLimited, message, correlationID, cfg)
}

// ServiceUnavailable writes a 503 SERVICE_UNAVAILABLE response with retry headers.
func ServiceUnavailable(w http.ResponseWriter, message, correlationID string, cfg RetryConfig) {
	WriteRetryableError(w, http.StatusServiceUnavailable, ReasonServiceUnavail, message, correlationID, cfg)
}

// InternalError writes a 500 INTERNAL_ERROR response.
// SECURITY: the message is static — no stack traces, SQL errors, or internal paths are included.
func InternalError(w http.ResponseWriter, correlationID string) {
	WriteError(w, http.StatusInternalServerError, ReasonInternalError, CategoryServerError,
		"An internal error occurred. Contact NMS support if the issue persists.",
		correlationID)
}

// Forbidden writes a 403 FORBIDDEN response. Used for RBAC authorization failures
// (e.g., a non-Admin caller attempting to mutate credentials). No retry headers.
func Forbidden(w http.ResponseWriter, message, correlationID string) {
	WriteError(w, http.StatusForbidden, "FORBIDDEN", CategoryAuthFailure, message, correlationID)
}

// ── Utility helpers ───────────────────────────────────────────────────────────

// LookupStatus returns the HTTP status code for a given reason string.
// Returns 500 for unknown reasons (fail closed).
func LookupStatus(reason string) int {
	switch reason {
	case ReasonBadRequest:
		return http.StatusBadRequest
	case ReasonHMACInvalid:
		return StatusHMACInvalid
	case ReasonMTLSCertInvalid:
		return StatusMTLSCertInvalid
	case ReasonMTLSNoCert:
		return StatusMTLSNoCert
	case ReasonRateLimited:
		return http.StatusTooManyRequests
	case ReasonNMSFailover:
		return http.StatusFound
	case ReasonInternalError:
		return http.StatusInternalServerError
	case ReasonServiceUnavail:
		return http.StatusServiceUnavailable
	default:
		return http.StatusInternalServerError
	}
}

// LookupCategory returns the error category for a given reason string.
func LookupCategory(reason string) string {
	switch reason {
	case ReasonHMACInvalid, ReasonMTLSCertInvalid, ReasonMTLSNoCert:
		return CategoryAuthFailure
	case ReasonRateLimited, ReasonServiceUnavail:
		return CategoryRetryable
	case ReasonNMSFailover:
		return CategoryRedirect
	case ReasonBadRequest:
		return CategoryClientError
	default:
		return CategoryServerError
	}
}

// IsAuthFailure returns true when the reason is an authentication failure.
// Auth failures must never carry retry hints.
func IsAuthFailure(reason string) bool {
	return LookupCategory(reason) == CategoryAuthFailure
}

// IsRetryable returns true when the reason is retryable.
func IsRetryable(reason string) bool {
	return LookupCategory(reason) == CategoryRetryable
}

// itoa converts an integer to its decimal string representation.
// Used internally for header value formatting.
func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	return fmt.Sprintf("%s", strconv.Itoa(n))
}
