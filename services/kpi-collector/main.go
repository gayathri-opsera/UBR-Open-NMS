package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/ubrnms/kpi-collector/internal/config"
	"github.com/ubrnms/kpi-collector/internal/model"
	"github.com/ubrnms/kpi-collector/internal/normalizer"
	"github.com/ubrnms/kpi-collector/internal/poller"
)

// ── Prometheus metrics ─────────────────────────────────────────────

var (
	kpiPollsTotal = prometheus.NewCounterVec(
		prometheus.CounterOpts{Name: "kpi_polls_total", Help: "Total KPI polls by status"},
		[]string{"status"},
	)
	kpiPollDuration = prometheus.NewHistogram(prometheus.HistogramOpts{
		Name:    "kpi_poll_duration_seconds",
		Help:    "KPI poll duration in seconds",
		Buckets: []float64{1, 5, 10, 30, 60},
	})
	kpiMissingDevices = prometheus.NewCounter(prometheus.CounterOpts{
		Name: "kpi_missing_devices_total", Help: "Total devices missing from poll cycle",
	})
	kpiPollErrors = prometheus.NewCounter(prometheus.CounterOpts{
		Name: "kpi_poll_errors_total", Help: "Total KPI poll errors",
	})
)

func init() {
	prometheus.MustRegister(kpiPollsTotal, kpiPollDuration, kpiMissingDevices, kpiPollErrors)
}

// ── Kafka sink (noop for startup — replace with real producer) ─────

type noopSink struct{}

func (n *noopSink) PublishKPI(_ context.Context, kpi *model.RawKPI) error {
	slog.Info("KPI published (noop)", "deviceId", kpi.DeviceID)
	kpiPollsTotal.WithLabelValues("success").Inc()
	return nil
}

func (n *noopSink) PublishMissingData(_ context.Context, ev *model.MissingDataEvent) error {
	slog.Warn("Missing data event (noop)", "deviceId", ev.DeviceID)
	kpiMissingDevices.Inc()
	return nil
}

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	slog.SetDefault(logger)

	cfg := config.Load()

	// Metrics server
	go func() {
		mux := http.NewServeMux()
		mux.Handle("/metrics", promhttp.Handler())
		slog.Info("Metrics server", "port", cfg.MetricsPort)
		if err := http.ListenAndServe(":"+cfg.MetricsPort, mux); err != nil {
			slog.Error("Metrics server error", "err", err)
		}
	}()

	// Health/readiness
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintln(w, `{"status":"ok"}`)
	})
	mux.HandleFunc("/readyz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintln(w, `{"status":"ok"}`)
	})

	sink := &noopSink{}
	p := poller.New(sink, cfg.SNMPCommunity, cfg.SNMPv3User, cfg.SNMPv3AuthPass,
		cfg.SNMPv3PrivPass, cfg.PushTimeout, normalizer.DefaultOIDs)

	// Poll loop
	go func() {
		ticker := time.NewTicker(time.Duration(cfg.PollIntervalSec) * time.Second)
		pollCycle := int64(0)
		for {
			select {
			case <-ticker.C:
				pollCycle++
				start := time.Now()
				slog.Info("Starting poll cycle", "cycle", pollCycle)

				devices := loadDevices(cfg)
				ctx := context.Background()
				p.PollAll(ctx, devices, pollCycle, 500)

				kpiPollDuration.Observe(time.Since(start).Seconds())
				slog.Info("Poll cycle complete", "cycle", pollCycle,
					"devices", len(devices), "durationMs", time.Since(start).Milliseconds())
			}
		}
	}()

	slog.Info("KPI Collector started", "port", cfg.Port)
	if err := http.ListenAndServe(":"+cfg.Port, mux); err != nil {
		slog.Error("HTTP server error", "err", err)
		os.Exit(1)
	}
}

// loadDevices fetches the device list from the Inventory Service.
// Simplified: returns empty slice in this scaffold; real impl makes HTTP call.
func loadDevices(cfg *config.Config) []model.Device {
	slog.Debug("Loading device list from inventory", "url", cfg.InventoryURL)
	return []model.Device{}
}

// encodeJSON is used by the Kafka producer (helper for tests).
func encodeJSON(v interface{}) ([]byte, error) {
	return json.Marshal(v)
}
