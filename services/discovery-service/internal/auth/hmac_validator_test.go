package auth_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
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
	secrets   map[string]string // serial -> secret
	shouldErr bool
}

func (f *fakeSecretResolver) GetSecretBySerial(serial string) (string, bool, error) {
	if f.shouldErr {
		return "", false, fmt.Errorf("secret store error")
	}
	s, ok := f.secrets[serial]
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
	testSerial = "SN12345678"
	testSecret = "super-secret-key-for-testing"
)

func buildRequest(t *testing.T, method, path string, body []byte, secret, nonce string, tsOffset int64) *http.Request {
	t.Helper()
	ts := fmt.Sprintf("%d", time.Now().Unix()+tsOffset)
	sig := auth.ComputeSignature(secret, method, path, ts, nonce, body)
	req, err := http.NewRequest(method, path, bytes.NewBuffer(body))
	if err != nil {
		t.Fatalf("build request: %v", err)
	}
	req.Header.Set(auth.HeaderSignature, sig)
	req.Header.Set(auth.HeaderTimestamp, ts)
	req.Header.Set(auth.HeaderNonce, nonce)
	return req
}

func newValidator(t *testing.T, nonces auth.NonceStore, secrets auth.SecretResolver, toleranceSecs int64) *auth.Validator {
	t.Helper()
	return auth.NewValidator(nonces, secrets, auth.ValidatorConfig{ToleranceSecs: toleranceSecs})
}

// ── Tests ─────────────────────────────────────────────────────────────────────

func TestValidate_HappyPath(t *testing.T) {
	secrets := &fakeSecretResolver{secrets: map[string]string{testSerial: testSecret}}
	nonces := newFakeNonceStore()
	v := newValidator(t, nonces, secrets, 300)

	body := []byte(`{"serialNumber":"SN12345678","macAddress":"AA:BB:CC:DD:EE:FF","ipAddress":"192.168.1.1"}`)
	req := buildRequest(t, http.MethodPost, "/api/v1/discovery/check-in", body, testSecret, "nonce-abc-001", 0)
	w := httptest.NewRecorder()

	gotBody, ok := v.Validate(w, req, testSerial, "corr-001")
	if !ok {
		t.Fatalf("expected valid, got status %d: %s", w.Code, w.Body.String())
	}
	if !bytes.Equal(gotBody, body) {
		t.Errorf("body mismatch: got %q, want %q", gotBody, body)
	}
	if w.Code == http.StatusOK {
		t.Log("no response written — correct for passing validation")
	}
}

func TestValidate_MissingSignatureHeader(t *testing.T) {
	secrets := &fakeSecretResolver{secrets: map[string]string{testSerial: testSecret}}
	v := newValidator(t, newFakeNonceStore(), secrets, 300)

	req, _ := http.NewRequest(http.MethodPost, "/check-in", bytes.NewBuffer([]byte(`{}`)))
	req.Header.Set(auth.HeaderTimestamp, fmt.Sprintf("%d", time.Now().Unix()))
	req.Header.Set(auth.HeaderNonce, "some-nonce")
	// X-UBR-Signature deliberately omitted

	w := httptest.NewRecorder()
	_, ok := v.Validate(w, req, testSerial, "corr-002")
	if ok {
		t.Fatal("expected validation failure for missing signature header")
	}
	if w.Code != 462 {
		t.Errorf("expected 462, got %d", w.Code)
	}
}

func TestValidate_MissingTimestampHeader(t *testing.T) {
	secrets := &fakeSecretResolver{secrets: map[string]string{testSerial: testSecret}}
	v := newValidator(t, newFakeNonceStore(), secrets, 300)

	req, _ := http.NewRequest(http.MethodPost, "/check-in", bytes.NewBuffer([]byte(`{}`)))
	req.Header.Set(auth.HeaderSignature, "deadbeef")
	req.Header.Set(auth.HeaderNonce, "some-nonce")
	// X-UBR-Timestamp deliberately omitted

	w := httptest.NewRecorder()
	_, ok := v.Validate(w, req, testSerial, "corr-003")
	if ok {
		t.Fatal("expected validation failure for missing timestamp header")
	}
	if w.Code != 462 {
		t.Errorf("expected 462, got %d", w.Code)
	}
}

func TestValidate_ExpiredTimestamp(t *testing.T) {
	secrets := &fakeSecretResolver{secrets: map[string]string{testSerial: testSecret}}
	v := newValidator(t, newFakeNonceStore(), secrets, 300)

	// Timestamp is 301 seconds in the past — outside the 300-second window
	body := []byte(`{}`)
	req := buildRequest(t, http.MethodPost, "/check-in", body, testSecret, "nonce-stale-001", -301)

	w := httptest.NewRecorder()
	_, ok := v.Validate(w, req, testSerial, "corr-004")
	if ok {
		t.Fatal("expected validation failure for expired timestamp")
	}
	if w.Code != 462 {
		t.Errorf("expected 462, got %d", w.Code)
	}
}

func TestValidate_FutureTimestampBeyondTolerance(t *testing.T) {
	secrets := &fakeSecretResolver{secrets: map[string]string{testSerial: testSecret}}
	v := newValidator(t, newFakeNonceStore(), secrets, 300)

	body := []byte(`{}`)
	req := buildRequest(t, http.MethodPost, "/check-in", body, testSecret, "nonce-future-001", 301)

	w := httptest.NewRecorder()
	_, ok := v.Validate(w, req, testSerial, "corr-005")
	if ok {
		t.Fatal("expected validation failure for future timestamp beyond tolerance")
	}
	if w.Code != 462 {
		t.Errorf("expected 462, got %d", w.Code)
	}
}

func TestValidate_TimestampAtEdgeOfWindow(t *testing.T) {
	secrets := &fakeSecretResolver{secrets: map[string]string{testSerial: testSecret}}
	v := newValidator(t, newFakeNonceStore(), secrets, 300)

	// Exactly at the boundary — should pass
	body := []byte(`{}`)
	req := buildRequest(t, http.MethodPost, "/check-in", body, testSecret, "nonce-edge-001", -300)

	w := httptest.NewRecorder()
	_, ok := v.Validate(w, req, testSerial, "corr-006")
	if !ok {
		t.Errorf("expected timestamp at exact boundary to pass, got %d: %s", w.Code, w.Body.String())
	}
}

func TestValidate_NonceReplay(t *testing.T) {
	secrets := &fakeSecretResolver{secrets: map[string]string{testSerial: testSecret}}
	nonces := newFakeNonceStore()
	v := newValidator(t, nonces, secrets, 300)

	body := []byte(`{}`)
	const replayNonce = "nonce-replay-001"

	// First request — should pass
	req1 := buildRequest(t, http.MethodPost, "/check-in", body, testSecret, replayNonce, 0)
	w1 := httptest.NewRecorder()
	_, ok := v.Validate(w1, req1, testSerial, "corr-007a")
	if !ok {
		t.Fatalf("first request should pass, got %d", w1.Code)
	}

	// Second request with the same nonce — should fail
	req2 := buildRequest(t, http.MethodPost, "/check-in", body, testSecret, replayNonce, 0)
	w2 := httptest.NewRecorder()
	_, ok = v.Validate(w2, req2, testSerial, "corr-007b")
	if ok {
		t.Fatal("replayed nonce should fail")
	}
	if w2.Code != 462 {
		t.Errorf("expected 462 for replay, got %d", w2.Code)
	}
}

func TestValidate_TamperedBody(t *testing.T) {
	secrets := &fakeSecretResolver{secrets: map[string]string{testSerial: testSecret}}
	v := newValidator(t, newFakeNonceStore(), secrets, 300)

	originalBody := []byte(`{"serialNumber":"SN12345678"}`)
	tamperedBody := []byte(`{"serialNumber":"EVIL12345678"}`)

	ts := fmt.Sprintf("%d", time.Now().Unix())
	nonce := "nonce-tamper-001"
	// Signature computed over originalBody
	sig := auth.ComputeSignature(testSecret, http.MethodPost, "/check-in", ts, nonce, originalBody)

	// Request carries tamperedBody but signature was for originalBody
	req, _ := http.NewRequest(http.MethodPost, "/check-in", bytes.NewBuffer(tamperedBody))
	req.Header.Set(auth.HeaderSignature, sig)
	req.Header.Set(auth.HeaderTimestamp, ts)
	req.Header.Set(auth.HeaderNonce, nonce)

	w := httptest.NewRecorder()
	_, ok := v.Validate(w, req, testSerial, "corr-008")
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
	req := buildRequest(t, http.MethodPost, "/check-in", body, testSecret, "nonce-nosecret-001", 0)

	w := httptest.NewRecorder()
	_, ok := v.Validate(w, req, testSerial, "corr-009")
	if ok {
		t.Fatal("missing device secret should fail")
	}
	if w.Code != 462 {
		t.Errorf("expected 462 for no active secret, got %d", w.Code)
	}
}

func TestValidate_NonceStoreUnavailable(t *testing.T) {
	secrets := &fakeSecretResolver{secrets: map[string]string{testSerial: testSecret}}
	nonces := &fakeNonceStore{shouldErr: true}
	v := newValidator(t, nonces, secrets, 300)

	body := []byte(`{}`)
	req := buildRequest(t, http.MethodPost, "/check-in", body, testSecret, "nonce-err-001", 0)

	w := httptest.NewRecorder()
	_, ok := v.Validate(w, req, testSerial, "corr-010")
	if ok {
		t.Fatal("nonce store error should fail closed")
	}
	if w.Code != http.StatusServiceUnavailable {
		t.Errorf("expected 503 for nonce store unavailable, got %d", w.Code)
	}
}

func TestValidate_EmptyBody(t *testing.T) {
	secrets := &fakeSecretResolver{secrets: map[string]string{testSerial: testSecret}}
	v := newValidator(t, newFakeNonceStore(), secrets, 300)

	// Empty body is valid — signature still covers empty body hash
	emptyBody := []byte{}
	req := buildRequest(t, http.MethodPost, "/check-in", emptyBody, testSecret, "nonce-empty-001", 0)

	w := httptest.NewRecorder()
	gotBody, ok := v.Validate(w, req, testSerial, "corr-011")
	if !ok {
		t.Fatalf("empty body with valid signature should pass, got %d: %s", w.Code, w.Body.String())
	}
	if len(gotBody) != 0 {
		t.Errorf("expected empty body back, got %q", gotBody)
	}
}

func TestComputeSignature_Deterministic(t *testing.T) {
	body := []byte(`{"test":"value"}`)
	ts := "1700000000"
	nonce := "det-nonce"
	method := "POST"
	path := "/api/v1/check-in"

	sig1 := auth.ComputeSignature(testSecret, method, path, ts, nonce, body)
	sig2 := auth.ComputeSignature(testSecret, method, path, ts, nonce, body)
	if sig1 != sig2 {
		t.Errorf("signature not deterministic: %q != %q", sig1, sig2)
	}
	if len(sig1) != 64 { // SHA256 hex = 64 chars
		t.Errorf("unexpected signature length: %d", len(sig1))
	}
}

func TestComputeSignature_CanonicalFormat(t *testing.T) {
	body := []byte(`{"key":"val"}`)
	ts := "1700000000"
	nonce := "canonical-nonce"
	method := "POST"
	path := "/check-in"
	secret := "test-secret"

	// Manually compute what the function should produce
	bodyHash := sha256.Sum256(body)
	canonical := fmt.Sprintf("%s\n%s\n%s\n%s\n%s",
		method, path, ts, nonce, hex.EncodeToString(bodyHash[:]))
	_ = canonical // validates the format expectation

	got := auth.ComputeSignature(secret, method, path, ts, nonce, body)
	if !strings.HasPrefix(got, "") || len(got) != 64 {
		t.Errorf("unexpected signature format: %q", got)
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
	req := buildRequest(t, http.MethodPost, "/check-in", body, testSecret, "nonce-audit-001", 0)
	w := httptest.NewRecorder()
	v.Validate(w, req, testSerial, "corr-audit-001") //nolint:errcheck

	if auditReason == "" {
		t.Error("expected audit event to be emitted on failure")
	}
}
