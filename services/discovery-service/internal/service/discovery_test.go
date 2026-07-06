package service_test

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/airtel-ubrnms/discovery-service/internal/model"
	"github.com/airtel-ubrnms/discovery-service/internal/service"
)

// mockPublisher satisfies service.Publisher for testing.
type mockPublisher struct {
	devices []model.DiscoveredDevice
	alarms  []model.Alarm
}

func (m *mockPublisher) PublishDevice(d model.DiscoveredDevice) error {
	m.devices = append(m.devices, d)
	return nil
}

func (m *mockPublisher) PublishAlarm(a model.Alarm) error {
	m.alarms = append(m.alarms, a)
	return nil
}

func makeSignature(secret string, req *model.CheckInRequest) string {
	canonical := map[string]interface{}{
		"serialNumber":    req.SerialNumber,
		"macAddress":      req.MACAddress,
		"ipAddress":       req.IPAddress,
		"deviceType":      req.DeviceType,
		"softwareVersion": req.SoftwareVersion,
		"timestamp":       req.Timestamp.UTC().Format(time.RFC3339),
	}
	data, _ := json.Marshal(canonical)
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(data)
	return hex.EncodeToString(mac.Sum(nil))
}

const testSecret = "test-secret"

func newService(pub service.Publisher) *service.DiscoveryService {
	store := service.NewDeviceStore()
	return service.NewDiscoveryService(testSecret, 5*time.Minute, pub, store)
}

func TestProcessCheckIn_Success(t *testing.T) {
	pub := &mockPublisher{}
	svc := newService(pub)
	store := service.NewDeviceStore()
	svc2 := service.NewDiscoveryService(testSecret, 5*time.Minute, pub, store)

	req := &model.CheckInRequest{
		SerialNumber:    "SN-001",
		MACAddress:      "AA:BB:CC:DD:EE:FF",
		IPAddress:       "192.168.1.1",
		DeviceType:      "BTS",
		SoftwareVersion: "v1.0",
		Timestamp:       time.Now().UTC().Truncate(time.Second),
	}
	req.Signature = makeSignature(testSecret, req)

	device, err := svc2.ProcessCheckIn(req)
	if err != nil {
		t.Fatalf("expected success, got error: %v", err)
	}
	if device.SerialNumber != "SN-001" {
		t.Errorf("unexpected serial: %s", device.SerialNumber)
	}
	if len(pub.devices) != 1 {
		t.Errorf("expected 1 device published, got %d", len(pub.devices))
	}
	_ = svc
}

func TestProcessCheckIn_InvalidSignature(t *testing.T) {
	pub := &mockPublisher{}
	store := service.NewDeviceStore()
	svc := service.NewDiscoveryService(testSecret, 5*time.Minute, pub, store)

	req := &model.CheckInRequest{
		SerialNumber:    "SN-002",
		MACAddress:      "AA:BB:CC:DD:EE:01",
		IPAddress:       "192.168.1.2",
		DeviceType:      "CPE",
		SoftwareVersion: "v1.0",
		Timestamp:       time.Now().UTC().Truncate(time.Second),
		Signature:       "invalid-signature",
	}

	_, err := svc.ProcessCheckIn(req)
	if !errors.Is(err, service.ErrInvalidSignature) {
		t.Errorf("expected ErrInvalidSignature, got %v", err)
	}
	// Alarm should have been published
	if len(pub.alarms) != 1 {
		t.Errorf("expected 1 alarm published for auth failure, got %d", len(pub.alarms))
	}
	if pub.alarms[0].AlarmType != "NMS-DIS-05" {
		t.Errorf("expected alarm type NMS-DIS-05, got %s", pub.alarms[0].AlarmType)
	}
}

func TestProcessCheckIn_MissingSignature(t *testing.T) {
	pub := &mockPublisher{}
	store := service.NewDeviceStore()
	svc := service.NewDiscoveryService(testSecret, 5*time.Minute, pub, store)

	req := &model.CheckInRequest{
		SerialNumber: "SN-003",
		MACAddress:   "AA:BB:CC:DD:EE:02",
		IPAddress:    "192.168.1.3",
		Timestamp:    time.Now().UTC(),
	}

	_, err := svc.ProcessCheckIn(req)
	if !errors.Is(err, service.ErrInvalidSignature) {
		t.Errorf("expected ErrInvalidSignature for missing signature, got %v", err)
	}
}

func TestProcessCheckIn_MissingFields(t *testing.T) {
	pub := &mockPublisher{}
	store := service.NewDeviceStore()
	svc := service.NewDiscoveryService(testSecret, 5*time.Minute, pub, store)

	_, err := svc.ProcessCheckIn(&model.CheckInRequest{SerialNumber: "SN-004"})
	if !errors.Is(err, service.ErrMissingFields) {
		t.Errorf("expected ErrMissingFields, got %v", err)
	}
}

func TestDeviceStore_Lookup(t *testing.T) {
	store := service.NewDeviceStore()
	d := &model.DiscoveredDevice{
		SerialNumber: "SN-005",
		MACAddress:   "11:22:33:44:55:66",
		IPAddress:    "10.0.0.1",
	}
	store.Upsert(d)

	if found, ok := store.FindBySerial("SN-005"); !ok || found.SerialNumber != "SN-005" {
		t.Error("FindBySerial failed")
	}
	if found, ok := store.FindByMAC("11:22:33:44:55:66"); !ok || found.MACAddress != "11:22:33:44:55:66" {
		t.Error("FindByMAC failed")
	}
	if found, ok := store.FindByIP("10.0.0.1"); !ok || found.IPAddress != "10.0.0.1" {
		t.Error("FindByIP failed")
	}
	if _, ok := store.FindBySerial("nonexistent"); ok {
		t.Error("expected not found for nonexistent serial")
	}
}

func TestCheckInInterval_Config(t *testing.T) {
	pub := &mockPublisher{}
	store := service.NewDeviceStore()
	interval := 10 * time.Minute
	svc := service.NewDiscoveryService(testSecret, interval, pub, store)

	req := &model.CheckInRequest{
		SerialNumber:    "SN-006",
		MACAddress:      "AA:BB:CC:DD:EE:03",
		IPAddress:       "192.168.2.1",
		DeviceType:      "BTS",
		SoftwareVersion: "v2.0",
		Timestamp:       time.Now().UTC().Truncate(time.Second),
	}
	req.Signature = makeSignature(testSecret, req)

	device, err := svc.ProcessCheckIn(req)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if device.CheckInInterval != 600 {
		t.Errorf("expected check-in interval 600s, got %d", device.CheckInInterval)
	}
}
