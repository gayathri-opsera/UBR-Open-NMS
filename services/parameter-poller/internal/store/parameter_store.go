// Package store implements the parameter current-value persistence layer.
//
// The P0 implementation uses a thread-safe in-memory store that satisfies the
// Store interface. Production deployments can supply a MongoDB-backed
// implementation that implements the same interface without changing callers.
//
// Persistence key: (deviceID, groupID, parameterID, registryVersion).
// When a new registryVersion is written for an existing key the old record is
// replaced; the last successful value is always carried forward so the UI never
// shows empty values for STALE parameters.
package store

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/airtel-ubrnms/parameter-poller/internal/model"
)

// compositeKey is the internal map key for the current-value store.
type compositeKey struct {
	DeviceID    string
	GroupID     string
	ParameterID string
}

// Store is the current-value persistence interface used by the poller and handler.
// All implementations must be safe for concurrent use.
type Store interface {
	// Upsert writes or replaces the current value record for a parameter.
	// It preserves LastSuccessAt from the prior record when the new record
	// does not represent a successful read.
	Upsert(ctx context.Context, value model.ParameterValue) error

	// GetByDevice returns all current-value records for a device, ordered by
	// (groupID, parameterID). Returns an empty slice when the device is unknown.
	GetByDevice(ctx context.Context, deviceID string) ([]model.ParameterValue, error)
}

// InMemoryStore is the default Store implementation backed by a sync.Map.
// It satisfies the Store interface for P0 development and testing.
type InMemoryStore struct {
	mu     sync.RWMutex
	values map[compositeKey]model.ParameterValue
}

// NewInMemoryStore creates an empty InMemoryStore.
func NewInMemoryStore() *InMemoryStore {
	return &InMemoryStore{
		values: make(map[compositeKey]model.ParameterValue),
	}
}

// Upsert implements Store.
func (s *InMemoryStore) Upsert(_ context.Context, v model.ParameterValue) error {
	key := compositeKey{
		DeviceID:    v.DeviceID,
		GroupID:     v.GroupID,
		ParameterID: v.ParameterID,
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	// Carry forward the last successful timestamp when the new record failed.
	if existing, ok := s.values[key]; ok && v.ReadStatus != model.ParameterReadStatusSuccess {
		if existing.LastSuccessAt != nil {
			v.LastSuccessAt = existing.LastSuccessAt
		}
		// Preserve the last known value for STALE/FAILED states so the UI
		// shows the previous reading rather than an empty string.
		if existing.Value != "" && v.Value == "" {
			v.Value = existing.Value
			v.ValueNumeric = existing.ValueNumeric
			v.Source = existing.Source
		}
	}

	s.values[key] = v
	return nil
}

// GetByDevice implements Store.
func (s *InMemoryStore) GetByDevice(_ context.Context, deviceID string) ([]model.ParameterValue, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	var out []model.ParameterValue
	for _, v := range s.values {
		if v.DeviceID == deviceID {
			out = append(out, v)
		}
	}
	return out, nil
}

// --- Freshness calculation ---

// CalculateFreshness derives the FreshnessState for a ParameterValue based on
// the time elapsed since the last successful collection and the configured interval.
//
// Rules:
//   - If LastSuccessAt is nil → FAILED (never successfully polled)
//   - If time.Since(*LastSuccessAt) <= PollIntervalSeconds * 1.5 → FRESH
//   - Otherwise → STALE
//
// The 1.5× multiplier provides one-missed-cycle tolerance before declaring stale.
func CalculateFreshness(v model.ParameterValue, now time.Time) model.FreshnessState {
	if v.ReadStatus == model.ParameterReadStatusUnmapped {
		return model.FreshnessStateUnmapped
	}
	if v.LastSuccessAt == nil {
		return model.FreshnessStateFailed
	}
	threshold := time.Duration(float64(v.PollIntervalSeconds)*1.5) * time.Second
	if now.Sub(*v.LastSuccessAt) <= threshold {
		return model.FreshnessStateFresh
	}
	return model.FreshnessStateStale
}

// CoerceNumeric attempts to parse a raw value string as float64.
// Returns nil when the string is empty, non-numeric, or a vendor placeholder.
func CoerceNumeric(raw string) *float64 {
	if raw == "" {
		return nil
	}
	// Vendor placeholders that must not be treated as numbers.
	switch raw {
	case "N/A", "n/a", "not available", "Not Available", "--", "None", "none":
		return nil
	}

	var f float64
	if _, err := fmt.Sscanf(raw, "%f", &f); err != nil {
		return nil
	}
	return &f
}
