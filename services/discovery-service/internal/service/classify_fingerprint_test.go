package service

import (
	"context"
	"testing"
	"time"

	"github.com/airtel-ubrnms/discovery-service/internal/fingerprint"
	"github.com/airtel-ubrnms/discovery-service/internal/model"
)

func executorWithRegistry(deviceType string) *RunExecutor {
	reader := fingerprint.NewInMemoryRegistryReader([]fingerprint.RegistryEntry{{
		RegistryEntryID:     "reg-ubr655-001",
		ProductDefinitionID: "eoc-ubr655",
		RegistryVersion:     "rv-001",
		Vendor:              "EOC",
		Model:               "UBR655",
		DeviceType:          deviceType,
		SNMPOIDPrefix:       ".1.3.6.1.4.1.52619",
		CreatedAt:           time.Now().UTC(),
	}}, "rv-001")
	return NewRunExecutor(nil, nil).WithFingerprintMatcher(fingerprint.NewMatcher(fingerprint.NewRegistryClient(reader, 0)))
}

func ubrFingerprint(oid string) model.SNMPFingerprintResult {
	return model.SNMPFingerprintResult{
		IP: "10.0.150.16", RunID: "run-1", Status: model.SNMPFingerprintSuccess,
		SysObjectID: oid, SysDescr: "Linux UBR655 4.4.60 #1 SMP PREEMPT armv7l",
	}
}

// A registry match on a definition that declares no device type used to label every UBR radio a SWITCH.
func TestClassifyFingerprint_RegistryMatchWithoutDeviceType_UsesTheOIDMapNotSwitch(t *testing.T) {
	for _, oid := range []string{".1.3.6.1.4.1.52619", ".1.3.6.1.4.1.14125.123"} { // old and new firmware root
		got := executorWithRegistry("").classifyFingerprint(context.Background(), ubrFingerprint(oid))
		if got.GenericDeviceType != "RADIO" || got.Vendor != "EOC" || got.Model != "UBR655" {
			t.Errorf("%s: got vendor=%q model=%q type=%q, want EOC UBR655 RADIO", oid, got.Vendor, got.Model, got.GenericDeviceType)
		}
	}
}

func TestClassifyFingerprint_DeclaredDeviceTypeStillWins(t *testing.T) {
	got := executorWithRegistry("GATEWAY").classifyFingerprint(context.Background(), ubrFingerprint(".1.3.6.1.4.1.14125.123"))
	if got.GenericDeviceType != "GATEWAY" {
		t.Fatalf("type = %q, want GATEWAY (the definition's own type)", got.GenericDeviceType)
	}
}
