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

	"github.com/airtel-ubrnms/discovery-service/internal/auth"
	"github.com/airtel-ubrnms/discovery-service/internal/config"
	"github.com/airtel-ubrnms/discovery-service/internal/handler"
	"github.com/airtel-ubrnms/discovery-service/internal/model"
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
	hmacValidator := auth.NewValidator(nonceStore, secretStore, auth.ValidatorConfig{
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

	h := handler.New(svc, store, runStore).WithHMACValidator(hmacValidator)
	schedHandler := handler.NewScheduleHandler(rediscoSched)

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
		r.Post("/runs", h.CreateDiscoveryRun)                                   // WO-011
		r.Post("/schedules", schedHandler.CreateSchedule)                       // WO-017
		r.Get("/schedules", schedHandler.ListSchedules)                         // WO-017
		r.Delete("/schedules/{scheduleId}", schedHandler.DeleteSchedule)        // WO-017
		r.Post("/schedules/{scheduleId}/run", schedHandler.TriggerScheduleRun)  // WO-017
		r.Get("/schedules/{scheduleId}/history", schedHandler.GetScheduleHistory) // WO-017
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
