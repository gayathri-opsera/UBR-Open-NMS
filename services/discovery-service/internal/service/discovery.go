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

// Publisher abstracts Kafka publishing for testability.
type Publisher interface {
	PublishDevice(d model.DiscoveredDevice) error
	PublishAlarm(a model.Alarm) error
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

// DiscoveryService handles device check-ins and service registry (WO-009).
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
}

func NewDiscoveryService(hmacSecret string, interval time.Duration, pub Publisher, store *DeviceStore) *DiscoveryService {
	return &DiscoveryService{
		hmacSecret:      hmacSecret,
		checkInInterval: interval,
		publisher:       pub,
		store:           store,
	}
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
