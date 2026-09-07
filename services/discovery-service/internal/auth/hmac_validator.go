// Package auth provides HMAC-SHA256 request validation for southbound UBR device endpoints (WO-015).
//
// # Header protocol (Auth-Info / Auth-Signature format per WO-015 spec)
//
//	Auth-Info      id=<mac-addr>,timestamp=<unix-epoch-secs>,nonce=<30-char-random>
//	Auth-Signature hex(HMAC-SHA256(secret, Auth-Info_value + "\n" + request_path + "\n" + raw_body_bytes))
//
// The Auth-Info header carries the device MAC address (id), request timestamp, and a
// 30-character unique nonce.  The HMAC digest in Auth-Signature is computed over the
// Auth-Info header value, the request path, and the raw request body bytes.
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
	"strings"
	"sync"
	"time"

	"github.com/airtel-ubrnms/discovery-service/internal/southbound"
)

// Header names for WO-015 southbound HMAC authentication.
const (
	HeaderAuthInfo      = "Auth-Info"
	HeaderAuthSignature = "Auth-Signature"
)

// NonceLength is the required length of the nonce field in Auth-Info.
const NonceLength = 30

const (
	defaultTimestampToleranceSecs = int64(300)
	DefaultNonceTTL               = 10 * time.Minute
)

// ParsedAuthInfo holds the structured fields extracted from the Auth-Info header.
// Format on the wire: id=<mac-addr>,timestamp=<unix-time>,nonce=<30-char-nonce>
type ParsedAuthInfo struct {
	DeviceID  string // MAC address, e.g. "AA:BB:CC:DD:EE:FF"
	Timestamp string // Unix epoch seconds as a string
	Nonce     string // 30-character random string
}

// ParseAuthInfo parses the Auth-Info header value into structured fields.
// Returns an error if any required field is missing or the nonce is not exactly NonceLength chars.
func ParseAuthInfo(header string) (ParsedAuthInfo, error) {
	var info ParsedAuthInfo
	for _, part := range strings.Split(header, ",") {
		part = strings.TrimSpace(part)
		kv := strings.SplitN(part, "=", 2)
		if len(kv) != 2 {
			return info, fmt.Errorf("malformed Auth-Info field %q: expected key=value", part)
		}
		key, val := strings.TrimSpace(kv[0]), strings.TrimSpace(kv[1])
		switch key {
		case "id":
			info.DeviceID = val
		case "timestamp":
			info.Timestamp = val
		case "nonce":
			info.Nonce = val
		}
	}
	if info.DeviceID == "" {
		return info, fmt.Errorf("Auth-Info missing required field: id")
	}
	if info.Timestamp == "" {
		return info, fmt.Errorf("Auth-Info missing required field: timestamp")
	}
	if info.Nonce == "" {
		return info, fmt.Errorf("Auth-Info missing required field: nonce")
	}
	if len(info.Nonce) != NonceLength {
		return info, fmt.Errorf("Auth-Info nonce must be exactly %d characters, got %d", NonceLength, len(info.Nonce))
	}
	return info, nil
}

// NonceStore is the interface for nonce replay protection.
// All implementations must be safe for concurrent use.
type NonceStore interface {
	// Check returns (true, nil) when the nonce is fresh (first use within TTL),
	// (false, nil) when it is a replay, and (false, err) on storage failure.
	Check(ctx context.Context, nonce string) (fresh bool, err error)
}

// SecretResolver looks up the active per-device HMAC secret by device identifier.
// In the Auth-Info protocol the device identifier is the MAC address from the id= field.
type SecretResolver interface {
	// GetSecretBySerial returns (secretValue, found, error).
	// secretValue must never be logged.
	GetSecretBySerial(deviceID string) (string, bool, error)
}

// AuditEventFunc is called on every validation failure to emit
// a "southbound.hmac.failure" audit event.
type AuditEventFunc func(corrID, reason, deviceID string)

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

// Validate reads the request body, extracts the device identity from the Auth-Info header,
// validates all HMAC authentication conditions, and returns the authenticated device ID
// and buffered body bytes (rewound into r.Body for downstream handlers) on success.
//
// When ok is false, the appropriate southbound error has already been written to w.
// The caller MUST NOT write any further response in that case.
//
// The device identity is derived exclusively from the Auth-Info header's id= field;
// downstream handlers receive this authenticated MAC address to correlate the request.
//
// SECURITY: this function never logs the secret, signature, or raw HMAC material.
func (v *Validator) Validate(w http.ResponseWriter, r *http.Request, corrID string) (deviceID string, bodyBytes []byte, ok bool) {
	body, err := io.ReadAll(r.Body)
	if err != nil {
		slog.Error("Failed to read request body for HMAC validation", "corrID", corrID)
		southbound.InternalError(w, corrID)
		return "", nil, false
	}
	r.Body = io.NopCloser(bytes.NewBuffer(body))

	id, b, validated := v.validateWithBody(w, r, corrID, body)
	return id, b, validated
}

// ValidatePreloaded validates HMAC authentication when the caller has already read
// the request body.  The body bytes are validated and then rewound into r.Body for
// the downstream handler.
//
// Returns the authenticated device ID (MAC address from Auth-Info id= field) on success.
//
// SECURITY: this function never logs the secret, signature, or raw HMAC material.
func (v *Validator) ValidatePreloaded(w http.ResponseWriter, r *http.Request, corrID string, body []byte) (deviceID string, ok bool) {
	r.Body = io.NopCloser(bytes.NewBuffer(body))
	id, _, validated := v.validateWithBody(w, r, corrID, body)
	return id, validated
}

// validateWithBody performs all HMAC checks using caller-provided body bytes.
// r.Body is reset to the provided body on success.
func (v *Validator) validateWithBody(w http.ResponseWriter, r *http.Request, corrID string, body []byte) (deviceID string, bodyOut []byte, ok bool) {
	// ── 1. Extract and parse Auth-Info / Auth-Signature headers ──────────────
	authInfoRaw := r.Header.Get(HeaderAuthInfo)
	authSig := r.Header.Get(HeaderAuthSignature)

	if authInfoRaw == "" || authSig == "" {
		v.fail(w, corrID, "missing_headers", "")
		return "", nil, false
	}

	info, err := ParseAuthInfo(authInfoRaw)
	if err != nil {
		v.fail(w, corrID, "malformed_auth_info", "")
		return "", nil, false
	}

	// ── 2. Validate timestamp freshness ───────────────────────────────────────
	ts, err := strconv.ParseInt(info.Timestamp, 10, 64)
	if err != nil {
		v.fail(w, corrID, "invalid_timestamp", info.DeviceID)
		return "", nil, false
	}
	delta := time.Now().Unix() - ts
	if delta < 0 {
		delta = -delta
	}
	if delta > v.toleranceSecs {
		v.fail(w, corrID, "stale_timestamp", info.DeviceID)
		return "", nil, false
	}

	// ── 3. Nonce replay protection ────────────────────────────────────────────
	fresh, err := v.nonces.Check(r.Context(), info.Nonce)
	if err != nil {
		slog.Error("HMAC nonce store unavailable", "corrID", corrID)
		southbound.ServiceUnavailable(w, "HMAC nonce store temporarily unavailable.", corrID, southbound.DefaultRetryConfig)
		return "", nil, false
	}
	if !fresh {
		v.fail(w, corrID, "nonce_replay", info.DeviceID)
		return "", nil, false
	}

	// ── 4. Resolve per-device secret using device MAC from Auth-Info id= ──────
	secret, found, err := v.secrets.GetSecretBySerial(info.DeviceID)
	if err != nil {
		slog.Error("Secret store error during HMAC validation", "corrID", corrID)
		southbound.InternalError(w, corrID)
		return "", nil, false
	}
	if !found || secret == "" {
		v.fail(w, corrID, "no_active_secret", info.DeviceID)
		return "", nil, false
	}

	// ── 5. Compute and compare signature (constant-time) ─────────────────────
	// Canonical message: Auth-Info_header_value + "\n" + request_path + "\n" + raw_body_bytes
	expected := computeAuthSignature(secret, authInfoRaw, r.URL.Path, body)
	if !hmac.Equal([]byte(authSig), []byte(expected)) {
		v.fail(w, corrID, "signature_mismatch", info.DeviceID)
		return "", nil, false
	}

	r.Body = io.NopCloser(bytes.NewBuffer(body)) // rewind for downstream handler
	return info.DeviceID, body, true
}

// fail writes the HMACInvalid southbound error and emits the audit event.
// SECURITY: never include the secret, signature, or nonce value in any log field.
func (v *Validator) fail(w http.ResponseWriter, corrID, reason, deviceID string) {
	slog.Warn("HMAC validation failure",
		"corrID", corrID,
		"reason", reason,
		// deviceID is sanitized identity only — never a secret
	)
	southbound.HMACInvalid(w, corrID)
	v.onFailure(corrID, reason, deviceID)
}

// computeAuthSignature computes HMAC-SHA256 over the canonical message:
//
//	Auth-Info_header_value + "\n" + request_path + "\n" + raw_body_bytes
//
// and returns the hex digest.
//
// SECURITY: secret must never be logged or included in error messages.
func computeAuthSignature(secret, authInfo, path string, body []byte) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(authInfo))
	mac.Write([]byte("\n"))
	mac.Write([]byte(path))
	mac.Write([]byte("\n"))
	mac.Write(body)
	return hex.EncodeToString(mac.Sum(nil))
}

// ComputeAuthSignature is exported for device simulators and integration test harnesses.
// Given a secret, the raw Auth-Info header value, the request path, and the body,
// it returns the hex HMAC-SHA256 digest to place in the Auth-Signature header.
//
// SECURITY: only call this from trusted internal code; never expose over HTTP.
func ComputeAuthSignature(secret, authInfo, path string, body []byte) string {
	return computeAuthSignature(secret, authInfo, path, body)
}

// BuildAuthInfoHeader constructs a well-formed Auth-Info header value from its components.
// nonce must be exactly NonceLength (30) characters.
func BuildAuthInfoHeader(deviceID string, timestampUnix int64, nonce string) string {
	return fmt.Sprintf("id=%s,timestamp=%d,nonce=%s", deviceID, timestampUnix, nonce)
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

// ── SHA256 export (kept for compatibility) ───────────────────────────────────

// SHA256Hex returns the hex SHA-256 digest of b.  Used by device simulators to
// compute body digests independently of the HMAC computation.
func SHA256Hex(b []byte) string {
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}
