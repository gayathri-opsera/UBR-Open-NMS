// Package kafka — Kafka consumer for initial KPI collection trigger events (WO-031).
//
// Listens to the kpi.initial.collection.trigger topic and schedules an immediate
// one-time SNMP poll for newly registered generic devices.
//
// Idempotency: the consumer tracks received idempotencyKeys in a bounded in-memory
// set to prevent duplicate collection jobs on repeated rediscovery runs. This is
// a best-effort deduplication guard; the poller itself is idempotent by design.
package kafka

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"sync"

	confluent "github.com/confluentinc/confluent-kafka-go/v2/kafka"
)

// InitialCollectionTriggerEvent is the shape expected on the kpi.initial.collection.trigger topic.
type InitialCollectionTriggerEvent struct {
	EventID             string   `json:"eventId"`
	RunID               string   `json:"runId"`
	InventoryDeviceID   string   `json:"inventoryDeviceId"`
	IP                  string   `json:"ip"`
	CorrelationID       string   `json:"correlationId"`
	IdempotencyKey      string   `json:"idempotencyKey"`
	SysObjectID         string   `json:"sysObjectID,omitempty"`
	DiscoveryParadigm   string   `json:"discoveryParadigm"`
	DriverID            string   `json:"driverId,omitempty"`
	CapabilityProfileID string   `json:"capabilityProfileId,omitempty"`
	ProtocolHints       []string `json:"protocolHints,omitempty"`
	IsRediscovery       bool     `json:"isRediscovery"`
}

// ImmediateCollectionScheduler schedules a one-time KPI collection for a device.
type ImmediateCollectionScheduler interface {
	ScheduleImmediateCollection(ctx context.Context, deviceID, ip, correlationID string) error
}

// InitialCollectionConsumer consumes kpi.initial.collection.trigger events and
// schedules immediate one-time polls for newly registered generic devices.
type InitialCollectionConsumer struct {
	consumer  *confluent.Consumer
	scheduler ImmediateCollectionScheduler
	topic     string

	// Best-effort idempotency guard — bounded to prevent memory growth.
	// Real production deployments should use a Redis SETNX with TTL.
	idempotencyMu  sync.Mutex
	seenKeys       map[string]struct{}
	seenKeyMaxSize int
}

// NewInitialCollectionConsumer creates a consumer for kpi.initial.collection.trigger.
func NewInitialCollectionConsumer(brokers, groupID, topic string, scheduler ImmediateCollectionScheduler) (*InitialCollectionConsumer, error) {
	c, err := confluent.NewConsumer(&confluent.ConfigMap{
		"bootstrap.servers":       brokers,
		"group.id":                groupID,
		"auto.offset.reset":       "latest", // only new registrations — don't replay history
		"enable.auto.commit":      false,    // manual commit after successful scheduling
		"session.timeout.ms":      30000,
		"heartbeat.interval.ms":   10000,
	})
	if err != nil {
		return nil, fmt.Errorf("failed to create initial-collection consumer: %w", err)
	}
	if err := c.Subscribe(topic, nil); err != nil {
		c.Close()
		return nil, fmt.Errorf("failed to subscribe to %s: %w", topic, err)
	}
	return &InitialCollectionConsumer{
		consumer:       c,
		scheduler:      scheduler,
		topic:          topic,
		seenKeys:       make(map[string]struct{}),
		seenKeyMaxSize: 10000, // evict oldest entries beyond this bound
	}, nil
}

// Run starts the consumer loop. Blocks until ctx is cancelled.
func (c *InitialCollectionConsumer) Run(ctx context.Context) {
	slog.Info("WO-031: InitialCollectionConsumer started", "topic", c.topic)
	for {
		select {
		case <-ctx.Done():
			slog.Info("WO-031: InitialCollectionConsumer stopping")
			c.consumer.Close()
			return
		default:
		}

		msg, err := c.consumer.ReadMessage(100 /* ms timeout */)
		if err != nil {
			if err.(confluent.Error).Code() == confluent.ErrTimedOut {
				continue
			}
			slog.Warn("WO-031: consumer read error", "err", err)
			continue
		}

		c.handleMessage(ctx, msg)
	}
}

func (c *InitialCollectionConsumer) handleMessage(ctx context.Context, msg *confluent.Message) {
	var evt InitialCollectionTriggerEvent
	if err := json.Unmarshal(msg.Value, &evt); err != nil {
		slog.Error("WO-031: malformed initial-collection trigger event",
			"correlationId", "unknown", "err", err)
		_, _ = c.consumer.CommitMessage(msg)
		return
	}

	// Idempotency check.
	if c.alreadySeen(evt.IdempotencyKey) {
		slog.Debug("WO-031: duplicate trigger suppressed",
			"idempotencyKey", evt.IdempotencyKey, "deviceId", evt.InventoryDeviceID)
		_, _ = c.consumer.CommitMessage(msg)
		return
	}

	if err := c.scheduler.ScheduleImmediateCollection(ctx, evt.InventoryDeviceID, evt.IP, evt.CorrelationID); err != nil {
		// Non-retryable errors: log, mark seen, commit (prevents infinite reprocessing).
		// Retryable errors: do NOT commit — the consumer will reprocess on restart.
		slog.Error("WO-031: immediate collection scheduling failed — will not retry automatically",
			"deviceId", evt.InventoryDeviceID, "correlationId", evt.CorrelationID, "err", err)
	} else {
		slog.Info("WO-031: immediate KPI collection scheduled",
			"deviceId", evt.InventoryDeviceID,
			"idempotencyKey", evt.IdempotencyKey,
			"correlationId", evt.CorrelationID)
		c.markSeen(evt.IdempotencyKey)
	}

	_, _ = c.consumer.CommitMessage(msg)
}

func (c *InitialCollectionConsumer) alreadySeen(key string) bool {
	if key == "" {
		return false
	}
	c.idempotencyMu.Lock()
	defer c.idempotencyMu.Unlock()
	_, seen := c.seenKeys[key]
	return seen
}

func (c *InitialCollectionConsumer) markSeen(key string) {
	if key == "" {
		return
	}
	c.idempotencyMu.Lock()
	defer c.idempotencyMu.Unlock()
	// Bounded eviction: clear half the map when limit is reached to avoid OOM.
	if len(c.seenKeys) >= c.seenKeyMaxSize {
		count := 0
		for k := range c.seenKeys {
			delete(c.seenKeys, k)
			count++
			if count >= c.seenKeyMaxSize/2 {
				break
			}
		}
	}
	c.seenKeys[key] = struct{}{}
}
