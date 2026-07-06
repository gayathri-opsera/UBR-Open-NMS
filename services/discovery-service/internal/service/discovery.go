// Package service implements Discovery Service business logic.
package service

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/airtel-ubrnms/discovery-service/internal/model"
	"github.com/google/uuid"
)

// ErrInvalidSignature is returned when HMAC verification fails.
var ErrInvalidSignature = errors.New("invalid HMAC-SHA256 signature")

// ErrMissingFields is returned when required check-in fields are absent.
var ErrMissingFields = errors.New("missing required check-in fields")

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

// DiscoveryService handles device check-ins.
type DiscoveryService struct {
	hmacSecret      string
	checkInInterval time.Duration
	publisher       Publisher
	store           *DeviceStore
}

func NewDiscoveryService(hmacSecret string, interval time.Duration, pub Publisher, store *DeviceStore) *DiscoveryService {
	return &DiscoveryService{
		hmacSecret:      hmacSecret,
		checkInInterval: interval,
		publisher:       pub,
		store:           store,
	}
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
