package handler

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/airtel-ubrnms/discovery-service/internal/model"
	"github.com/airtel-ubrnms/discovery-service/internal/service"
)

// TestServiceRegistry_Success verifies the registry endpoint with valid recurse=1 parameter.
func TestServiceRegistry_Success(t *testing.T) {
	store := service.NewDeviceStore()
	runStore := service.NewDiscoveryRunStore()
	svc := service.NewDiscoveryService("test-secret", 300, &noopPublisher{}, store)
	svc.SetServiceURLs(
		"https://auth.local:3000",
		"https://checkin.local:8082",
		"https://event.local:8083",
		"wss://realtime.local:8084",
	)
	h := New(svc, store, runStore)

	req := httptest.NewRequest(http.MethodGet, "/discovery/v1/kv/services?recurse=1", nil)
	req.Header.Set("X-Correlation-ID", "test-corr-id")
	w := httptest.NewRecorder()

	h.ServiceRegistry(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d", w.Code)
	}

	var entries []model.KVEntry
	if err := json.NewDecoder(w.Body).Decode(&entries); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}

	if len(entries) != 4 {
		t.Fatalf("expected 4 KV entries, got %d", len(entries))
	}

	// Verify each entry can be decoded
	for _, entry := range entries {
		if entry.Key == "" {
			t.Error("entry has empty Key")
		}
		if entry.Value == "" {
			t.Error("entry has empty Value")
		}

		// Decode and verify JSON structure
		decoded, err := base64.StdEncoding.DecodeString(entry.Value)
		if err != nil {
			t.Errorf("entry %s: Value not valid base64: %v", entry.Key, err)
			continue
		}

		var meta model.ServiceMetadata
		if err := json.Unmarshal(decoded, &meta); err != nil {
			t.Errorf("entry %s: decoded Value not valid JSON: %v", entry.Key, err)
			continue
		}

		if meta.Scheme == "" || meta.Address == "" {
			t.Errorf("entry %s: missing scheme or address", entry.Key)
		}
	}
}

// TestServiceRegistry_MissingRecurse verifies BAD_REQUEST when recurse parameter is missing.
func TestServiceRegistry_MissingRecurse(t *testing.T) {
	store := service.NewDeviceStore()
	svc := service.NewDiscoveryService("test-secret", 300, &noopPublisher{}, store)
	svc.SetServiceURLs("http://a:3000", "http://b:8082", "http://c:8083", "ws://d:8084")
	runStore := service.NewDiscoveryRunStore()
	h := New(svc, store, runStore)

	req := httptest.NewRequest(http.MethodGet, "/discovery/v1/kv/services", nil)
	req.Header.Set("X-Correlation-ID", "test-corr-id")
	w := httptest.NewRecorder()

	h.ServiceRegistry(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("expected status 400, got %d", w.Code)
	}
}

// TestServiceRegistry_InvalidRecurseValue verifies BAD_REQUEST when recurse != 1.
func TestServiceRegistry_InvalidRecurseValue(t *testing.T) {
	tests := []string{"0", "2", "true", "false", ""}

	for _, recurseValue := range tests {
		t.Run("recurse="+recurseValue, func(t *testing.T) {
			store := service.NewDeviceStore()
			svc := service.NewDiscoveryService("test-secret", 300, &noopPublisher{}, store)
			svc.SetServiceURLs("http://a:3000", "http://b:8082", "http://c:8083", "ws://d:8084")
			runStore := service.NewDiscoveryRunStore()
	h := New(svc, store, runStore)

			req := httptest.NewRequest(http.MethodGet, "/discovery/v1/kv/services?recurse="+recurseValue, nil)
			req.Header.Set("X-Correlation-ID", "test-corr-id")
			w := httptest.NewRecorder()

			h.ServiceRegistry(w, req)

			if w.Code != http.StatusBadRequest {
				t.Errorf("expected status 400 for recurse=%s, got %d", recurseValue, w.Code)
			}
		})
	}
}

// TestServiceRegistry_ServiceUnavailable verifies 503 when service URLs are not configured.
func TestServiceRegistry_ServiceUnavailable(t *testing.T) {
	store := service.NewDeviceStore()
	svc := service.NewDiscoveryService("test-secret", 300, &noopPublisher{}, store)
	// Do not set service URLs (incomplete configuration)
	runStore := service.NewDiscoveryRunStore()
	h := New(svc, store, runStore)

	req := httptest.NewRequest(http.MethodGet, "/discovery/v1/kv/services?recurse=1", nil)
	req.Header.Set("X-Correlation-ID", "test-corr-id")
	w := httptest.NewRecorder()

	h.ServiceRegistry(w, req)

	if w.Code != http.StatusServiceUnavailable {
		t.Errorf("expected status 503, got %d", w.Code)
	}
}

// TestServiceRegistry_UnknownQueryParams verifies unknown query parameters are ignored.
func TestServiceRegistry_UnknownQueryParams(t *testing.T) {
	store := service.NewDeviceStore()
	svc := service.NewDiscoveryService("test-secret", 300, &noopPublisher{}, store)
	svc.SetServiceURLs("http://a:3000", "http://b:8082", "http://c:8083", "ws://d:8084")
	runStore := service.NewDiscoveryRunStore()
	h := New(svc, store, runStore)

	req := httptest.NewRequest(http.MethodGet, "/discovery/v1/kv/services?recurse=1&extra=foo&bar=baz", nil)
	req.Header.Set("X-Correlation-ID", "test-corr-id")
	w := httptest.NewRecorder()

	h.ServiceRegistry(w, req)

	// Unknown query parameters must not alter the returned registry (edge case from WO-009)
	if w.Code != http.StatusOK {
		t.Errorf("expected status 200, got %d (unknown params should not cause failure)", w.Code)
	}

	var entries []model.KVEntry
	json.NewDecoder(w.Body).Decode(&entries)
	if len(entries) != 4 {
		t.Errorf("expected 4 entries even with unknown params, got %d", len(entries))
	}
}

// noopPublisher for tests
type noopPublisher struct{}

func (n *noopPublisher) PublishDevice(d model.DiscoveredDevice) error { return nil }
func (n *noopPublisher) PublishAlarm(a model.Alarm) error             { return nil }
