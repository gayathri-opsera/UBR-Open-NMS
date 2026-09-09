package classifier_test

import (
	"testing"

	"github.com/airtel-ubrnms/discovery-service/internal/classifier"
	"github.com/airtel-ubrnms/discovery-service/internal/model"
)

func successFingerprint(ip, runID, oid, descr string) model.SNMPFingerprintResult {
	return model.SNMPFingerprintResult{
		IP:          ip,
		RunID:       runID,
		Status:      model.SNMPFingerprintSuccess,
		SysObjectID: oid,
		SysDescr:    descr,
	}
}

func partialFingerprint(ip, runID, oid, descr string) model.SNMPFingerprintResult {
	return model.SNMPFingerprintResult{
		IP:          ip,
		RunID:       runID,
		Status:      model.SNMPFingerprintPartial,
		SysObjectID: oid,
		SysDescr:    descr,
	}
}

func failedFingerprint(ip, runID string, cat model.FingerprintFailureCategory) model.SNMPFingerprintResult {
	return model.SNMPFingerprintResult{
		IP:              ip,
		RunID:           runID,
		Status:          model.SNMPFingerprintFailed,
		FailureCategory: cat,
	}
}

// ── OID-based classification ─────────────────────────────────────────────────

func TestClassify_CiscoSwitch_RecognisedByOID(t *testing.T) {
	fp := successFingerprint("10.0.0.1", "run-1", ".1.3.6.1.4.1.9.1.1208", "Cisco IOS")
	result := classifier.Classify(fp, "corr-1")

	if result.Status != classifier.ClassificationRecognised {
		t.Fatalf("expected RECOGNISED, got %s", result.Status)
	}
	if result.Vendor != "Cisco" {
		t.Errorf("expected vendor Cisco, got %s", result.Vendor)
	}
	if result.GenericDeviceType != "SWITCH" {
		t.Errorf("expected SWITCH, got %s", result.GenericDeviceType)
	}
	if result.CapabilityProfileID == "" {
		t.Error("expected non-empty CapabilityProfileID")
	}
	if result.DriverID == "" {
		t.Error("expected non-empty DriverID")
	}
	if result.CorrelationID != "corr-1" {
		t.Errorf("expected corr-1, got %s", result.CorrelationID)
	}
}

func TestClassify_JuniperRouter_RecognisedByOID(t *testing.T) {
	fp := successFingerprint("10.0.0.2", "run-2", ".1.3.6.1.4.1.2636.1.1", "")
	result := classifier.Classify(fp, "corr-2")

	if result.Status != classifier.ClassificationRecognised {
		t.Fatalf("expected RECOGNISED, got %s", result.Status)
	}
	if result.Vendor != "Juniper" {
		t.Errorf("expected Juniper, got %s", result.Vendor)
	}
	if result.GenericDeviceType != "ROUTER" {
		t.Errorf("expected ROUTER, got %s", result.GenericDeviceType)
	}
}

func TestClassify_FortinetFirewall_RecognisedByOID(t *testing.T) {
	fp := successFingerprint("10.0.0.3", "run-3", ".1.3.6.1.4.1.12356.101.1.1", "")
	result := classifier.Classify(fp, "corr-3")

	if result.Status != classifier.ClassificationRecognised {
		t.Fatalf("expected RECOGNISED, got %s", result.Status)
	}
	if result.GenericDeviceType != "FIREWALL" {
		t.Errorf("expected FIREWALL, got %s", result.GenericDeviceType)
	}
}

func TestClassify_UnknownOID_DeferredNotInScope(t *testing.T) {
	fp := successFingerprint("10.0.0.4", "run-4", ".1.3.6.1.4.1.99999.1.1", "some unknown device")
	result := classifier.Classify(fp, "corr-4")

	if result.Status != classifier.ClassificationDeferred {
		t.Fatalf("expected DEFERRED_UNSUPPORTED, got %s", result.Status)
	}
	if result.DeferReason != "OID_NOT_IN_RELEASE_SCOPE" {
		t.Errorf("unexpected defer reason: %s", result.DeferReason)
	}
}

// ── Partial fingerprint (OID absent, sysDescr present) ──────────────────────

func TestClassify_PartialNoOID_CiscoDescr_Recognised(t *testing.T) {
	fp := partialFingerprint("10.0.0.5", "run-5", "", "Cisco IOS Software, Version 15.1")
	result := classifier.Classify(fp, "corr-5")

	if result.Status != classifier.ClassificationRecognised {
		t.Fatalf("expected RECOGNISED via sysDescr heuristic, got %s (reason: %s)", result.Status, result.DeferReason)
	}
	if result.Vendor != "Cisco" {
		t.Errorf("expected Cisco, got %s", result.Vendor)
	}
}

func TestClassify_PartialNoOID_LinuxDescr_Recognised(t *testing.T) {
	fp := partialFingerprint("10.0.0.6", "run-6", "", "Linux ubuntu-host 5.15.0-amd64")
	result := classifier.Classify(fp, "corr-6")

	if result.Status != classifier.ClassificationRecognised {
		t.Fatalf("expected RECOGNISED, got %s", result.Status)
	}
	if result.GenericDeviceType != "SERVER" {
		t.Errorf("expected SERVER, got %s", result.GenericDeviceType)
	}
}

func TestClassify_PartialNoOIDNoDescr_DeferredInsufficientEvidence(t *testing.T) {
	fp := partialFingerprint("10.0.0.7", "run-7", "", "")
	result := classifier.Classify(fp, "corr-7")

	if result.Status != classifier.ClassificationDeferred {
		t.Fatalf("expected DEFERRED_UNSUPPORTED, got %s", result.Status)
	}
	if result.DeferReason != "INSUFFICIENT_FINGERPRINT_EVIDENCE" {
		t.Errorf("unexpected defer reason: %s", result.DeferReason)
	}
}

// ── Failed fingerprint ────────────────────────────────────────────────────────

func TestClassify_FingerprintFailed_ClassificationError(t *testing.T) {
	fp := failedFingerprint("10.0.0.8", "run-8", model.FingerprintCategoryTimeout)
	result := classifier.Classify(fp, "corr-8")

	if result.Status != classifier.ClassificationError {
		t.Fatalf("expected CLASSIFICATION_ERROR, got %s", result.Status)
	}
	if result.DeferReason == "" {
		t.Error("expected non-empty DeferReason for failed fingerprint")
	}
}

// ── MergeRegistrationPayload authority rules ─────────────────────────────────

func TestMerge_NewGenericDevice_SetsAuthorityFieldsToGeneric(t *testing.T) {
	fp := successFingerprint("10.0.0.9", "run-9", ".1.3.6.1.4.1.9.1.100", "Cisco IOS 15.2")
	cl := classifier.Classify(fp, "corr-9")

	payload := classifier.MergeRegistrationPayload(fp, cl, "")

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

func TestMerge_UBRCallHomeDevice_AuthorityFieldsNotOverwritten(t *testing.T) {
	fp := successFingerprint("10.0.0.10", "run-10", ".1.3.6.1.4.1.9.1.100", "Cisco IOS 15.2")
	cl := classifier.Classify(fp, "corr-10")

	payload := classifier.MergeRegistrationPayload(fp, cl, "UBR_CALL_HOME")

	// Authority fields must remain empty — the caller will retain UBR values.
	if payload.DiscoveryParadigm != "" {
		t.Errorf("expected empty DiscoveryParadigm for UBR device, got %s", payload.DiscoveryParadigm)
	}
	if payload.IdentityAuthority != "" {
		t.Errorf("expected empty IdentityAuthority for UBR device, got %s", payload.IdentityAuthority)
	}
}

func TestMerge_DeferredDevice_IncludesDeferReason(t *testing.T) {
	fp := successFingerprint("10.0.0.11", "run-11", ".1.3.6.1.4.1.99999.1", "unknown")
	cl := classifier.Classify(fp, "corr-11")

	payload := classifier.MergeRegistrationPayload(fp, cl, "")

	if payload.ClassificationStatus != string(classifier.ClassificationDeferred) {
		t.Errorf("expected DEFERRED_UNSUPPORTED, got %s", payload.ClassificationStatus)
	}
	if payload.DeferReason == "" {
		t.Error("expected non-empty DeferReason")
	}
}

// ── WO-004: Expanded vendor OID mappings ─────────────────────────────────────

func TestClassify_HuaweiSwitch_RecognisedByOID(t *testing.T) {
	fp := successFingerprint("10.1.0.1", "run-wo4-1", ".1.3.6.1.4.1.2011.2.23.1", "Huawei Quidway S5700")
	result := classifier.Classify(fp, "corr-wo4-1")

	if result.Status != classifier.ClassificationRecognised {
		t.Fatalf("expected RECOGNISED, got %s (reason: %s)", result.Status, result.DeferReason)
	}
	if result.Vendor != "Huawei" {
		t.Errorf("expected Huawei, got %s", result.Vendor)
	}
	if result.GenericDeviceType != "SWITCH" {
		t.Errorf("expected SWITCH, got %s", result.GenericDeviceType)
	}
	if result.CapabilityProfileID == "" {
		t.Error("expected non-empty CapabilityProfileID")
	}
}

func TestClassify_HuaweiRouter_RecognisedByOID(t *testing.T) {
	fp := successFingerprint("10.1.0.2", "run-wo4-2", ".1.3.6.1.4.1.2011.5.25.100", "Huawei NE40E Router")
	result := classifier.Classify(fp, "corr-wo4-2")

	if result.Status != classifier.ClassificationRecognised {
		t.Fatalf("expected RECOGNISED, got %s", result.Status)
	}
	if result.Vendor != "Huawei" {
		t.Errorf("expected Huawei, got %s", result.Vendor)
	}
	if result.GenericDeviceType != "ROUTER" {
		t.Errorf("expected ROUTER, got %s", result.GenericDeviceType)
	}
}

func TestClassify_Nokia7750SR_RecognisedByOID(t *testing.T) {
	fp := successFingerprint("10.1.0.3", "run-wo4-3", ".1.3.6.1.4.1.637.61.1.1", "Nokia 7750 SR-12")
	result := classifier.Classify(fp, "corr-wo4-3")

	if result.Status != classifier.ClassificationRecognised {
		t.Fatalf("expected RECOGNISED, got %s", result.Status)
	}
	if result.Vendor != "Nokia" {
		t.Errorf("expected Nokia, got %s", result.Vendor)
	}
	if result.GenericDeviceType != "ROUTER" {
		t.Errorf("expected ROUTER, got %s", result.GenericDeviceType)
	}
}

func TestClassify_NokiaTiMOS_RecognisedByOID(t *testing.T) {
	fp := successFingerprint("10.1.0.4", "run-wo4-4", ".1.3.6.1.4.1.6527.1.1.2.21.1", "TiMOS-B-21.2.R1")
	result := classifier.Classify(fp, "corr-wo4-4")

	if result.Status != classifier.ClassificationRecognised {
		t.Fatalf("expected RECOGNISED, got %s", result.Status)
	}
	if result.Vendor != "Nokia" {
		t.Errorf("expected Nokia, got %s", result.Vendor)
	}
}

func TestClassify_EricssonMINILINK_RecognisedByOID(t *testing.T) {
	fp := successFingerprint("10.1.0.5", "run-wo4-5", ".1.3.6.1.4.1.193.81.1", "Ericsson MINI-LINK Traffic Node")
	result := classifier.Classify(fp, "corr-wo4-5")

	if result.Status != classifier.ClassificationRecognised {
		t.Fatalf("expected RECOGNISED, got %s", result.Status)
	}
	if result.Vendor != "Ericsson" {
		t.Errorf("expected Ericsson, got %s", result.Vendor)
	}
	if result.GenericDeviceType != "ROUTER" {
		t.Errorf("expected ROUTER, got %s", result.GenericDeviceType)
	}
}

func TestClassify_EricssonRBS_RecognisedByOID(t *testing.T) {
	fp := successFingerprint("10.1.0.6", "run-wo4-6", ".1.3.6.1.4.1.193.140.1", "Ericsson Radio Base Station")
	result := classifier.Classify(fp, "corr-wo4-6")

	if result.Status != classifier.ClassificationRecognised {
		t.Fatalf("expected RECOGNISED, got %s", result.Status)
	}
	if result.Vendor != "Ericsson" {
		t.Errorf("expected Ericsson, got %s", result.Vendor)
	}
}

func TestClassify_ZTESwitch_RecognisedByOID(t *testing.T) {
	fp := successFingerprint("10.1.0.7", "run-wo4-7", ".1.3.6.1.4.1.3902.1082.10", "ZTE ZXR10 5960 Switch")
	result := classifier.Classify(fp, "corr-wo4-7")

	if result.Status != classifier.ClassificationRecognised {
		t.Fatalf("expected RECOGNISED, got %s", result.Status)
	}
	if result.Vendor != "ZTE" {
		t.Errorf("expected ZTE, got %s", result.Vendor)
	}
	if result.GenericDeviceType != "SWITCH" {
		t.Errorf("expected SWITCH, got %s", result.GenericDeviceType)
	}
}

func TestClassify_ZTERouter_RecognisedByOID(t *testing.T) {
	fp := successFingerprint("10.1.0.8", "run-wo4-8", ".1.3.6.1.4.1.3902.1015.1", "ZTE ZXR10 Router")
	result := classifier.Classify(fp, "corr-wo4-8")

	if result.Status != classifier.ClassificationRecognised {
		t.Fatalf("expected RECOGNISED, got %s", result.Status)
	}
	if result.Vendor != "ZTE" {
		t.Errorf("expected ZTE, got %s", result.Vendor)
	}
	if result.GenericDeviceType != "ROUTER" {
		t.Errorf("expected ROUTER, got %s", result.GenericDeviceType)
	}
}

func TestClassify_MikroTikRouter_RecognisedByOID(t *testing.T) {
	fp := successFingerprint("10.1.0.9", "run-wo4-9", ".1.3.6.1.4.1.14988.1.1", "MikroTik RouterOS 6.49")
	result := classifier.Classify(fp, "corr-wo4-9")

	if result.Status != classifier.ClassificationRecognised {
		t.Fatalf("expected RECOGNISED, got %s", result.Status)
	}
	if result.Vendor != "MikroTik" {
		t.Errorf("expected MikroTik, got %s", result.Vendor)
	}
	if result.GenericDeviceType != "ROUTER" {
		t.Errorf("expected ROUTER, got %s", result.GenericDeviceType)
	}
}

func TestClassify_AristaSwitch_RecognisedByOID(t *testing.T) {
	fp := successFingerprint("10.1.0.10", "run-wo4-10", ".1.3.6.1.4.1.30065.1.1", "Arista Networks EOS 4.28")
	result := classifier.Classify(fp, "corr-wo4-10")

	if result.Status != classifier.ClassificationRecognised {
		t.Fatalf("expected RECOGNISED, got %s", result.Status)
	}
	if result.Vendor != "Arista" {
		t.Errorf("expected Arista, got %s", result.Vendor)
	}
	if result.GenericDeviceType != "SWITCH" {
		t.Errorf("expected SWITCH, got %s", result.GenericDeviceType)
	}
	if result.CapabilityProfileID == "" {
		t.Error("expected non-empty CapabilityProfileID")
	}
	if result.DriverID == "" {
		t.Error("expected non-empty DriverID")
	}
}

// ── OID normalisation edge cases ─────────────────────────────────────────────

func TestClassify_LongestPrefixWins(t *testing.T) {
	// .1.3.6.1.4.1.9.9.5 (ASA/firewall) is a longer match than .1.3.6.1.4.1.9.1 (Catalyst switch)
	fp := successFingerprint("10.0.0.12", "run-12", ".1.3.6.1.4.1.9.9.5.1", "")
	result := classifier.Classify(fp, "corr-12")

	if result.Status != classifier.ClassificationRecognised {
		t.Fatalf("expected RECOGNISED, got %s", result.Status)
	}
	if result.GenericDeviceType != "FIREWALL" {
		t.Errorf("expected FIREWALL for ASA OID, got %s", result.GenericDeviceType)
	}
}
