package consumer

import (
	"fmt"
	"log/slog"
	"time"

	kafka "github.com/confluentinc/confluent-kafka-go/v2/kafka"
	"github.com/ubrnms/mobinet-sync/internal/metrics"
)

// ForwardSink abstracts publishing to the Mobinet Kafka endpoint.
type ForwardSink interface {
	Publish(key string, data []byte) error
}

// Syncer reads from the inventory-sync topic, validates, converts, and publishes
// to Mobinet. It also provides a stub consumer for the inventory-delete topic.
type Syncer struct {
	cfg      *Config
	log      *slog.Logger
	consumer *kafka.Consumer
	producer *kafka.Producer
	sink     ForwardSink
	dlqSink  ForwardSink
	stopCh   chan struct{}
}

// NewSyncer creates a real Kafka syncer.
func NewSyncer(cfg *Config, log *slog.Logger) (*Syncer, error) {
	c, err := kafka.NewConsumer(&kafka.ConfigMap{
		"bootstrap.servers":  cfg.KafkaBrokers,
		"group.id":           cfg.ConsumerGroupID,
		"auto.offset.reset":  "earliest",
		"enable.auto.commit": false,
		"session.timeout.ms": 30000,
	})
	if err != nil {
		return nil, fmt.Errorf("create consumer: %w", err)
	}
	// Subscribe to both sync and delete topics
	if err := c.SubscribeTopics([]string{cfg.SyncTopic, cfg.DeleteTopic}, nil); err != nil {
		return nil, fmt.Errorf("subscribe: %w", err)
	}

	p, err := kafka.NewProducer(&kafka.ConfigMap{
		"bootstrap.servers": cfg.MobinetBrokers,
		"acks":              "all",
	})
	if err != nil {
		return nil, fmt.Errorf("create producer: %w", err)
	}

	s := &Syncer{
		cfg:      cfg,
		log:      log,
		consumer: c,
		producer: p,
		stopCh:   make(chan struct{}),
	}
	s.sink = &kafkaSink{producer: p, topic: cfg.MobinetTopic}
	s.dlqSink = &kafkaSink{producer: p, topic: cfg.DLQTopic}
	return s, nil
}

// NewSyncerWithSink creates a syncer with injectable sinks (for unit tests).
func NewSyncerWithSink(cfg *Config, log *slog.Logger, sink ForwardSink) *Syncer {
	return &Syncer{
		cfg:    cfg,
		log:    log,
		sink:   sink,
		stopCh: make(chan struct{}),
	}
}

// SetDLQSink overrides the DLQ sink for unit tests.
func (s *Syncer) SetDLQSink(sink ForwardSink) {
	s.dlqSink = sink
}

// Run is the main processing loop.
func (s *Syncer) Run() error {
	s.log.Info("mobinet syncer started", "syncTopic", s.cfg.SyncTopic, "deleteTopic", s.cfg.DeleteTopic)
	for {
		select {
		case <-s.stopCh:
			return nil
		default:
		}
		if s.consumer == nil {
			return nil
		}
		msg, err := s.consumer.ReadMessage(500 * time.Millisecond)
		if err != nil {
			if kerr, ok := err.(kafka.Error); ok && kerr.Code() == kafka.ErrTimedOut {
				continue
			}
			s.log.Warn("consume error", "err", err)
			continue
		}

		topic := *msg.TopicPartition.Topic
		if topic == s.cfg.DeleteTopic {
			s.handleDeleteStub(msg)
		} else {
			if err := s.ProcessMessage(msg.Value); err != nil {
				s.log.Error("process message failed", "err", err)
				continue
			}
		}
		if s.consumer != nil {
			if _, err := s.consumer.CommitMessage(msg); err != nil {
				s.log.Warn("commit failed", "err", err)
			}
		}
	}
}

// handleDeleteStub logs delete events; actual deletion handling is a future integration point.
func (s *Syncer) handleDeleteStub(msg *kafka.Message) {
	s.log.Info("inventory-delete event received (stub — future integration)", "offset", msg.TopicPartition.Offset)
	metrics.DeleteEventsTotal.Inc()
}

// ProcessMessage processes a raw inventory-sync Kafka payload (exported for testing).
func (s *Syncer) ProcessMessage(payload []byte) error {
	start := time.Now()

	event, err := ParseInventoryEvent(payload)
	if err != nil {
		s.log.Warn("parse inventory event failed, routing to DLQ", "err", err)
		metrics.DLQTotal.Inc()
		return s.publishToDLQ(payload)
	}

	if event.EventType == "DELETE" {
		// DELETE events on the sync topic are treated like stub delete handling
		s.log.Info("delete event via sync topic (stub)", "deviceId", event.DeviceID)
		metrics.DeleteEventsTotal.Inc()
		return nil
	}

	if event.Device == nil {
		s.log.Warn("missing device in UPSERT event, routing to DLQ", "deviceId", event.DeviceID)
		metrics.DLQTotal.Inc()
		return s.publishToDLQ(payload)
	}

	if err := ValidateDevice(*event.Device); err != nil {
		s.log.Warn("invalid device record, routing to DLQ", "err", err)
		metrics.DLQTotal.Inc()
		return s.publishToDLQ(payload)
	}

	mobinetBytes, err := MarshalMobinet(*event.Device)
	if err != nil {
		metrics.DLQTotal.Inc()
		return s.publishToDLQ(payload)
	}

	var lastErr error
	for attempt := 0; attempt < s.cfg.MaxRetries; attempt++ {
		if err := s.sink.Publish(event.Device.SerialNumber, mobinetBytes); err != nil {
			lastErr = err
			s.log.Warn("forward attempt failed", "attempt", attempt+1, "err", err)
			time.Sleep(time.Duration(attempt+1) * 50 * time.Millisecond)
			continue
		}
		metrics.ForwardedTotal.Inc()
		metrics.ForwardLatency.Observe(time.Since(start).Seconds())
		return nil
	}
	_ = lastErr
	metrics.DLQTotal.Inc()
	return s.publishToDLQ(payload)
}

func (s *Syncer) publishToDLQ(payload []byte) error {
	if s.dlqSink != nil {
		return s.dlqSink.Publish("dlq", payload)
	}
	return nil
}

// Stop shuts down the syncer gracefully.
func (s *Syncer) Stop() {
	close(s.stopCh)
	if s.consumer != nil {
		_ = s.consumer.Close()
	}
	if s.producer != nil {
		s.producer.Flush(5000)
		s.producer.Close()
	}
}

// kafkaSink publishes to a Kafka topic.
type kafkaSink struct {
	producer *kafka.Producer
	topic    string
}

func (ks *kafkaSink) Publish(key string, data []byte) error {
	deliveryChan := make(chan kafka.Event, 1)
	err := ks.producer.Produce(&kafka.Message{
		TopicPartition: kafka.TopicPartition{Topic: &ks.topic, Partition: kafka.PartitionAny},
		Key:            []byte(key),
		Value:          data,
	}, deliveryChan)
	if err != nil {
		return err
	}
	e := <-deliveryChan
	if dm, ok := e.(*kafka.Message); ok && dm.TopicPartition.Error != nil {
		return dm.TopicPartition.Error
	}
	return nil
}
