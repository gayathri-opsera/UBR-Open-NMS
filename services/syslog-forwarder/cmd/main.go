package main

import (
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"

	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/ubrnms/syslog-forwarder/internal/consumer"
	"github.com/ubrnms/syslog-forwarder/internal/metrics"
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

	fwd, err := consumer.NewForwarder(cfg, log)
	if err != nil {
		log.Error("failed to create forwarder", "err", err)
		os.Exit(1)
	}

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)

	go func() {
		if err := fwd.Run(); err != nil {
			log.Error("forwarder stopped", "err", err)
		}
	}()

	<-quit
	log.Info("shutting down syslog forwarder")
	fwd.Stop()
}
