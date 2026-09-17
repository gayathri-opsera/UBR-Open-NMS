// Package spal — adapter selection with preferred-protocol-first and fallback (WO-009).
package spal

import (
	"context"
	"log/slog"
	"sync"
	"time"
)

// AdapterFactory constructs a DeviceClient for the given protocol.
// Returns (nil, error) when the protocol is unsupported or cannot be initialised.
type AdapterFactory func(protocol Protocol, credResolver CredentialResolver) (DeviceClient, error)

// AdapterCache holds the active adapter and its last known health for one device.
type AdapterCache struct {
	mu          sync.RWMutex
	activeProto Protocol
	health      AdapterHealth
	client      DeviceClient
	lastUpdated time.Time
}

// Selector implements adapter selection with preferred-protocol-first behavior,
// deterministic fallback through supported protocols, and health-triggered cache
// invalidation.
type Selector struct {
	factory  AdapterFactory
	resolver CredentialResolver
	// cache maps deviceID → AdapterCache.
	mu    sync.RWMutex
	cache map[string]*AdapterCache
	// healthTTL is how long a healthy adapter status is considered fresh.
	healthTTL time.Duration
}

// NewSelector creates a Selector with the provided factory, credential resolver,
// and health TTL (how long a passing ping result is considered valid).
func NewSelector(factory AdapterFactory, resolver CredentialResolver, healthTTL time.Duration) *Selector {
	if healthTTL <= 0 {
		healthTTL = 5 * time.Minute
	}
	return &Selector{
		factory:   factory,
		resolver:  resolver,
		cache:     make(map[string]*AdapterCache),
		healthTTL: healthTTL,
	}
}

// Select returns a healthy DeviceClient for the given device context.
// It tries the preferred protocol first, then falls back through the supported list.
// If all adapters fail their health checks, a guided failure AdapterHealth is returned
// alongside a nil client.
func (s *Selector) Select(ctx context.Context, device DeviceContext) (DeviceClient, AdapterHealth, error) {
	// Build the ordered protocol list: preferred first, then the rest.
	ordered := orderedProtocols(device.PreferredProtocol, device.SupportedProtocols)

	// Check whether the cached adapter is still healthy.
	if cached := s.loadCache(device.DeviceID); cached != nil {
		if time.Since(cached.health.CheckedAt) < s.healthTTL && cached.health.Healthy {
			slog.Debug("spal: using cached healthy adapter",
				"deviceId", device.DeviceID, "protocol", cached.activeProto)
			return cached.client, cached.health, nil
		}
	}

	// Try each protocol in order.
	for _, proto := range ordered {
		client, err := s.factory(proto, s.resolver)
		if err != nil {
			slog.Info("spal: adapter init failed",
				"deviceId", device.DeviceID, "protocol", proto, "err", err)
			continue
		}

		ping := client.Ping(ctx, device)
		health := AdapterHealth{
			Protocol:  proto,
			Healthy:   ping.Reachable,
			LatencyMs: ping.LatencyMs,
			CheckedAt: time.Now().UTC(),
		}
		if !ping.Reachable {
			health.FailureCategory = ping.FailureCategory
			health.FailureReason = ping.FailureReason
			slog.Info("spal: adapter ping failed",
				"deviceId", device.DeviceID, "protocol", proto, "category", ping.FailureCategory)
			continue
		}

		// Healthy — cache and return.
		s.storeCache(device.DeviceID, &AdapterCache{
			activeProto: proto,
			health:      health,
			client:      client,
			lastUpdated: time.Now().UTC(),
		})
		slog.Info("spal: adapter selected",
			"deviceId", device.DeviceID, "protocol", proto, "latencyMs", ping.LatencyMs)
		return client, health, nil
	}

	// All adapters failed — invalidate cache and return guided failure.
	s.invalidateCache(device.DeviceID)
	guided := AdapterHealth{
		Protocol:        ProtocolUnknown,
		Healthy:         false,
		CheckedAt:       time.Now().UTC(),
		FailureCategory: FailureCategoryUnreachable,
		FailureReason:   "all supported protocol adapters failed their health checks; device may be unreachable or no credentials are configured",
	}
	slog.Warn("spal: no healthy adapter found",
		"deviceId", device.DeviceID, "triedProtocols", ordered)
	return nil, guided, nil
}

// InvalidateAdapter removes the cached adapter for a device, forcing re-selection
// on the next call. Should be called when a runtime get operation fails permanently.
func (s *Selector) InvalidateAdapter(deviceID string) {
	s.invalidateCache(deviceID)
}

// ── Cache helpers ─────────────────────────────────────────────────────────────

func (s *Selector) loadCache(deviceID string) *AdapterCache {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.cache[deviceID]
}

func (s *Selector) storeCache(deviceID string, c *AdapterCache) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.cache[deviceID] = c
}

func (s *Selector) invalidateCache(deviceID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.cache, deviceID)
}

// orderedProtocols returns the protocol list with preferred first, followed by
// supportedProtocols in their declared order (de-duplicated).
func orderedProtocols(preferred Protocol, supported []Protocol) []Protocol {
	seen := map[Protocol]bool{}
	out := make([]Protocol, 0, len(supported)+1)

	if preferred != "" && preferred != ProtocolUnknown {
		out = append(out, preferred)
		seen[preferred] = true
	}
	for _, p := range supported {
		if !seen[p] && p != "" && p != ProtocolUnknown {
			out = append(out, p)
			seen[p] = true
		}
	}
	return out
}
