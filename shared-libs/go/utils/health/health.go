// Package health provides /healthz and /readyz HTTP handlers for Go services.
package health

import (
	"encoding/json"
	"net/http"
)

// ReadinessCheck is a function that returns true if the service is ready, false otherwise.
type ReadinessCheck func() (ready bool, reason string)

// HealthzHandler responds 200 for liveness checks.
func HealthzHandler(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}

// ReadyzHandler runs registered readiness checks.
func ReadyzHandler(checks ...ReadinessCheck) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		for _, check := range checks {
			if ok, reason := check(); !ok {
				w.WriteHeader(http.StatusServiceUnavailable)
				_ = json.NewEncoder(w).Encode(map[string]string{"status": "not_ready", "reason": reason})
				return
			}
		}
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(map[string]string{"status": "ready"})
	}
}

// MountHealthChecks registers /healthz and /readyz on a ServeMux.
func MountHealthChecks(mux *http.ServeMux, checks ...ReadinessCheck) {
	mux.HandleFunc("/healthz", HealthzHandler)
	mux.HandleFunc("/readyz", ReadyzHandler(checks...))
}
