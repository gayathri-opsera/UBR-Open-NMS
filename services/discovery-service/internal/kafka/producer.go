// Package kafka provides Kafka producer for the Discovery Service.
package kafka

import (
	"encoding/json"
	"fmt"

	confluent "github.com/confluentinc/confluent-kafka-go/v2/kafka"
	"github.com/airtel-ubrnms/discovery-service/internal/model"
	sharedmodels "github.com/airtel-ubrnms/shared-libs/go/models"
)

// Producer wraps a Kafka producer with idempotent, acks=all writes.
type Producer struct {
	p                        *confluent.Producer
	topicDevice              string
	topicAlarms              string
	topicClassification      string // WO-030: discovery.classification.results
	topicInventoryRegistered string // WO-030: inventory.device.registered
}

// NewProducer creates an idempotent Kafka producer.
func NewProducer(brokers, topicDevice, topicAlarms string) (*Producer, error) {
	return NewProducerWithClassificationTopics(brokers, topicDevice, topicAlarms, "", "")
}

// NewProducerWithClassificationTopics creates an idempotent Kafka producer with WO-030 classification topics.
func NewProducerWithClassificationTopics(brokers, topicDevice, topicAlarms, topicClassification, topicInventoryRegistered string) (*Producer, error) {
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
	return &Producer{
		p:                        p,
		topicDevice:              topicDevice,
		topicAlarms:              topicAlarms,
		topicClassification:      topicClassification,
		topicInventoryRegistered: topicInventoryRegistered,
	}, nil
}

// PublishDevice publishes a DiscoveredDevice event.
func (kp *Producer) PublishDevice(d model.DiscoveredDevice) error {
	return kp.publish(kp.topicDevice, d.SerialNumber, d)
}

// PublishAlarm publishes a raw alarm event.
func (kp *Producer) PublishAlarm(a model.Alarm) error {
	return kp.publish(kp.topicAlarms, a.Source, a)
}

// PublishClassificationResult publishes a GenericDeviceClassifiedEvent (WO-030).
// Returns an error if the classification topic is not configured, but callers should
// treat this as non-fatal so deferred devices still get an audit trail.
func (kp *Producer) PublishClassificationResult(evt sharedmodels.GenericDeviceClassifiedEvent) error {
	if kp.topicClassification == "" {
		return fmt.Errorf("classification topic not configured")
	}
	return kp.publish(kp.topicClassification, evt.CorrelationID, evt)
}

// PublishKpiCollectionTrigger publishes an InitialKpiCollectionTriggerEvent (WO-031).
func (kp *Producer) PublishKpiCollectionTrigger(evt sharedmodels.InitialKpiCollectionTriggerEvent) error {
	topic := "kpi.initial.collection.trigger"
	return kp.publish(topic, evt.IdempotencyKey, evt)
}

// PublishTopologyWalkTrigger publishes an InitialTopologyWalkTriggerEvent (WO-031).
func (kp *Producer) PublishTopologyWalkTrigger(evt sharedmodels.InitialTopologyWalkTriggerEvent) error {
	topic := "topology.initial.walk.trigger"
	return kp.publish(topic, evt.IdempotencyKey, evt)
}

// PublishInventoryRegistered publishes a GenericInventoryRegisteredEvent (WO-030).
// Published only after successful inventory persistence; must be called even for
// DEFERRED results so downstream consumers can track deferred counts.
func (kp *Producer) PublishInventoryRegistered(evt sharedmodels.GenericInventoryRegisteredEvent) error {
	if kp.topicInventoryRegistered == "" {
		return fmt.Errorf("inventory-registered topic not configured")
	}
	return kp.publish(kp.topicInventoryRegistered, evt.CorrelationID, evt)
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
