// WO-005: Unit tests for the canonical southbound error contract.
// Tests verify exact status codes, reason strings, category labels, and header
// presence/absence for every error category in the UBR southbound protocol.
package southbound

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// ─── helpers ────────────────────────────────────────────────────────────────

func record(handler func(http.ResponseWriter)) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	handler(w)
	return w
}

func decodeBody(t *testing.T, w *httptest.ResponseRecorder) ErrorBody {
	t.Helper()
	var body ErrorBody
	if err := json.NewDecoder(w.Body).Decode(&body); err != nil {
		t.Fatalf("failed to decode response body: %v (body: %s)", err, w.Body.String())
	}
	return body
}

// ─── Status code and reason mapping table ────────────────────────────────────

func TestErrorMapping_AllStatusCodesAndReasons(t *testing.T) {
	corr := "test-corr-001"

	cases := []struct {
		name        string
		statusCode  int
		reason      string
		category    string
		hasRetry    bool // Retry-After + X-Retry-Jitter-Max must be set
		hasLocation bool // Location header must be set (failover only)
		handler     func(http.ResponseWriter)
	}{
		{
			name:       "400 BAD_REQUEST",
			statusCode: http.StatusBadRequest,
			reason:     ReasonBadRequest,
			category:   CategoryClientError,
			hasRetry:   false,
			handler:    func(w http.ResponseWriter) { BadRequest(w, "invalid payload", corr) },
		},
		{
			name:       "462 HMAC_INVALID",
			statusCode: StatusHMACInvalid,
			reason:     ReasonHMACInvalid,
			category:   CategoryAuthFailure,
			hasRetry:   false, // Auth failures MUST NOT have retry headers
			handler:    func(w http.ResponseWriter) { HMACInvalid(w, corr) },
		},
		{
			name:       "495 MTLS_CERT_INVALID",
			statusCode: StatusMTLSCertInvalid,
			reason:     ReasonMTLSCertInvalid,
			category:   CategoryAuthFailure,
			hasRetry:   false,
			handler:    func(w http.ResponseWriter) { MTLSCertInvalid(w, corr) },
		},
		{
			name:       "496 MTLS_NO_CERT",
			statusCode: StatusMTLSNoCert,
			reason:     ReasonMTLSNoCert,
			category:   CategoryAuthFailure,
			hasRetry:   false,
			handler:    func(w http.ResponseWriter) { MTLSNoCert(w, corr) },
		},
		{
			name:       "429 RATE_LIMITED",
			statusCode: http.StatusTooManyRequests,
			reason:     ReasonRateLimited,
			category:   CategoryRetryable,
			hasRetry:   true,
			handler:    func(w http.ResponseWriter) { RateLimited(w, "slow down", corr, DefaultRetryConfig) },
		},
		{
			name:       "503 SERVICE_UNAVAILABLE",
			statusCode: http.StatusServiceUnavailable,
			reason:     ReasonServiceUnavail,
			category:   CategoryRetryable,
			hasRetry:   true,
			handler:    func(w http.ResponseWriter) { ServiceUnavailable(w, "dependency down", corr, DefaultRetryConfig) },
		},
		{
			name:       "500 INTERNAL_ERROR",
			statusCode: http.StatusInternalServerError,
			reason:     ReasonInternalError,
			category:   CategoryServerError,
			hasRetry:   false,
			handler:    func(w http.ResponseWriter) { InternalError(w, corr) },
		},
		{
			name:        "302 NMS_FAILOVER",
			statusCode:  http.StatusFound,
			reason:      ReasonNMSFailover,
			category:    CategoryRedirect,
			hasRetry:    false,
			hasLocation: true,
			handler: func(w http.ResponseWriter) {
				WriteFailoverError(w, corr, FailoverConfig{Location: "https://nms-standby.example.com/api/v1/discovery"})
			},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			w := record(tc.handler)

			// Status code
			if w.Code != tc.statusCode {
				t.Errorf("status: got %d, want %d", w.Code, tc.statusCode)
			}

			// Body fields
			body := decodeBody(t, w)
			if body.Reason != tc.reason {
				t.Errorf("reason: got %q, want %q", body.Reason, tc.reason)
			}
			if body.Category != tc.category {
				t.Errorf("category: got %q, want %q", body.Category, tc.category)
			}
			if body.Timestamp == "" {
				t.Error("timestamp must not be empty")
			}
			if body.CorrelationID != corr {
				t.Errorf("correlationId: got %q, want %q", body.CorrelationID, corr)
			}

			// Retry headers
			retryAfter := w.Header().Get("Retry-After")
			jitterMax := w.Header().Get("X-Retry-Jitter-Max")
			if tc.hasRetry {
				if retryAfter == "" {
					t.Errorf("Retry-After header must be set for retryable category")
				}
				if jitterMax == "" {
					t.Errorf("X-Retry-Jitter-Max header must be set for retryable category")
				}
			} else {
				if retryAfter != "" {
					t.Errorf("Retry-After must NOT be set for category %q", tc.category)
				}
				if jitterMax != "" {
					t.Errorf("X-Retry-Jitter-Max must NOT be set for category %q", tc.category)
				}
			}

			// Location header (failover only)
			location := w.Header().Get("Location")
			if tc.hasLocation {
				if location == "" {
					t.Error("Location header must be set for NMS_FAILOVER")
				}
			} else {
				if location != "" {
					t.Errorf("Location header must NOT be set for %q", tc.name)
				}
			}

			// Content-Type
			ct := w.Header().Get("Content-Type")
			if !strings.Contains(ct, "application/json") {
				t.Errorf("Content-Type: got %q, want application/json", ct)
			}
		})
	}
}

// ─── Auth failures must never have retry headers ──────────────────────────────

func TestAuthFailures_NoRetryHeaders(t *testing.T) {
	corr := "auth-corr-001"
	authHandlers := []struct {
		name    string
		handler func(http.ResponseWriter)
	}{
		{"HMACInvalid", func(w http.ResponseWriter) { HMACInvalid(w, corr) }},
		{"MTLSCertInvalid", func(w http.ResponseWriter) { MTLSCertInvalid(w, corr) }},
		{"MTLSNoCert", func(w http.ResponseWriter) { MTLSNoCert(w, corr) }},
	}
	for _, tc := range authHandlers {
		t.Run(tc.name, func(t *testing.T) {
			w := record(tc.handler)
			if w.Header().Get("Retry-After") != "" {
				t.Errorf("%s: Retry-After must not be set for auth failures", tc.name)
			}
			if w.Header().Get("X-Retry-Jitter-Max") != "" {
				t.Errorf("%s: X-Retry-Jitter-Max must not be set for auth failures", tc.name)
			}
		})
	}
}

// ─── Failover: missing Location falls back to 500 ───────────────────────────

func TestWriteFailoverError_MissingLocation_Falls_Back_To_500(t *testing.T) {
	w := record(func(rw http.ResponseWriter) {
		WriteFailoverError(rw, "corr-fallback", FailoverConfig{Location: ""})
	})
	if w.Code != http.StatusInternalServerError {
		t.Errorf("empty Location: got %d, want 500", w.Code)
	}
	body := decodeBody(t, w)
	if body.Reason != ReasonInternalError {
		t.Errorf("reason: got %q, want %q", body.Reason, ReasonInternalError)
	}
	if w.Header().Get("Location") != "" {
		t.Error("Location must not be set when fallback to 500")
	}
}

// ─── Non-standard status codes must be numeric-exact ────────────────────────

func TestNonStandardStatusCodes_AreNumericExact(t *testing.T) {
	if StatusHMACInvalid != 462 {
		t.Errorf("StatusHMACInvalid: got %d, want 462", StatusHMACInvalid)
	}
	if StatusMTLSCertInvalid != 495 {
		t.Errorf("StatusMTLSCertInvalid: got %d, want 495", StatusMTLSCertInvalid)
	}
	if StatusMTLSNoCert != 496 {
		t.Errorf("StatusMTLSNoCert: got %d, want 496", StatusMTLSNoCert)
	}
}

// ─── Custom retry config ─────────────────────────────────────────────────────

func TestWriteRetryableError_CustomRetryConfig(t *testing.T) {
	cfg := RetryConfig{RetryAfterSecs: 60, JitterMaxSecs: 30}
	w := record(func(rw http.ResponseWriter) {
		WriteRetryableError(rw, http.StatusTooManyRequests, ReasonRateLimited, "custom retry", "corr-001", cfg)
	})
	if w.Header().Get("Retry-After") != "60" {
		t.Errorf("Retry-After: got %q, want %q", w.Header().Get("Retry-After"), "60")
	}
	if w.Header().Get("X-Retry-Jitter-Max") != "30" {
		t.Errorf("X-Retry-Jitter-Max: got %q, want %q", w.Header().Get("X-Retry-Jitter-Max"), "30")
	}
}

// ─── Unknown internal error must not leak stack traces ───────────────────────

func TestInternalError_MessageDoesNotContainSensitiveData(t *testing.T) {
	w := record(func(rw http.ResponseWriter) { InternalError(rw, "corr-internal-001") })
	body := decodeBody(t, w)
	sensitiveKeywords := []string{"panic", "goroutine", "runtime", "stack", "trace", "sql", "mongo", "redis"}
	for _, kw := range sensitiveKeywords {
		if strings.Contains(strings.ToLower(body.Message), kw) {
			t.Errorf("InternalError message must not contain %q", kw)
		}
	}
}

// ─── WriteError passes correlationId through correctly ───────────────────────

func TestWriteError_CorrelationID(t *testing.T) {
	corrID := "unique-corr-id-xyz-789"
	w := record(func(rw http.ResponseWriter) {
		WriteError(rw, http.StatusBadRequest, ReasonBadRequest, CategoryClientError, "test", corrID)
	})
	body := decodeBody(t, w)
	if body.CorrelationID != corrID {
		t.Errorf("correlationId: got %q, want %q", body.CorrelationID, corrID)
	}
}

// ─── itoa helper ─────────────────────────────────────────────────────────────

func TestItoa(t *testing.T) {
	cases := []struct{ in int; out string }{
		{0, "0"}, {1, "1"}, {30, "30"}, {-5, "-5"}, {100, "100"},
	}
	for _, tc := range cases {
		if got := itoa(tc.in); got != tc.out {
			t.Errorf("itoa(%d) = %q, want %q", tc.in, got, tc.out)
		}
	}
}
