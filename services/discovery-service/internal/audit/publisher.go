// Package audit implements structured audit-event publishing for the discovery service (WO-011).
//
// All discovery operations (run created, completed, failed) emit an AuditEvent to the
// "audit-events" Kafka topic. The publisher is non-blocking with respect to the primary
// discovery flow: if Kafka is unavailable the event is logged and dropped rather than
// blocking or crashing the discovery process.
package audit

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"time"

	confluent "github.com/confluentinc/confluent-kafka-go/v2/kafka"
	"github.com/google/uuid"
)

const (
	SchemaVersion = "1.0"
	Topic         = "audit-events"
)

// AuditEvent is the payload published to the audit-events Kafka topic.
// Fields align with the AuditEvent message in proto/ubrnms/events.proto.
type AuditEvent struct {
	EventID       string    `json:"eventId"`
	ProducedAt    time.Time `json:"producedAt"`
	SchemaVersion string    `json:"schemaVersion"`
	Service       string    `json:"service"`
	CorrelationID string    `json:"correlationId,omitempty"`
	// Actor is the user sub or service account. Never log this field — may contain PII.
	Actor        string `json:"actor,omitempty"`
	Action       string `json:"action"`
	ResourceType string `json:"resourceType"`
	ResourceID   string `json:"resourceId"`
	Outcome      string `json:"outcome"` // "success" | "failure"
	Detail       string `json:"detail,omitempty"`
}

// Publisher defines the interface for emitting discovery audit events.
// Implementations must be safe for concurrent use.
type Publisher interface {
	// Publish emits a pre-built AuditEvent. Returns an error only if
	// serialisation fails; Kafka delivery failures are logged and swallowed
	// to preserve the non-blocking contract.
	Publish(ctx context.Context, evt AuditEvent) error
}

// KafkaPublisher publishes AuditEvents to a Kafka topic using an idempotent producer.
type KafkaPublisher struct {
	producer *confluent.Producer
	topic    string
}

// NewKafkaPublisher creates a Kafka-backed Publisher connected to brokers.
func NewKafkaPublisher(brokers string) (*KafkaPublisher, error) {
	if brokers == "" {
		return nil, fmt.Errorf("audit.NewKafkaPublisher: brokers must not be empty")
	}
	p, err := confluent.NewProducer(&confluent.ConfigMap{
		"bootstrap.servers":                     brokers,
		"enable.idempotence":                    true,
		"acks":                                  "all",
		"retries":                               5,
		"max.in.flight.requests.per.connection": 1,
		// Keep delivery report channel drained asynchronously.
		"go.delivery.reports": true,
	})
	if err != nil {
		return nil, fmt.Errorf("audit.NewKafkaPublisher: %w", err)
	}
	pub := &KafkaPublisher{producer: p, topic: Topic}
	// Drain delivery reports in the background; log failures without blocking callers.
	go pub.drainDeliveryReports()
	return pub, nil
}

// Publish serialises evt and sends it to the audit-events topic.
// Delivery is asynchronous and failures are logged, not propagated.
func (k *KafkaPublisher) Publish(_ context.Context, evt AuditEvent) error {
	data, err := json.Marshal(evt)
	if err != nil {
		return fmt.Errorf("audit: marshal error: %w", err)
	}
	topic := k.topic
	err = k.producer.Produce(&confluent.Message{
		TopicPartition: confluent.TopicPartition{Topic: &topic, Partition: confluent.PartitionAny},
		Key:            []byte(evt.ResourceID),
		Value:          data,
	}, nil) // delivery reports drained in background goroutine
	if err != nil {
		// Log but don't propagate: audit must not block discovery runs.
		slog.Error("audit: kafka produce error", "action", evt.Action, "err", err)
	}
	return nil
}

func (k *KafkaPublisher) drainDeliveryReports() {
	for e := range k.producer.Events() {
		switch ev := e.(type) {
		case *confluent.Message:
			if ev.TopicPartition.Error != nil {
				slog.Error("audit: delivery failure",
					"topic", *ev.TopicPartition.Topic,
					"err", ev.TopicPartition.Error)
			}
		}
	}
}

// Close flushes pending events and closes the underlying producer.
func (k *KafkaPublisher) Close() {
	k.producer.Flush(10_000)
	k.producer.Close()
}

// NoopPublisher discards all events. Used in tests and local dev.
type NoopPublisher struct{}

func (n *NoopPublisher) Publish(_ context.Context, evt AuditEvent) error {
	slog.Debug("audit: noop — discarding event", "action", evt.Action, "resourceId", evt.ResourceID)
	return nil
}

// NewEvent is a convenience constructor that fills boilerplate fields.
func NewEvent(service, action, resourceType, resourceID, outcome string) AuditEvent {
	return AuditEvent{
		EventID:       uuid.NewString(),
		ProducedAt:    time.Now().UTC(),
		SchemaVersion: SchemaVersion,
		Service:       service,
		Action:        action,
		ResourceType:  resourceType,
		ResourceID:    resourceID,
		Outcome:       outcome,
	}
}
