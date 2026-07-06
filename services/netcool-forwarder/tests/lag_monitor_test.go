package consumer_test

import (
	"log/slog"
	"os"
	"testing"
	"time"

	"github.com/ubrnms/netcool-forwarder/internal/consumer"
	"github.com/ubrnms/netcool-forwarder/internal/metrics"
)

func TestLagMonitor_StopDoesNotPanic(t *testing.T) {
	cfg := consumer.LoadConfig()
	log := slog.New(slog.NewTextHandler(os.Stdout, nil))
	mon := consumer.NewLagMonitor(cfg, log)

	// Stop before Run — should not panic.
	mon.Stop()
}

func TestLagMonitor_StopIdempotent(t *testing.T) {
	cfg := consumer.LoadConfig()
	log := slog.New(slog.NewTextHandler(os.Stdout, nil))
	mon := consumer.NewLagMonitor(cfg, log)

	mon.Stop()
	// Double stop must not panic.
	mon.Stop()
}

func TestLagMonitor_RunAndStop(t *testing.T) {
	cfg := consumer.LoadConfig()
	// Point at non-existent broker so probe() errors gracefully.
	cfg.KafkaBrokers = "127.0.0.1:19999"
	log := slog.New(slog.NewTextHandler(os.Stdout, nil))
	mon := consumer.NewLagMonitor(cfg, log)

	done := make(chan struct{})
	go func() {
		mon.Run()
		close(done)
	}()

	time.Sleep(50 * time.Millisecond)
	mon.Stop()

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("LagMonitor did not stop in time")
	}
}

func TestConsumerLagMetricExists(t *testing.T) {
	metrics.Register()
	// ConsumerLag gauge should be set without panic.
	metrics.ConsumerLag.Set(42)
}
