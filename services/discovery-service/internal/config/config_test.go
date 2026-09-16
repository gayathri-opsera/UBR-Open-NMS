// Package config_test validates configuration loading for the Discovery Service (WO-029).
package config_test

import (
	"os"
	"testing"

	"github.com/airtel-ubrnms/discovery-service/internal/config"
)

func TestLoad_DefaultRetryConfig_MatchesWO029Spec(t *testing.T) {
	// Unset env vars so defaults apply.
	os.Unsetenv("SOUTHBOUND_RETRY_AFTER_SECS")
	os.Unsetenv("SOUTHBOUND_JITTER_MAX_SECS")

	cfg := config.Load()

	if cfg.RetryAfterSecs != 15 {
		t.Errorf("RetryAfterSecs default: got %d, want 15", cfg.RetryAfterSecs)
	}
	if cfg.JitterMaxSecs != 30 {
		t.Errorf("JitterMaxSecs default: got %d, want 30", cfg.JitterMaxSecs)
	}
}

func TestLoad_RetryConfig_FromEnv(t *testing.T) {
	os.Setenv("SOUTHBOUND_RETRY_AFTER_SECS", "60")
	os.Setenv("SOUTHBOUND_JITTER_MAX_SECS", "20")
	defer func() {
		os.Unsetenv("SOUTHBOUND_RETRY_AFTER_SECS")
		os.Unsetenv("SOUTHBOUND_JITTER_MAX_SECS")
	}()

	cfg := config.Load()

	if cfg.RetryAfterSecs != 60 {
		t.Errorf("RetryAfterSecs from env: got %d, want 60", cfg.RetryAfterSecs)
	}
	if cfg.JitterMaxSecs != 20 {
		t.Errorf("JitterMaxSecs from env: got %d, want 20", cfg.JitterMaxSecs)
	}
}

func TestLoad_RetryAfterSecs_TooLow_FallsBackToDefault(t *testing.T) {
	os.Setenv("SOUTHBOUND_RETRY_AFTER_SECS", "2") // below minimum of 5
	defer os.Unsetenv("SOUTHBOUND_RETRY_AFTER_SECS")

	cfg := config.Load()
	if cfg.RetryAfterSecs != 15 {
		t.Errorf("RetryAfterSecs below minimum: got %d, want 15 (default)", cfg.RetryAfterSecs)
	}
}

func TestLoad_FailoverEndpoint_ValidHTTPS(t *testing.T) {
	os.Setenv("NMS_FAILOVER_ENDPOINT", "https://nms-standby.example.com/discovery/v1/kv/services?recurse=1")
	defer os.Unsetenv("NMS_FAILOVER_ENDPOINT")

	cfg := config.Load()
	if cfg.FailoverEndpoint == "" {
		t.Error("valid https failover endpoint should be accepted")
	}
}

func TestLoad_FailoverEndpoint_MalformedURL_Disabled(t *testing.T) {
	os.Setenv("NMS_FAILOVER_ENDPOINT", "not-a-url")
	defer os.Unsetenv("NMS_FAILOVER_ENDPOINT")

	cfg := config.Load()
	if cfg.FailoverEndpoint != "" {
		t.Errorf("malformed failover endpoint should be rejected, got %q", cfg.FailoverEndpoint)
	}
}

func TestLoad_FailoverEndpoint_EmptyString_Disabled(t *testing.T) {
	os.Unsetenv("NMS_FAILOVER_ENDPOINT")

	cfg := config.Load()
	if cfg.FailoverEndpoint != "" {
		t.Errorf("empty NMS_FAILOVER_ENDPOINT should remain empty, got %q", cfg.FailoverEndpoint)
	}
}

func TestLoad_FailoverEndpoint_NonHTTPScheme_Disabled(t *testing.T) {
	os.Setenv("NMS_FAILOVER_ENDPOINT", "ftp://bad-scheme.example.com/path")
	defer os.Unsetenv("NMS_FAILOVER_ENDPOINT")

	cfg := config.Load()
	if cfg.FailoverEndpoint != "" {
		t.Errorf("non-http(s) failover endpoint must be rejected, got %q", cfg.FailoverEndpoint)
	}
}
