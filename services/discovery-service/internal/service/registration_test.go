package service_test

import (
	"context"
	"errors"
	"testing"

	"github.com/airtel-ubrnms/discovery-service/internal/classifier"
	"github.com/airtel-ubrnms/discovery-service/internal/model"
	"github.com/airtel-ubrnms/discovery-service/internal/service"
	sharedmodels "github.com/airtel-ubrnms/shared-libs/go/models"
)

// ── Fakes ────────────────────────────────────────────────────────────────────

type fakeRegistrar struct {
	deviceID string
	err      error
	calls    []classifier.RegistrationPayload
}

func (f *fakeRegistrar) UpsertGenericDevice(_ context.Context, payload classifier.RegistrationPayload) (string, error) {
	f.calls = append(f.calls, payload)
	return f.deviceID, f.err
}

type fakePublisher struct {
	classifiedEvents  []sharedmodels.GenericDeviceClassifiedEvent
	registeredEvents  []sharedmodels.GenericInventoryRegisteredEvent
	publishClassErr   error
	publishRegErr     error
}

func (f *fakePublisher) PublishClassificationResult(evt sharedmodels.GenericDeviceClassifiedEvent) error {
	f.classifiedEvents = append(f.classifiedEvents, evt)
	return f.publishClassErr
}

func (f *fakePublisher) PublishInventoryRegistered(evt sharedmodels.GenericInventoryRegisteredEvent) error {
	f.registeredEvents = append(f.registeredEvents, evt)
	return f.publishRegErr
}

func successFP(ip, oid string) model.SNMPFingerprintResult {
	return model.SNMPFingerprintResult{
		IP:          ip,
		RunID:       "run-test",
		Status:      model.SNMPFingerprintSuccess,
		SysObjectID: oid,
	}
}

// ── Tests ────────────────────────────────────────────────────────────────────

func TestRegister_RecognisedDevice_RegisteredAndEventsPublished(t *testing.T) {
	reg := &fakeRegistrar{deviceID: "inv-device-001"}
	pub := &fakePublisher{}
	svc := service.NewGenericRegistrationService(reg, pub)

	fp := successFP("10.0.0.1", ".1.3.6.1.4.1.9.1.1208") // Cisco Catalyst
	result := svc.Register(context.Background(), fp, "run-1")

	if result.RegistrationStatus != "REGISTERED" {
		t.Errorf("expected REGISTERED, got %s", result.RegistrationStatus)
	}
	if result.InventoryDeviceID != "inv-device-001" {
		t.Errorf("expected inv-device-001, got %s", result.InventoryDeviceID)
	}
	if result.ClassificationStatus != classifier.ClassificationRecognised {
		t.Errorf("expected RECOGNISED, got %s", result.ClassificationStatus)
	}
	if result.Vendor != "Cisco" {
		t.Errorf("expected Cisco, got %s", result.Vendor)
	}
	if result.GenericDeviceType != "SWITCH" {
		t.Errorf("expected SWITCH, got %s", result.GenericDeviceType)
	}
	// Both events must be published for the recognised path.
	if len(pub.classifiedEvents) != 1 {
		t.Errorf("expected 1 classification event, got %d", len(pub.classifiedEvents))
	}
	if len(pub.registeredEvents) != 1 {
		t.Errorf("expected 1 registered event, got %d", len(pub.registeredEvents))
	}
	if pub.registeredEvents[0].InventoryDeviceID != "inv-device-001" {
		t.Errorf("expected inventoryDeviceId inv-device-001 in registered event, got %s",
			pub.registeredEvents[0].InventoryDeviceID)
	}
}

func TestRegister_DeferredDevice_NoInventoryUpsert(t *testing.T) {
	reg := &fakeRegistrar{deviceID: "should-not-be-used"}
	pub := &fakePublisher{}
	svc := service.NewGenericRegistrationService(reg, pub)

	fp := successFP("10.0.0.2", ".1.3.6.1.4.1.99999.1") // unknown OID
	result := svc.Register(context.Background(), fp, "run-2")

	if result.RegistrationStatus != "DEFERRED" {
		t.Errorf("expected DEFERRED, got %s", result.RegistrationStatus)
	}
	if len(reg.calls) != 0 {
		t.Errorf("expected no inventory upsert calls for deferred device, got %d", len(reg.calls))
	}
	if len(pub.classifiedEvents) != 1 {
		t.Errorf("expected 1 classification event for deferred device, got %d", len(pub.classifiedEvents))
	}
	if len(pub.registeredEvents) != 1 {
		t.Errorf("expected 1 registered event even for deferred, got %d", len(pub.registeredEvents))
	}
	if pub.registeredEvents[0].RegistrationStatus != "DEFERRED" {
		t.Errorf("expected DEFERRED in registered event, got %s", pub.registeredEvents[0].RegistrationStatus)
	}
}

func TestRegister_InventoryUpsertFails_ReturnsError(t *testing.T) {
	reg := &fakeRegistrar{err: errors.New("connection refused")}
	pub := &fakePublisher{}
	svc := service.NewGenericRegistrationService(reg, pub)

	fp := successFP("10.0.0.3", ".1.3.6.1.4.1.9.1.100") // Cisco Catalyst (RECOGNISED)
	result := svc.Register(context.Background(), fp, "run-3")

	if result.RegistrationStatus != "ERROR" {
		t.Errorf("expected ERROR on inventory failure, got %s", result.RegistrationStatus)
	}
	if result.DeferReason != "INVENTORY_UPSERT_FAILED" {
		t.Errorf("expected INVENTORY_UPSERT_FAILED, got %s", result.DeferReason)
	}
	// Event publication must still be attempted.
	if len(pub.registeredEvents) != 1 {
		t.Errorf("expected 1 registered event even on error, got %d", len(pub.registeredEvents))
	}
}

func TestRegister_KafkaPublishFails_DeviceStillRegistered(t *testing.T) {
	reg := &fakeRegistrar{deviceID: "inv-device-002"}
	pub := &fakePublisher{publishClassErr: errors.New("kafka unavailable")}
	svc := service.NewGenericRegistrationService(reg, pub)

	fp := successFP("10.0.0.4", ".1.3.6.1.4.1.9.1.1000") // Cisco
	result := svc.Register(context.Background(), fp, "run-4")

	// Device should still be registered even though Kafka publish failed.
	if result.RegistrationStatus != "REGISTERED" {
		t.Errorf("expected REGISTERED despite kafka failure, got %s", result.RegistrationStatus)
	}
	if result.EventPublishErr == nil {
		t.Error("expected non-nil EventPublishErr when kafka fails")
	}
}

func TestRegister_CorrelationIDGenerated_WhenAbsent(t *testing.T) {
	reg := &fakeRegistrar{deviceID: "inv-device-003"}
	pub := &fakePublisher{}
	svc := service.NewGenericRegistrationService(reg, pub)

	fp := model.SNMPFingerprintResult{
		IP:          "10.0.0.5",
		RunID:       "run-5",
		Status:      model.SNMPFingerprintSuccess,
		SysObjectID: ".1.3.6.1.4.1.9.1.500",
		CorrelationID: "", // empty — should be auto-generated
	}
	result := svc.Register(context.Background(), fp, "run-5")

	if result.CorrelationID == "" {
		t.Error("expected auto-generated correlationId, got empty")
	}
}

func TestRegister_AuthorityMetadata_SetToGenericForNewDevice(t *testing.T) {
	reg := &fakeRegistrar{deviceID: "inv-device-004"}
	pub := &fakePublisher{}
	svc := service.NewGenericRegistrationService(reg, pub)

	fp := successFP("10.0.0.6", ".1.3.6.1.4.1.9.1.200") // Cisco
	svc.Register(context.Background(), fp, "run-6")

	if len(reg.calls) != 1 {
		t.Fatalf("expected 1 inventory upsert, got %d", len(reg.calls))
	}
	payload := reg.calls[0]
	if payload.DiscoveryParadigm != "GENERIC_SNMP" {
		t.Errorf("expected GENERIC_SNMP, got %s", payload.DiscoveryParadigm)
	}
	if payload.IdentityAuthority != "GENERIC" {
		t.Errorf("expected GENERIC identity authority, got %s", payload.IdentityAuthority)
	}
	if payload.OnlineStateAuthority != "GENERIC" {
		t.Errorf("expected GENERIC online-state authority, got %s", payload.OnlineStateAuthority)
	}
}

func TestRegister_FailedFingerprint_ClassificationError(t *testing.T) {
	reg := &fakeRegistrar{}
	pub := &fakePublisher{}
	svc := service.NewGenericRegistrationService(reg, pub)

	fp := model.SNMPFingerprintResult{
		IP:              "10.0.0.7",
		RunID:           "run-7",
		Status:          model.SNMPFingerprintFailed,
		FailureCategory: model.FingerprintCategoryTimeout,
	}
	result := svc.Register(context.Background(), fp, "run-7")

	if result.RegistrationStatus != "DEFERRED" {
		t.Errorf("expected DEFERRED for failed fingerprint, got %s", result.RegistrationStatus)
	}
	if len(reg.calls) != 0 {
		t.Error("expected no inventory upsert for classification-errored device")
	}
}
