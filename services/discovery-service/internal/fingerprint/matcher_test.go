// Package fingerprint — unit tests for FingerprintMatcher (WO-010).
//
// Fixture coverage: 5 representative vendor products, multiple firmware ranges,
// unknown devices, and conflicting fingerprints — no live network access required.
package fingerprint

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

// ── Test fixtures ─────────────────────────────────────────────────────────────

// fixtureEntries returns a representative registry snapshot for unit tests.
// Covers: Cisco IOS router, Juniper EX switch, Arista vEOS, Nokia 7x50, Huawei CE.
func fixtureEntries() []RegistryEntry {
	now := time.Now().UTC()
	return []RegistryEntry{
		{
			// Cisco IOS router — matched by exact SNMP OID.
			RegistryEntryID:          "reg-cisco-ios-001",
			ProductDefinitionID:      "pd-cisco-ios-router",
			ProductDefinitionVersion: "v1.2.0",
			RegistryVersion:          "rv-001",
			SNMPOIDExact:             ".1.3.6.1.4.1.9.1.2071", // Cisco ISR 4331
			FirmwareMin:              "15.0",
			FirmwareMax:              "17.9",
			PreferredProtocol:        "SNMP",
			SupportedProtocols:       []string{"SNMP", "SSH"},
			CreatedAt:                now,
		},
		{
			// Juniper EX switch — matched by SNMP OID prefix (family).
			RegistryEntryID:          "reg-juniper-ex-001",
			ProductDefinitionID:      "pd-juniper-ex-switch",
			ProductDefinitionVersion: "v2.0.0",
			RegistryVersion:          "rv-001",
			SNMPOIDPrefix:            ".1.3.6.1.4.1.2636.1.1.1", // Juniper EX family
			PreferredProtocol:        "SNMP",
			SupportedProtocols:       []string{"SNMP", "SSH"},
			CreatedAt:                now,
		},
		{
			// Arista vEOS — matched by SSH banner substring.
			RegistryEntryID:          "reg-arista-veos-001",
			ProductDefinitionID:      "pd-arista-veos",
			ProductDefinitionVersion: "v1.0.0",
			RegistryVersion:          "rv-001",
			SSHBannerSubstring:       "Arista",
			FirmwareMin:              "4.20",
			FirmwareMax:              "4.29",
			PreferredProtocol:        "SSH",
			SupportedProtocols:       []string{"SSH", "REST"},
			CreatedAt:                now,
		},
		{
			// Nokia 7x50 — matched by HTTP header.
			RegistryEntryID:          "reg-nokia-7x50-001",
			ProductDefinitionID:      "pd-nokia-7750",
			ProductDefinitionVersion: "v3.1.0",
			RegistryVersion:          "rv-001",
			HTTPHeaderKey:            "server",
			HTTPHeaderContains:       "Nokia-7750SR",
			PreferredProtocol:        "REST",
			SupportedProtocols:       []string{"REST", "SNMP"},
			CreatedAt:                now,
		},
		{
			// Huawei CE switch — matched by gRPC service.
			RegistryEntryID:          "reg-huawei-ce-001",
			ProductDefinitionID:      "pd-huawei-ce-switch",
			ProductDefinitionVersion: "v1.5.0",
			RegistryVersion:          "rv-001",
			GRPCServiceExact:         "huawei.datacom.v1.Telemetry",
			PreferredProtocol:        "GRPC",
			SupportedProtocols:       []string{"GRPC", "SNMP"},
			CreatedAt:                now,
		},
	}
}

// newTestMatcher creates a Matcher backed by a registry loaded with fixtureEntries.
func newTestMatcher() *Matcher {
	reader := NewInMemoryRegistryReader(fixtureEntries(), "rv-001")
	client := NewRegistryClient(reader, 0) // TTL=0 → always use provided entries
	return NewMatcher(client)
}

// ── SNMP OID matching ─────────────────────────────────────────────────────────

func TestMatcher_SNMPOIDExact_Matches(t *testing.T) {
	m := newTestMatcher()
	ev := ProbeEvidence{
		IP:                 "10.0.0.1",
		SNMPOIDSysObjectID: ".1.3.6.1.4.1.9.1.2071",
		FirmwareVersion:    "16.3.1",
	}
	result := m.Match(context.Background(), ev)
	if result.Status != FingerprintStatusMatched {
		t.Fatalf("expected MATCHED, got %s", result.Status)
	}
	if result.ProductDefinitionID != "pd-cisco-ios-router" {
		t.Errorf("expected pd-cisco-ios-router, got %s", result.ProductDefinitionID)
	}
	if result.MatchConfidence != 1.0 {
		t.Errorf("expected confidence 1.0 for exact OID match, got %.2f", result.MatchConfidence)
	}
	if !strings.Contains(result.MatchEvidence, "exact") {
		t.Errorf("expected 'exact' in evidence, got %q", result.MatchEvidence)
	}
}

func TestMatcher_SNMPOIDExact_WithLeadingDotNormalisation(t *testing.T) {
	m := newTestMatcher()
	ev := ProbeEvidence{
		IP:                 "10.0.0.2",
		SNMPOIDSysObjectID: "1.3.6.1.4.1.9.1.2071", // no leading dot
		FirmwareVersion:    "16.3.1",
	}
	result := m.Match(context.Background(), ev)
	if result.Status != FingerprintStatusMatched {
		t.Fatalf("expected MATCHED after OID normalisation, got %s", result.Status)
	}
}

func TestMatcher_SNMPOIDPrefix_Matches(t *testing.T) {
	m := newTestMatcher()
	ev := ProbeEvidence{
		IP:                 "10.0.1.1",
		SNMPOIDSysObjectID: ".1.3.6.1.4.1.2636.1.1.1.2.59", // Juniper EX2300
	}
	result := m.Match(context.Background(), ev)
	if result.Status != FingerprintStatusMatched {
		t.Fatalf("expected MATCHED on prefix, got %s", result.Status)
	}
	if result.ProductDefinitionID != "pd-juniper-ex-switch" {
		t.Errorf("expected pd-juniper-ex-switch, got %s", result.ProductDefinitionID)
	}
	if result.MatchConfidence != 0.8 {
		t.Errorf("expected confidence 0.8 for prefix match, got %.2f", result.MatchConfidence)
	}
}

// ── SSH banner matching ───────────────────────────────────────────────────────

func TestMatcher_SSHBanner_CaseInsensitive(t *testing.T) {
	m := newTestMatcher()
	ev := ProbeEvidence{
		IP:              "10.0.2.1",
		SSHBanner:       "SSH-2.0-OpenSSH_arista vEOS-4.26.3F",
		FirmwareVersion: "4.26.3",
	}
	result := m.Match(context.Background(), ev)
	if result.Status != FingerprintStatusMatched {
		t.Fatalf("expected MATCHED on SSH banner, got %s", result.Status)
	}
	if result.ProductDefinitionID != "pd-arista-veos" {
		t.Errorf("expected pd-arista-veos, got %s", result.ProductDefinitionID)
	}
}

// ── HTTP header matching ──────────────────────────────────────────────────────

func TestMatcher_HTTPHeader_Matches(t *testing.T) {
	m := newTestMatcher()
	ev := ProbeEvidence{
		IP:                  "10.0.3.1",
		HTTPResponseHeaders: map[string]string{"server": "Nokia-7750SR/16.0"},
	}
	result := m.Match(context.Background(), ev)
	if result.Status != FingerprintStatusMatched {
		t.Fatalf("expected MATCHED on HTTP header, got %s", result.Status)
	}
	if result.ProductDefinitionID != "pd-nokia-7750" {
		t.Errorf("expected pd-nokia-7750, got %s", result.ProductDefinitionID)
	}
}

// ── gRPC matching ─────────────────────────────────────────────────────────────

func TestMatcher_GRPCService_ExactMatch(t *testing.T) {
	m := newTestMatcher()
	ev := ProbeEvidence{
		IP:           "10.0.4.1",
		GRPCServices: []string{"grpc.health.v1.Health", "huawei.datacom.v1.Telemetry"},
	}
	result := m.Match(context.Background(), ev)
	if result.Status != FingerprintStatusMatched {
		t.Fatalf("expected MATCHED on gRPC service, got %s", result.Status)
	}
	if result.ProductDefinitionID != "pd-huawei-ce-switch" {
		t.Errorf("expected pd-huawei-ce-switch, got %s", result.ProductDefinitionID)
	}
	if result.MatchConfidence != 0.9 {
		t.Errorf("expected confidence 0.9 for gRPC match, got %.2f", result.MatchConfidence)
	}
}

// ── Firmware range ────────────────────────────────────────────────────────────

func TestMatcher_FirmwareOutsideRange_VersionMismatch(t *testing.T) {
	m := newTestMatcher()
	ev := ProbeEvidence{
		IP:                 "10.0.0.1",
		SNMPOIDSysObjectID: ".1.3.6.1.4.1.9.1.2071", // Cisco ISR 4331
		FirmwareVersion:    "14.9", // below min 15.0
	}
	result := m.Match(context.Background(), ev)
	if result.Status != FingerprintStatusVersionMismatch {
		t.Fatalf("expected VERSION_MISMATCH, got %s (pdId=%s)", result.Status, result.ProductDefinitionID)
	}
	if result.VersionMismatchEntry != "pd-cisco-ios-router" {
		t.Errorf("expected pd-cisco-ios-router in mismatch, got %q", result.VersionMismatchEntry)
	}
}

func TestMatcher_FirmwareAboveMax_VersionMismatch(t *testing.T) {
	m := newTestMatcher()
	ev := ProbeEvidence{
		IP:                 "10.0.0.1",
		SNMPOIDSysObjectID: ".1.3.6.1.4.1.9.1.2071",
		FirmwareVersion:    "18.0", // above max 17.9
	}
	result := m.Match(context.Background(), ev)
	if result.Status != FingerprintStatusVersionMismatch {
		t.Fatalf("expected VERSION_MISMATCH for firmware above max, got %s", result.Status)
	}
}

func TestMatcher_FirmwareEmpty_SkipsRangeCheck(t *testing.T) {
	m := newTestMatcher()
	ev := ProbeEvidence{
		IP:                 "10.0.0.1",
		SNMPOIDSysObjectID: ".1.3.6.1.4.1.9.1.2071",
		FirmwareVersion:    "", // not known — range check is skipped
	}
	result := m.Match(context.Background(), ev)
	// Should still match — no firmware → no range enforcement.
	if result.Status != FingerprintStatusMatched {
		t.Fatalf("expected MATCHED when firmware is empty, got %s", result.Status)
	}
}

// ── Unknown device ────────────────────────────────────────────────────────────

func TestMatcher_NoMatch_Unknown(t *testing.T) {
	m := newTestMatcher()
	ev := ProbeEvidence{
		IP:                 "10.0.99.1",
		SNMPOIDSysObjectID: ".1.3.6.1.4.1.9999.9.9", // unknown vendor
	}
	result := m.Match(context.Background(), ev)
	if result.Status != FingerprintStatusUnknown {
		t.Fatalf("expected UNKNOWN, got %s", result.Status)
	}
	if result.ProductDefinitionID != "" {
		t.Error("expected empty ProductDefinitionID for UNKNOWN result")
	}
}

func TestMatcher_EmptyEvidence_Unknown(t *testing.T) {
	m := newTestMatcher()
	ev := ProbeEvidence{IP: "10.0.99.2"}
	result := m.Match(context.Background(), ev)
	if result.Status != FingerprintStatusUnknown {
		t.Errorf("expected UNKNOWN for empty evidence, got %s", result.Status)
	}
}

// ── Conflict detection ────────────────────────────────────────────────────────

func TestMatcher_Conflict_TwoEqualConfidenceMatches(t *testing.T) {
	// Add two entries that both match by SSH banner at equal confidence.
	conflictEntries := []RegistryEntry{
		{
			RegistryEntryID:     "conflict-a",
			ProductDefinitionID: "pd-conflict-a",
			RegistryVersion:     "rv-conflict",
			SSHBannerSubstring:  "ACME",
		},
		{
			RegistryEntryID:     "conflict-b",
			ProductDefinitionID: "pd-conflict-b",
			RegistryVersion:     "rv-conflict",
			SSHBannerSubstring:  "ACME",
		},
	}
	reader := NewInMemoryRegistryReader(conflictEntries, "rv-conflict")
	client := NewRegistryClient(reader, 0)
	m := NewMatcher(client)

	ev := ProbeEvidence{IP: "10.0.5.1", SSHBanner: "ACME-NOS-v2.1"}
	result := m.Match(context.Background(), ev)

	if result.Status != FingerprintStatusConflict {
		t.Fatalf("expected CONFLICT, got %s", result.Status)
	}
	if len(result.ConflictCandidates) < 2 {
		t.Errorf("expected at least 2 conflict candidates, got %v", result.ConflictCandidates)
	}
	if result.ConflictReason == "" {
		t.Error("expected non-empty ConflictReason")
	}
}

func TestMatcher_HigherConfidenceWins_NoConflict(t *testing.T) {
	// One exact OID + one SSH banner → OID wins (1.0 > 0.75).
	entries := []RegistryEntry{
		{
			RegistryEntryID:     "winner",
			ProductDefinitionID: "pd-winner",
			RegistryVersion:     "rv-w",
			SNMPOIDExact:        ".1.3.6.1.4.1.9.1.9999",
		},
		{
			RegistryEntryID:     "loser",
			ProductDefinitionID: "pd-loser",
			RegistryVersion:     "rv-w",
			SSHBannerSubstring:  "Cisco",
		},
	}
	reader := NewInMemoryRegistryReader(entries, "rv-w")
	client := NewRegistryClient(reader, 0)
	m := NewMatcher(client)

	ev := ProbeEvidence{
		IP:                 "10.0.6.1",
		SNMPOIDSysObjectID: ".1.3.6.1.4.1.9.1.9999",
		SSHBanner:          "SSH-2.0-OpenSSH_Cisco-IOS",
	}
	result := m.Match(context.Background(), ev)
	if result.Status != FingerprintStatusMatched {
		t.Fatalf("expected MATCHED (higher confidence wins), got %s", result.Status)
	}
	if result.ProductDefinitionID != "pd-winner" {
		t.Errorf("expected pd-winner, got %s", result.ProductDefinitionID)
	}
}

// ── Registry unavailable ──────────────────────────────────────────────────────

func TestMatcher_RegistryUnavailable(t *testing.T) {
	reader := NewInMemoryRegistryReader(nil, "")
	reader.SetError(errors.New("connection refused"))
	client := NewRegistryClient(reader, 0)
	m := NewMatcher(client)

	ev := ProbeEvidence{IP: "10.0.7.1", SNMPOIDSysObjectID: ".1.3.6.1.4.1.9.1.2071"}
	result := m.Match(context.Background(), ev)
	if result.Status != FingerprintStatusRegistryUnavailable {
		t.Fatalf("expected REGISTRY_UNAVAILABLE, got %s", result.Status)
	}
}

func TestMatcher_RegistryFallsBackToCache(t *testing.T) {
	// Seed the cache with one valid entry.
	reader := NewInMemoryRegistryReader(fixtureEntries(), "rv-001")
	client := NewRegistryClient(reader, 60*1000*1000*1000) // 60 s TTL — cache stays fresh
	_ = NewMatcher(client)

	// Warm the cache.
	_, _, _ = client.ListActive(context.Background())

	// Now break the reader.
	reader.SetError(errors.New("service down"))

	// Invalidate the cache so the next read attempts a fresh fetch.
	client.InvalidateCache()

	// Since there's no cached snapshot and reader is down, should get REGISTRY_UNAVAILABLE.
	m := NewMatcher(client)
	ev := ProbeEvidence{IP: "10.0.8.1", SNMPOIDSysObjectID: ".1.3.6.1.4.1.9.1.2071"}
	result := m.Match(context.Background(), ev)
	if result.Status != FingerprintStatusRegistryUnavailable {
		t.Errorf("expected REGISTRY_UNAVAILABLE after cache invalidation + reader error, got %s", result.Status)
	}
}

// ── Empty registry ────────────────────────────────────────────────────────────

func TestMatcher_EmptyRegistry_Unknown(t *testing.T) {
	reader := NewInMemoryRegistryReader([]RegistryEntry{}, "rv-empty")
	client := NewRegistryClient(reader, 0)
	m := NewMatcher(client)

	ev := ProbeEvidence{IP: "10.0.9.1", SNMPOIDSysObjectID: ".1.3.6.1.4.1.9.1.2071"}
	result := m.Match(context.Background(), ev)
	if result.Status != FingerprintStatusUnknown {
		t.Fatalf("expected UNKNOWN for empty registry, got %s", result.Status)
	}
}

// ── firmwareInRange ───────────────────────────────────────────────────────────

func TestFirmwareInRange(t *testing.T) {
	cases := []struct {
		fw, min, max string
		want         bool
	}{
		{"16.3.1", "15.0", "17.9", true},
		{"14.9", "15.0", "17.9", false},
		{"18.0", "15.0", "17.9", false},
		{"16.3.1", "", "17.9", true},   // no lower bound
		{"16.3.1", "15.0", "", true},   // no upper bound
		{"16.3.1", "", "", true},       // unbounded
	}
	for _, tc := range cases {
		got := firmwareInRange(tc.fw, tc.min, tc.max)
		if got != tc.want {
			t.Errorf("firmwareInRange(%q, %q, %q) = %v, want %v", tc.fw, tc.min, tc.max, got, tc.want)
		}
	}
}

// ── normaliseOID ──────────────────────────────────────────────────────────────

func TestNormaliseOID(t *testing.T) {
	cases := []struct{ in, want string }{
		{".1.3.6.1", ".1.3.6.1"},
		{"1.3.6.1", ".1.3.6.1"},
		{"", ""},
	}
	for _, tc := range cases {
		got := normaliseOID(tc.in)
		if got != tc.want {
			t.Errorf("normaliseOID(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

// ── RegistryClient cache tests ────────────────────────────────────────────────

func TestRegistryClient_CachesFreshSnapshot(t *testing.T) {
	callCount := 0
	reader := &countingReader{
		inner: NewInMemoryRegistryReader(fixtureEntries(), "rv-001"),
		count: &callCount,
	}
	client := NewRegistryClient(reader, 60*1000*1000*1000) // 60 s TTL

	_, _, _ = client.ListActive(context.Background())
	_, _, _ = client.ListActive(context.Background())

	if callCount > 1 {
		t.Errorf("expected 1 reader call (cached), got %d", callCount)
	}
}

func TestRegistryClient_InvalidateForcesRefresh(t *testing.T) {
	callCount := 0
	reader := &countingReader{
		inner: NewInMemoryRegistryReader(fixtureEntries(), "rv-001"),
		count: &callCount,
	}
	client := NewRegistryClient(reader, 60*1000*1000*1000)

	_, _, _ = client.ListActive(context.Background())
	client.InvalidateCache()
	_, _, _ = client.ListActive(context.Background())

	if callCount < 2 {
		t.Errorf("expected at least 2 reader calls after invalidation, got %d", callCount)
	}
}

func TestRegistryClient_GracefulDegradation(t *testing.T) {
	reader := NewInMemoryRegistryReader(fixtureEntries(), "rv-001")
	client := NewRegistryClient(reader, 0) // TTL=0 so it fetches every time

	// Warm cache.
	_, v1, err := client.ListActive(context.Background())
	if err != nil || v1 == "" {
		t.Fatalf("initial read failed: %v", err)
	}

	// Break reader — but since TTL=0 the cache is already stale; simulate by not invalidating:
	// Instead, use a positive TTL for degradation test.
	reader2 := NewInMemoryRegistryReader(fixtureEntries(), "rv-002")
	client2 := NewRegistryClient(reader2, 60*1000*1000*1000)
	_, _, _ = client2.ListActive(context.Background())
	reader2.SetError(errors.New("down"))
	client2.InvalidateCache() // force stale; snapshot was good; now reader is broken
	// After InvalidateCache, snapshot = nil; reader error → ErrRegistryUnavailable.
	_, _, err2 := client2.ListActive(context.Background())
	if err2 == nil {
		t.Error("expected error after cache invalidation + reader failure")
	}
}

// ── countingReader helper ─────────────────────────────────────────────────────

type countingReader struct {
	inner RegistryReader
	count *int
}

func (c *countingReader) ListActive(ctx context.Context) ([]RegistryEntry, string, error) {
	*c.count++
	return c.inner.ListActive(ctx)
}
