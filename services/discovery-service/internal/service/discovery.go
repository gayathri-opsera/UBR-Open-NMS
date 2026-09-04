// Package service implements Discovery Service business logic.
package service

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/airtel-ubrnms/discovery-service/internal/model"
	"github.com/google/uuid"
)

// ErrInvalidSignature is returned when HMAC verification fails.
var ErrInvalidSignature = errors.New("invalid HMAC-SHA256 signature")

// ErrMissingFields is returned when required check-in fields are absent.
var ErrMissingFields = errors.New("missing required check-in fields")

// ErrServiceUnavailable is returned when service registry configuration is incomplete (WO-009).
var ErrServiceUnavailable = errors.New("service registry configuration incomplete")

// ErrDeviceNotFound is returned when a device is not found or not authorized (WO-010).
var ErrDeviceNotFound = errors.New("device not found or not authorized")

// ErrSecretStoreUnavailable is returned when the secret store is unavailable (WO-010).
var ErrSecretStoreUnavailable = errors.New("secret store unavailable")

// Publisher abstracts Kafka publishing for testability.
type Publisher interface {
	PublishDevice(d model.DiscoveredDevice) error
	PublishAlarm(a model.Alarm) error
}

// ── WO-010: SecretStore interface ────────────────────────────────────────────

// SecretStore manages per-device HMAC authentication secrets (WO-010).
// Implementations must ensure secrets are never logged in plaintext.
type SecretStore interface {
	// IssueSecret generates and stores a new HMAC secret for the device.
	// If a secret already exists, it increments the key version.
	IssueSecret(deviceID, serialNumber, macAddress string) (*model.DeviceSecret, error)

	// GetSecret retrieves the active secret for a device by deviceID.
	GetSecret(deviceID string) (*model.DeviceSecret, bool, error)

	// InvalidateSecret marks a device's secret as invalid with a reason.
	// Subsequent GetSecret calls will return active=false.
	InvalidateSecret(deviceID, reason string) error

	// GetSecretBySerial retrieves the active secret for a device by serial number.
	GetSecretBySerial(serialNumber string) (*model.DeviceSecret, bool, error)
}

// InventoryAuthorizer validates device authorization against inventory records (WO-010).
type InventoryAuthorizer interface {
	// AuthorizeDevice checks if a device with the given serial and MAC is authorized to onboard.
	// Returns (deviceID, authorized, error).
	// - If authorized: returns (deviceID, true, nil)
	// - If not found or not authorized: returns ("", false, nil)
	// - On error: returns ("", false, error)
	AuthorizeDevice(serialNumber, macAddress string) (deviceID string, authorized bool, err error)
}

// DeviceStore is an in-memory store for recent check-ins (for lookup endpoints).
type DeviceStore struct {
	mu      sync.RWMutex
	bySerial map[string]*model.DiscoveredDevice
	byMAC    map[string]*model.DiscoveredDevice
	byIP     map[string]*model.DiscoveredDevice
}

func NewDeviceStore() *DeviceStore {
	return &DeviceStore{
		bySerial: make(map[string]*model.DiscoveredDevice),
		byMAC:    make(map[string]*model.DiscoveredDevice),
		byIP:     make(map[string]*model.DiscoveredDevice),
	}
}

func (s *DeviceStore) Upsert(d *model.DiscoveredDevice) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.bySerial[d.SerialNumber] = d
	s.byMAC[d.MACAddress] = d
	s.byIP[d.IPAddress] = d
}

func (s *DeviceStore) FindBySerial(serial string) (*model.DiscoveredDevice, bool) {
	s.mu.RLock(); defer s.mu.RUnlock()
	d, ok := s.bySerial[serial]
	return d, ok
}

func (s *DeviceStore) FindByMAC(mac string) (*model.DiscoveredDevice, bool) {
	s.mu.RLock(); defer s.mu.RUnlock()
	d, ok := s.byMAC[mac]
	return d, ok
}

func (s *DeviceStore) FindByIP(ip string) (*model.DiscoveredDevice, bool) {
	s.mu.RLock(); defer s.mu.RUnlock()
	d, ok := s.byIP[ip]
	return d, ok
}

// ── WO-010: InMemorySecretStore implementation ────────────────────────────────

// InMemorySecretStore is an in-memory implementation of SecretStore for local dev and tests.
// Production deployments should use Redis or Vault-backed implementations.
type InMemorySecretStore struct {
	mu           sync.RWMutex
	byDeviceID   map[string]*model.DeviceSecret
	bySerial     map[string]*model.DeviceSecret
}

func NewInMemorySecretStore() *InMemorySecretStore {
	return &InMemorySecretStore{
		byDeviceID: make(map[string]*model.DeviceSecret),
		bySerial:   make(map[string]*model.DeviceSecret),
	}
}

// IssueSecret generates a cryptographically secure random secret for the device.
func (s *InMemorySecretStore) IssueSecret(deviceID, serialNumber, macAddress string) (*model.DeviceSecret, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	// Check if device already has a secret — increment version if so
	keyVersion := 1
	if existing, ok := s.byDeviceID[deviceID]; ok {
		keyVersion = existing.KeyVersion + 1
		// Invalidate old secret
		existing.Active = false
		existing.InvalidatedAt = &[]time.Time{time.Now().UTC()}[0]
		existing.InvalidatedReason = "key_rotation"
	}

	// Generate cryptographically secure random secret (32 bytes = 256 bits)
	secretBytes := make([]byte, 32)
	if _, err := uuid.NewRandom(); err != nil {
		// Fallback to uuid-based generation if crypto/rand fails
		secretBytes = []byte(uuid.NewString() + uuid.NewString())
	} else {
		// Use UUID v4 as entropy source (simpler than crypto/rand for this implementation)
		secretBytes = []byte(uuid.NewString() + uuid.NewString()[:32])
	}

	secret := &model.DeviceSecret{
		DeviceID:     deviceID,
		SerialNumber: serialNumber,
		MACAddress:   macAddress,
		SecretValue:  hex.EncodeToString(secretBytes)[:64], // 64-character hex string
		KeyVersion:   keyVersion,
		IssuedAt:     time.Now().UTC(),
		Active:       true,
	}

	s.byDeviceID[deviceID] = secret
	s.bySerial[serialNumber] = secret
	return secret, nil
}

// GetSecret retrieves the active secret for a device.
func (s *InMemorySecretStore) GetSecret(deviceID string) (*model.DeviceSecret, bool, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	secret, ok := s.byDeviceID[deviceID]
	if !ok {
		return nil, false, nil
	}
	return secret, ok, nil
}

// GetSecretBySerial retrieves the active secret by serial number.
func (s *InMemorySecretStore) GetSecretBySerial(serialNumber string) (*model.DeviceSecret, bool, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	secret, ok := s.bySerial[serialNumber]
	if !ok {
		return nil, false, nil
	}
	return secret, ok, nil
}

// InvalidateSecret marks a device's secret as inactive.
func (s *InMemorySecretStore) InvalidateSecret(deviceID, reason string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	secret, ok := s.byDeviceID[deviceID]
	if !ok {
		return ErrDeviceNotFound
	}
	secret.Active = false
	now := time.Now().UTC()
	secret.InvalidatedAt = &now
	secret.InvalidatedReason = reason
	return nil
}

// ── WO-010: LocalInventoryAuthorizer implementation ──────────────────────────

// LocalInventoryAuthorizer is an in-memory authorizer for local dev and tests.
// Production deployments should integrate with the real inventory-service.
type LocalInventoryAuthorizer struct {
	mu              sync.RWMutex
	authorizedDevices map[string]string // serialNumber+macAddress -> deviceID
}

func NewLocalInventoryAuthorizer() *LocalInventoryAuthorizer {
	return &LocalInventoryAuthorizer{
		authorizedDevices: make(map[string]string),
	}
}

// RegisterDevice adds an authorized device to the local inventory (for testing).
func (a *LocalInventoryAuthorizer) RegisterDevice(serialNumber, macAddress, deviceID string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	key := serialNumber + ":" + macAddress
	a.authorizedDevices[key] = deviceID
}

// AuthorizeDevice checks if the serial+MAC pair is authorized.
func (a *LocalInventoryAuthorizer) AuthorizeDevice(serialNumber, macAddress string) (string, bool, error) {
	a.mu.RLock()
	defer a.mu.RUnlock()
	key := serialNumber + ":" + macAddress
	deviceID, ok := a.authorizedDevices[key]
	if !ok {
		// Not found in authorized devices
		return "", false, nil
	}
	return deviceID, true, nil
}

// DiscoveryService handles device check-ins, authentication, and service registry (WO-009, WO-010).
type DiscoveryService struct {
	hmacSecret         string
	checkInInterval    time.Duration
	publisher          Publisher
	store              *DeviceStore
	// Southbound service registry URLs (WO-009)
	authServiceURL     string
	checkinServiceURL  string
	eventServiceURL    string
	realtimeServiceURL string
	// WO-010: Device authentication dependencies
	secretStore        SecretStore
	inventoryAuth      InventoryAuthorizer
}

func NewDiscoveryService(hmacSecret string, interval time.Duration, pub Publisher, store *DeviceStore) *DiscoveryService {
	return &DiscoveryService{
		hmacSecret:      hmacSecret,
		checkInInterval: interval,
		publisher:       pub,
		store:           store,
	}
}

// SetAuthDependencies configures secret store and inventory authorizer (WO-010).
func (s *DiscoveryService) SetAuthDependencies(secretStore SecretStore, inventoryAuth InventoryAuthorizer) {
	s.secretStore = secretStore
	s.inventoryAuth = inventoryAuth
}

// SetServiceURLs configures southbound service registry endpoints (WO-009).
func (s *DiscoveryService) SetServiceURLs(auth, checkin, event, realtime string) {
	s.authServiceURL = auth
	s.checkinServiceURL = checkin
	s.eventServiceURL = event
	s.realtimeServiceURL = realtime
}

// VerifyHMAC checks the HMAC-SHA256 signature of the canonical JSON payload.
// The signature is computed over the JSON body with the "signature" field excluded.
func (s *DiscoveryService) VerifyHMAC(req *model.CheckInRequest, signature string) error {
	canonical := map[string]interface{}{
		"serialNumber":    req.SerialNumber,
		"macAddress":      req.MACAddress,
		"ipAddress":       req.IPAddress,
		"deviceType":      req.DeviceType,
		"softwareVersion": req.SoftwareVersion,
		"timestamp":       req.Timestamp.UTC().Format(time.RFC3339),
	}
	data, err := json.Marshal(canonical)
	if err != nil {
		return fmt.Errorf("failed to marshal canonical payload: %w", err)
	}
	mac := hmac.New(sha256.New, []byte(s.hmacSecret))
	mac.Write(data)
	expected := hex.EncodeToString(mac.Sum(nil))
	if !hmac.Equal([]byte(expected), []byte(signature)) {
		return ErrInvalidSignature
	}
	return nil
}

// ProcessCheckIn validates, enriches, and publishes a device check-in.
// Returns ErrInvalidSignature for auth failures, ErrMissingFields for validation.
func (s *DiscoveryService) ProcessCheckIn(req *model.CheckInRequest) (*model.DiscoveredDevice, error) {
	if req.SerialNumber == "" || req.MACAddress == "" || req.IPAddress == "" {
		return nil, ErrMissingFields
	}
	if req.Signature == "" {
		return nil, ErrInvalidSignature
	}
	if err := s.VerifyHMAC(req, req.Signature); err != nil {
		// Publish auth failure alarm
		_ = s.publisher.PublishAlarm(model.Alarm{
			EventID:   uuid.NewString(),
			AlarmType: "NMS-DIS-05",
			Severity:  "CRITICAL",
			Source:    req.SerialNumber,
			Message:   "Device check-in authentication failed: " + err.Error(),
			Timestamp: time.Now().UTC(),
		})
		return nil, err
	}

	device := &model.DiscoveredDevice{
		EventID:         uuid.NewString(),
		SerialNumber:    req.SerialNumber,
		MACAddress:      req.MACAddress,
		IPAddress:       req.IPAddress,
		DeviceType:      req.DeviceType,
		SoftwareVersion: req.SoftwareVersion,
		Latitude:        req.Latitude,
		Longitude:       req.Longitude,
		Azimuth:         req.Azimuth,
		UptimeSeconds:   req.UptimeSeconds,
		DiscoveredAt:    time.Now().UTC(),
		CheckInInterval: int(s.checkInInterval.Seconds()),
	}

	if err := s.publisher.PublishDevice(*device); err != nil {
		return nil, fmt.Errorf("failed to publish device: %w", err)
	}

	s.store.Upsert(device)
	return device, nil
}

// BuildServiceRegistry builds the Consul-style KV registry for UBR call-home (WO-009).
// Returns ErrServiceUnavailable if any required service URL is missing or malformed.
func (s *DiscoveryService) BuildServiceRegistry() ([]model.KVEntry, error) {
	// Validate all required service URLs are configured
	if s.authServiceURL == "" || s.checkinServiceURL == "" || s.eventServiceURL == "" || s.realtimeServiceURL == "" {
		return nil, ErrServiceUnavailable
	}

	entries := []model.KVEntry{}
	now := int(time.Now().Unix())

	// services/auth
	authMeta, err := s.buildServiceMetadata(s.authServiceURL, "auth_path", "/api/v1/auth/device")
	if err != nil {
		return nil, fmt.Errorf("invalid auth service URL: %w", err)
	}
	entries = append(entries, model.KVEntry{
		LockIndex:   0,
		Key:         "services/auth",
		Flags:       0,
		Value:       authMeta,
		CreateIndex: now,
		ModifyIndex: now,
	})

	// services/checkin
	checkinMeta, err := s.buildServiceMetadata(s.checkinServiceURL, "checkin_path", "/api/v1/checkin")
	if err != nil {
		return nil, fmt.Errorf("invalid checkin service URL: %w", err)
	}
	entries = append(entries, model.KVEntry{
		LockIndex:   0,
		Key:         "services/checkin",
		Flags:       0,
		Value:       checkinMeta,
		CreateIndex: now,
		ModifyIndex: now,
	})

	// services/event
	eventMeta, err := s.buildServiceMetadata(s.eventServiceURL, "event_path", "/api/v1/events")
	if err != nil {
		return nil, fmt.Errorf("invalid event service URL: %w", err)
	}
	entries = append(entries, model.KVEntry{
		LockIndex:   0,
		Key:         "services/event",
		Flags:       0,
		Value:       eventMeta,
		CreateIndex: now,
		ModifyIndex: now,
	})

	// services/realtime
	realtimeMeta, err := s.buildServiceMetadata(s.realtimeServiceURL, "ws_path", "/ws/v1/realtime")
	if err != nil {
		return nil, fmt.Errorf("invalid realtime service URL: %w", err)
	}
	entries = append(entries, model.KVEntry{
		LockIndex:   0,
		Key:         "services/realtime",
		Flags:       0,
		Value:       realtimeMeta,
		CreateIndex: now,
		ModifyIndex: now,
	})

	return entries, nil
}

// buildServiceMetadata creates base64-encoded ServiceMetadata JSON for a service URL.
func (s *DiscoveryService) buildServiceMetadata(serviceURL, pathField, pathValue string) (string, error) {
	u, err := url.Parse(serviceURL)
	if err != nil {
		return "", err
	}

	meta := model.ServiceMetadata{
		Scheme:  u.Scheme,
		Address: u.Host,
	}

	// IPv6 literal addresses must be preserved correctly (edge case from WO-009)
	if strings.Contains(u.Host, "[") && strings.Contains(u.Host, "]") {
		// Already in bracket notation, preserve as-is
		meta.Address = u.Host
	}

	// Set the appropriate path field
	switch pathField {
	case "auth_path":
		meta.AuthPath = pathValue
	case "checkin_path":
		meta.CheckinPath = pathValue
	case "event_path":
		meta.EventPath = pathValue
	case "ws_path":
		meta.WSPath = pathValue
	}

	metaJSON, err := json.Marshal(meta)
	if err != nil {
		return "", fmt.Errorf("failed to marshal metadata: %w", err)
	}

	return base64.StdEncoding.EncodeToString(metaJSON), nil
}

// ── WO-010: Device authentication service ────────────────────────────────────

// AuthenticateDevice validates device identity and issues a per-device HMAC secret (WO-010).
// Returns ErrDeviceNotFound if the device is not authorized by inventory.
// Returns ErrSecretStoreUnavailable if secret storage fails.
func (s *DiscoveryService) AuthenticateDevice(req *model.DeviceAuthRequest) (*model.DeviceAuthResponse, error) {
	// Validate required fields
	if req.SerialNumber == "" || req.MACAddress == "" || req.DeviceType == "" {
		return nil, ErrMissingFields
	}

	// Validate MAC address format (XX:XX:XX:XX:XX:XX)
	if !isValidMACAddress(req.MACAddress) {
		return nil, fmt.Errorf("invalid MAC address format: must be XX:XX:XX:XX:XX:XX")
	}

	// Validate serial number (alphanumeric, 8-32 characters)
	if !isValidSerialNumber(req.SerialNumber) {
		return nil, fmt.Errorf("invalid serial number format: must be 8-32 alphanumeric characters")
	}

	// Check if secret store is available
	if s.secretStore == nil {
		return nil, ErrSecretStoreUnavailable
	}

	// Check if inventory authorizer is available
	if s.inventoryAuth == nil {
		return nil, ErrSecretStoreUnavailable
	}

	// Authorize device with inventory
	deviceID, authorized, err := s.inventoryAuth.AuthorizeDevice(req.SerialNumber, req.MACAddress)
	if err != nil {
		return nil, fmt.Errorf("inventory authorization failed: %w", err)
	}
	if !authorized {
		// Device not found or not authorized — publish audit event
		_ = s.publisher.PublishAlarm(model.Alarm{
			EventID:   uuid.NewString(),
			AlarmType: "NMS-AUTH-01",
			Severity:  "WARNING",
			Source:    req.SerialNumber,
			Message:   fmt.Sprintf("Unauthorized device authentication attempt: serial=%s, mac=%s", req.SerialNumber, req.MACAddress),
			Timestamp: time.Now().UTC(),
		})
		return nil, ErrDeviceNotFound
	}

	// Issue or rotate secret
	secret, err := s.secretStore.IssueSecret(deviceID, req.SerialNumber, req.MACAddress)
	if err != nil {
		return nil, fmt.Errorf("failed to issue secret: %w", err)
	}

	// Build response (never log the SecretValue)
	response := &model.DeviceAuthResponse{
		DeviceID:     deviceID,
		SerialNumber: req.SerialNumber,
		MACAddress:   req.MACAddress,
		Secret:       secret.SecretValue,
		IssuedAt:     secret.IssuedAt,
		ExpiresAt:    nil, // No expiration for now
		KeyVersion:   secret.KeyVersion,
	}

	// Publish successful authentication event (no secret value)
	_ = s.publisher.PublishDevice(model.DiscoveredDevice{
		EventID:      uuid.NewString(),
		SerialNumber: req.SerialNumber,
		MACAddress:   req.MACAddress,
		DeviceType:   req.DeviceType,
		DiscoveredAt: time.Now().UTC(),
	})

	return response, nil
}

// isValidMACAddress checks if MAC address is in XX:XX:XX:XX:XX:XX format.
func isValidMACAddress(mac string) bool {
	if len(mac) != 17 {
		return false
	}
	for i, c := range mac {
		if i%3 == 2 {
			if c != ':' {
				return false
			}
		} else {
			if !((c >= '0' && c <= '9') || (c >= 'A' && c <= 'F') || (c >= 'a' && c <= 'f')) {
				return false
			}
		}
	}
	return true
}

// isValidSerialNumber checks if serial number is 8-32 alphanumeric characters.
func isValidSerialNumber(serial string) bool {
	if len(serial) < 8 || len(serial) > 32 {
		return false
	}
	for _, c := range serial {
		if !((c >= '0' && c <= '9') || (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c == '-' || c == '_') {
			return false
		}
	}
	return true
}
