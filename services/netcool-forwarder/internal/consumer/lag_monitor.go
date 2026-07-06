package consumer

import (
	"log/slog"
	"time"

	kafka "github.com/confluentinc/confluent-kafka-go/v2/kafka"
	"github.com/ubrnms/netcool-forwarder/internal/metrics"
)

// lagThresholds defines alert levels in message counts.
// Time-based alerting (1h, 6h, 24h) is done via Prometheus alerting rules
// that compare consumer lag against estimated throughput.
var lagThresholds = []struct {
	messages int64
	label    string
}{
	{3600, "1h"},
	{21600, "6h"},
	{86400, "24h"},
}

// LagMonitor periodically samples consumer group lag and publishes to Prometheus.
type LagMonitor struct {
	cfg      *Config
	log      *slog.Logger
	interval time.Duration
	stopCh   chan struct{}
}

// NewLagMonitor creates a LagMonitor.
func NewLagMonitor(cfg *Config, log *slog.Logger) *LagMonitor {
	return &LagMonitor{
		cfg:      cfg,
		log:      log,
		interval: 30 * time.Second,
		stopCh:   make(chan struct{}),
	}
}

// WithInterval overrides the polling interval (useful in tests).
func (m *LagMonitor) WithInterval(d time.Duration) *LagMonitor {
	m.interval = d
	return m
}

// Run starts the polling loop in the caller's goroutine.
func (m *LagMonitor) Run() {
	ticker := time.NewTicker(m.interval)
	defer ticker.Stop()
	for {
		select {
		case <-m.stopCh:
			return
		case <-ticker.C:
			m.probe()
		}
	}
}

// Stop halts the monitor.
func (m *LagMonitor) Stop() {
	select {
	case <-m.stopCh:
	default:
		close(m.stopCh)
	}
}

// probe computes consumer group lag for the source topic.
func (m *LagMonitor) probe() {
	// Temporary consumer used only for offset and watermark queries.
	c, err := kafka.NewConsumer(&kafka.ConfigMap{
		"bootstrap.servers": m.cfg.KafkaBrokers,
		"group.id":          m.cfg.ConsumerGroupID,
	})
	if err != nil {
		m.log.Warn("lag probe: create consumer failed", "err", err)
		return
	}
	defer c.Close()

	meta, err := c.GetMetadata(&m.cfg.SourceTopic, false, 10000)
	if err != nil {
		m.log.Warn("lag probe: get metadata failed", "err", err)
		return
	}

	topicMeta, ok := meta.Topics[m.cfg.SourceTopic]
	if !ok {
		return
	}

	var partitions []kafka.TopicPartition
	for _, p := range topicMeta.Partitions {
		partitions = append(partitions, kafka.TopicPartition{
			Topic:     &m.cfg.SourceTopic,
			Partition: p.ID,
		})
	}
	if len(partitions) == 0 {
		return
	}

	committed, err := c.Committed(partitions, 10000)
	if err != nil {
		m.log.Warn("lag probe: committed offsets failed", "err", err)
		return
	}

	var totalLag int64
	for _, tp := range committed {
		committedOffset := int64(tp.Offset)
		if committedOffset < 0 {
			committedOffset = 0
		}
		_, high, err := c.QueryWatermarkOffsets(*tp.Topic, tp.Partition, 10000)
		if err != nil {
			continue
		}
		lag := high - committedOffset
		if lag < 0 {
			lag = 0
		}
		totalLag += lag
	}

	metrics.ConsumerLag.Set(float64(totalLag))
	m.log.Debug("consumer lag probed", "lag", totalLag, "topic", m.cfg.SourceTopic)

	for _, th := range lagThresholds {
		if totalLag >= th.messages {
			m.log.Warn("consumer lag alert threshold exceeded",
				"threshold", th.label,
				"lag_messages", totalLag,
				"topic", m.cfg.SourceTopic,
			)
		}
	}
}
