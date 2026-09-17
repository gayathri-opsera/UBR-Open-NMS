// Command parameter-poller starts the framework parameter polling service.
//
// It reads active Product Definition parameter metadata from the registry,
// dispatches read-only southbound adapter calls, and persists current values
// for the framework read API. The HTTP server exposes the current-value
// endpoint at GET /devices/{deviceId}/parameters/current.
//
// All configuration is sourced from environment variables. Credential secrets
// are never stored in the current-value records — only opaque credential
// references from the registry are used during polling.
package main

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/robfig/cron/v3"

	"github.com/airtel-ubrnms/parameter-poller/internal/handler"
	"github.com/airtel-ubrnms/parameter-poller/internal/model"
	"github.com/airtel-ubrnms/parameter-poller/internal/poller"
	"github.com/airtel-ubrnms/parameter-poller/internal/registry"
	"github.com/airtel-ubrnms/parameter-poller/internal/store"
)

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	}))

	port := envOrDefault("PORT", "8097")
	registryBaseURL := envOrDefault("PRODUCT_DEFINITION_SERVICE_URL", "http://localhost:8093")
	pollCron := envOrDefault("POLL_CRON", "@every 60s")

	log.Info("starting parameter-poller",
		slog.String("port", port),
		slog.String("registryURL", registryBaseURL),
		slog.String("pollCron", pollCron),
	)

	// --- Dependency wiring ---

	// Registry: reads active Product Definition profiles from the PD service.
	// For local development without the PD service, fall back to a seeded
	// in-memory reader loaded from IN_MEMORY_REGISTRY=true.
	var reg registry.Reader
	if envOrDefault("IN_MEMORY_REGISTRY", "false") == "true" {
		reg = registry.NewInMemoryReader(devFixtureProfiles())
		log.Info("using in-memory registry (development mode)")
	} else {
		reg = registry.NewHTTPClient(registryBaseURL, log)
	}

	// Current-value store.
	st := store.NewInMemoryStore()

	// Adapter map — no live adapters in P0; the null adapter returns unmapped
	// so poll cycles persist safe UNMAPPED records instead of failing.
	nullAdapter := &nullAdapterClient{}
	adapters := poller.NewAdapterResolver(map[string]poller.AdapterClient{
		"SNMP": nullAdapter,
		"CLI":  nullAdapter,
		"REST": nullAdapter,
		"GRPC": nullAdapter,
	})

	p := poller.New(reg, st, adapters, log)

	// --- Scheduled polling ---
	c := cron.New()
	_, err := c.AddFunc(pollCron, func() {
		// Discover active devices from the registry and poll each one.
		// In the P0 design the registry snapshot drives the device list.
		// Production: replace with an inventory query.
		log.Info("poll cycle started")
		// Placeholder: poll a configurable device list.
		// In production this comes from a registry-backed device enumeration.
		if ids := os.Getenv("POLL_DEVICE_IDS"); ids != "" {
			for _, id := range splitCSV(ids) {
				if err := p.PollDevice(loggingCtx(log), id); err != nil {
					log.Error("poll device failed",
						slog.String("deviceID", id),
						slog.Any("err", err),
					)
				}
			}
		}
		log.Info("poll cycle completed")
	})
	if err != nil {
		log.Error("failed to add cron job", slog.Any("err", err))
		os.Exit(1)
	}
	c.Start()
	defer c.Stop()

	// --- HTTP server ---
	h := handler.New(st, reg, log)

	r := chi.NewRouter()
	r.Use(middleware.RealIP)
	r.Use(middleware.Recoverer)

	r.Get("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	})

	// The gateway mounts this service at /api/framework/v1/devices; the handler
	// exposes /{deviceId}/parameters/current relative to that prefix.
	r.Mount("/devices", h.Routes())

	srv := &http.Server{
		Addr:         ":" + port,
		Handler:      r,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 15 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	log.Info("HTTP server listening", slog.String("addr", srv.Addr))
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Error("server error", slog.Any("err", err))
		os.Exit(1)
	}
}

// --- helpers ---

func envOrDefault(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func splitCSV(s string) []string {
	var out []string
	for _, part := range splitOn(s, ',') {
		if part != "" {
			out = append(out, part)
		}
	}
	return out
}

func splitOn(s string, sep rune) []string {
	var out []string
	start := 0
	for i, r := range s {
		if r == sep {
			out = append(out, s[start:i])
			start = i + 1
		}
	}
	out = append(out, s[start:])
	return out
}

// loggingCtx returns a background context suitable for cron job dispatch.
// In production this would carry a correlation ID derived from the schedule run.
func loggingCtx(log *slog.Logger) context.Context {
	_ = log
	return context.Background()
}

// nullAdapterClient is an AdapterClient that returns empty strings for every call.
// It is used in local development and tests where no live southbound
// connections are available. Empty values trigger CoerceNumeric → nil, which
// the store preserves as unmapped rather than a failure.
type nullAdapterClient struct{}

func (n *nullAdapterClient) Get(_ context.Context, _ string, keys []string) (map[string]string, error) {
	out := make(map[string]string, len(keys))
	for _, k := range keys {
		out[k] = ""
	}
	return out, nil
}

// devFixtureProfiles returns seeded fixture profiles for local development.
// These match the WO-012 fixtures: SNMP-first, REST-first, CLI-only.
func devFixtureProfiles() []*model.RegistryDeviceProfile {
	pollInterval := 60
	if s := os.Getenv("DEV_POLL_INTERVAL"); s != "" {
		if n, err := strconv.Atoi(s); err == nil {
			pollInterval = n
		}
	}

	return []*model.RegistryDeviceProfile{
		{
			DeviceID:            "dev-snmp-001",
			ProductDefinitionID: "pd-cisco-ios-router",
			RegistryVersion:     "registry-v1",
			Groups: []model.RegistryGroupMetadata{
				{
					GroupID:             "grp-interface",
					Label:               "Interface Statistics",
					PollIntervalSeconds: pollInterval,
					Parameters: []model.RegistryParamRef{
						{ParameterID: "ifInOctets",  Label: "Inbound Octets",  DataType: "counter", Unit: "bytes", Protocol: "SNMP", ReadRef: ".1.3.6.1.2.1.2.2.1.10.1"},
						{ParameterID: "ifOutOctets", Label: "Outbound Octets", DataType: "counter", Unit: "bytes", Protocol: "SNMP", ReadRef: ".1.3.6.1.2.1.2.2.1.16.1"},
					},
				},
			},
		},
		{
			DeviceID:            "dev-rest-001",
			ProductDefinitionID: "pd-nokia-sr",
			RegistryVersion:     "registry-v1",
			Groups: []model.RegistryGroupMetadata{
				{
					GroupID:             "grp-optical",
					Label:               "Optical Power",
					PollIntervalSeconds: pollInterval,
					Parameters: []model.RegistryParamRef{
						{ParameterID: "rxPower", Label: "RX Power", DataType: "gauge", Unit: "dBm", Protocol: "REST", ReadRef: "/api/v1/interfaces/1/optics/rx-power"},
						{ParameterID: "txPower", Label: "TX Power", DataType: "gauge", Unit: "dBm", Protocol: "REST", ReadRef: "/api/v1/interfaces/1/optics/tx-power"},
					},
				},
			},
		},
		{
			DeviceID:            "dev-cli-001",
			ProductDefinitionID: "pd-juniper-mx",
			RegistryVersion:     "registry-v1",
			Groups: []model.RegistryGroupMetadata{
				{
					GroupID:             "grp-chassis",
					Label:               "Chassis Health",
					PollIntervalSeconds: pollInterval,
					Parameters: []model.RegistryParamRef{
						{ParameterID: "cpuLoad", Label: "CPU Load", DataType: "gauge", Unit: "%",  Protocol: "CLI", ReadRef: "show system statistics | match CPU"},
						{ParameterID: "memUtil", Label: "Memory Utilisation", DataType: "gauge", Unit: "%", Protocol: "CLI", ReadRef: "show system statistics | match Memory"},
					},
				},
			},
		},
	}
}
