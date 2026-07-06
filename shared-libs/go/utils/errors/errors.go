// Package errors provides standardized error response types for UBR NMS services.
package errors

import (
	"encoding/json"
	"net/http"
)

// APIError is the standard error response shape:
// {"status":"error","error":{"code":"...","message":"..."}}
type APIError struct {
	Status string     `json:"status"`
	Error  ErrorBody  `json:"error"`
}

// ErrorBody holds the error code and human-readable message.
type ErrorBody struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// NewAPIError creates an APIError with the given code and message.
func NewAPIError(code, message string) APIError {
	return APIError{Status: "error", Error: ErrorBody{Code: code, Message: message}}
}

// WriteJSON encodes the error as JSON and writes it to the ResponseWriter.
func (e APIError) WriteJSON(w http.ResponseWriter, statusCode int) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(statusCode)
	_ = json.NewEncoder(w).Encode(e)
}

// Common factory helpers.
func NotFound(resource string) APIError {
	return NewAPIError("NOT_FOUND", resource+" not found")
}
func Forbidden(msg string) APIError { return NewAPIError("FORBIDDEN", msg) }
func Unauthorized(msg string) APIError { return NewAPIError("UNAUTHORIZED", msg) }
func Conflict(msg string) APIError { return NewAPIError("CONFLICT", msg) }
func Validation(msg string) APIError { return NewAPIError("VALIDATION_ERROR", msg) }
func ServiceUnavailable(msg string) APIError { return NewAPIError("SERVICE_UNAVAILABLE", msg) }
func Internal(msg string) APIError { return NewAPIError("INTERNAL_ERROR", msg) }
