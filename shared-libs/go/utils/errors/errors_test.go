package errors_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/airtel-ubrnms/shared-libs/utils/errors"
)

func TestNewAPIError(t *testing.T) {
	e := errors.NewAPIError("MY_CODE", "my message")
	if e.Status != "error" {
		t.Errorf("expected status 'error', got %s", e.Status)
	}
	if e.Error.Code != "MY_CODE" {
		t.Errorf("expected code MY_CODE, got %s", e.Error.Code)
	}
	if e.Error.Message != "my message" {
		t.Errorf("expected message 'my message', got %s", e.Error.Message)
	}
}

func TestFactories(t *testing.T) {
	cases := []struct {
		name string
		err  errors.APIError
		code string
	}{
		{"NotFound", errors.NotFound("Device"), "NOT_FOUND"},
		{"Forbidden", errors.Forbidden("no"), "FORBIDDEN"},
		{"Unauthorized", errors.Unauthorized("no"), "UNAUTHORIZED"},
		{"Conflict", errors.Conflict("dup"), "CONFLICT"},
		{"Validation", errors.Validation("bad"), "VALIDATION_ERROR"},
		{"ServiceUnavailable", errors.ServiceUnavailable("down"), "SERVICE_UNAVAILABLE"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if c.err.Error.Code != c.code {
				t.Errorf("expected code %s, got %s", c.code, c.err.Error.Code)
			}
		})
	}
}

func TestWriteJSON(t *testing.T) {
	w := httptest.NewRecorder()
	errors.NotFound("Resource").WriteJSON(w, http.StatusNotFound)
	if w.Code != http.StatusNotFound {
		t.Errorf("expected 404, got %d", w.Code)
	}
	var decoded errors.APIError
	if err := json.NewDecoder(w.Body).Decode(&decoded); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}
	if decoded.Error.Code != "NOT_FOUND" {
		t.Errorf("expected NOT_FOUND code in body")
	}
}
