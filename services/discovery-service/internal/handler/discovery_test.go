package handler

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/airtel-ubrnms/discovery-service/internal/model"
	"github.com/airtel-ubrnms/discovery-service/internal/service"
)

// TestCreateDiscoveryRun_Success verifies successful HTTP discovery run creation.
func TestCreateDiscoveryRun_Success(t *testing.T) {
	store := service.NewDeviceStore()
	runStore := service.NewDiscoveryRunStore()
	svc := service.NewDiscoveryService("test-secret", 300, &noopPublisher{}, store)
	h := New(svc, store, runStore)

	reqBody := model.DiscoveryRunRequest{
		Scope: []model.ScopeEntry{
			{Type: "CIDR", Value: "192.168.1.0/24", Label: "Test Network"},
			{Type: "IP", Value: "10.0.0.1", Label: "Gateway"},
		},
	}
	bodyBytes, _ := json.Marshal(reqBody)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/discovery/runs", bytes.NewReader(bodyBytes))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Correlation-ID", "test-corr-id")
	req.Header.Set("X-User-ID", "test-user@example.com")
	w := httptest.NewRecorder()

	h.CreateDiscoveryRun(w, req)

	if w.Code != http.StatusCreated {
		t.Fatalf("expected status 201, got %d", w.Code)
	}

	var response model.DiscoveryRunResponse
	if err := json.NewDecoder(w.Body).Decode(&response); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}

	if response.RunID == "" {
		t.Error("RunID is empty")
	}
	if response.Status != "CREATED" {
		t.Errorf("Status = %s, want CREATED", response.Status)
	}
	if response.CreatedBy != "test-user@example.com" {
		t.Errorf("CreatedBy = %s, want test-user@example.com", response.CreatedBy)
	}
	if len(response.NormalizedScope) != 2 {
		t.Errorf("len(NormalizedScope) = %d, want 2", len(response.NormalizedScope))
	}
}

// TestCreateDiscoveryRun_MalformedPayload verifies HTTP 400 for invalid JSON.
func TestCreateDiscoveryRun_MalformedPayload(t *testing.T) {
	store := service.NewDeviceStore()
	runStore := service.NewDiscoveryRunStore()
	svc := service.NewDiscoveryService("test-secret", 300, &noopPublisher{}, store)
	h := New(svc, store, runStore)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/discovery/runs", bytes.NewReader([]byte("not-json")))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Correlation-ID", "test-corr-id")
	w := httptest.NewRecorder()

	h.CreateDiscoveryRun(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("expected status 400, got %d", w.Code)
	}
}

// TestCreateDiscoveryRun_EmptyScope verifies HTTP 400 for empty scope.
func TestCreateDiscoveryRun_EmptyScope(t *testing.T) {
	store := service.NewDeviceStore()
	runStore := service.NewDiscoveryRunStore()
	svc := service.NewDiscoveryService("test-secret", 300, &noopPublisher{}, store)
	h := New(svc, store, runStore)

	reqBody := model.DiscoveryRunRequest{
		Scope: []model.ScopeEntry{},
	}
	bodyBytes, _ := json.Marshal(reqBody)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/discovery/runs", bytes.NewReader(bodyBytes))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Correlation-ID", "test-corr-id")
	w := httptest.NewRecorder()

	h.CreateDiscoveryRun(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("expected status 400, got %d", w.Code)
	}

	var errResp model.ScopeValidationError
	json.NewDecoder(w.Body).Decode(&errResp)
	if errResp.Reason != "VALIDATION_ERROR" {
		t.Errorf("Reason = %s, want VALIDATION_ERROR", errResp.Reason)
	}
	if len(errResp.FieldErrors) == 0 {
		t.Error("expected fieldErrors for empty scope")
	}
}

// TestCreateDiscoveryRun_InvalidCIDR verifies HTTP 400 for invalid CIDR.
func TestCreateDiscoveryRun_InvalidCIDR(t *testing.T) {
	store := service.NewDeviceStore()
	runStore := service.NewDiscoveryRunStore()
	svc := service.NewDiscoveryService("test-secret", 300, &noopPublisher{}, store)
	h := New(svc, store, runStore)

	reqBody := model.DiscoveryRunRequest{
		Scope: []model.ScopeEntry{
			{Type: "CIDR", Value: "invalid-cidr"},
		},
	}
	bodyBytes, _ := json.Marshal(reqBody)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/discovery/runs", bytes.NewReader(bodyBytes))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Correlation-ID", "test-corr-id")
	w := httptest.NewRecorder()

	h.CreateDiscoveryRun(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("expected status 400, got %d", w.Code)
	}

	var errResp model.ScopeValidationError
	json.NewDecoder(w.Body).Decode(&errResp)
	if len(errResp.FieldErrors) == 0 {
		t.Error("expected fieldErrors for invalid CIDR")
	}
}

// TestCreateDiscoveryRun_InvalidIP verifies HTTP 400 for invalid IP.
func TestCreateDiscoveryRun_InvalidIP(t *testing.T) {
	store := service.NewDeviceStore()
	runStore := service.NewDiscoveryRunStore()
	svc := service.NewDiscoveryService("test-secret", 300, &noopPublisher{}, store)
	h := New(svc, store, runStore)

	reqBody := model.DiscoveryRunRequest{
		Scope: []model.ScopeEntry{
			{Type: "IP", Value: "999.999.999.999"},
		},
	}
	bodyBytes, _ := json.Marshal(reqBody)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/discovery/runs", bytes.NewReader(bodyBytes))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Correlation-ID", "test-corr-id")
	w := httptest.NewRecorder()

	h.CreateDiscoveryRun(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("expected status 400, got %d", w.Code)
	}
}

// TestCreateDiscoveryRun_DuplicateElimination verifies duplicates are removed.
func TestCreateDiscoveryRun_DuplicateElimination(t *testing.T) {
	store := service.NewDeviceStore()
	runStore := service.NewDiscoveryRunStore()
	svc := service.NewDiscoveryService("test-secret", 300, &noopPublisher{}, store)
	h := New(svc, store, runStore)

	reqBody := model.DiscoveryRunRequest{
		Scope: []model.ScopeEntry{
			{Type: "IP", Value: "192.168.1.1"},
			{Type: "IP", Value: "192.168.1.1"}, // Duplicate
			{Type: "CIDR", Value: "10.0.0.0/24"},
			{Type: "CIDR", Value: "10.0.0.0/24"}, // Duplicate
		},
	}
	bodyBytes, _ := json.Marshal(reqBody)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/discovery/runs", bytes.NewReader(bodyBytes))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Correlation-ID", "test-corr-id")
	req.Header.Set("X-User-ID", "test-user")
	w := httptest.NewRecorder()

	h.CreateDiscoveryRun(w, req)

	if w.Code != http.StatusCreated {
		t.Fatalf("expected status 201, got %d", w.Code)
	}

	var response model.DiscoveryRunResponse
	json.NewDecoder(w.Body).Decode(&response)
	if len(response.NormalizedScope) != 2 {
		t.Errorf("len(NormalizedScope) = %d, want 2 (duplicates removed)", len(response.NormalizedScope))
	}
}

// TestCreateDiscoveryRun_MixedValidInvalid verifies partial validation errors.
func TestCreateDiscoveryRun_MixedValidInvalid(t *testing.T) {
	store := service.NewDeviceStore()
	runStore := service.NewDiscoveryRunStore()
	svc := service.NewDiscoveryService("test-secret", 300, &noopPublisher{}, store)
	h := New(svc, store, runStore)

	reqBody := model.DiscoveryRunRequest{
		Scope: []model.ScopeEntry{
			{Type: "IP", Value: "192.168.1.1"},       // Valid
			{Type: "IP", Value: "invalid-ip"},        // Invalid
			{Type: "CIDR", Value: "10.0.0.0/24"},     // Valid
		},
	}
	bodyBytes, _ := json.Marshal(reqBody)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/discovery/runs", bytes.NewReader(bodyBytes))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Correlation-ID", "test-corr-id")
	w := httptest.NewRecorder()

	h.CreateDiscoveryRun(w, req)

	// Should fail validation due to invalid entry
	if w.Code != http.StatusBadRequest {
		t.Errorf("expected status 400, got %d", w.Code)
	}

	var errResp model.ScopeValidationError
	json.NewDecoder(w.Body).Decode(&errResp)
	if len(errResp.FieldErrors) == 0 {
		t.Error("expected fieldErrors for invalid entry")
	}
}
