package main

import (
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"

	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/ubrnms/mobinet-sync/internal/consumer"
	"github.com/ubrnms/mobinet-sync/internal/metrics"
)

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, nil))

	cfg := consumer.LoadConfig()

	go func() {
		mux := http.NewServeMux()
		mux.Handle("/metrics", promhttp.Handler())
		mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"status":"ok"}`))
		})
		addr := ":" + cfg.MetricsPort
		log.Info("metrics server starting", "addr", addr)
		if err := http.ListenAndServe(addr, mux); err != nil {
			log.Error("metrics server failed", "err", err)
		}
	}()

	metrics.Register()

	syncer, err := consumer.NewSyncer(cfg, log)
	if err != nil {
		log.Error("failed to create syncer", "err", err)
		os.Exit(1)
	}

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)

	go func() {
		if err := syncer.Run(); err != nil {
			log.Error("syncer stopped", "err", err)
		}
	}()

	<-quit
	log.Info("shutting down mobinet syncer")
	syncer.Stop()
}
