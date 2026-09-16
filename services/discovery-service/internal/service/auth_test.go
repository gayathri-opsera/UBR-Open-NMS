package service

import (
	"testing"

	"github.com/airtel-ubrnms/discovery-service/internal/model"
)

// TestAuthenticateDevice_Success verifies successful authentication with valid device.
func TestAuthenticateDevice_Success(t *testing.T) {
	secretStore := NewInMemorySecretStore()
	inventoryAuth := NewLocalInventoryAuthorizer()
	store := NewDeviceStore()
	svc := NewDiscoveryService("test-secret", 300, &noopPublisher{}, store)
	svc.SetAuthDependencies(secretStore, inventoryAuth)

	// Register an authorized device
	deviceID := "test-device-001"
	inventoryAuth.RegisterDevice("UBR-BTS-12345678", "AA:BB:CC:DD:EE:FF", deviceID)

	req := &model.DeviceAuthRequest{
		SerialNumber:    "UBR-BTS-12345678",
		MACAddress:      "AA:BB:CC:DD:EE:FF",
		DeviceType:      "BTS",
		FirmwareVersion: "v2.3.1",
	}

	response, err := svc.AuthenticateDevice(req)
	if err != nil {
		t.Fatalf("AuthenticateDevice() error = %v, want nil", err)
	}

	if response.DeviceID != deviceID {
		t.Errorf("DeviceID = %s, want %s", response.DeviceID, deviceID)
	}
	if response.SerialNumber != req.SerialNumber {
		t.Errorf("SerialNumber = %s, want %s", response.SerialNumber, req.SerialNumber)
	}
	if response.MACAddress != req.MACAddress {
		t.Errorf("MACAddress = %s, want %s", response.MACAddress, req.MACAddress)
	}
	if response.Secret == "" {
		t.Error("Secret is empty, want non-empty secret")
	}
	if response.KeyVersion != 1 {
		t.Errorf("KeyVersion = %d, want 1", response.KeyVersion)
	}
}

// TestAuthenticateDevice_UnauthorizedDevice verifies 404 for unknown devices.
func TestAuthenticateDevice_UnauthorizedDevice(t *testing.T) {
	secretStore := NewInMemorySecretStore()
	inventoryAuth := NewLocalInventoryAuthorizer()
	store := NewDeviceStore()
	svc := NewDiscoveryService("test-secret", 300, &noopPublisher{}, store)
	svc.SetAuthDependencies(secretStore, inventoryAuth)

	// Do not register device — it's unauthorized

	req := &model.DeviceAuthRequest{
		SerialNumber: "UBR-BTS-99999999",
		MACAddress:   "FF:FF:FF:FF:FF:FF",
		DeviceType:   "BTS",
	}

	_, err := svc.AuthenticateDevice(req)
	if err != ErrDeviceNotFound {
		t.Errorf("AuthenticateDevice() error = %v, want ErrDeviceNotFound", err)
	}
}

// TestAuthenticateDevice_InvalidMACAddress verifies validation errors.
func TestAuthenticateDevice_InvalidMACAddress(t *testing.T) {
	secretStore := NewInMemorySecretStore()
	inventoryAuth := NewLocalInventoryAuthorizer()
	store := NewDeviceStore()
	svc := NewDiscoveryService("test-secret", 300, &noopPublisher{}, store)
	svc.SetAuthDependencies(secretStore, inventoryAuth)

	tests := []string{
		"AABBCCDDEEFF",      // No colons
		"AA:BB:CC:DD:EE",    // Too short
		"AA-BB-CC-DD-EE-FF", // Wrong separator
		"",                  // Empty
	}

	for _, mac := range tests {
		req := &model.DeviceAuthRequest{
			SerialNumber: "UBR-BTS-12345678",
			MACAddress:   mac,
			DeviceType:   "BTS",
		}

		_, err := svc.AuthenticateDevice(req)
		if err == nil {
			t.Errorf("AuthenticateDevice(mac=%s) error = nil, want validation error", mac)
		}
	}
}

// TestAuthenticateDevice_InvalidSerialNumber verifies serial validation.
func TestAuthenticateDevice_InvalidSerialNumber(t *testing.T) {
	secretStore := NewInMemorySecretStore()
	inventoryAuth := NewLocalInventoryAuthorizer()
	store := NewDeviceStore()
	svc := NewDiscoveryService("test-secret", 300, &noopPublisher{}, store)
	svc.SetAuthDependencies(secretStore, inventoryAuth)

	tests := []struct {
		name   string
		serial string
	}{
		{"too short", "SHORT"},
		{"too long", "THIS-IS-A-VERY-LONG-SERIAL-NUMBER-EXCEEDING-32-CHARACTERS"},
		{"empty", ""},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := &model.DeviceAuthRequest{
				SerialNumber: tt.serial,
				MACAddress:   "AA:BB:CC:DD:EE:FF",
				DeviceType:   "BTS",
			}

			_, err := svc.AuthenticateDevice(req)
			if err == nil {
				t.Errorf("AuthenticateDevice(serial=%s) error = nil, want validation error", tt.serial)
			}
		})
	}
}

// TestAuthenticateDevice_KeyRotation verifies key version increments.
func TestAuthenticateDevice_KeyRotation(t *testing.T) {
	secretStore := NewInMemorySecretStore()
	inventoryAuth := NewLocalInventoryAuthorizer()
	store := NewDeviceStore()
	svc := NewDiscoveryService("test-secret", 300, &noopPublisher{}, store)
	svc.SetAuthDependencies(secretStore, inventoryAuth)

	deviceID := "test-device-002"
	inventoryAuth.RegisterDevice("UBR-BTS-87654321", "11:22:33:44:55:66", deviceID)

	req := &model.DeviceAuthRequest{
		SerialNumber: "UBR-BTS-87654321",
		MACAddress:   "11:22:33:44:55:66",
		DeviceType:   "CPE",
	}

	// First authentication
	response1, err := svc.AuthenticateDevice(req)
	if err != nil {
		t.Fatalf("First AuthenticateDevice() error = %v", err)
	}
	if response1.KeyVersion != 1 {
		t.Errorf("First KeyVersion = %d, want 1", response1.KeyVersion)
	}
	secret1 := response1.Secret

	// Second authentication (key rotation)
	response2, err := svc.AuthenticateDevice(req)
	if err != nil {
		t.Fatalf("Second AuthenticateDevice() error = %v", err)
	}
	if response2.KeyVersion != 2 {
		t.Errorf("Second KeyVersion = %d, want 2", response2.KeyVersion)
	}
	secret2 := response2.Secret

	// Secrets should be different
	if secret1 == secret2 {
		t.Error("Secret did not rotate: secret1 == secret2")
	}
}

// TestSecretStore_IssueAndRetrieve verifies secret storage operations.
func TestSecretStore_IssueAndRetrieve(t *testing.T) {
	store := NewInMemorySecretStore()

	deviceID := "dev-123"
	serial := "UBR-TEST-01"
	mac := "AA:BB:CC:DD:EE:FF"

	secret, err := store.IssueSecret(deviceID, serial, mac)
	if err != nil {
		t.Fatalf("IssueSecret() error = %v", err)
	}
	if secret.DeviceID != deviceID {
		t.Errorf("DeviceID = %s, want %s", secret.DeviceID, deviceID)
	}
	if !secret.Active {
		t.Error("Secret.Active = false, want true")
	}

	// Retrieve by deviceID
	retrieved, ok, err := store.GetSecret(deviceID)
	if err != nil || !ok {
		t.Fatalf("GetSecret() error = %v, ok = %v", err, ok)
	}
	if retrieved.SecretValue != secret.SecretValue {
		t.Error("Retrieved secret does not match issued secret")
	}

	// Retrieve by serial
	retrievedBySerial, ok, err := store.GetSecretBySerial(serial)
	if err != nil || !ok {
		t.Fatalf("GetSecretBySerial() error = %v, ok = %v", err, ok)
	}
	if retrievedBySerial.SecretValue != secret.SecretValue {
		t.Error("Retrieved by serial does not match issued secret")
	}
}

// TestSecretStore_InvalidateSecret verifies secret invalidation.
func TestSecretStore_InvalidateSecret(t *testing.T) {
	store := NewInMemorySecretStore()

	deviceID := "dev-456"
	secret, _ := store.IssueSecret(deviceID, "UBR-TEST-02", "11:22:33:44:55:66")

	if !secret.Active {
		t.Fatal("Initial secret.Active = false, want true")
	}

	err := store.InvalidateSecret(deviceID, "device_removed")
	if err != nil {
		t.Fatalf("InvalidateSecret() error = %v", err)
	}

	// Retrieve again — should be inactive
	retrieved, ok, err := store.GetSecret(deviceID)
	if err != nil || !ok {
		t.Fatalf("GetSecret() after invalidation error = %v, ok = %v", err, ok)
	}
	if retrieved.Active {
		t.Error("After invalidation, secret.Active = true, want false")
	}
	if retrieved.InvalidatedReason != "device_removed" {
		t.Errorf("InvalidatedReason = %s, want device_removed", retrieved.InvalidatedReason)
	}
}

// TestInventoryAuthorizer_Authorized verifies authorization checks.
func TestInventoryAuthorizer_Authorized(t *testing.T) {
	auth := NewLocalInventoryAuthorizer()

	auth.RegisterDevice("SERIAL-001", "AA:BB:CC:DD:EE:FF", "device-001")

	deviceID, authorized, err := auth.AuthorizeDevice("SERIAL-001", "AA:BB:CC:DD:EE:FF")
	if err != nil {
		t.Fatalf("AuthorizeDevice() error = %v", err)
	}
	if !authorized {
		t.Error("authorized = false, want true")
	}
	if deviceID != "device-001" {
		t.Errorf("deviceID = %s, want device-001", deviceID)
	}
}

// TestInventoryAuthorizer_NotAuthorized verifies rejection of unknown devices.
func TestInventoryAuthorizer_NotAuthorized(t *testing.T) {
	auth := NewLocalInventoryAuthorizer()

	deviceID, authorized, err := auth.AuthorizeDevice("UNKNOWN-SERIAL", "FF:FF:FF:FF:FF:FF")
	if err != nil {
		t.Fatalf("AuthorizeDevice() error = %v", err)
	}
	if authorized {
		t.Error("authorized = true, want false for unknown device")
	}
	if deviceID != "" {
		t.Errorf("deviceID = %s, want empty string for unauthorized device", deviceID)
	}
}

// TestInventoryAuthorizer_SerialAndMACMustMatch verifies serial+MAC pairing.
func TestInventoryAuthorizer_SerialAndMACMustMatch(t *testing.T) {
	auth := NewLocalInventoryAuthorizer()

	auth.RegisterDevice("SERIAL-002", "AA:BB:CC:DD:EE:FF", "device-002")

	// Correct serial, wrong MAC
	_, authorized, _ := auth.AuthorizeDevice("SERIAL-002", "11:22:33:44:55:66")
	if authorized {
		t.Error("authorized = true for mismatched MAC, want false")
	}

	// Correct MAC, wrong serial
	_, authorized, _ = auth.AuthorizeDevice("WRONG-SERIAL", "AA:BB:CC:DD:EE:FF")
	if authorized {
		t.Error("authorized = true for mismatched serial, want false")
	}
}
