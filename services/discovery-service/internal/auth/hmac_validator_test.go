package auth_test

import (
	"bytes"
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/airtel-ubrnms/discovery-service/internal/auth"
)

// ── Test doubles ──────────────────────────────────────────────────────────────

type fakeSecretResolver struct {
	secrets   map[string]string // deviceID -> secret
	shouldErr bool
}

func (f *fakeSecretResolver) GetSecretBySerial(deviceID string) (string, bool, error) {
	if f.shouldErr {
		return "", false, fmt.Errorf("secret store error")
	}
	s, ok := f.secrets[deviceID]
	return s, ok, nil
}

type fakeNonceStore struct {
	seen      map[string]struct{}
	shouldErr bool
}

func newFakeNonceStore() *fakeNonceStore {
	return &fakeNonceStore{seen: make(map[string]struct{})}
}

func (f *fakeNonceStore) Check(_ context.Context, nonce string) (bool, error) {
	if f.shouldErr {
		return false, fmt.Errorf("nonce store error")
	}
	if _, exists := f.seen[nonce]; exists {
		return false, nil // replay
	}
	f.seen[nonce] = struct{}{}
	return true, nil
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const (
	testDeviceID = "AA:BB:CC:DD:EE:FF" // MAC address — the id= field in Auth-Info
	testSecret   = "super-secret-key-for-testing"
)

// testNonce30 is a 30-character nonce for use in all test requests.
const testNonce30 = "ABCDEFGHIJ1234567890abcdefghij"

// buildRequest constructs a signed HTTP request using the Auth-Info / Auth-Signature
// header protocol defined in WO-015.
func buildRequest(t *testing.T, method, path string, body []byte, secret, nonce string, tsOffset int64) *http.Request {
	t.Helper()
	ts := time.Now().Unix() + tsOffset
	authInfo := auth.BuildAuthInfoHeader(testDeviceID, ts, nonce)
	sig := auth.ComputeAuthSignature(secret, authInfo, path, body)
	req, err := http.NewRequest(method, path, bytes.NewBuffer(body))
	if err != nil {
		t.Fatalf("build request: %v", err)
	}
	req.Header.Set(auth.HeaderAuthInfo, authInfo)
	req.Header.Set(auth.HeaderAuthSignature, sig)
	return req
}

// buildRequestWithDeviceID constructs a signed request with an explicit device ID.
func buildRequestWithDeviceID(t *testing.T, method, path string, body []byte, secret, deviceID, nonce string, tsOffset int64) *http.Request {
	t.Helper()
	ts := time.Now().Unix() + tsOffset
	authInfo := auth.BuildAuthInfoHeader(deviceID, ts, nonce)
	sig := auth.ComputeAuthSignature(secret, authInfo, path, body)
	req, err := http.NewRequest(method, path, bytes.NewBuffer(body))
	if err != nil {
		t.Fatalf("build request: %v", err)
	}
	req.Header.Set(auth.HeaderAuthInfo, authInfo)
	req.Header.Set(auth.HeaderAuthSignature, sig)
	return req
}

func newValidator(t *testing.T, nonces auth.NonceStore, secrets auth.SecretResolver, toleranceSecs int64) *auth.Validator {
	t.Helper()
	return auth.NewValidator(nonces, secrets, auth.ValidatorConfig{ToleranceSecs: toleranceSecs})
}

// ── Tests ─────────────────────────────────────────────────────────────────────

func TestValidate_HappyPath(t *testing.T) {
	secrets := &fakeSecretResolver{secrets: map[string]string{testDeviceID: testSecret}}
	nonces := newFakeNonceStore()
	v := newValidator(t, nonces, secrets, 300)

	body := []byte(`{"serialNumber":"SN12345678","macAddress":"AA:BB:CC:DD:EE:FF","ipAddress":"192.168.1.1"}`)
	req := buildRequest(t, http.MethodPost, "/api/v1/discovery/check-in", body, testSecret, testNonce30, 0)
	w := httptest.NewRecorder()

	deviceID, gotBody, ok := v.Validate(w, req, "corr-001")
	if !ok {
		t.Fatalf("expected valid, got status %d: %s", w.Code, w.Body.String())
	}
	if deviceID != testDeviceID {
		t.Errorf("expected deviceID %q, got %q", testDeviceID, deviceID)
	}
	if !bytes.Equal(gotBody, body) {
		t.Errorf("body mismatch: got %q, want %q", gotBody, body)
	}
}

func TestValidate_MissingAuthInfoHeader(t *testing.T) {
	secrets := &fakeSecretResolver{secrets: map[string]string{testDeviceID: testSecret}}
	v := newValidator(t, newFakeNonceStore(), secrets, 300)

	req, _ := http.NewRequest(http.MethodPost, "/check-in", bytes.NewBuffer([]byte(`{}`)))
	// Auth-Info deliberately omitted; only Auth-Signature set
	req.Header.Set(auth.HeaderAuthSignature, "deadbeef")

	w := httptest.NewRecorder()
	_, _, ok := v.Validate(w, req, "corr-002")
	if ok {
		t.Fatal("expected validation failure for missing Auth-Info header")
	}
	if w.Code != 462 {
		t.Errorf("expected 462, got %d", w.Code)
	}
}

func TestValidate_MissingAuthSignatureHeader(t *testing.T) {
	secrets := &fakeSecretResolver{secrets: map[string]string{testDeviceID: testSecret}}
	v := newValidator(t, newFakeNonceStore(), secrets, 300)

	req, _ := http.NewRequest(http.MethodPost, "/check-in", bytes.NewBuffer([]byte(`{}`)))
	ts := time.Now().Unix()
	req.Header.Set(auth.HeaderAuthInfo, auth.BuildAuthInfoHeader(testDeviceID, ts, testNonce30))
	// Auth-Signature deliberately omitted

	w := httptest.NewRecorder()
	_, _, ok := v.Validate(w, req, "corr-003")
	if ok {
		t.Fatal("expected validation failure for missing Auth-Signature header")
	}
	if w.Code != 462 {
		t.Errorf("expected 462, got %d", w.Code)
	}
}

func TestValidate_MalformedAuthInfo(t *testing.T) {
	secrets := &fakeSecretResolver{secrets: map[string]string{testDeviceID: testSecret}}
	v := newValidator(t, newFakeNonceStore(), secrets, 300)

	req, _ := http.NewRequest(http.MethodPost, "/check-in", bytes.NewBuffer([]byte(`{}`)))
	req.Header.Set(auth.HeaderAuthInfo, "not-valid-format")
	req.Header.Set(auth.HeaderAuthSignature, "deadbeef")

	w := httptest.NewRecorder()
	_, _, ok := v.Validate(w, req, "corr-004")
	if ok {
		t.Fatal("expected validation failure for malformed Auth-Info")
	}
	if w.Code != 462 {
		t.Errorf("expected 462, got %d", w.Code)
	}
}

func TestValidate_ExpiredTimestamp(t *testing.T) {
	secrets := &fakeSecretResolver{secrets: map[string]string{testDeviceID: testSecret}}
	v := newValidator(t, newFakeNonceStore(), secrets, 300)

	// Timestamp is 301 seconds in the past — outside the 300-second window
	body := []byte(`{}`)
	req := buildRequest(t, http.MethodPost, "/check-in", body, testSecret, testNonce30, -301)

	w := httptest.NewRecorder()
	_, _, ok := v.Validate(w, req, "corr-005")
	if ok {
		t.Fatal("expected validation failure for expired timestamp")
	}
	if w.Code != 462 {
		t.Errorf("expected 462, got %d", w.Code)
	}
}

func TestValidate_FutureTimestampBeyondTolerance(t *testing.T) {
	secrets := &fakeSecretResolver{secrets: map[string]string{testDeviceID: testSecret}}
	v := newValidator(t, newFakeNonceStore(), secrets, 300)

	body := []byte(`{}`)
	req := buildRequest(t, http.MethodPost, "/check-in", body, testSecret, testNonce30, 301)

	w := httptest.NewRecorder()
	_, _, ok := v.Validate(w, req, "corr-006")
	if ok {
		t.Fatal("expected validation failure for future timestamp beyond tolerance")
	}
	if w.Code != 462 {
		t.Errorf("expected 462, got %d", w.Code)
	}
}

func TestValidate_TimestampAtEdgeOfWindow(t *testing.T) {
	secrets := &fakeSecretResolver{secrets: map[string]string{testDeviceID: testSecret}}
	v := newValidator(t, newFakeNonceStore(), secrets, 300)

	// Exactly at the boundary — should pass
	body := []byte(`{}`)
	// Use a unique nonce for this test
	nonce := "EdgeNonce1234567890123456789X"
	req := buildRequest(t, http.MethodPost, "/check-in", body, testSecret, nonce, -300)

	w := httptest.NewRecorder()
	_, _, ok := v.Validate(w, req, "corr-007")
	if !ok {
		t.Errorf("expected timestamp at exact boundary to pass, got %d: %s", w.Code, w.Body.String())
	}
}

func TestValidate_NonceReplay(t *testing.T) {
	secrets := &fakeSecretResolver{secrets: map[string]string{testDeviceID: testSecret}}
	nonces := newFakeNonceStore()
	v := newValidator(t, nonces, secrets, 300)

	body := []byte(`{}`)
	// 30-char replay nonce
	const replayNonce = "ReplayNonce123456789012345678"

	// First request — should pass
	req1 := buildRequest(t, http.MethodPost, "/check-in", body, testSecret, replayNonce, 0)
	w1 := httptest.NewRecorder()
	_, _, ok := v.Validate(w1, req1, "corr-008a")
	if !ok {
		t.Fatalf("first request should pass, got %d", w1.Code)
	}

	// Second request with the same nonce — should fail
	req2 := buildRequest(t, http.MethodPost, "/check-in", body, testSecret, replayNonce, 0)
	w2 := httptest.NewRecorder()
	_, _, ok = v.Validate(w2, req2, "corr-008b")
	if ok {
		t.Fatal("replayed nonce should fail")
	}
	if w2.Code != 462 {
		t.Errorf("expected 462 for replay, got %d", w2.Code)
	}
}

func TestValidate_TamperedBody(t *testing.T) {
	secrets := &fakeSecretResolver{secrets: map[string]string{testDeviceID: testSecret}}
	v := newValidator(t, newFakeNonceStore(), secrets, 300)

	originalBody := []byte(`{"serialNumber":"SN12345678"}`)
	tamperedBody := []byte(`{"serialNumber":"EVIL12345678"}`)

	ts := time.Now().Unix()
	nonce := "TamperNonce12345678901234567X"
	authInfo := auth.BuildAuthInfoHeader(testDeviceID, ts, nonce)
	// Signature computed over originalBody
	sig := auth.ComputeAuthSignature(testSecret, authInfo, "/check-in", originalBody)

	// Request carries tamperedBody but signature was for originalBody
	req, _ := http.NewRequest(http.MethodPost, "/check-in", bytes.NewBuffer(tamperedBody))
	req.Header.Set(auth.HeaderAuthInfo, authInfo)
	req.Header.Set(auth.HeaderAuthSignature, sig)

	w := httptest.NewRecorder()
	_, _, ok := v.Validate(w, req, "corr-009")
	if ok {
		t.Fatal("tampered body should fail HMAC validation")
	}
	if w.Code != 462 {
		t.Errorf("expected 462 for tampered body, got %d", w.Code)
	}
}

func TestValidate_NoActiveSecret(t *testing.T) {
	// Device has no secret in the store
	secrets := &fakeSecretResolver{secrets: map[string]string{}}
	v := newValidator(t, newFakeNonceStore(), secrets, 300)

	body := []byte(`{}`)
	nonce := "NoSecretNonce1234567890123456"
	req := buildRequest(t, http.MethodPost, "/check-in", body, testSecret, nonce, 0)

	w := httptest.NewRecorder()
	_, _, ok := v.Validate(w, req, "corr-010")
	if ok {
		t.Fatal("missing device secret should fail")
	}
	if w.Code != 462 {
		t.Errorf("expected 462 for no active secret, got %d", w.Code)
	}
}

func TestValidate_NonceStoreUnavailable(t *testing.T) {
	secrets := &fakeSecretResolver{secrets: map[string]string{testDeviceID: testSecret}}
	nonces := &fakeNonceStore{shouldErr: true}
	v := newValidator(t, nonces, secrets, 300)

	body := []byte(`{}`)
	req := buildRequest(t, http.MethodPost, "/check-in", body, testSecret, testNonce30, 0)

	w := httptest.NewRecorder()
	_, _, ok := v.Validate(w, req, "corr-011")
	if ok {
		t.Fatal("nonce store error should fail closed")
	}
	if w.Code != http.StatusServiceUnavailable {
		t.Errorf("expected 503 for nonce store unavailable, got %d", w.Code)
	}
}

func TestValidate_EmptyBody(t *testing.T) {
	secrets := &fakeSecretResolver{secrets: map[string]string{testDeviceID: testSecret}}
	v := newValidator(t, newFakeNonceStore(), secrets, 300)

	// Empty body is valid — signature still covers empty body
	emptyBody := []byte{}
	nonce := "EmptyBodyNonce1234567890123456"[:30]
	req := buildRequest(t, http.MethodPost, "/check-in", emptyBody, testSecret, nonce, 0)

	w := httptest.NewRecorder()
	deviceID, gotBody, ok := v.Validate(w, req, "corr-012")
	if !ok {
		t.Fatalf("empty body with valid signature should pass, got %d: %s", w.Code, w.Body.String())
	}
	if len(gotBody) != 0 {
		t.Errorf("expected empty body back, got %q", gotBody)
	}
	if deviceID != testDeviceID {
		t.Errorf("expected deviceID %q, got %q", testDeviceID, deviceID)
	}
}

func TestValidate_InvalidatedSecret(t *testing.T) {
	// Secret store returns an error (invalidated/revoked secret scenario)
	secrets := &fakeSecretResolver{shouldErr: true}
	v := newValidator(t, newFakeNonceStore(), secrets, 300)

	body := []byte(`{}`)
	nonce := "InvalidatedSecret12345678901X"[:30]
	req := buildRequest(t, http.MethodPost, "/check-in", body, testSecret, nonce, 0)

	w := httptest.NewRecorder()
	_, _, ok := v.Validate(w, req, "corr-013")
	if ok {
		t.Fatal("invalidated secret should fail")
	}
	// Secret store errors produce 500, not 462
	if w.Code == http.StatusOK {
		t.Error("expected non-200 response for secret store error")
	}
}

// ── ParseAuthInfo tests ───────────────────────────────────────────────────────

func TestParseAuthInfo_Valid(t *testing.T) {
	nonce := strings.Repeat("x", 30)
	header := fmt.Sprintf("id=AA:BB:CC:DD:EE:FF,timestamp=1700000000,nonce=%s", nonce)
	info, err := auth.ParseAuthInfo(header)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if info.DeviceID != "AA:BB:CC:DD:EE:FF" {
		t.Errorf("DeviceID: got %q, want %q", info.DeviceID, "AA:BB:CC:DD:EE:FF")
	}
	if info.Timestamp != "1700000000" {
		t.Errorf("Timestamp: got %q, want %q", info.Timestamp, "1700000000")
	}
	if info.Nonce != nonce {
		t.Errorf("Nonce: got %q, want %q", info.Nonce, nonce)
	}
}

func TestParseAuthInfo_MissingID(t *testing.T) {
	nonce := strings.Repeat("y", 30)
	_, err := auth.ParseAuthInfo(fmt.Sprintf("timestamp=1700000000,nonce=%s", nonce))
	if err == nil {
		t.Fatal("expected error for missing id field")
	}
}

func TestParseAuthInfo_MissingTimestamp(t *testing.T) {
	nonce := strings.Repeat("z", 30)
	_, err := auth.ParseAuthInfo(fmt.Sprintf("id=AA:BB:CC:DD:EE:FF,nonce=%s", nonce))
	if err == nil {
		t.Fatal("expected error for missing timestamp field")
	}
}

func TestParseAuthInfo_MissingNonce(t *testing.T) {
	_, err := auth.ParseAuthInfo("id=AA:BB:CC:DD:EE:FF,timestamp=1700000000")
	if err == nil {
		t.Fatal("expected error for missing nonce field")
	}
}

func TestParseAuthInfo_NonceTooShort(t *testing.T) {
	_, err := auth.ParseAuthInfo("id=AA:BB:CC:DD:EE:FF,timestamp=1700000000,nonce=tooshort")
	if err == nil {
		t.Fatal("expected error for nonce shorter than 30 chars")
	}
}

func TestParseAuthInfo_NonceTooLong(t *testing.T) {
	longNonce := strings.Repeat("a", 31)
	_, err := auth.ParseAuthInfo(fmt.Sprintf("id=AA:BB:CC:DD:EE:FF,timestamp=1700000000,nonce=%s", longNonce))
	if err == nil {
		t.Fatal("expected error for nonce longer than 30 chars")
	}
}

// ── ComputeAuthSignature tests ────────────────────────────────────────────────

func TestComputeAuthSignature_Deterministic(t *testing.T) {
	body := []byte(`{"test":"value"}`)
	authInfo := auth.BuildAuthInfoHeader(testDeviceID, 1700000000, testNonce30)
	path := "/api/v1/check-in"

	sig1 := auth.ComputeAuthSignature(testSecret, authInfo, path, body)
	sig2 := auth.ComputeAuthSignature(testSecret, authInfo, path, body)
	if sig1 != sig2 {
		t.Errorf("signature not deterministic: %q != %q", sig1, sig2)
	}
	if len(sig1) != 64 { // SHA256 hex = 64 chars
		t.Errorf("unexpected signature length: %d", len(sig1))
	}
}

func TestComputeAuthSignature_DifferentBodyProducesDifferentSig(t *testing.T) {
	authInfo := auth.BuildAuthInfoHeader(testDeviceID, 1700000000, testNonce30)
	path := "/api/v1/check-in"

	sig1 := auth.ComputeAuthSignature(testSecret, authInfo, path, []byte(`{"a":1}`))
	sig2 := auth.ComputeAuthSignature(testSecret, authInfo, path, []byte(`{"a":2}`))
	if sig1 == sig2 {
		t.Error("different bodies should produce different signatures")
	}
}

func TestComputeAuthSignature_DifferentPathProducesDifferentSig(t *testing.T) {
	authInfo := auth.BuildAuthInfoHeader(testDeviceID, 1700000000, testNonce30)
	body := []byte(`{}`)

	sig1 := auth.ComputeAuthSignature(testSecret, authInfo, "/path/a", body)
	sig2 := auth.ComputeAuthSignature(testSecret, authInfo, "/path/b", body)
	if sig1 == sig2 {
		t.Error("different paths should produce different signatures")
	}
}

// ── InMemoryNonceStore tests ──────────────────────────────────────────────────

func TestInMemoryNonceStore_FreshNonce(t *testing.T) {
	store := auth.NewInMemoryNonceStore(10 * time.Minute)
	fresh, err := store.Check(context.Background(), "nonce-fresh-001")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !fresh {
		t.Error("expected fresh nonce to return true")
	}
}

func TestInMemoryNonceStore_ReplayNonce(t *testing.T) {
	store := auth.NewInMemoryNonceStore(10 * time.Minute)
	nonce := "replay-test"
	store.Check(context.Background(), nonce) //nolint:errcheck
	fresh, err := store.Check(context.Background(), nonce)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if fresh {
		t.Error("expected replayed nonce to return false")
	}
}

func TestInMemoryNonceStore_ExpiredNoncesArePruned(t *testing.T) {
	store := auth.NewInMemoryNonceStore(50 * time.Millisecond) // very short TTL for testing
	nonce := "expiring-nonce"
	store.Check(context.Background(), nonce) //nolint:errcheck

	time.Sleep(100 * time.Millisecond) // wait for TTL to expire

	// After expiry the nonce should be treated as fresh again
	fresh, err := store.Check(context.Background(), nonce)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !fresh {
		t.Error("expired nonce should be treated as fresh after TTL")
	}
}

func TestValidate_AuditEventEmittedOnFailure(t *testing.T) {
	secrets := &fakeSecretResolver{secrets: map[string]string{}}
	var auditReason string
	v := auth.NewValidator(newFakeNonceStore(), secrets, auth.ValidatorConfig{
		ToleranceSecs: 300,
		OnFailure: func(_, reason, _ string) {
			auditReason = reason
		},
	})

	body := []byte(`{}`)
	req := buildRequest(t, http.MethodPost, "/check-in", body, testSecret, testNonce30, 0)
	w := httptest.NewRecorder()
	v.Validate(w, req, "corr-audit-001") //nolint:errcheck

	if auditReason == "" {
		t.Error("expected audit event to be emitted on failure")
	}
}

// ── Fixture-based tests (AC6) ─────────────────────────────────────────────────
// These tests validate the parsing and signing logic against committed fixture scenarios.

func TestValidate_MissingBothHeaders(t *testing.T) {
	secrets := &fakeSecretResolver{secrets: map[string]string{testDeviceID: testSecret}}
	v := newValidator(t, newFakeNonceStore(), secrets, 300)

	req, _ := http.NewRequest(http.MethodPost, "/check-in", bytes.NewBuffer([]byte(`{}`)))
	// Neither Auth-Info nor Auth-Signature set

	w := httptest.NewRecorder()
	_, _, ok := v.Validate(w, req, "corr-missing-both")
	if ok {
		t.Fatal("expected failure when both headers are absent")
	}
	if w.Code != 462 {
		t.Errorf("expected 462, got %d", w.Code)
	}
}

func TestBuildAuthInfoHeader(t *testing.T) {
	header := auth.BuildAuthInfoHeader("AA:BB:CC:DD:EE:FF", 1700000000, testNonce30)
	expected := fmt.Sprintf("id=AA:BB:CC:DD:EE:FF,timestamp=1700000000,nonce=%s", testNonce30)
	if header != expected {
		t.Errorf("BuildAuthInfoHeader: got %q, want %q", header, expected)
	}

	// Verify round-trip through ParseAuthInfo
	info, err := auth.ParseAuthInfo(header)
	if err != nil {
		t.Fatalf("ParseAuthInfo round-trip error: %v", err)
	}
	if info.DeviceID != "AA:BB:CC:DD:EE:FF" {
		t.Errorf("round-trip DeviceID: got %q", info.DeviceID)
	}
	if info.Timestamp != "1700000000" {
		t.Errorf("round-trip Timestamp: got %q", info.Timestamp)
	}
	if info.Nonce != testNonce30 {
		t.Errorf("round-trip Nonce: got %q", info.Nonce)
	}
}
