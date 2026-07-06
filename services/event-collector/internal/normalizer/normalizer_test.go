package normalizer_test

import (
	"fmt"
	"testing"
	"time"

	"github.com/gosnmp/gosnmp"
	"github.com/airtel-ubrnms/event-collector/internal/normalizer"
)

func TestNormalizeSNMPv2Trap_Basic(t *testing.T) {
	trap := &gosnmp.SnmpTrap{
		Variables: []gosnmp.SnmpPDU{
			{Name: ".1.3.6.1.6.3.1.1.4.1.0", Type: gosnmp.ObjectIdentifier, Value: "linkDown"},
		},
	}
	alarm := normalizer.NormalizeSNMPv2Trap(trap, "192.168.1.1:162")
	if alarm.DeviceID != "192.168.1.1" {
		t.Errorf("expected device ID 192.168.1.1, got %s", alarm.DeviceID)
	}
	if alarm.AlarmType != "LINK_DOWN" {
		t.Errorf("expected alarm type LINK_DOWN, got %s", alarm.AlarmType)
	}
	if alarm.Severity != "CRITICAL" {
		t.Errorf("expected severity CRITICAL, got %s", alarm.Severity)
	}
	if alarm.EventID == "" {
		t.Error("expected non-empty event ID")
	}
	if alarm.Timestamp.IsZero() {
		t.Error("expected non-zero timestamp")
	}
}

func TestNormalizeSNMPv2Trap_ColdStart(t *testing.T) {
	trap := &gosnmp.SnmpTrap{
		Variables: []gosnmp.SnmpPDU{
			{Name: ".1.3.6.1.6.3.1.1.4.1.0", Type: gosnmp.ObjectIdentifier, Value: "coldStart"},
		},
	}
	alarm := normalizer.NormalizeSNMPv2Trap(trap, "10.0.0.5:162")
	if alarm.AlarmType != "COLD_START" {
		t.Errorf("expected COLD_START, got %s", alarm.AlarmType)
	}
	if alarm.Severity != "MAJOR" {
		t.Errorf("expected MAJOR, got %s", alarm.Severity)
	}
}

func TestNormalizeSNMPv3Trap_HasVersion(t *testing.T) {
	trap := &gosnmp.SnmpTrap{
		Variables: []gosnmp.SnmpPDU{},
	}
	alarm := normalizer.NormalizeSNMPv3Trap(trap, "10.0.0.6:162")
	if alarm.RawData["snmpVersion"] != "v3" {
		t.Errorf("expected snmpVersion v3 in raw data")
	}
}

func TestNormalizeSyslog_RFC5424(t *testing.T) {
	ts := time.Now().UTC().Format(time.RFC3339)
	msg := fmt.Sprintf("<34>1 %s router1 sshd 1234 - - Failed login attempt", ts)
	alarm := normalizer.NormalizeSyslog(msg, "172.16.0.1:514")
	if alarm.DeviceID != "router1" {
		t.Errorf("expected device router1 from hostname, got %s", alarm.DeviceID)
	}
	if alarm.Severity != "CRITICAL" {
		t.Errorf("expected CRITICAL severity for facility 4/severity 2, got %s", alarm.Severity)
	}
	if alarm.Message == "" {
		t.Error("expected non-empty message")
	}
}

func TestNormalizeSyslog_NoMatch_FallbackToRaw(t *testing.T) {
	raw := "plain syslog message without RFC 5424 header"
	alarm := normalizer.NormalizeSyslog(raw, "10.0.0.9:514")
	if alarm.DeviceID != "10.0.0.9" {
		t.Errorf("expected device from addr, got %s", alarm.DeviceID)
	}
	if alarm.AlarmType != "SYSLOG" {
		t.Errorf("expected SYSLOG type, got %s", alarm.AlarmType)
	}
}

func TestNormalizeKafkaKey_IsDeviceID(t *testing.T) {
	trap := &gosnmp.SnmpTrap{Variables: []gosnmp.SnmpPDU{}}
	alarm := normalizer.NormalizeSNMPv2Trap(trap, "192.168.10.20:162")
	if alarm.DeviceID != "192.168.10.20" {
		t.Errorf("expected Kafka key == DeviceID == 192.168.10.20, got %s", alarm.DeviceID)
	}
}
