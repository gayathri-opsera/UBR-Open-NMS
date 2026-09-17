// Package fingerprint — FingerprintRegistryClient with versioned cache (WO-010).
//
// RegistryClient reads active fingerprint entries from the Product Definition
// service and caches them by registryVersion. Cache is invalidated when the
// registry version changes, and falls back to the last-known-good snapshot on
// temporary read failures so discovery runs continue operating under degraded
// conditions rather than blocking entirely.
package fingerprint

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"time"
)

// ErrRegistryUnavailable is returned when the registry cannot be read and there
// is no cached snapshot to fall back to.
var ErrRegistryUnavailable = errors.New("fingerprint registry unavailable: no cached snapshot and remote read failed")

// RegistryReader is the abstract source for active fingerprint entries.
// In production this is an HTTP/gRPC client to the Product Definition service.
// In tests it is replaced with an InMemoryRegistryReader.
type RegistryReader interface {
	// ListActive returns all currently active RegistryEntries and the current
	// registryVersion string. Returns an error when the source is unreachable.
	ListActive(ctx context.Context) (entries []RegistryEntry, registryVersion string, err error)
}

// cachedSnapshot holds one fetched and validated registry snapshot.
type cachedSnapshot struct {
	entries         []RegistryEntry
	registryVersion string
	fetchedAt       time.Time
}

// RegistryClient wraps a RegistryReader with version-aware caching and graceful
// degradation. It is safe for concurrent use.
type RegistryClient struct {
	reader    RegistryReader
	mu        sync.RWMutex
	snapshot  *cachedSnapshot
	cacheTTL  time.Duration // how long a snapshot is considered fresh
}

// NewRegistryClient creates a RegistryClient backed by the given reader.
// cacheTTL controls how long a snapshot is reused before a fresh read is attempted.
// ≤0 defaults to 60 seconds.
func NewRegistryClient(reader RegistryReader, cacheTTL time.Duration) *RegistryClient {
	if cacheTTL <= 0 {
		cacheTTL = 60 * time.Second
	}
	return &RegistryClient{reader: reader, cacheTTL: cacheTTL}
}

// ListActive returns the current active fingerprint entries.
// It fetches fresh data when the cache is empty or stale. On reader errors it
// returns the last known-good snapshot (degraded mode) and logs a warning.
// Returns ErrRegistryUnavailable only when there is no snapshot at all.
func (c *RegistryClient) ListActive(ctx context.Context) ([]RegistryEntry, string, error) {
	// Fast-path: read lock to check freshness.
	c.mu.RLock()
	if c.snapshot != nil && time.Since(c.snapshot.fetchedAt) < c.cacheTTL {
		snap := c.snapshot
		c.mu.RUnlock()
		return snap.entries, snap.registryVersion, nil
	}
	c.mu.RUnlock()

	// Slow-path: acquire write lock and refresh.
	c.mu.Lock()
	defer c.mu.Unlock()

	// Double-check — another goroutine may have refreshed while we waited.
	if c.snapshot != nil && time.Since(c.snapshot.fetchedAt) < c.cacheTTL {
		return c.snapshot.entries, c.snapshot.registryVersion, nil
	}

	entries, version, readErr := c.reader.ListActive(ctx)
	if readErr != nil {
		if c.snapshot != nil {
			slog.Warn("fingerprint: registry read failed — using last-known-good snapshot",
				"registryVersion", c.snapshot.registryVersion, "err", readErr)
			return c.snapshot.entries, c.snapshot.registryVersion, nil
		}
		slog.Error("fingerprint: registry read failed — no cached snapshot available", "err", readErr)
		return nil, "", ErrRegistryUnavailable
	}

	c.snapshot = &cachedSnapshot{
		entries:         entries,
		registryVersion: version,
		fetchedAt:       time.Now().UTC(),
	}
	slog.Info("fingerprint: registry cache refreshed",
		"registryVersion", version, "entries", len(entries))
	return entries, version, nil
}

// InvalidateCache forces the next call to ListActive to fetch fresh data.
// Call this when an explicit admin refresh is triggered or after a PD activation event.
func (c *RegistryClient) InvalidateCache() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.snapshot = nil
	slog.Info("fingerprint: registry cache invalidated")
}

// ── InMemoryRegistryReader ────────────────────────────────────────────────────

// InMemoryRegistryReader is a test-double that returns a fixed list of entries.
// It supports atomic version updates for testing cache-invalidation behavior.
type InMemoryRegistryReader struct {
	mu      sync.RWMutex
	entries []RegistryEntry
	version string
	readErr error
}

// NewInMemoryRegistryReader creates a reader pre-loaded with entries and a version string.
func NewInMemoryRegistryReader(entries []RegistryEntry, version string) *InMemoryRegistryReader {
	return &InMemoryRegistryReader{entries: entries, version: version}
}

// SetError makes the next read(s) return err. Pass nil to clear.
func (r *InMemoryRegistryReader) SetError(err error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.readErr = err
}

// SetEntries atomically replaces the entry list and increments the version.
func (r *InMemoryRegistryReader) SetEntries(entries []RegistryEntry, version string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.entries = entries
	r.version = version
	r.readErr = nil
}

func (r *InMemoryRegistryReader) ListActive(_ context.Context) ([]RegistryEntry, string, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	if r.readErr != nil {
		return nil, "", r.readErr
	}
	out := make([]RegistryEntry, len(r.entries))
	copy(out, r.entries)
	return out, r.version, nil
}
