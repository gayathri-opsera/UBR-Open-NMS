// Package spal — unit tests for SNMP, CLI, REST, gRPC adapters and selector (WO-009).
package spal

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"
)

// ── Shared fakes ──────────────────────────────────────────────────────────────

// fakeResolver implements CredentialResolver for tests.
type fakeResolver struct {
	cred ResolvedCredential
	err  error
}

func (f *fakeResolver) Resolve(_ context.Context, _ string) (ResolvedCredential, error) {
	return f.cred, f.err
}

func goodResolver() CredentialResolver {
	return &fakeResolver{cred: ResolvedCredential{Username: "admin", Password: "s3cr3t"}}
}

func badResolver() CredentialResolver {
	return &fakeResolver{err: errors.New("vault unreachable")}
}

func sampleDevice() DeviceContext {
	return DeviceContext{
		DeviceID:           "dev-001",
		IPAddress:          "192.168.1.1",
		ProductDefinitionID: "pd-snmp-v2",
		PreferredProtocol:  ProtocolSNMP,
		SupportedProtocols: []Protocol{ProtocolSNMP, ProtocolSSH},
		CredentialRef:      "cref-001",
		CorrelationID:      "corr-abc",
		BaseURL:            "http://192.168.1.1:8080",
	}
}

// ── ErrReadOnly ───────────────────────────────────────────────────────────────

func TestErrReadOnly(t *testing.T) {
	err := NewReadOnlyError("SET", ProtocolSNMP)
	if !strings.Contains(err.Error(), "SET") {
		t.Errorf("expected SET in error: %v", err)
	}
	if !strings.Contains(err.Error(), "SNMP") {
		t.Errorf("expected SNMP in error: %v", err)
	}
	var target ErrReadOnly
	if !errors.As(err, &target) {
		t.Error("errors.As should match ErrReadOnly")
	}
}

// ── orderedProtocols ──────────────────────────────────────────────────────────

func TestOrderedProtocols_PreferredFirst(t *testing.T) {
	result := orderedProtocols(ProtocolSSH, []Protocol{ProtocolSNMP, ProtocolSSH, ProtocolREST})
	if result[0] != ProtocolSSH {
		t.Errorf("expected SSH first, got %v", result)
	}
	// No duplicates.
	seen := map[Protocol]int{}
	for _, p := range result {
		seen[p]++
	}
	for p, count := range seen {
		if count > 1 {
			t.Errorf("protocol %s appears %d times", p, count)
		}
	}
}

func TestOrderedProtocols_UnknownIgnored(t *testing.T) {
	result := orderedProtocols(ProtocolUnknown, []Protocol{ProtocolSNMP, ProtocolUnknown})
	for _, p := range result {
		if p == ProtocolUnknown {
			t.Error("UNKNOWN should be excluded from ordered list")
		}
	}
}

func TestOrderedProtocols_EmptyPreferred(t *testing.T) {
	result := orderedProtocols("", []Protocol{ProtocolSNMP, ProtocolREST})
	if len(result) != 2 {
		t.Errorf("expected 2 protocols, got %d", len(result))
	}
}

// ── SNMP adapter ──────────────────────────────────────────────────────────────

// fakeSNMPClient stubs SNMPGetClient for tests.
type fakeSNMPClient struct {
	vals map[string]string
	err  error
}

func (f *fakeSNMPClient) GetOIDs(_ context.Context, _ string, oids []string) (map[string]string, error) {
	if f.err != nil {
		return nil, f.err
	}
	out := map[string]string{}
	for _, oid := range oids {
		if v, ok := f.vals[oid]; ok {
			out[oid] = v
		}
	}
	return out, nil
}

func TestSNMPAdapter_Ping_Success(t *testing.T) {
	snmpClient := &fakeSNMPClient{vals: map[string]string{".1.3.6.1.2.1.1.2.0": "1.3.6"}}
	a := NewSNMPAdapter(snmpClient, goodResolver(), 0)
	res := a.Ping(context.Background(), sampleDevice())
	if !res.Reachable {
		t.Errorf("expected reachable, got failure: %s", res.FailureReason)
	}
}

func TestSNMPAdapter_Ping_CredentialFailure(t *testing.T) {
	a := NewSNMPAdapter(&fakeSNMPClient{}, badResolver(), 0)
	res := a.Ping(context.Background(), sampleDevice())
	if res.Reachable {
		t.Error("expected unreachable when credential resolution fails")
	}
	if res.FailureCategory != FailureCategoryCredentialResolution {
		t.Errorf("expected CREDENTIAL_RESOLUTION_FAILED, got %s", res.FailureCategory)
	}
}

func TestSNMPAdapter_Ping_GetFails(t *testing.T) {
	snmpClient := &fakeSNMPClient{err: errors.New("timeout: request timed out")}
	a := NewSNMPAdapter(snmpClient, goodResolver(), 0)
	res := a.Ping(context.Background(), sampleDevice())
	if res.Reachable {
		t.Error("expected unreachable on GET error")
	}
	if res.FailureCategory != FailureCategoryTimeout {
		t.Errorf("expected TIMEOUT, got %s", res.FailureCategory)
	}
}

func TestSNMPAdapter_Get_Success(t *testing.T) {
	snmpClient := &fakeSNMPClient{vals: map[string]string{
		".1.3.6.1.2.1.1.1.0": "Cisco IOS",
		".1.3.6.1.2.1.2.2.1.10.1": "42",
	}}
	a := NewSNMPAdapter(snmpClient, goodResolver(), 0)
	params := []ParamRef{
		{ParameterID: "sysDescr", OID: ".1.3.6.1.2.1.1.1.0"},
		{ParameterID: "ifInOctets", OID: ".1.3.6.1.2.1.2.2.1.10.1"},
	}
	result := a.Get(context.Background(), sampleDevice(), params)
	if len(result.Values) != 2 {
		t.Errorf("expected 2 values, got %d (failures: %v)", len(result.Values), result.Failures)
	}
	// Verify numeric conversion for the integer OID value.
	for _, v := range result.Values {
		if v.ParameterID == "ifInOctets" && !v.NumericValid {
			t.Error("expected NumericValid=true for numeric value")
		}
	}
}

func TestSNMPAdapter_Get_UnsupportedParam(t *testing.T) {
	a := NewSNMPAdapter(&fakeSNMPClient{}, goodResolver(), 0)
	params := []ParamRef{{ParameterID: "noOID"}} // no OID set
	result := a.Get(context.Background(), sampleDevice(), params)
	if len(result.Failures) != 1 {
		t.Fatalf("expected 1 failure, got %d", len(result.Failures))
	}
	if result.Failures[0].FailureCategory != FailureCategoryUnsupportedParam {
		t.Errorf("expected UNSUPPORTED_PARAMETER, got %s", result.Failures[0].FailureCategory)
	}
}

func TestSNMPAdapter_Set_Blocked(t *testing.T) {
	a := NewSNMPAdapter(&fakeSNMPClient{}, goodResolver(), 0)
	err := a.Set(context.Background(), sampleDevice(), ParamRef{}, "value")
	if err == nil {
		t.Fatal("expected ErrReadOnly from Set")
	}
	var ro ErrReadOnly
	if !errors.As(err, &ro) {
		t.Errorf("expected ErrReadOnly, got %T", err)
	}
}

func TestSNMPAdapter_Protocol(t *testing.T) {
	a := NewSNMPAdapter(&fakeSNMPClient{}, goodResolver(), 0)
	if a.Protocol() != ProtocolSNMP {
		t.Errorf("expected SNMP protocol, got %s", a.Protocol())
	}
}

// ── REST adapter ──────────────────────────────────────────────────────────────

func TestRESTAdapter_Ping_Success(t *testing.T) {
	doer := &testHTTPDoer{status: 200, body: `{"status":"ok"}`}
	a := NewRESTAdapter(doer, goodResolver(), 0)
	res := a.Ping(context.Background(), sampleDevice())
	if !res.Reachable {
		t.Errorf("expected reachable, got: %s", res.FailureReason)
	}
}

func TestRESTAdapter_Ping_5xx(t *testing.T) {
	doer := &testHTTPDoer{status: 503, body: ""}
	a := NewRESTAdapter(doer, goodResolver(), 0)
	res := a.Ping(context.Background(), sampleDevice())
	if res.Reachable {
		t.Error("expected unreachable on 5xx")
	}
}

func TestRESTAdapter_Ping_CredentialFailure(t *testing.T) {
	a := NewRESTAdapter(&testHTTPDoer{}, badResolver(), 0)
	res := a.Ping(context.Background(), sampleDevice())
	if res.Reachable {
		t.Error("expected unreachable on credential failure")
	}
	if res.FailureCategory != FailureCategoryCredentialResolution {
		t.Errorf("expected CREDENTIAL_RESOLUTION_FAILED, got %s", res.FailureCategory)
	}
}

func TestRESTAdapter_Ping_EmptyBaseURL(t *testing.T) {
	dev := sampleDevice()
	dev.BaseURL = ""
	doer := &testHTTPDoer{status: 200}
	a := NewRESTAdapter(doer, goodResolver(), 0)
	res := a.Ping(context.Background(), dev)
	if res.Reachable {
		t.Error("expected unreachable with empty BaseURL")
	}
}

func TestRESTAdapter_Get_Success(t *testing.T) {
	doer := &testHTTPDoer{status: 200, body: "running"}
	a := NewRESTAdapter(doer, goodResolver(), 0)
	params := []ParamRef{{ParameterID: "status", URLPath: "/api/status"}}
	result := a.Get(context.Background(), sampleDevice(), params)
	if len(result.Values) != 1 {
		t.Fatalf("expected 1 value, got %d", len(result.Values))
	}
	if result.Values[0].Value != "running" {
		t.Errorf("unexpected value: %q", result.Values[0].Value)
	}
}

func TestRESTAdapter_Get_UnsupportedParam(t *testing.T) {
	a := NewRESTAdapter(&testHTTPDoer{}, goodResolver(), 0)
	params := []ParamRef{{ParameterID: "noURL"}} // no URLPath
	result := a.Get(context.Background(), sampleDevice(), params)
	if len(result.Failures) != 1 || result.Failures[0].FailureCategory != FailureCategoryUnsupportedParam {
		t.Errorf("expected UNSUPPORTED_PARAMETER failure, got %v", result.Failures)
	}
}

func TestRESTAdapter_Set_Blocked(t *testing.T) {
	a := NewRESTAdapter(&testHTTPDoer{}, goodResolver(), 0)
	err := a.Set(context.Background(), sampleDevice(), ParamRef{}, "v")
	var ro ErrReadOnly
	if !errors.As(err, &ro) {
		t.Errorf("expected ErrReadOnly from Set, got %v", err)
	}
}

// ── gRPC adapter ──────────────────────────────────────────────────────────────

// fakeGRPCClient stubs GRPCGenericClient for tests.
type fakeGRPCClient struct {
	pingLatency int64
	pingErr     error
	paramVals   map[string]string
	paramErr    error
}

func (f *fakeGRPCClient) HealthCheck(_ context.Context, _ string, _ string) (int64, error) {
	return f.pingLatency, f.pingErr
}

func (f *fakeGRPCClient) GetParameter(_ context.Context, _ string, paramName string, _ string) (string, error) {
	if f.paramErr != nil {
		return "", f.paramErr
	}
	return f.paramVals[paramName], nil
}

func TestGRPCAdapter_Ping_Success(t *testing.T) {
	client := &fakeGRPCClient{pingLatency: 12}
	a := NewGRPCAdapter(client, goodResolver(), 0)
	res := a.Ping(context.Background(), sampleDevice())
	if !res.Reachable {
		t.Errorf("expected reachable, got: %s", res.FailureReason)
	}
	if res.LatencyMs != 12 {
		t.Errorf("expected latency 12, got %d", res.LatencyMs)
	}
}

func TestGRPCAdapter_Ping_HealthCheckFail(t *testing.T) {
	client := &fakeGRPCClient{pingErr: errors.New("deadline exceeded")}
	a := NewGRPCAdapter(client, goodResolver(), 0)
	res := a.Ping(context.Background(), sampleDevice())
	if res.Reachable {
		t.Error("expected unreachable on health check failure")
	}
	if res.FailureCategory != FailureCategoryTimeout {
		t.Errorf("expected TIMEOUT, got %s", res.FailureCategory)
	}
}

func TestGRPCAdapter_Ping_CredentialFailure(t *testing.T) {
	a := NewGRPCAdapter(&fakeGRPCClient{}, badResolver(), 0)
	res := a.Ping(context.Background(), sampleDevice())
	if res.Reachable {
		t.Error("expected unreachable on credential failure")
	}
	if res.FailureCategory != FailureCategoryCredentialResolution {
		t.Errorf("expected CREDENTIAL_RESOLUTION_FAILED, got %s", res.FailureCategory)
	}
}

func TestGRPCAdapter_Get_Success(t *testing.T) {
	client := &fakeGRPCClient{paramVals: map[string]string{"uptime": "86400", "hostname": "router-01"}}
	a := NewGRPCAdapter(client, goodResolver(), 0)
	params := []ParamRef{
		{ParameterID: "uptime"},
		{ParameterID: "hostname"},
	}
	result := a.Get(context.Background(), sampleDevice(), params)
	if len(result.Values) != 2 {
		t.Fatalf("expected 2 values, got %d (failures: %v)", len(result.Values), result.Failures)
	}
}

func TestGRPCAdapter_Get_ParamError(t *testing.T) {
	client := &fakeGRPCClient{paramErr: errors.New("not found")}
	a := NewGRPCAdapter(client, goodResolver(), 0)
	params := []ParamRef{{ParameterID: "uptime"}}
	result := a.Get(context.Background(), sampleDevice(), params)
	if len(result.Failures) != 1 {
		t.Fatalf("expected 1 failure, got %d", len(result.Failures))
	}
}

func TestGRPCAdapter_Set_Blocked(t *testing.T) {
	a := NewGRPCAdapter(&fakeGRPCClient{}, goodResolver(), 0)
	err := a.Set(context.Background(), sampleDevice(), ParamRef{}, "v")
	var ro ErrReadOnly
	if !errors.As(err, &ro) {
		t.Errorf("expected ErrReadOnly from Set, got %v", err)
	}
}

// ── Adapter Selector ──────────────────────────────────────────────────────────

// fakeSelectorClient is a DeviceClient stub for selector tests.
type fakeSelectorClient struct {
	proto     Protocol
	reachable bool
	latency   int64
}

func (f *fakeSelectorClient) Protocol() Protocol     { return f.proto }
func (f *fakeSelectorClient) AdapterVersion() string { return "fake/1.0" }
func (f *fakeSelectorClient) Ping(_ context.Context, _ DeviceContext) PingResult {
	return PingResult{
		Protocol:  f.proto,
		Reachable: f.reachable,
		LatencyMs: f.latency,
	}
}
func (f *fakeSelectorClient) Get(_ context.Context, _ DeviceContext, _ []ParamRef) GetResult {
	return GetResult{}
}
func (f *fakeSelectorClient) Set(_ context.Context, _ DeviceContext, _ ParamRef, _ string) error {
	return NewReadOnlyError("SET", f.proto)
}

func TestSelector_SelectsHealthyAdapter(t *testing.T) {
	factory := func(proto Protocol, _ CredentialResolver) (DeviceClient, error) {
		return &fakeSelectorClient{proto: proto, reachable: true, latency: 5}, nil
	}
	s := NewSelector(factory, goodResolver(), time.Minute)
	dev := sampleDevice()

	client, health, err := s.Select(context.Background(), dev)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if client == nil {
		t.Fatal("expected non-nil client")
	}
	if !health.Healthy {
		t.Error("expected healthy adapter")
	}
	if health.Protocol != dev.PreferredProtocol {
		t.Errorf("expected preferred protocol %s, got %s", dev.PreferredProtocol, health.Protocol)
	}
}

func TestSelector_FallsBackOnUnhealthyPreferred(t *testing.T) {
	callOrder := []Protocol{}
	factory := func(proto Protocol, _ CredentialResolver) (DeviceClient, error) {
		callOrder = append(callOrder, proto)
		// SNMP is unhealthy; SSH is healthy.
		healthy := proto == ProtocolSSH
		return &fakeSelectorClient{proto: proto, reachable: healthy, latency: 10}, nil
	}
	s := NewSelector(factory, goodResolver(), time.Minute)
	dev := sampleDevice()

	client, health, err := s.Select(context.Background(), dev)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if client == nil {
		t.Fatal("expected non-nil client after fallback")
	}
	if health.Protocol != ProtocolSSH {
		t.Errorf("expected fallback to SSH, got %s", health.Protocol)
	}
}

func TestSelector_ReturnsGuidedFailureWhenAllFail(t *testing.T) {
	factory := func(proto Protocol, _ CredentialResolver) (DeviceClient, error) {
		return &fakeSelectorClient{proto: proto, reachable: false}, nil
	}
	s := NewSelector(factory, goodResolver(), time.Minute)

	client, health, err := s.Select(context.Background(), sampleDevice())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if client != nil {
		t.Error("expected nil client when all adapters fail")
	}
	if health.Healthy {
		t.Error("expected unhealthy result")
	}
	if health.FailureCategory != FailureCategoryUnreachable {
		t.Errorf("expected UNREACHABLE, got %s", health.FailureCategory)
	}
}

func TestSelector_UsesCache(t *testing.T) {
	callCount := 0
	factory := func(proto Protocol, _ CredentialResolver) (DeviceClient, error) {
		callCount++
		return &fakeSelectorClient{proto: proto, reachable: true, latency: 5}, nil
	}
	s := NewSelector(factory, goodResolver(), time.Hour) // long TTL

	dev := sampleDevice()
	_, _, _ = s.Select(context.Background(), dev)
	_, _, _ = s.Select(context.Background(), dev) // should hit cache

	if callCount > 1 {
		t.Errorf("expected only 1 factory call (cached), got %d", callCount)
	}
}

func TestSelector_InvalidateRemovesCache(t *testing.T) {
	callCount := 0
	factory := func(proto Protocol, _ CredentialResolver) (DeviceClient, error) {
		callCount++
		return &fakeSelectorClient{proto: proto, reachable: true, latency: 5}, nil
	}
	s := NewSelector(factory, goodResolver(), time.Hour)

	dev := sampleDevice()
	_, _, _ = s.Select(context.Background(), dev)
	s.InvalidateAdapter(dev.DeviceID)
	_, _, _ = s.Select(context.Background(), dev) // should NOT hit cache

	if callCount < 2 {
		t.Errorf("expected at least 2 factory calls after invalidation, got %d", callCount)
	}
}

// ── testHTTPDoer helper ───────────────────────────────────────────────────────

// testHTTPDoer is used by REST adapter tests.
type testHTTPDoer struct {
	status int
	body   string
	err    error
}

func (f *testHTTPDoer) Do(_ *http.Request) (*http.Response, error) {
	if f.err != nil {
		return nil, f.err
	}
	return &http.Response{
		StatusCode: f.status,
		Body:       testReadCloser(f.body),
	}, nil
}

// testReadCloser wraps a string into a ReadCloser for HTTP response bodies.
type testRC struct{ r *strings.Reader }

func (t *testRC) Read(b []byte) (int, error) { return t.r.Read(b) }
func (t *testRC) Close() error               { return nil }

func testReadCloser(s string) interface {
	Read([]byte) (int, error)
	Close() error
} {
	return &testRC{r: strings.NewReader(s)}
}

// Verify fakeResolver implements CredentialResolver.
var _ CredentialResolver = (*fakeResolver)(nil)

// Verify adapters implement DeviceClient at compile time.
var _ DeviceClient = (*SNMPAdapter)(nil)
var _ DeviceClient = (*CLIAdapter)(nil)
var _ DeviceClient = (*RESTAdapter)(nil)
var _ DeviceClient = (*GRPCAdapter)(nil)

// ── categorizeDialError / categorizeSafeMsg ───────────────────────────────────

func TestCategorizeDialError(t *testing.T) {
	cases := []struct {
		msg      string
		expected AdapterFailureCategory
	}{
		{"timeout: connection timed out", FailureCategoryTimeout},
		{"auth failed: bad password", FailureCategoryAuthFailed},
		{"connection refused", FailureCategoryUnreachable},
		{"unknown error", FailureCategoryInternal},
	}
	for _, tc := range cases {
		got := categorizeDialError(fmt.Errorf("%s", tc.msg))
		if got != tc.expected {
			t.Errorf("categorizeDialError(%q) = %s, want %s", tc.msg, got, tc.expected)
		}
	}
}

func TestCategorizeDialError_Nil(t *testing.T) {
	if categorizeDialError(nil) != "" {
		t.Error("nil error should return empty category")
	}
}
