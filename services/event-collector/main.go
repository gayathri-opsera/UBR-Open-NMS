package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"

	"github.com/airtel-ubrnms/event-collector/internal/config"
	"github.com/airtel-ubrnms/event-collector/internal/normalizer"
)

var (
	eventsIngested = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "event_collector_ingested_total",
		Help: "Total events ingested",
	}, []string{"source", "severity"})
)

func init() {
	prometheus.MustRegister(eventsIngested)
}

// noopProducer is used when Kafka is disabled.
type noopProducer struct{}

func (n *noopProducer) Publish(alarm normalizer.RawAlarm) error {
	eventsIngested.WithLabelValues(alarm.Source, alarm.Severity).Inc()
	data, _ := json.Marshal(alarm)
	slog.Debug("Alarm (noop)", "payload", string(data))
	return nil
}

func main() {
	cfg := config.Load()

	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo})))

	// Metrics server
	mux := http.NewServeMux()
	mux.Handle("/metrics", promhttp.Handler())
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintln(w, `{"status":"ok"}`)
	})
	metricsSrv := &http.Server{Addr: fmt.Sprintf(":%d", cfg.MetricsPort), Handler: mux}
	go func() {
		slog.Info("Metrics server started", "port", cfg.MetricsPort)
		if err := metricsSrv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			slog.Error("Metrics server failed", "error", err)
		}
	}()

	// Use noop sink (Kafka producer would be wired here from internal/kafka package)
	sink := &noopProducer{}
	_ = sink
	_ = cfg

	// Await shutdown signal
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGTERM, syscall.SIGINT)
	slog.Info("Event Collector started", "snmpPort", cfg.SNMPPort, "syslogPort", cfg.SyslogPort)
	<-quit
	slog.Info("Shutting down Event Collector")

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	metricsSrv.Shutdown(ctx)
}
