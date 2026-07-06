package consumer

import (
	"fmt"
	"log/slog"
	"time"

	kafka "github.com/confluentinc/confluent-kafka-go/v2/kafka"
	"github.com/ubrnms/netcool-forwarder/internal/metrics"
)

// ForwardSink abstracts publishing to the Netcool Kafka endpoint.
type ForwardSink interface {
	Publish(alarmID string, data []byte) error
}

// Forwarder reads from the source topic, converts, and publishes to Netcool.
type Forwarder struct {
	cfg      *Config
	log      *slog.Logger
	consumer *kafka.Consumer
	producer *kafka.Producer
	sink     ForwardSink
	dlqSink  ForwardSink
	stopCh   chan struct{}
}

// NewForwarder creates a real Kafka forwarder.
func NewForwarder(cfg *Config, log *slog.Logger) (*Forwarder, error) {
	c, err := kafka.NewConsumer(&kafka.ConfigMap{
		"bootstrap.servers":        cfg.KafkaBrokers,
		"group.id":                 cfg.ConsumerGroupID,
		"auto.offset.reset":        "earliest",
		"enable.auto.commit":       false,
		"session.timeout.ms":       30000,
	})
	if err != nil {
		return nil, fmt.Errorf("create consumer: %w", err)
	}
	if err := c.SubscribeTopics([]string{cfg.SourceTopic}, nil); err != nil {
		return nil, fmt.Errorf("subscribe: %w", err)
	}

	p, err := kafka.NewProducer(&kafka.ConfigMap{
		"bootstrap.servers": cfg.NetcoolBrokers,
		"acks":              "all",
	})
	if err != nil {
		return nil, fmt.Errorf("create producer: %w", err)
	}

	f := &Forwarder{
		cfg:      cfg,
		log:      log,
		consumer: c,
		producer: p,
		stopCh:   make(chan struct{}),
	}
	f.sink = &kafkaSink{producer: p, topic: cfg.NetcoolTopic}
	f.dlqSink = &kafkaSink{producer: p, topic: cfg.DLQTopic}
	return f, nil
}

// NewForwarderWithSink creates a forwarder with an injectable sink (for testing).
func NewForwarderWithSink(cfg *Config, log *slog.Logger, sink ForwardSink) *Forwarder {
	return &Forwarder{
		cfg:    cfg,
		log:    log,
		sink:   sink,
		stopCh: make(chan struct{}),
	}
}

// SetDLQSink overrides the DLQ sink for testing.
func (f *Forwarder) SetDLQSink(sink ForwardSink) {
	f.dlqSink = sink
}

// ProcessMessage processes a raw Kafka message payload (exported for testing).
func (f *Forwarder) ProcessMessage(payload []byte) error {
	start := time.Now()

	raw, err := ParseRawAlarm(payload)
	if err != nil {
		f.log.Warn("parse alarm failed, sending to DLQ", "err", err)
		return f.publishToDLQ(payload)
	}

	netcoolBytes, err := MarshalNetcool(raw)
	if err != nil {
		return f.publishToDLQ(payload)
	}

	var lastErr error
	for attempt := 0; attempt < f.cfg.MaxRetries; attempt++ {
		if err := f.sink.Publish(raw.AlarmID, netcoolBytes); err != nil {
			lastErr = err
			f.log.Warn("forward attempt failed", "attempt", attempt+1, "err", err)
			time.Sleep(time.Duration(attempt+1) * 50 * time.Millisecond)
			continue
		}
		metrics.ForwardedTotal.Inc()
		metrics.ForwardLatency.Observe(time.Since(start).Seconds())
		return nil
	}
	_ = lastErr
	metrics.DLQTotal.Inc()
	return f.publishToDLQ(payload)
}

func (f *Forwarder) publishToDLQ(payload []byte) error {
	if f.dlqSink != nil {
		return f.dlqSink.Publish("dlq", payload)
	}
	return nil
}

func (f *Forwarder) Run() error {
	f.log.Info("netcool forwarder started", "topic", f.cfg.SourceTopic)
	for {
		select {
		case <-f.stopCh:
			return nil
		default:
		}
		if f.consumer == nil {
			return nil
		}
		msg, err := f.consumer.ReadMessage(500 * time.Millisecond)
		if err != nil {
			if kerr, ok := err.(kafka.Error); ok && kerr.Code() == kafka.ErrTimedOut {
				continue
			}
			f.log.Warn("consume error", "err", err)
			continue
		}
		if err := f.ProcessMessage(msg.Value); err != nil {
			f.log.Error("process message failed", "err", err)
		} else if f.consumer != nil {
			if _, err := f.consumer.CommitMessage(msg); err != nil {
				f.log.Warn("commit failed", "err", err)
			}
		}
	}
}

func (f *Forwarder) Stop() {
	close(f.stopCh)
	if f.consumer != nil {
		_ = f.consumer.Close()
	}
	if f.producer != nil {
		f.producer.Flush(5000)
		f.producer.Close()
	}
}

// kafkaSink publishes to the real Netcool Kafka endpoint.
type kafkaSink struct {
	producer *kafka.Producer
	topic    string
}

func (s *kafkaSink) Publish(alarmID string, data []byte) error {
	deliveryChan := make(chan kafka.Event, 1)
	err := s.producer.Produce(&kafka.Message{
		TopicPartition: kafka.TopicPartition{Topic: &s.topic, Partition: kafka.PartitionAny},
		Key:            []byte(alarmID),
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
