// Package kafka provides the high-throughput Kafka producer for the Event Collector.
package kafka

import (
	"encoding/json"
	"fmt"
	"strings"

	confluent "github.com/confluentinc/confluent-kafka-go/v2/kafka"
	"github.com/airtel-ubrnms/event-collector/internal/normalizer"
)

type Producer struct {
	p     *confluent.Producer
	topic string
}

func NewProducer(brokers []string, topic string) (*Producer, error) {
	p, err := confluent.NewProducer(&confluent.ConfigMap{
		"bootstrap.servers":                     strings.Join(brokers, ","),
		"enable.idempotence":                    true,
		"acks":                                  "all",
		"retries":                               10,
		"max.in.flight.requests.per.connection": 5,
		"batch.size":                            65536,
		"linger.ms":                             5,
		"compression.type":                      "snappy",
	})
	if err != nil {
		return nil, fmt.Errorf("kafka producer init: %w", err)
	}

	// Start async delivery report goroutine
	go func() {
		for range p.Events() {}
	}()

	return &Producer{p: p, topic: topic}, nil
}

// Publish sends a RawAlarm to Kafka asynchronously (fire-and-forget with delivery chan monitoring).
func (kp *Producer) Publish(alarm normalizer.RawAlarm) error {
	data, err := json.Marshal(alarm)
	if err != nil {
		return fmt.Errorf("marshal: %w", err)
	}
	return kp.p.Produce(&confluent.Message{
		TopicPartition: confluent.TopicPartition{Topic: &kp.topic, Partition: confluent.PartitionAny},
		Key:            []byte(alarm.DeviceID),
		Value:          data,
	}, nil)
}

// Flush drains in-flight messages.
func (kp *Producer) Flush(timeoutMs int) {
	kp.p.Flush(timeoutMs)
}

// Close flushes and closes the producer.
func (kp *Producer) Close() {
	kp.p.Flush(10000)
	kp.p.Close()
}
