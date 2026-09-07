package scanner

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/airtel-ubrnms/discovery-service/internal/model"
)

// ── Fakes ─────────────────────────────────────────────────────────────────────

type fakeSNMPClient struct {
	values map[string]string
	err    error
}

func (f *fakeSNMPClient) GetOIDs(_ context.Context, _ string, _ []string) (map[string]string, error) {
	return f.values, f.err
}

type fakeCred struct {
	ref   string
	found bool
	err   error
}

func (c *fakeCred) ResolveCredential(_ string) (string, bool, error) {
	return c.ref, c.found, c.err
}

func newFP(client *fakeSNMPClient, cred *fakeCred) *SNMPFingerprinter {
	return NewSNMPFingerprinter(client, cred, 100*time.Millisecond)
}

// ── Tests ─────────────────────────────────────────────────────────────────────

func TestFingerprint_Success(t *testing.T) {
	fp := newFP(
		&fakeSNMPClient{values: map[string]string{
			OIDSysDescr:    "Cisco IOS Software, Version 12.4",
			OIDSysObjectID: ".1.3.6.1.4.1.9.1.1",
		}},
		&fakeCred{ref: "ref-001", found: true},
	)
	res := fp.Fingerprint(context.Background(), "10.0.0.1", "run-1", "corr-1")
	if res.Status != model.SNMPFingerprintSuccess {
		t.Errorf("expected success, got %s (category: %s)", res.Status, res.FailureCategory)
	}
	if res.SysObjectID != ".1.3.6.1.4.1.9.1.1" {
		t.Errorf("unexpected sysObjectID: %q", res.SysObjectID)
	}
	if res.SysDescr == "" {
		t.Error("expected sysDescr to be non-empty")
	}
}

func TestFingerprint_OIDWithoutLeadingDot_Normalised(t *testing.T) {
	fp := newFP(
		&fakeSNMPClient{values: map[string]string{
			OIDSysDescr:    "Some device",
			OIDSysObjectID: "1.3.6.1.4.1.9.1.2", // no leading dot
		}},
		&fakeCred{ref: "ref-001", found: true},
	)
	res := fp.Fingerprint(context.Background(), "10.0.0.1", "run-1", "")
	if res.Status != model.SNMPFingerprintSuccess {
		t.Fatalf("expected success, got %s", res.Status)
	}
	if res.SysObjectID[0] != '.' {
		t.Errorf("expected normalised OID with leading dot, got %q", res.SysObjectID)
	}
}

func TestFingerprint_MissingCredentials_AuthFailed(t *testing.T) {
	fp := newFP(
		&fakeSNMPClient{},
		&fakeCred{found: false},
	)
	res := fp.Fingerprint(context.Background(), "10.0.0.1", "run-1", "")
	if res.Status != model.SNMPFingerprintAuthFailed {
		t.Errorf("expected auth_failed, got %s", res.Status)
	}
	if res.FailureCategory != "SNMP_AUTH_FAILED" {
		t.Errorf("expected SNMP_AUTH_FAILED category, got %q", res.FailureCategory)
	}
}

func TestFingerprint_Timeout(t *testing.T) {
	fp := newFP(
		&fakeSNMPClient{err: errors.New("request timeout")},
		&fakeCred{ref: "ref", found: true},
	)
	res := fp.Fingerprint(context.Background(), "10.0.0.1", "run-1", "")
	if res.Status != model.SNMPFingerprintTimeout {
		t.Errorf("expected timeout, got %s", res.Status)
	}
	if res.FailureCategory != "SNMP_TIMEOUT" {
		t.Errorf("expected SNMP_TIMEOUT, got %q", res.FailureCategory)
	}
}

func TestFingerprint_MalformedOID_ReturnsPartialWithDescr(t *testing.T) {
	fp := newFP(
		&fakeSNMPClient{values: map[string]string{
			OIDSysDescr:    "HP ProCurve Switch",
			OIDSysObjectID: "ENTERPRISE:CISCO:BIG_IRON", // non-numeric — invalid
		}},
		&fakeCred{ref: "ref", found: true},
	)
	res := fp.Fingerprint(context.Background(), "10.0.0.1", "run-1", "")
	if res.Status != model.SNMPFingerprintPartial {
		t.Errorf("expected partial (sysDescr preserved), got %s", res.Status)
	}
	if res.SysObjectID != "" {
		t.Error("malformed OID must not be persisted")
	}
	if res.SysDescr == "" {
		t.Error("sysDescr should be preserved when OID is malformed")
	}
}

func TestFingerprint_SysDescrButNoOID_Partial(t *testing.T) {
	fp := newFP(
		&fakeSNMPClient{values: map[string]string{
			OIDSysDescr:    "Linux 5.4.0 server1",
			OIDSysObjectID: "", // missing
		}},
		&fakeCred{ref: "ref", found: true},
	)
	res := fp.Fingerprint(context.Background(), "10.0.0.1", "run-1", "")
	if res.Status != model.SNMPFingerprintPartial {
		t.Errorf("expected partial, got %s", res.Status)
	}
	if res.SysDescr == "" {
		t.Error("expected sysDescr to be preserved")
	}
}

func TestFingerprint_BothMissing(t *testing.T) {
	fp := newFP(
		&fakeSNMPClient{values: map[string]string{}},
		&fakeCred{ref: "ref", found: true},
	)
	res := fp.Fingerprint(context.Background(), "10.0.0.1", "run-1", "")
	if res.Status == model.SNMPFingerprintSuccess {
		t.Error("should not succeed with no OID or descr")
	}
}

func TestFingerprint_CredentialError(t *testing.T) {
	fp := newFP(
		&fakeSNMPClient{},
		&fakeCred{err: errors.New("vault unavailable")},
	)
	res := fp.Fingerprint(context.Background(), "10.0.0.1", "run-1", "")
	if res.Status != model.SNMPFingerprintAuthFailed {
		t.Errorf("expected auth_failed on credential error, got %s", res.Status)
	}
}

func TestNormaliseOID(t *testing.T) {
	cases := []struct {
		input, expected string
	}{
		{".1.3.6.1.4.1.9", ".1.3.6.1.4.1.9"},
		{"1.3.6.1.4.1.9", ".1.3.6.1.4.1.9"},
	}
	for _, tc := range cases {
		if got := normaliseOID(tc.input); got != tc.expected {
			t.Errorf("normaliseOID(%q) = %q, want %q", tc.input, got, tc.expected)
		}
	}
}

func TestValidOIDPattern(t *testing.T) {
	valid := []string{".1.3.6.1.2.1.1.2.0", "1.3.6.1.2.1.1.2.0", ".1.3.6.1.4.1.9.1.1"}
	invalid := []string{"", "ENTERPRISE:CISCO", "abc.def.ghi", ".1.a.2"}
	for _, s := range valid {
		if !validOIDPattern.MatchString(s) {
			t.Errorf("expected valid OID %q to match", s)
		}
	}
	for _, s := range invalid {
		if validOIDPattern.MatchString(s) {
			t.Errorf("expected invalid OID %q to not match", s)
		}
	}
}

func TestClassifyError(t *testing.T) {
	cases := []struct {
		err string
		cat string
	}{
		{"request timeout", "SNMP_TIMEOUT"},
		{"context deadline exceeded", "SNMP_TIMEOUT"},
		{"authentication failed", "SNMP_AUTH_FAILED"},
		{"wrong community string", "SNMP_AUTH_FAILED"},
		{"unsupported version", "SNMP_UNSUPPORTED_VERSION"},
		{"malformed response", "SNMP_MALFORMED_OID"},
		{"unexpected error", "SNMP_INTERNAL"},
	}
	for _, tc := range cases {
		if got := classifyError(errors.New(tc.err)); got != tc.cat {
			t.Errorf("classifyError(%q) = %q, want %q", tc.err, got, tc.cat)
		}
	}
}

func TestFingerprintBatch_ReturnsOnePerHost(t *testing.T) {
	fp := newFP(
		&fakeSNMPClient{values: map[string]string{
			OIDSysDescr:    "Test device",
			OIDSysObjectID: ".1.3.6.1.4.1.1.1.1",
		}},
		&fakeCred{ref: "ref", found: true},
	)
	hosts := []string{"10.0.0.1", "10.0.0.2", "10.0.0.3"}
	results := fp.FingerprintBatch(context.Background(), hosts, "run-batch", 2)
	if len(results) != len(hosts) {
		t.Errorf("expected %d results, got %d", len(hosts), len(results))
	}
}
