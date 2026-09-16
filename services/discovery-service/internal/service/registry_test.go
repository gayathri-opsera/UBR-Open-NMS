// Package service implements Discovery Service business logic.
package service

import (
	"encoding/base64"
	"encoding/json"
	"testing"

	"github.com/airtel-ubrnms/discovery-service/internal/model"
)

// TestBuildServiceRegistry_Success verifies the registry builder with complete configuration.
func TestBuildServiceRegistry_Success(t *testing.T) {
	svc := NewDiscoveryService("test-secret", 300, &noopPublisher{}, NewDeviceStore())
	svc.SetServiceURLs(
		"https://auth.ubr.local:3000",
		"https://checkin.ubr.local:8082",
		"https://event.ubr.local:8083",
		"wss://realtime.ubr.local:8084",
	)

	entries, err := svc.BuildServiceRegistry()
	if err != nil {
		t.Fatalf("BuildServiceRegistry() error = %v", err)
	}

	if len(entries) != 4 {
		t.Fatalf("expected 4 KV entries, got %d", len(entries))
	}

	// Verify keys
	expectedKeys := map[string]bool{
		"services/auth":     false,
		"services/checkin":  false,
		"services/event":    false,
		"services/realtime": false,
	}
	for _, entry := range entries {
		if _, ok := expectedKeys[entry.Key]; !ok {
			t.Errorf("unexpected key: %s", entry.Key)
		}
		expectedKeys[entry.Key] = true

		// Verify Value is base64-encoded JSON
		if entry.Value == "" {
			t.Errorf("entry %s has empty Value", entry.Key)
		}
		decoded, err := base64.StdEncoding.DecodeString(entry.Value)
		if err != nil {
			t.Errorf("entry %s Value is not valid base64: %v", entry.Key, err)
		}
		var meta model.ServiceMetadata
		if err := json.Unmarshal(decoded, &meta); err != nil {
			t.Errorf("entry %s decoded Value is not valid JSON: %v", entry.Key, err)
		}

		// Verify scheme and address
		if meta.Scheme == "" {
			t.Errorf("entry %s missing scheme", entry.Key)
		}
		if meta.Address == "" {
			t.Errorf("entry %s missing address", entry.Key)
		}

		// Verify appropriate path field is set
		switch entry.Key {
		case "services/auth":
			if meta.AuthPath == "" {
				t.Errorf("services/auth missing auth_path")
			}
		case "services/checkin":
			if meta.CheckinPath == "" {
				t.Errorf("services/checkin missing checkin_path")
			}
		case "services/event":
			if meta.EventPath == "" {
				t.Errorf("services/event missing event_path")
			}
		case "services/realtime":
			if meta.WSPath == "" {
				t.Errorf("services/realtime missing ws_path")
			}
		}
	}

	// Verify all keys were found
	for key, found := range expectedKeys {
		if !found {
			t.Errorf("missing expected key: %s", key)
		}
	}
}

// TestBuildServiceRegistry_MissingConfig verifies error when service URLs are incomplete.
func TestBuildServiceRegistry_MissingConfig(t *testing.T) {
	tests := []struct {
		name      string
		auth      string
		checkin   string
		event     string
		realtime  string
		wantError bool
	}{
		{"missing auth", "", "http://c:8082", "http://e:8083", "ws://r:8084", true},
		{"missing checkin", "http://a:3000", "", "http://e:8083", "ws://r:8084", true},
		{"missing event", "http://a:3000", "http://c:8082", "", "ws://r:8084", true},
		{"missing realtime", "http://a:3000", "http://c:8082", "http://e:8083", "", true},
		{"all configured", "http://a:3000", "http://c:8082", "http://e:8083", "ws://r:8084", false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			svc := NewDiscoveryService("test-secret", 300, &noopPublisher{}, NewDeviceStore())
			svc.SetServiceURLs(tt.auth, tt.checkin, tt.event, tt.realtime)

			_, err := svc.BuildServiceRegistry()
			if (err != nil) != tt.wantError {
				t.Errorf("BuildServiceRegistry() error = %v, wantError %v", err, tt.wantError)
			}
		})
	}
}

// TestBuildServiceRegistry_IPv6Literal verifies IPv6 literal addresses are preserved correctly.
func TestBuildServiceRegistry_IPv6Literal(t *testing.T) {
	svc := NewDiscoveryService("test-secret", 300, &noopPublisher{}, NewDeviceStore())
	svc.SetServiceURLs(
		"https://[::1]:3000",
		"https://[2001:db8::1]:8082",
		"https://[fe80::1%eth0]:8083",
		"wss://[::1]:8084",
	)

	entries, err := svc.BuildServiceRegistry()
	if err != nil {
		t.Fatalf("BuildServiceRegistry() error = %v", err)
	}

	for _, entry := range entries {
		decoded, _ := base64.StdEncoding.DecodeString(entry.Value)
		var meta model.ServiceMetadata
		json.Unmarshal(decoded, &meta)

		// Verify IPv6 literal brackets are preserved
		if !containsIPv6Brackets(meta.Address) {
			t.Errorf("entry %s address %q missing IPv6 brackets", entry.Key, meta.Address)
		}
	}
}

func containsIPv6Brackets(addr string) bool {
	return len(addr) > 0 && (addr[0] == '[' || !hasColon(addr))
}

func hasColon(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] == ':' {
			return true
		}
	}
	return false
}

// noopPublisher is used for tests.
type noopPublisher struct{}

func (n *noopPublisher) PublishDevice(d model.DiscoveredDevice) error { return nil }
func (n *noopPublisher) PublishAlarm(a model.Alarm) error             { return nil }
