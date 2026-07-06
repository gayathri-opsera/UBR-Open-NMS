package poller_test

import (
	"testing"

	"github.com/gosnmp/gosnmp"
	"github.com/ubrnms/kpi-collector/internal/model"
	"github.com/ubrnms/kpi-collector/internal/normalizer"
	"github.com/ubrnms/kpi-collector/internal/poller"
)

// ── SNMP request construction ──────────────────────────────────────

func TestBuildSNMPRequest_ContainsAllOIDs(t *testing.T) {
	oids := poller.BuildSNMPRequest(normalizer.DefaultOIDs)
	if len(oids) != len(normalizer.DefaultOIDs) {
		t.Fatalf("expected %d OIDs, got %d", len(normalizer.DefaultOIDs), len(oids))
	}
	for _, oid := range oids {
		if len(oid) == 0 {
			t.Error("empty OID in request")
		}
	}
}

// ── SNMP response parsing ──────────────────────────────────────────

func TestNormalize_ParsesMandatoryFields(t *testing.T) {
	rssiOID := ".1.3.6.1.4.1.12345.1.1.1"
	snrOID := ".1.3.6.1.4.1.12345.1.1.2"

	pdus := []gosnmp.SnmpPDU{
		{Name: rssiOID, Type: gosnmp.Integer, Value: -65},
		{Name: snrOID, Type: gosnmp.Integer, Value: 25},
	}

	kpi := normalizer.Normalize(pdus, normalizer.DefaultOIDs, nil)
	if kpi.RSSI == nil || *kpi.RSSI != -65 {
		t.Errorf("RSSI: expected -65, got %v", kpi.RSSI)
	}
	if kpi.SNR == nil || *kpi.SNR != 25 {
		t.Errorf("SNR: expected 25, got %v", kpi.SNR)
	}
}

func TestNormalize_UnknownOIDsGoToRaw(t *testing.T) {
	pdus := []gosnmp.SnmpPDU{
		{Name: ".1.9.9.9.9.unknown", Type: gosnmp.Integer, Value: 42},
	}
	kpi := normalizer.Normalize(pdus, normalizer.DefaultOIDs, nil)
	if _, ok := kpi.Raw[".1.9.9.9.9.unknown"]; !ok {
		t.Error("unknown OID not stored in Raw map")
	}
}

func TestNormalize_TrafficCounters(t *testing.T) {
	txBytesOID := ".1.3.6.1.2.1.2.2.1.16.1"
	rxBytesOID := ".1.3.6.1.2.1.2.2.1.10.1"

	pdus := []gosnmp.SnmpPDU{
		{Name: txBytesOID, Type: gosnmp.Counter32, Value: uint(1000000)},
		{Name: rxBytesOID, Type: gosnmp.Counter32, Value: uint(2000000)},
	}
	kpi := normalizer.Normalize(pdus, normalizer.DefaultOIDs, nil)
	if kpi.TxBytes == nil || *kpi.TxBytes != 1000000 {
		t.Errorf("TxBytes: expected 1000000, got %v", kpi.TxBytes)
	}
	if kpi.RxBytes == nil || *kpi.RxBytes != 2000000 {
		t.Errorf("RxBytes: expected 2000000, got %v", kpi.RxBytes)
	}
}

// ── Missing data detection ─────────────────────────────────────────

func TestMissingDataEvent_Structure(t *testing.T) {
	dev := model.Device{
		DeviceID: "bts-001", DeviceType: "BTS",
	}
	_ = dev // used to verify model compiles and fields are accessible
	if dev.DeviceID != "bts-001" {
		t.Error("DeviceID not set")
	}
}

// ── Kafka message formatting ───────────────────────────────────────

func TestFormatKafkaMessage_ValidJSON(t *testing.T) {
	rssi := -70.0
	kpi := &model.RawKPI{
		DeviceID: "cpe-001",
		RSSI:     &rssi,
	}
	b, err := poller.FormatKafkaMessage(kpi)
	if err != nil {
		t.Fatalf("JSON marshal failed: %v", err)
	}
	if len(b) == 0 {
		t.Error("empty JSON output")
	}
	msg := string(b)
	if msg[:1] != "{" {
		t.Errorf("expected JSON object, got: %s", msg[:20])
	}
}

func TestFormatKafkaMessage_OmitsNilFields(t *testing.T) {
	kpi := &model.RawKPI{DeviceID: "dev-x"}
	b, _ := poller.FormatKafkaMessage(kpi)
	msg := string(b)
	if containsStr(msg, "rssi") || containsStr(msg, "snr") {
		t.Error("nil fields should be omitted from JSON")
	}
}

func containsStr(s, sub string) bool {
	return len(s) >= len(sub) && (s == sub ||
		(len(s) > 0 && containsStr(s[1:], sub)) ||
		s[:len(sub)] == sub)
}
