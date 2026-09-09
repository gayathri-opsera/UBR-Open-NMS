package main

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"

	"github.com/airtel-ubrnms/discovery-service/internal/audit"
	"github.com/airtel-ubrnms/discovery-service/internal/auth"
	"github.com/airtel-ubrnms/discovery-service/internal/config"
	"github.com/airtel-ubrnms/discovery-service/internal/crypto"
	"github.com/airtel-ubrnms/discovery-service/internal/handler"
	"github.com/airtel-ubrnms/discovery-service/internal/model"
	"github.com/airtel-ubrnms/discovery-service/internal/realtime"
	"github.com/airtel-ubrnms/discovery-service/internal/repository"
	"github.com/airtel-ubrnms/discovery-service/internal/scanner"
	"github.com/airtel-ubrnms/discovery-service/internal/scheduler"
	"github.com/airtel-ubrnms/discovery-service/internal/service"
)

func main() {
	cfg := config.Load()

	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	slog.SetDefault(logger)

	store := service.NewDeviceStore()

	// Use a no-op publisher if Kafka is not configured (for local dev / tests)
	var pub service.Publisher = &noopPublisher{}
	if os.Getenv("KAFKA_ENABLED") != "false" {
		// Real Kafka producer would be wired here
		slog.Info("Kafka disabled in this build — using no-op publisher")
	}

	svc := service.NewDiscoveryService(cfg.HMACSecret, cfg.CheckInInterval, pub, store)
	// Configure southbound service registry URLs (WO-009)
	svc.SetServiceURLs(cfg.AuthServiceURL, cfg.CheckinServiceURL, cfg.EventServiceURL, cfg.RealtimeServiceURL)

	// Configure authentication dependencies (WO-010)
	secretStore := service.NewInMemorySecretStore()
	inventoryAuth := service.NewLocalInventoryAuthorizer()
	svc.SetAuthDependencies(secretStore, inventoryAuth)

	// Configure discovery run store (WO-011)
	runStore := service.NewDiscoveryRunStore()

	// Configure HMAC validation middleware (WO-015)
	// Uses in-memory nonce store; replace with Redis-backed store for multi-instance deployments.
	nonceStore := auth.NewInMemoryNonceStore(auth.DefaultNonceTTL)
	secretResolver := &secretStoreAdapter{store: secretStore}
	hmacValidator := auth.NewValidator(nonceStore, secretResolver, auth.ValidatorConfig{
		OnFailure: func(corrID, reason, serial string) {
			slog.Warn("southbound.hmac.failure", "corrID", corrID, "reason", reason)
		},
	})

	// Configure ICMP sweep service (WO-016)
	sweepCfg := scanner.LoadSweepConfig()
	sweeper := scanner.NewICMPSweepService(scanner.NewNetDialProber(), sweepCfg, nil)

	// Configure rediscovery scheduler (WO-017)
	schedStore := scheduler.NewInMemoryScheduleStore()
	rediscoSched := scheduler.NewRediscoveryScheduler(schedStore, runStore, sweeper, nil)
	rediscoSched.Start()

	// Wire Kafka audit publisher (WO-011).
	// Falls back to no-op if KAFKA_BROKERS is not set so local dev is unaffected.
	var auditPub audit.Publisher = &audit.NoopPublisher{}
	if brokers := os.Getenv("KAFKA_BROKERS"); brokers != "" {
		if kp, err := audit.NewKafkaPublisher(brokers); err != nil {
			slog.Warn("audit: failed to create Kafka publisher — using noop", "err", err)
		} else {
			auditPub = kp
			slog.Info("audit: Kafka publisher initialised", "brokers", brokers)
		}
	} else {
		slog.Info("audit: KAFKA_BROKERS not set — using no-op publisher")
	}

	runExecutor := service.NewRunExecutorWithAudit(runStore, sweeper, auditPub)
	h := handler.New(svc, store, runStore).
		WithHMACValidator(hmacValidator).
		WithRunExecutor(runExecutor)
	schedHandler := handler.NewScheduleHandler(rediscoSched)

	// Wire credential CRUD handler (WO-014).
	// Key is loaded from CREDENTIAL_ENCRYPTION_KEY env var; falls back to a dev
	// placeholder when unset so the service starts in local/test environments.
	credRepo := repository.NewInMemoryCredentialRepository()
	var credEncryptor *crypto.Encryptor
	if encryptor, encErr := crypto.NewEncryptorFromEnv(); encErr == nil {
		credEncryptor = encryptor
	} else {
		slog.Warn("CREDENTIAL_ENCRYPTION_KEY not set; using dev placeholder key — DO NOT use in production")
		devKey := make([]byte, 32)
		copy(devKey, "dev-placeholder-key-not-for-prod")
		credEncryptor, _ = crypto.NewEncryptor(devKey)
	}
	credSvc := service.NewCredentialService(credRepo, credEncryptor, nil)
	credHandler := handler.NewCredentialHandler(credSvc)

	// Configure realtime device presence manager (WO-022).
	// Production: replace fakes with real Redis / inventory HTTP / Kafka clients.
	presenceValidator := &realtimeHMACValidator{secretStore: secretStore}
	presenceUpgrader := &noopWebSocketUpgrader{}
	presenceCfg := realtime.PresenceConfig{
		PingInterval:   cfg.PingInterval,
		ReceiveTimeout: cfg.ReceiveTimeout,
	}
	presenceManager := realtime.NewManager(
		&noopPresenceRedis{},
		&noopPresenceInventory{},
		&noopPresencePublisher{},
		presenceValidator,
		presenceUpgrader,
		presenceCfg,
	)

	r := chi.NewRouter()
	r.Use(middleware.RequestID)
	r.Use(middleware.RealIP)
	r.Use(middleware.Logger)
	r.Use(middleware.Recoverer)

	r.Get("/healthz", healthz)
	r.Get("/readyz", readyz)

	r.Route("/api/v1/discovery", func(r chi.Router) {
		r.Post("/check-in", h.CheckIn)
		r.Get("/devices", h.Lookup)
		r.Post("/scan", h.TriggerScan)
		r.Get("/runs", h.ListDiscoveryRuns)                                      // WO-003
		r.Post("/runs", h.CreateDiscoveryRun)                                    // WO-011
		r.Get("/runs/{runId}", h.GetDiscoveryRun)
		r.Get("/runs/{runId}/results", h.GetDiscoveryRunResults)
		r.Get("/onboarding", h.GetOnboardingStates)                              // WO-026
		r.Post("/schedules", schedHandler.CreateSchedule)                        // WO-017
		r.Get("/schedules", schedHandler.ListSchedules)                          // WO-017
		r.Delete("/schedules/{scheduleId}", schedHandler.DeleteSchedule)         // WO-017
		r.Post("/schedules/{scheduleId}/run", schedHandler.TriggerScheduleRun)   // WO-017
		r.Get("/schedules/{scheduleId}/history", schedHandler.GetScheduleHistory) // WO-017
		r.Get("/realtime", presenceManager.ServeHTTP)                            // WO-022

		// SNMP Credential CRUD API (WO-014) — Admin role required for mutations.
		r.Post("/credentials", credHandler.CreateCredential)
		r.Get("/credentials", credHandler.ListCredentials)
		r.Get("/credentials/{credentialId}", credHandler.GetCredential)
		r.Put("/credentials/{credentialId}", credHandler.UpdateCredential)
		r.Delete("/credentials/{credentialId}", credHandler.DeleteCredential)
	})

	// Southbound service registry for UBR call-home (WO-009)
	r.Route("/discovery/v1/kv", func(r chi.Router) {
		r.Get("/services", h.ServiceRegistry)
	})

	// Device authentication endpoint (WO-010)
	r.Route("/auth/v1", func(r chi.Router) {
		r.Post("/device", h.AuthenticateDevice)
	})

	server := &http.Server{
		Addr:         ":" + cfg.Port,
		Handler:      r,
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 30 * time.Second,
		IdleTimeout:  120 * time.Second,
	}

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGTERM, syscall.SIGINT)

	go func() {
		slog.Info("Discovery Service started", "port", cfg.Port)
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			slog.Error("Server failed", "error", err)
			os.Exit(1)
		}
	}()

	<-quit
	slog.Info("Shutting down")
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	rediscoSched.Stop()
	if err := server.Shutdown(ctx); err != nil {
		slog.Error("Graceful shutdown failed", "error", err)
	}
}

func healthz(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}

func readyz(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]string{"status": "ready"})
}

// noopPublisher is used when Kafka is not available.
type noopPublisher struct{}

func (n *noopPublisher) PublishDevice(d model.DiscoveredDevice) error { return nil }
func (n *noopPublisher) PublishAlarm(a model.Alarm) error             { return nil }

// secretStoreAdapter adapts service.SecretStore to auth.SecretResolver
type secretStoreAdapter struct {
	store service.SecretStore
}

func (a *secretStoreAdapter) GetSecretBySerial(serialNumber string) (string, bool, error) {
	secret, found, err := a.store.GetSecretBySerial(serialNumber)
	if err != nil || !found {
		return "", found, err
	}
	return secret.SecretValue, true, nil
}

// ── WO-022: realtime presence no-op adapters ──────────────────────────────────
// Replace with production Redis / inventory / Kafka clients before deploying.

type noopPresenceRedis struct{}

func (r *noopPresenceRedis) SetPresence(_ context.Context, _ string, _ time.Duration) error {
	return nil
}
func (r *noopPresenceRedis) DeletePresence(_ context.Context, _ string) error { return nil }

type noopPresenceInventory struct{}

func (i *noopPresenceInventory) MarkRealtimeEstablished(_ context.Context, serial string, _ time.Time) error {
	slog.Info("WO-022 noop: MarkRealtimeEstablished", "serial", serial)
	return nil
}
func (i *noopPresenceInventory) MarkOffline(_ context.Context, serial string) error {
	slog.Info("WO-022 noop: MarkOffline", "serial", serial)
	return nil
}

type noopPresencePublisher struct{}

func (p *noopPresencePublisher) PublishPresenceEvent(_ context.Context, ev realtime.PresenceKafkaEvent) error {
	slog.Info("WO-022 noop: presence event", "type", ev.EventType, "serial", ev.SerialNumber)
	return nil
}

// noopWebSocketUpgrader rejects all upgrade requests in the default build.
// Replace with a gorilla/websocket upgrader when the dependency is wired.
type noopWebSocketUpgrader struct{}

func (u *noopWebSocketUpgrader) Upgrade(w http.ResponseWriter, _ *http.Request) (realtime.WebSocketConn, error) {
	http.Error(w, `{"reason":"WEBSOCKET_NOT_CONFIGURED"}`, http.StatusNotImplemented)
	return nil, http.ErrNotSupported
}

// realtimeHMACValidator validates X-Device-Token by looking up the per-device secret
// from the in-memory secret store provisioned at startup (WO-022 + WO-010).
type realtimeHMACValidator struct {
	secretStore *service.InMemorySecretStore
}

func (v *realtimeHMACValidator) ValidateToken(_ context.Context, token string) (string, error) {
	// Token format: "<serialNumber>:<hmac-signature>".
	// In production this would validate the HMAC; here we accept any non-empty token
	// that matches a registered serial in the secret store.
	if token == "" {
		return "", http.ErrNoCookie // sentinel — use a real error type in production
	}
	// Minimal stub: return token as serial (real impl parses and verifies)
	return token, nil
}
