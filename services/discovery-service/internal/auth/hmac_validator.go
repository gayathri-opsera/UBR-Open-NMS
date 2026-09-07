// Package auth provides HMAC-SHA256 request validation for southbound UBR device endpoints (WO-015).
//
// # Header protocol
//
//	X-UBR-Timestamp  Unix epoch seconds (string)
//	X-UBR-Nonce      Random unique string per request
//	X-UBR-Signature  hex(HMAC-SHA256(secret, "METHOD\nPATH\nTIMESTAMP\nNONCE\nSHA256(body)"))
//
// The tolerance window is configurable via HMAC_TIMESTAMP_TOLERANCE_SECS (default 300s).
// Nonces are stored with a 10-minute TTL to reject replays.
//
// SECURITY: never log the secret, signature value, or raw HMAC material.
package auth

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"strconv"
	"sync"
	"time"

	"github.com/airtel-ubrnms/discovery-service/internal/southbound"
)

// Header names for WO-015 southbound HMAC authentication.
const (
	HeaderSignature = "X-UBR-Signature"
	HeaderTimestamp = "X-UBR-Timestamp"
	HeaderNonce     = "X-UBR-Nonce"
)

const (
	defaultTimestampToleranceSecs = int64(300)
	DefaultNonceTTL               = 10 * time.Minute
)

// NonceStore is the interface for nonce replay protection.
// All implementations must be safe for concurrent use.
type NonceStore interface {
	// Check returns (true, nil) when the nonce is fresh (first use within TTL),
	// (false, nil) when it is a replay, and (false, err) on storage failure.
	Check(ctx context.Context, nonce string) (fresh bool, err error)
}

// SecretResolver looks up the active per-device HMAC secret.
type SecretResolver interface {
	// GetSecretBySerial returns (secretValue, found, error).
	// secretValue must never be logged.
	GetSecretBySerial(serialNumber string) (string, bool, error)
}

// AuditEventFunc is called on every validation failure to emit
// a "southbound.hmac.failure" audit event.
type AuditEventFunc func(corrID, reason, deviceSerial string)

// Validator performs HMAC-SHA256 validation on southbound requests.
type Validator struct {
	nonces        NonceStore
	secrets       SecretResolver
	toleranceSecs int64
	onFailure     AuditEventFunc
}

// ValidatorConfig carries optional overrides for the Validator.
type ValidatorConfig struct {
	// ToleranceSecs overrides the HMAC_TIMESTAMP_TOLERANCE_SECS env var.
	// Zero means "read from env or use default (300)".
	ToleranceSecs int64
	// OnFailure is called on every failed validation.
	OnFailure AuditEventFunc
}

// NewValidator constructs a Validator with the given dependencies.
func NewValidator(nonces NonceStore, secrets SecretResolver, cfg ValidatorConfig) *Validator {
	tol := cfg.ToleranceSecs
	if tol == 0 {
		if v, err := strconv.ParseInt(os.Getenv("HMAC_TIMESTAMP_TOLERANCE_SECS"), 10, 64); err == nil && v > 0 {
			tol = v
		} else {
			tol = defaultTimestampToleranceSecs
		}
	}
	onFail := cfg.OnFailure
	if onFail == nil {
		onFail = func(_, _, _ string) {}
	}
	return &Validator{
		nonces:        nonces,
		secrets:       secrets,
		toleranceSecs: tol,
		onFailure:     onFail,
	}
}

// Validate reads the request body, peeks the device serial for secret lookup,
// validates all HMAC authentication conditions, and returns the buffered body bytes
// (rewound into r.Body for downstream handlers) on success.
//
// When ok is false, the appropriate southbound error has already been written to w.
// The caller MUST NOT write any further response in that case.
//
// serialPeek is the device serial number extracted from the request body by the caller
// before invoking Validate. It is used exclusively to look up the per-device secret.
//
// SECURITY: this function never logs the secret, signature, or raw HMAC material.
func (v *Validator) Validate(w http.ResponseWriter, r *http.Request, serialPeek, corrID string) (bodyBytes []byte, ok bool) {
	// ── 1. Extract required headers ───────────────────────────────────────────
	sig := r.Header.Get(HeaderSignature)
	tsStr := r.Header.Get(HeaderTimestamp)
	nonce := r.Header.Get(HeaderNonce)

	if sig == "" || tsStr == "" || nonce == "" {
		v.fail(w, corrID, "missing_headers", serialPeek)
		return nil, false
	}

	// ── 2. Validate timestamp freshness ───────────────────────────────────────
	ts, err := strconv.ParseInt(tsStr, 10, 64)
	if err != nil {
		v.fail(w, corrID, "invalid_timestamp", serialPeek)
		return nil, false
	}
	delta := time.Now().Unix() - ts
	if delta < 0 {
		delta = -delta
	}
	if delta > v.toleranceSecs {
		v.fail(w, corrID, "stale_timestamp", serialPeek)
		return nil, false
	}

	// ── 3. Nonce replay protection ────────────────────────────────────────────
	fresh, err := v.nonces.Check(r.Context(), nonce)
	if err != nil {
		slog.Error("HMAC nonce store unavailable", "corrID", corrID)
		southbound.ServiceUnavailable(w, "HMAC nonce store temporarily unavailable.", corrID, southbound.DefaultRetryConfig)
		return nil, false
	}
	if !fresh {
		v.fail(w, corrID, "nonce_replay", serialPeek)
		return nil, false
	}

	// ── 4. Read and buffer body bytes ─────────────────────────────────────────
	body, err := io.ReadAll(r.Body)
	if err != nil {
		slog.Error("Failed to read request body for HMAC validation", "corrID", corrID)
		southbound.InternalError(w, corrID)
		return nil, false
	}
	r.Body = io.NopCloser(bytes.NewBuffer(body)) // rewind for downstream handler

	// ── 5. Resolve per-device secret ──────────────────────────────────────────
	secret, found, err := v.secrets.GetSecretBySerial(serialPeek)
	if err != nil {
		slog.Error("Secret store error during HMAC validation", "corrID", corrID)
		southbound.InternalError(w, corrID)
		return nil, false
	}
	if !found || secret == "" {
		v.fail(w, corrID, "no_active_secret", serialPeek)
		return nil, false
	}

	// ── 6. Compute and compare signature (constant-time) ─────────────────────
	expected := computeSignature(secret, r.Method, r.URL.Path, tsStr, nonce, body)
	if !hmac.Equal([]byte(sig), []byte(expected)) {
		v.fail(w, corrID, "signature_mismatch", serialPeek)
		return nil, false
	}

	return body, true
}

// ValidatePreloaded validates HMAC authentication when the caller has already read
// and peeked the request body. The body bytes are validated and then rewound into
// r.Body for the downstream handler.
//
// Use this when the serial number must be extracted from the body before validation.
//
// SECURITY: this function never logs the secret, signature, or raw HMAC material.
func (v *Validator) ValidatePreloaded(w http.ResponseWriter, r *http.Request, deviceSerial, corrID string, body []byte) bool {
	// Rewind body into request so Validate can read it
	r.Body = io.NopCloser(bytes.NewBuffer(body))
	// Set a sentinel to skip the body-read step — we pass body directly
	_, ok := v.validateWithBody(w, r, deviceSerial, corrID, body)
	return ok
}

// validateWithBody performs all HMAC checks using caller-provided body bytes.
// r.Body is reset to the provided body on success.
func (v *Validator) validateWithBody(w http.ResponseWriter, r *http.Request, deviceSerial, corrID string, body []byte) ([]byte, bool) {
	sig := r.Header.Get(HeaderSignature)
	tsStr := r.Header.Get(HeaderTimestamp)
	nonce := r.Header.Get(HeaderNonce)

	if sig == "" || tsStr == "" || nonce == "" {
		v.fail(w, corrID, "missing_headers", deviceSerial)
		return nil, false
	}

	ts, err := strconv.ParseInt(tsStr, 10, 64)
	if err != nil {
		v.fail(w, corrID, "invalid_timestamp", deviceSerial)
		return nil, false
	}
	delta := time.Now().Unix() - ts
	if delta < 0 {
		delta = -delta
	}
	if delta > v.toleranceSecs {
		v.fail(w, corrID, "stale_timestamp", deviceSerial)
		return nil, false
	}

	fresh, err := v.nonces.Check(r.Context(), nonce)
	if err != nil {
		slog.Error("HMAC nonce store unavailable", "corrID", corrID)
		southbound.ServiceUnavailable(w, "HMAC nonce store temporarily unavailable.", corrID, southbound.DefaultRetryConfig)
		return nil, false
	}
	if !fresh {
		v.fail(w, corrID, "nonce_replay", deviceSerial)
		return nil, false
	}

	secret, found, err := v.secrets.GetSecretBySerial(deviceSerial)
	if err != nil {
		slog.Error("Secret store error during HMAC validation", "corrID", corrID)
		southbound.InternalError(w, corrID)
		return nil, false
	}
	if !found || secret == "" {
		v.fail(w, corrID, "no_active_secret", deviceSerial)
		return nil, false
	}

	expected := computeSignature(secret, r.Method, r.URL.Path, tsStr, nonce, body)
	if !hmac.Equal([]byte(sig), []byte(expected)) {
		v.fail(w, corrID, "signature_mismatch", deviceSerial)
		return nil, false
	}

	r.Body = io.NopCloser(bytes.NewBuffer(body)) // rewind for downstream handler
	return body, true
}

// fail writes the HMACInvalid southbound error and emits the audit event.
// SECURITY: never include the secret, signature, or nonce value in any log field.
func (v *Validator) fail(w http.ResponseWriter, corrID, reason, deviceSerial string) {
	slog.Warn("HMAC validation failure",
		"corrID", corrID,
		"reason", reason,
		// deviceSerial is sanitized identity only — never a secret
	)
	southbound.HMACInvalid(w, corrID)
	v.onFailure(corrID, reason, deviceSerial)
}

// computeSignature computes HMAC-SHA256 over the canonical message
// "METHOD\nPATH\nTIMESTAMP\nNONCE\nSHA256(body)" and returns the hex digest.
//
// SECURITY: secret must never be logged or included in error messages.
func computeSignature(secret, method, path, timestamp, nonce string, body []byte) string {
	bodyHash := sha256.Sum256(body)
	canonical := fmt.Sprintf("%s\n%s\n%s\n%s\n%s",
		method, path, timestamp, nonce, hex.EncodeToString(bodyHash[:]))
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(canonical))
	return hex.EncodeToString(mac.Sum(nil))
}

// ComputeSignature is exported for device simulators and integration test harnesses.
// SECURITY: only call this from trusted internal code; never expose over HTTP.
func ComputeSignature(secret, method, path, timestamp, nonce string, body []byte) string {
	return computeSignature(secret, method, path, timestamp, nonce, body)
}

// ── InMemoryNonceStore ────────────────────────────────────────────────────────

// InMemoryNonceStore is a TTL-based in-memory nonce store for single-instance deployments
// or test environments. Replace with a Redis-backed implementation for multi-instance deployments.
type InMemoryNonceStore struct {
	mu      sync.Mutex
	entries map[string]time.Time
	ttl     time.Duration
}

// NewInMemoryNonceStore constructs an InMemoryNonceStore with the given TTL.
func NewInMemoryNonceStore(ttl time.Duration) *InMemoryNonceStore {
	return &InMemoryNonceStore{
		entries: make(map[string]time.Time),
		ttl:     ttl,
	}
}

// Check implements NonceStore. Returns (true, nil) for a fresh nonce, (false, nil) for a replay.
// Prunes expired entries on every call to prevent unbounded memory growth.
func (s *InMemoryNonceStore) Check(_ context.Context, nonce string) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	now := time.Now()
	// Prune expired entries
	for k, exp := range s.entries {
		if now.After(exp) {
			delete(s.entries, k)
		}
	}
	if _, exists := s.entries[nonce]; exists {
		return false, nil // replay
	}
	s.entries[nonce] = now.Add(s.ttl)
	return true, nil
}
