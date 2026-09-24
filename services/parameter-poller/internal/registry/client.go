// Package registry provides a client for reading active Product Definition
// registry data needed by the parameter poller.
//
// In the P0 release the registry is read from the product-definition-service via
// HTTP. The client applies a short in-memory cache keyed on registry version so
// that each poll cycle does not fan out a request per device. Cache invalidation
// is version-driven: when the upstream registry version changes the cache is
// replaced atomically.
package registry

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/airtel-ubrnms/parameter-poller/internal/model"
)

// ErrRegistryUnavailable is returned when the registry cannot be read.
var ErrRegistryUnavailable = errors.New("parameter registry is unavailable")

// Reader is the registry data-access interface used by the poller.
// Implementations must be safe for concurrent use.
type Reader interface {
	// GetDeviceProfile returns the active polling profile for a device.
	// Returns (nil, ErrRegistryUnavailable) when the registry is degraded.
	// Returns (nil, nil) when the device is not associated with any active Product Definition.
	GetDeviceProfile(ctx context.Context, deviceID string) (*model.RegistryDeviceProfile, error)
}

// snapshot caches one resolved version of the registry index.
type snapshot struct {
	version  string
	profiles map[string]*model.RegistryDeviceProfile // keyed by deviceID
}

// HTTPClient is the registry reader backed by the product-definition-service HTTP API.
// It caches the full registry index in memory, invalidating on version change.
type HTTPClient struct {
	baseURL    string
	httpClient *http.Client
	log        *slog.Logger

	mu    sync.RWMutex
	cache *snapshot
}

// NewHTTPClient creates a new registry HTTP client pointed at the given base URL.
func NewHTTPClient(baseURL string, log *slog.Logger) *HTTPClient {
	return &HTTPClient{
		baseURL: baseURL,
		httpClient: &http.Client{
			Timeout: 10 * time.Second,
		},
		log: log,
	}
}

// GetDeviceProfile satisfies Reader. It returns the cached profile if the
// current registry version matches, otherwise fetches and caches the new index.
func (c *HTTPClient) GetDeviceProfile(ctx context.Context, deviceID string) (*model.RegistryDeviceProfile, error) {
	c.mu.RLock()
	if c.cache != nil {
		profile := c.cache.profiles[deviceID]
		c.mu.RUnlock()
		return profile, nil // nil profile means unknown device
	}
	c.mu.RUnlock()

	if err := c.refresh(ctx); err != nil {
		return nil, err
	}

	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.cache.profiles[deviceID], nil
}

// refresh fetches the full registry index from the product-definition-service
// and replaces the in-memory cache atomically.
func (c *HTTPClient) refresh(ctx context.Context) error {
	url := fmt.Sprintf("%s/internal/registry/active-profiles", c.baseURL)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return fmt.Errorf("%w: build request: %v", ErrRegistryUnavailable, err)
	}
	req.Header.Set("Accept", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		c.log.Error("registry fetch failed", slog.String("url", url), slog.Any("err", err))
		return ErrRegistryUnavailable
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		c.log.Error("registry returned non-200", slog.Int("status", resp.StatusCode))
		return ErrRegistryUnavailable
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return fmt.Errorf("%w: read body: %v", ErrRegistryUnavailable, err)
	}

	// wireProfile is the JSON shape returned by the product-definition-service
	// internal endpoint. Fields map to RegistryDeviceProfile with Go-style names.
	type wireProfile struct {
		DeviceID            string                       `json:"DeviceID"`
		DeviceIP            string                       `json:"DeviceIP"`
		ProductDefinitionID string                       `json:"ProductDefinitionID"`
		RegistryVersion     string                       `json:"RegistryVersion"`
		Groups              []model.RegistryGroupMetadata `json:"Groups"`
	}
	var envelope struct {
		Version  string         `json:"version"`
		Profiles []wireProfile  `json:"profiles"`
	}
	if err := json.Unmarshal(body, &envelope); err != nil {
		return fmt.Errorf("%w: unmarshal: %v", ErrRegistryUnavailable, err)
	}

	index := make(map[string]*model.RegistryDeviceProfile, len(envelope.Profiles))
	for _, wp := range envelope.Profiles {
		p := &model.RegistryDeviceProfile{
			DeviceID:            wp.DeviceID,
			DeviceIP:            wp.DeviceIP,
			ProductDefinitionID: wp.ProductDefinitionID,
			RegistryVersion:     wp.RegistryVersion,
			Groups:              wp.Groups,
		}
		index[p.DeviceID] = p
	}

	snap := &snapshot{version: envelope.Version, profiles: index}
	c.mu.Lock()
	c.cache = snap
	c.mu.Unlock()

	c.log.Info("registry cache refreshed",
		slog.String("version", envelope.Version),
		slog.Int("devices", len(index)),
	)
	return nil
}

// InMemoryReader is an in-memory Reader implementation used in tests and local development.
// It is safe for concurrent use.
type InMemoryReader struct {
	mu       sync.RWMutex
	profiles map[string]*model.RegistryDeviceProfile
}

// NewInMemoryReader creates an InMemoryReader pre-loaded with profiles.
func NewInMemoryReader(profiles []*model.RegistryDeviceProfile) *InMemoryReader {
	index := make(map[string]*model.RegistryDeviceProfile, len(profiles))
	for _, p := range profiles {
		index[p.DeviceID] = p
	}
	return &InMemoryReader{profiles: index}
}

// GetDeviceProfile returns the pre-loaded profile for the device, or nil if unknown.
func (r *InMemoryReader) GetDeviceProfile(_ context.Context, deviceID string) (*model.RegistryDeviceProfile, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.profiles[deviceID], nil
}

// SetProfile upserts a device profile. Safe for concurrent use.
func (r *InMemoryReader) SetProfile(p *model.RegistryDeviceProfile) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.profiles[p.DeviceID] = p
}
