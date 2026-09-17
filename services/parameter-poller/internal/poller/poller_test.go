package poller_test

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"testing"
	"time"

	"github.com/airtel-ubrnms/parameter-poller/internal/model"
	"github.com/airtel-ubrnms/parameter-poller/internal/poller"
	"github.com/airtel-ubrnms/parameter-poller/internal/registry"
	"github.com/airtel-ubrnms/parameter-poller/internal/store"
)

// --- test doubles ---

// stubAdapter is a controllable AdapterClient.
type stubAdapter struct {
	results map[string]string
	err     error
}

func (s *stubAdapter) Get(_ context.Context, _ string, keys []string) (map[string]string, error) {
	if s.err != nil {
		return nil, s.err
	}
	out := make(map[string]string, len(keys))
	for _, k := range keys {
		if v, ok := s.results[k]; ok {
			out[k] = v
		}
	}
	return out, nil
}

func newPoller(reg *registry.InMemoryReader, st store.Store, adapters map[string]poller.AdapterClient) *poller.Poller {
	return poller.New(reg, st, poller.NewAdapterResolver(adapters), slog.New(slog.NewTextHandler(os.Stdout, nil)))
}

func fixedClock(t time.Time) func() time.Time { return func() time.Time { return t } }

// singleSNMPProfile returns a minimal registry profile with two SNMP parameters.
func singleSNMPProfile(deviceID string) *model.RegistryDeviceProfile {
	return &model.RegistryDeviceProfile{
		DeviceID:            deviceID,
		ProductDefinitionID: "pd-cisco-ios",
		RegistryVersion:     "rv1",
		Groups: []model.RegistryGroupMetadata{
			{
				GroupID:             "grp-if",
				Label:               "Interfaces",
				PollIntervalSeconds: 60,
				Parameters: []model.RegistryParamRef{
					{ParameterID: "ifIn",  Label: "In",  Protocol: "SNMP", ReadRef: ".1.3.6.1.2.1.2.2.1.10.1"},
					{ParameterID: "ifOut", Label: "Out", Protocol: "SNMP", ReadRef: ".1.3.6.1.2.1.2.2.1.16.1"},
				},
			},
		},
	}
}

// --- tests ---

func TestPollDevice_SuccessfulSNMPRead(t *testing.T) {
	reg := registry.NewInMemoryReader([]*model.RegistryDeviceProfile{singleSNMPProfile("dev-001")})
	st := store.NewInMemoryStore()
	now := time.Date(2026, 9, 17, 10, 0, 0, 0, time.UTC)

	adapter := &stubAdapter{results: map[string]string{
		".1.3.6.1.2.1.2.2.1.10.1": "123456",
		".1.3.6.1.2.1.2.2.1.16.1": "654321",
	}}

	p := newPoller(reg, st, map[string]poller.AdapterClient{"SNMP": adapter})
	p.WithClock(fixedClock(now))

	if err := p.PollDevice(context.Background(), "dev-001"); err != nil {
		t.Fatalf("PollDevice returned error: %v", err)
	}

	values, _ := st.GetByDevice(context.Background(), "dev-001")
	if len(values) != 2 {
		t.Fatalf("expected 2 values, got %d", len(values))
	}

	byID := make(map[string]model.ParameterValue)
	for _, v := range values {
		byID[v.ParameterID] = v
	}

	in := byID["ifIn"]
	if in.Value != "123456" {
		t.Errorf("ifIn value: want 123456, got %q", in.Value)
	}
	if in.ReadStatus != model.ParameterReadStatusSuccess {
		t.Errorf("ifIn readStatus: want SUCCESS, got %s", in.ReadStatus)
	}
	if in.Source != "SNMP" {
		t.Errorf("ifIn source: want SNMP, got %q", in.Source)
	}
	if in.LastSuccessAt == nil {
		t.Error("ifIn LastSuccessAt should be set on success")
	}
}

func TestPollDevice_NumericCoercion(t *testing.T) {
	reg := registry.NewInMemoryReader([]*model.RegistryDeviceProfile{singleSNMPProfile("dev-002")})
	st := store.NewInMemoryStore()

	adapter := &stubAdapter{results: map[string]string{
		".1.3.6.1.2.1.2.2.1.10.1": "987654",
		".1.3.6.1.2.1.2.2.1.16.1": "N/A",
	}}

	p := newPoller(reg, st, map[string]poller.AdapterClient{"SNMP": adapter})
	if err := p.PollDevice(context.Background(), "dev-002"); err != nil {
		t.Fatal(err)
	}

	values, _ := st.GetByDevice(context.Background(), "dev-002")
	byID := make(map[string]model.ParameterValue)
	for _, v := range values {
		byID[v.ParameterID] = v
	}

	// Numeric string → float64 pointer.
	if byID["ifIn"].ValueNumeric == nil {
		t.Error("ifIn ValueNumeric should be set for numeric string")
	} else if *byID["ifIn"].ValueNumeric != 987654 {
		t.Errorf("ifIn ValueNumeric: want 987654, got %v", *byID["ifIn"].ValueNumeric)
	}

	// Vendor placeholder → nil.
	if byID["ifOut"].ValueNumeric != nil {
		t.Errorf("ifOut ValueNumeric should be nil for N/A placeholder")
	}
}

func TestPollDevice_AuthFailure_Classified(t *testing.T) {
	reg := registry.NewInMemoryReader([]*model.RegistryDeviceProfile{singleSNMPProfile("dev-003")})
	st := store.NewInMemoryStore()

	adapter := &stubAdapter{err: errors.New("auth failed: invalid credential")}
	p := newPoller(reg, st, map[string]poller.AdapterClient{"SNMP": adapter})

	if err := p.PollDevice(context.Background(), "dev-003"); err != nil {
		t.Fatal(err)
	}

	values, _ := st.GetByDevice(context.Background(), "dev-003")
	if len(values) == 0 {
		t.Fatal("expected failure records to be persisted")
	}
	for _, v := range values {
		if v.ReadStatus != model.ParameterReadStatusAuthFailure {
			t.Errorf("expected AUTH_FAILURE status, got %s", v.ReadStatus)
		}
		if v.FailureCategory != model.PollFailureCategoryAuthFailure {
			t.Errorf("expected AUTH_FAILURE category, got %s", v.FailureCategory)
		}
		// Confirm no credential material in failure reason.
		if containsCredentialKeyword(v.FailureReason) {
			t.Errorf("credential keyword found in FailureReason: %q", v.FailureReason)
		}
	}
}

func TestPollDevice_Timeout_Classified(t *testing.T) {
	reg := registry.NewInMemoryReader([]*model.RegistryDeviceProfile{singleSNMPProfile("dev-004")})
	st := store.NewInMemoryStore()

	adapter := &stubAdapter{err: errors.New("context deadline exceeded")}
	p := newPoller(reg, st, map[string]poller.AdapterClient{"SNMP": adapter})

	if err := p.PollDevice(context.Background(), "dev-004"); err != nil {
		t.Fatal(err)
	}

	values, _ := st.GetByDevice(context.Background(), "dev-004")
	for _, v := range values {
		if v.ReadStatus != model.ParameterReadStatusTimeout {
			t.Errorf("expected TIMEOUT, got %s", v.ReadStatus)
		}
	}
}

func TestPollDevice_UnknownDevice_ReturnsUnmapped(t *testing.T) {
	// Registry has no profile for "dev-unknown".
	reg := registry.NewInMemoryReader(nil)
	st := store.NewInMemoryStore()

	p := newPoller(reg, st, map[string]poller.AdapterClient{})
	if err := p.PollDevice(context.Background(), "dev-unknown"); err != nil {
		t.Fatalf("PollDevice should not error for unknown device, got: %v", err)
	}

	values, _ := st.GetByDevice(context.Background(), "dev-unknown")
	if len(values) != 1 {
		t.Fatalf("expected 1 placeholder record, got %d", len(values))
	}
	if values[0].FreshnessState != model.FreshnessStateUnknownDevice {
		t.Errorf("expected UNKNOWN_DEVICE, got %s", values[0].FreshnessState)
	}
}

func TestPollDevice_MissingMappingProtocol(t *testing.T) {
	// Profile has CLI parameters but no CLI adapter is registered.
	profile := &model.RegistryDeviceProfile{
		DeviceID: "dev-cli", ProductDefinitionID: "pd-juniper", RegistryVersion: "rv1",
		Groups: []model.RegistryGroupMetadata{{
			GroupID: "grp-chassis", Label: "Chassis", PollIntervalSeconds: 60,
			Parameters: []model.RegistryParamRef{
				{ParameterID: "cpu", Label: "CPU", Protocol: "CLI", ReadRef: "show cpu"},
			},
		}},
	}
	reg := registry.NewInMemoryReader([]*model.RegistryDeviceProfile{profile})
	st := store.NewInMemoryStore()

	// No CLI adapter registered.
	p := newPoller(reg, st, map[string]poller.AdapterClient{})
	if err := p.PollDevice(context.Background(), "dev-cli"); err != nil {
		t.Fatal(err)
	}

	values, _ := st.GetByDevice(context.Background(), "dev-cli")
	if len(values) != 1 {
		t.Fatalf("expected 1 unmapped record, got %d", len(values))
	}
	if values[0].ReadStatus != model.ParameterReadStatusUnmapped {
		t.Errorf("expected UNMAPPED, got %s", values[0].ReadStatus)
	}
}

func TestPollDevice_PartialSuccess_PerParameterPersistence(t *testing.T) {
	// First poll: adapter returns one value and one error — but we have two
	// parameters. Since both use the same protocol/adapter, we use an adapter
	// that returns only one key to simulate a missing key.
	reg := registry.NewInMemoryReader([]*model.RegistryDeviceProfile{singleSNMPProfile("dev-partial")})
	st := store.NewInMemoryStore()

	// Adapter returns only the first key.
	adapter := &stubAdapter{results: map[string]string{
		".1.3.6.1.2.1.2.2.1.10.1": "100",
		// .1.3.6.1.2.1.2.2.1.16.1 deliberately absent → empty string → unmapped.
	}}
	p := newPoller(reg, st, map[string]poller.AdapterClient{"SNMP": adapter})

	if err := p.PollDevice(context.Background(), "dev-partial"); err != nil {
		t.Fatal(err)
	}

	values, _ := st.GetByDevice(context.Background(), "dev-partial")
	if len(values) != 2 {
		t.Fatalf("expected 2 records, got %d", len(values))
	}

	byID := make(map[string]model.ParameterValue)
	for _, v := range values {
		byID[v.ParameterID] = v
	}

	if byID["ifIn"].Value != "100" {
		t.Errorf("ifIn should have value 100, got %q", byID["ifIn"].Value)
	}
	// Empty string from adapter is SUCCESS but with empty value — the store
	// does not classify it as failure; freshness determines stale state.
	if byID["ifOut"].ReadStatus != model.ParameterReadStatusSuccess {
		t.Errorf("ifOut without adapter error should be SUCCESS, got %s", byID["ifOut"].ReadStatus)
	}
}

func TestStaleValuePreservedOnFailure(t *testing.T) {
	reg := registry.NewInMemoryReader([]*model.RegistryDeviceProfile{singleSNMPProfile("dev-stale")})
	st := store.NewInMemoryStore()
	now := time.Date(2026, 9, 17, 10, 0, 0, 0, time.UTC)

	// First poll: success.
	ok := &stubAdapter{results: map[string]string{
		".1.3.6.1.2.1.2.2.1.10.1": "999",
		".1.3.6.1.2.1.2.2.1.16.1": "888",
	}}
	p := newPoller(reg, st, map[string]poller.AdapterClient{"SNMP": ok})
	p.WithClock(fixedClock(now))
	if err := p.PollDevice(context.Background(), "dev-stale"); err != nil {
		t.Fatal(err)
	}

	// Second poll: failure — last successful value must be preserved.
	fail := &stubAdapter{err: errors.New("timeout")}
	p2 := newPoller(reg, st, map[string]poller.AdapterClient{"SNMP": fail})
	p2.WithClock(fixedClock(now.Add(2 * time.Minute)))
	if err := p2.PollDevice(context.Background(), "dev-stale"); err != nil {
		t.Fatal(err)
	}

	values, _ := st.GetByDevice(context.Background(), "dev-stale")
	byID := make(map[string]model.ParameterValue)
	for _, v := range values {
		byID[v.ParameterID] = v
	}

	// Value is preserved from the first successful poll.
	if byID["ifIn"].Value != "999" {
		t.Errorf("stale value should be preserved: want 999, got %q", byID["ifIn"].Value)
	}
	if byID["ifIn"].LastSuccessAt == nil {
		t.Error("LastSuccessAt should be carried forward")
	}
}

// --- freshness calculation tests ---

func TestCalculateFreshness_Fresh(t *testing.T) {
	now := time.Date(2026, 9, 17, 10, 0, 0, 0, time.UTC)
	successAt := now.Add(-30 * time.Second)
	v := model.ParameterValue{
		PollIntervalSeconds: 60,
		ReadStatus:          model.ParameterReadStatusSuccess,
		LastSuccessAt:       &successAt,
	}
	got := store.CalculateFreshness(v, now)
	if got != model.FreshnessStateFresh {
		t.Errorf("want FRESH, got %s", got)
	}
}

func TestCalculateFreshness_Stale(t *testing.T) {
	now := time.Date(2026, 9, 17, 10, 0, 0, 0, time.UTC)
	// Last success was 120s ago, interval is 60s → stale (1.5× = 90s threshold).
	successAt := now.Add(-120 * time.Second)
	v := model.ParameterValue{
		PollIntervalSeconds: 60,
		ReadStatus:          model.ParameterReadStatusSuccess,
		LastSuccessAt:       &successAt,
	}
	got := store.CalculateFreshness(v, now)
	if got != model.FreshnessStateStale {
		t.Errorf("want STALE, got %s", got)
	}
}

func TestCalculateFreshness_NeverPolled(t *testing.T) {
	v := model.ParameterValue{
		PollIntervalSeconds: 60,
		ReadStatus:          model.ParameterReadStatusAuthFailure,
		LastSuccessAt:       nil,
	}
	got := store.CalculateFreshness(v, time.Now())
	if got != model.FreshnessStateFailed {
		t.Errorf("want FAILED, got %s", got)
	}
}

func TestCalculateFreshness_Unmapped(t *testing.T) {
	v := model.ParameterValue{ReadStatus: model.ParameterReadStatusUnmapped}
	got := store.CalculateFreshness(v, time.Now())
	if got != model.FreshnessStateUnmapped {
		t.Errorf("want UNMAPPED, got %s", got)
	}
}

// --- numeric coercion tests ---

func TestCoerceNumeric(t *testing.T) {
	cases := []struct {
		raw  string
		want *float64
	}{
		{"123",          floatPtr(123)},
		{"3.14",         floatPtr(3.14)},
		{"-45.2",        floatPtr(-45.2)},
		{"",             nil},
		{"N/A",          nil},
		{"not available", nil},
		{"none",         nil},
		{"abc",          nil},
	}
	for _, tc := range cases {
		got := store.CoerceNumeric(tc.raw)
		if tc.want == nil {
			if got != nil {
				t.Errorf("CoerceNumeric(%q): want nil, got %v", tc.raw, *got)
			}
		} else {
			if got == nil {
				t.Errorf("CoerceNumeric(%q): want %v, got nil", tc.raw, *tc.want)
			} else if *got != *tc.want {
				t.Errorf("CoerceNumeric(%q): want %v, got %v", tc.raw, *tc.want, *got)
			}
		}
	}
}

// --- helpers ---

func floatPtr(f float64) *float64 { return &f }

func containsCredentialKeyword(s string) bool {
	forbidden := []string{"password", "secret", "token", "api_key", "apikey", "private_key", "credential"}
	lower := ""
	for _, r := range s {
		if r >= 'A' && r <= 'Z' {
			lower += string(rune(r + 32))
		} else {
			lower += string(r)
		}
	}
	for _, kw := range forbidden {
		if len(lower) >= len(kw) {
			for i := 0; i <= len(lower)-len(kw); i++ {
				if lower[i:i+len(kw)] == kw {
					return true
				}
			}
		}
	}
	return false
}
