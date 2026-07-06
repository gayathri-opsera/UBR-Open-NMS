// Package kafka provides Kafka producer for the Discovery Service.
package kafka

import (
	"encoding/json"
	"fmt"

	confluent "github.com/confluentinc/confluent-kafka-go/v2/kafka"
	"github.com/airtel-ubrnms/discovery-service/internal/model"
)

// Producer wraps a Kafka producer with idempotent, acks=all writes.
type Producer struct {
	p            *confluent.Producer
	topicDevice  string
	topicAlarms  string
}

// NewProducer creates an idempotent Kafka producer.
func NewProducer(brokers, topicDevice, topicAlarms string) (*Producer, error) {
	p, err := confluent.NewProducer(&confluent.ConfigMap{
		"bootstrap.servers":  brokers,
		"enable.idempotence": true,
		"acks":               "all",
		"retries":            10,
		"max.in.flight.requests.per.connection": 1,
	})
	if err != nil {
		return nil, fmt.Errorf("failed to create kafka producer: %w", err)
	}
	return &Producer{p: p, topicDevice: topicDevice, topicAlarms: topicAlarms}, nil
}

// PublishDevice publishes a DiscoveredDevice event.
func (kp *Producer) PublishDevice(d model.DiscoveredDevice) error {
	return kp.publish(kp.topicDevice, d.SerialNumber, d)
}

// PublishAlarm publishes a raw alarm event.
func (kp *Producer) PublishAlarm(a model.Alarm) error {
	return kp.publish(kp.topicAlarms, a.Source, a)
}

func (kp *Producer) publish(topic, key string, payload interface{}) error {
	data, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("marshal error: %w", err)
	}
	deliveryChan := make(chan confluent.Event)
	err = kp.p.Produce(&confluent.Message{
		TopicPartition: confluent.TopicPartition{Topic: &topic, Partition: confluent.PartitionAny},
		Key:            []byte(key),
		Value:          data,
	}, deliveryChan)
	if err != nil {
		return fmt.Errorf("kafka produce error: %w", err)
	}
	e := <-deliveryChan
	m := e.(*confluent.Message)
	if m.TopicPartition.Error != nil {
		return fmt.Errorf("delivery error: %w", m.TopicPartition.Error)
	}
	return nil
}

// Close flushes and closes the producer.
func (kp *Producer) Close() {
	kp.p.Flush(5000)
	kp.p.Close()
}
