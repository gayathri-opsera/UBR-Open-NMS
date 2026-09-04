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

// TestAuthenticateDevice_Success verifies successful HTTP authentication flow.
func TestAuthenticateDevice_Success(t *testing.T) {
	secretStore := service.NewInMemorySecretStore()
	inventoryAuth := service.NewLocalInventoryAuthorizer()
	store := service.NewDeviceStore()
	svc := service.NewDiscoveryService("test-secret", 300, &noopPublisher{}, store)
	svc.SetAuthDependencies(secretStore, inventoryAuth)
	h := New(svc, store)

	// Register authorized device
	inventoryAuth.RegisterDevice("UBR-BTS-12345678", "AA:BB:CC:DD:EE:FF", "device-001")

	reqBody := model.DeviceAuthRequest{
		SerialNumber:    "UBR-BTS-12345678",
		MACAddress:      "AA:BB:CC:DD:EE:FF",
		DeviceType:      "BTS",
		FirmwareVersion: "v2.3.1",
	}
	bodyBytes, _ := json.Marshal(reqBody)

	req := httptest.NewRequest(http.MethodPost, "/auth/v1/device", bytes.NewReader(bodyBytes))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Correlation-ID", "test-corr-id")
	w := httptest.NewRecorder()

	h.AuthenticateDevice(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d", w.Code)
	}

	var response model.DeviceAuthResponse
	if err := json.NewDecoder(w.Body).Decode(&response); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}

	if response.DeviceID != "device-001" {
		t.Errorf("DeviceID = %s, want device-001", response.DeviceID)
	}
	if response.SerialNumber != reqBody.SerialNumber {
		t.Errorf("SerialNumber = %s, want %s", response.SerialNumber, reqBody.SerialNumber)
	}
	if response.Secret == "" {
		t.Error("Secret is empty, want non-empty secret")
	}
	if response.KeyVersion != 1 {
		t.Errorf("KeyVersion = %d, want 1", response.KeyVersion)
	}
}

// TestAuthenticateDevice_UnauthorizedDevice verifies HTTP 404 for unknown devices.
func TestAuthenticateDevice_UnauthorizedDevice(t *testing.T) {
	secretStore := service.NewInMemorySecretStore()
	inventoryAuth := service.NewLocalInventoryAuthorizer()
	store := service.NewDeviceStore()
	svc := service.NewDiscoveryService("test-secret", 300, &noopPublisher{}, store)
	svc.SetAuthDependencies(secretStore, inventoryAuth)
	h := New(svc, store)

	// Do not register device

	reqBody := model.DeviceAuthRequest{
		SerialNumber: "UBR-BTS-99999999",
		MACAddress:   "FF:FF:FF:FF:FF:FF",
		DeviceType:   "BTS",
	}
	bodyBytes, _ := json.Marshal(reqBody)

	req := httptest.NewRequest(http.MethodPost, "/auth/v1/device", bytes.NewReader(bodyBytes))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Correlation-ID", "test-corr-id")
	w := httptest.NewRecorder()

	h.AuthenticateDevice(w, req)

	if w.Code != http.StatusNotFound {
		t.Errorf("expected status 404, got %d", w.Code)
	}
}

// TestAuthenticateDevice_MalformedPayload verifies HTTP 400 for invalid JSON.
func TestAuthenticateDevice_MalformedPayload(t *testing.T) {
	secretStore := service.NewInMemorySecretStore()
	inventoryAuth := service.NewLocalInventoryAuthorizer()
	store := service.NewDeviceStore()
	svc := service.NewDiscoveryService("test-secret", 300, &noopPublisher{}, store)
	svc.SetAuthDependencies(secretStore, inventoryAuth)
	h := New(svc, store)

	req := httptest.NewRequest(http.MethodPost, "/auth/v1/device", bytes.NewReader([]byte("not-json")))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Correlation-ID", "test-corr-id")
	w := httptest.NewRecorder()

	h.AuthenticateDevice(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("expected status 400, got %d", w.Code)
	}
}

// TestAuthenticateDevice_MissingRequiredFields verifies HTTP 400 for validation errors.
func TestAuthenticateDevice_MissingRequiredFields(t *testing.T) {
	secretStore := service.NewInMemorySecretStore()
	inventoryAuth := service.NewLocalInventoryAuthorizer()
	store := service.NewDeviceStore()
	svc := service.NewDiscoveryService("test-secret", 300, &noopPublisher{}, store)
	svc.SetAuthDependencies(secretStore, inventoryAuth)
	h := New(svc, store)

	tests := []struct {
		name    string
		payload model.DeviceAuthRequest
	}{
		{"missing serial", model.DeviceAuthRequest{MACAddress: "AA:BB:CC:DD:EE:FF", DeviceType: "BTS"}},
		{"missing MAC", model.DeviceAuthRequest{SerialNumber: "UBR-BTS-12345678", DeviceType: "BTS"}},
		{"missing type", model.DeviceAuthRequest{SerialNumber: "UBR-BTS-12345678", MACAddress: "AA:BB:CC:DD:EE:FF"}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			bodyBytes, _ := json.Marshal(tt.payload)
			req := httptest.NewRequest(http.MethodPost, "/auth/v1/device", bytes.NewReader(bodyBytes))
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("X-Correlation-ID", "test-corr-id")
			w := httptest.NewRecorder()

			h.AuthenticateDevice(w, req)

			if w.Code != http.StatusBadRequest {
				t.Errorf("%s: expected status 400, got %d", tt.name, w.Code)
			}
		})
	}
}

// TestAuthenticateDevice_InvalidMACFormat verifies HTTP 400 for malformed MAC addresses.
func TestAuthenticateDevice_InvalidMACFormat(t *testing.T) {
	secretStore := service.NewInMemorySecretStore()
	inventoryAuth := service.NewLocalInventoryAuthorizer()
	store := service.NewDeviceStore()
	svc := service.NewDiscoveryService("test-secret", 300, &noopPublisher{}, store)
	svc.SetAuthDependencies(secretStore, inventoryAuth)
	h := New(svc, store)

	reqBody := model.DeviceAuthRequest{
		SerialNumber: "UBR-BTS-12345678",
		MACAddress:   "INVALID-MAC",
		DeviceType:   "BTS",
	}
	bodyBytes, _ := json.Marshal(reqBody)

	req := httptest.NewRequest(http.MethodPost, "/auth/v1/device", bytes.NewReader(bodyBytes))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Correlation-ID", "test-corr-id")
	w := httptest.NewRecorder()

	h.AuthenticateDevice(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("expected status 400, got %d", w.Code)
	}
}

// TestAuthenticateDevice_KeyRotation verifies key version increments across requests.
func TestAuthenticateDevice_KeyRotation(t *testing.T) {
	secretStore := service.NewInMemorySecretStore()
	inventoryAuth := service.NewLocalInventoryAuthorizer()
	store := service.NewDeviceStore()
	svc := service.NewDiscoveryService("test-secret", 300, &noopPublisher{}, store)
	svc.SetAuthDependencies(secretStore, inventoryAuth)
	h := New(svc, store)

	inventoryAuth.RegisterDevice("UBR-BTS-87654321", "11:22:33:44:55:66", "device-002")

	reqBody := model.DeviceAuthRequest{
		SerialNumber: "UBR-BTS-87654321",
		MACAddress:   "11:22:33:44:55:66",
		DeviceType:   "CPE",
	}
	bodyBytes, _ := json.Marshal(reqBody)

	// First request
	req1 := httptest.NewRequest(http.MethodPost, "/auth/v1/device", bytes.NewReader(bodyBytes))
	req1.Header.Set("Content-Type", "application/json")
	req1.Header.Set("X-Correlation-ID", "test-corr-id-1")
	w1 := httptest.NewRecorder()

	h.AuthenticateDevice(w1, req1)

	var response1 model.DeviceAuthResponse
	json.NewDecoder(w1.Body).Decode(&response1)
	if response1.KeyVersion != 1 {
		t.Errorf("First KeyVersion = %d, want 1", response1.KeyVersion)
	}

	// Second request (key rotation)
	req2 := httptest.NewRequest(http.MethodPost, "/auth/v1/device", bytes.NewReader(bodyBytes))
	req2.Header.Set("Content-Type", "application/json")
	req2.Header.Set("X-Correlation-ID", "test-corr-id-2")
	w2 := httptest.NewRecorder()

	h.AuthenticateDevice(w2, req2)

	var response2 model.DeviceAuthResponse
	json.NewDecoder(w2.Body).Decode(&response2)
	if response2.KeyVersion != 2 {
		t.Errorf("Second KeyVersion = %d, want 2", response2.KeyVersion)
	}

	if response1.Secret == response2.Secret {
		t.Error("Secret did not rotate across requests")
	}
}
