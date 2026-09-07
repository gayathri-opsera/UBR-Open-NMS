package handler

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/airtel-ubrnms/discovery-service/internal/model"
)

// ── Fakes ─────────────────────────────────────────────────────────────────────

type fakeInventory struct {
	resp *CheckInUpsertResponse
	err  error
}

func (f *fakeInventory) UpsertCheckIn(_ context.Context, _ *CheckInUpsertRequest) (*CheckInUpsertResponse, error) {
	return f.resp, f.err
}

type fakePublisher struct {
	published []CheckInKafkaEvent
	err       error
}

func (f *fakePublisher) PublishCheckInEvent(_ context.Context, ev CheckInKafkaEvent) error {
	if f.err != nil {
		return f.err
	}
	f.published = append(f.published, ev)
	return nil
}

// ── Helpers ───────────────────────────────────────────────────────────────────

func validCheckinRequest() *model.CheckInRequest {
	return &model.CheckInRequest{
		SerialNumber:        "SN-001",
		MACAddress:          "AA:BB:CC:DD:EE:FF",
		IPAddress:           "10.1.1.1",
		DeviceType:          "BTS",
		FirmwareVersion:     "v2.4.1",
		SoftwareVersion:     "v2.4.1-release",
		CapabilityProfileID: "profile-001",
		ConfigVersion:       "cfg-42",
		UptimeSeconds:       86400,
		Timestamp:           time.Now(),
	}
}

// ── Tests ─────────────────────────────────────────────────────────────────────

func TestCheckInProcessor_HappyPath_NoChange(t *testing.T) {
	inv := &fakeInventory{
		resp: &CheckInUpsertResponse{
			DeviceID:             "dev-001",
			Assigned:             true,
			CurrentConfigVersion: "cfg-42", // same as reported — no change
		},
	}
	pub := &fakePublisher{}
	proc := NewCheckInProcessor(inv, pub, 300)

	req := validCheckinRequest()
	rec := httptest.NewRecorder()

	proc.Process(context.Background(), rec, req, "corr-001")

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	var body model.CheckInResponse
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if body.ConfigAction != "NO_CHANGE" {
		t.Errorf("expected NO_CHANGE, got %q", body.ConfigAction)
	}
	if body.DeviceID != "dev-001" {
		t.Errorf("expected deviceId dev-001, got %q", body.DeviceID)
	}
}

func TestCheckInProcessor_HappyPath_ConfigAvailable(t *testing.T) {
	inv := &fakeInventory{
		resp: &CheckInUpsertResponse{
			DeviceID:             "dev-001",
			Assigned:             true,
			CurrentConfigVersion: "cfg-43", // newer than device
		},
	}
	pub := &fakePublisher{}
	proc := NewCheckInProcessor(inv, pub, 300)

	req := validCheckinRequest()
	rec := httptest.NewRecorder()

	proc.Process(context.Background(), rec, req, "corr-002")

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	var body model.CheckInResponse
	_ = json.NewDecoder(rec.Body).Decode(&body)
	if body.ConfigAction != "CONFIG_AVAILABLE" {
		t.Errorf("expected CONFIG_AVAILABLE, got %q", body.ConfigAction)
	}
}

func TestCheckInProcessor_UnknownDevice_AssignmentRequired(t *testing.T) {
	inv := &fakeInventory{
		resp: &CheckInUpsertResponse{DeviceID: "SN-001", Assigned: false},
	}
	pub := &fakePublisher{}
	proc := NewCheckInProcessor(inv, pub, 300)

	req := validCheckinRequest()
	rec := httptest.NewRecorder()

	proc.Process(context.Background(), rec, req, "corr-003")

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	var body model.CheckInResponse
	_ = json.NewDecoder(rec.Body).Decode(&body)
	if body.ConfigAction != "ASSIGNMENT_REQUIRED" {
		t.Errorf("expected ASSIGNMENT_REQUIRED, got %q", body.ConfigAction)
	}
}

func TestCheckInProcessor_UnsupportedDeviceType_Returns400(t *testing.T) {
	inv := &fakeInventory{}
	pub := &fakePublisher{}
	proc := NewCheckInProcessor(inv, pub, 300)

	req := validCheckinRequest()
	req.DeviceType = "UNKNOWN"

	rec := httptest.NewRecorder()
	proc.Process(context.Background(), rec, req, "corr-004")

	if rec.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for unsupported device type, got %d", rec.Code)
	}
}

func TestCheckInProcessor_MissingSerialNumber_Returns400(t *testing.T) {
	inv := &fakeInventory{}
	pub := &fakePublisher{}
	proc := NewCheckInProcessor(inv, pub, 300)

	req := validCheckinRequest()
	req.SerialNumber = ""

	rec := httptest.NewRecorder()
	proc.Process(context.Background(), rec, req, "corr-005")

	if rec.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for missing serial number, got %d", rec.Code)
	}
}

func TestCheckInProcessor_InventoryTransientError_Returns503(t *testing.T) {
	inv := &fakeInventory{
		err: errors.New("connection refused: inventory not ready"),
	}
	pub := &fakePublisher{}
	proc := NewCheckInProcessor(inv, pub, 300)

	req := validCheckinRequest()
	rec := httptest.NewRecorder()

	proc.Process(context.Background(), rec, req, "corr-006")

	if rec.Code != http.StatusServiceUnavailable {
		t.Errorf("expected 503 for retryable error, got %d", rec.Code)
	}
}

func TestCheckInProcessor_InventoryNonRetryableError_Returns500(t *testing.T) {
	inv := &fakeInventory{
		err: errors.New("fatal: database corruption"),
	}
	pub := &fakePublisher{}
	proc := NewCheckInProcessor(inv, pub, 300)

	req := validCheckinRequest()
	rec := httptest.NewRecorder()

	proc.Process(context.Background(), rec, req, "corr-007")

	if rec.Code != http.StatusInternalServerError {
		t.Errorf("expected 500 for non-retryable error, got %d", rec.Code)
	}
}

func TestCheckInProcessor_BootstrapStateTransition(t *testing.T) {
	var capturedReq *CheckInUpsertRequest
	inv := &fakeInventory{
		resp: &CheckInUpsertResponse{DeviceID: "dev-001", Assigned: true, CurrentConfigVersion: "cfg-42"},
	}

	// Use a capturing inventory client to inspect what was sent
	type capturingInv struct {
		*fakeInventory
	}
	capInv := &struct {
		fakeInventory
		req *CheckInUpsertRequest
	}{fakeInventory: *inv}
	_ = capInv // suppress unused

	pub := &fakePublisher{}
	proc := NewCheckInProcessor(&fakeInventory{
		resp: &CheckInUpsertResponse{DeviceID: "dev-001", Assigned: true, CurrentConfigVersion: "cfg-42"},
	}, pub, 300)

	req := validCheckinRequest()
	rec := httptest.NewRecorder()
	proc.Process(context.Background(), rec, req, "corr-008")

	// capturedReq cannot be inspected here without a capturing fake — but we can
	// confirm the upsert request builder encodes the correct state
	upsert := buildUpsertRequest(req, time.Now())
	if upsert.BootstrapState != model.BootstrapStateCheckInReceived {
		t.Errorf("expected bootstrapState CHECK_IN_RECEIVED, got %q", upsert.BootstrapState)
	}
	if upsert.IdentityAuthority != "call-home" {
		t.Errorf("expected identityAuthority call-home, got %q", upsert.IdentityAuthority)
	}
	_ = capturedReq
}

func TestCheckInProcessor_GPSZeroValues_NilInUpsert(t *testing.T) {
	req := validCheckinRequest()
	req.Latitude = 0
	req.Longitude = 0

	upsert := buildUpsertRequest(req, time.Now())
	if upsert.Latitude != nil || upsert.Longitude != nil {
		t.Error("expected nil latitude/longitude when zero (pending commissioning)")
	}
}

func TestCheckInProcessor_GPSNonZero_IncludedInUpsert(t *testing.T) {
	req := validCheckinRequest()
	req.Latitude = 13.0827
	req.Longitude = 80.2707

	upsert := buildUpsertRequest(req, time.Now())
	if upsert.Latitude == nil || upsert.Longitude == nil {
		t.Error("expected latitude/longitude populated when non-zero")
	}
	if *upsert.Latitude != 13.0827 {
		t.Errorf("expected latitude 13.0827, got %v", *upsert.Latitude)
	}
}

func TestDetermineConfigAction_Assignment(t *testing.T) {
	resp := &CheckInUpsertResponse{Assigned: false}
	if got := determineConfigAction("v1", resp); got != "ASSIGNMENT_REQUIRED" {
		t.Errorf("expected ASSIGNMENT_REQUIRED, got %q", got)
	}
}

func TestDetermineConfigAction_NoChange(t *testing.T) {
	resp := &CheckInUpsertResponse{Assigned: true, CurrentConfigVersion: "v1"}
	if got := determineConfigAction("v1", resp); got != "NO_CHANGE" {
		t.Errorf("expected NO_CHANGE, got %q", got)
	}
}

func TestDetermineConfigAction_Available(t *testing.T) {
	resp := &CheckInUpsertResponse{Assigned: true, CurrentConfigVersion: "v2"}
	if got := determineConfigAction("v1", resp); got != "CONFIG_AVAILABLE" {
		t.Errorf("expected CONFIG_AVAILABLE, got %q", got)
	}
}

func TestIsRetryable(t *testing.T) {
	if !isRetryable(errors.New("connection refused")) {
		t.Error("expected connection refused to be retryable")
	}
	if !isRetryable(errors.New("timeout waiting for response")) {
		t.Error("expected timeout to be retryable")
	}
	if isRetryable(errors.New("fatal error")) {
		t.Error("fatal error should not be retryable")
	}
	if isRetryable(nil) {
		t.Error("nil error should not be retryable")
	}
}
