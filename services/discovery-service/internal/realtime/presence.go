// Package realtime manages device realtime presence via WebSocket keepalive (WO-022).
//
// Each connecting device presents an HMAC session token (header X-Device-Token).
// The token is validated before the WebSocket upgrade. On first successful connection:
//   - lastRealtimeAt is updated in inventory-service
//   - bootstrapState transitions to REALTIME_ESTABLISHED
//   - a Kafka audit event is published
//
// Presence is stored in Redis with a TTL of 60 seconds, refreshed on each heartbeat.
// When a device disconnects (either cleanly or via missed heartbeat), its presence key
// is not renewed and expires naturally; the manager marks the device OFFLINE.
//
// Heartbeat interval: 30 s. TTL: 60 s (two missed heartbeats before presence expires).
package realtime

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/google/uuid"
)

// ── Constants ─────────────────────────────────────────────────────────────────

const (
	// HeartbeatInterval is how often the server expects a ping from the device.
	HeartbeatInterval = 30 * time.Second

	// PresenceTTL is how long the Redis key lives after the last heartbeat.
	// Set to 2× HeartbeatInterval to tolerate one missed heartbeat.
	PresenceTTL = 60 * time.Second

	// PresenceKeyPrefix is the Redis key prefix for presence entries.
	PresenceKeyPrefix = "nms:presence:"
)

// ── Dependency interfaces ─────────────────────────────────────────────────────

// PresenceRedis abstracts Redis presence operations.
type PresenceRedis interface {
	// SetPresence sets the presence key with the given TTL.
	SetPresence(ctx context.Context, serialNumber string, ttl time.Duration) error
	// DeletePresence removes the presence key for the given serial.
	DeletePresence(ctx context.Context, serialNumber string) error
}

// PresenceInventory abstracts inventory-service updates for realtime state.
type PresenceInventory interface {
	// MarkRealtimeEstablished sets bootstrapState=REALTIME_ESTABLISHED and lastRealtimeAt on a device.
	MarkRealtimeEstablished(ctx context.Context, serialNumber string, realtimeAt time.Time) error
	// MarkOffline sets bootstrapState=OFFLINE on a device.
	MarkOffline(ctx context.Context, serialNumber string) error
}

// PresencePublisher publishes Kafka audit events for presence lifecycle.
type PresencePublisher interface {
	PublishPresenceEvent(ctx context.Context, event PresenceKafkaEvent) error
}

// PresenceTokenValidator validates the per-device HMAC session token included in
// the WebSocket upgrade request. Returns the authenticated serial number.
type PresenceTokenValidator interface {
	ValidateToken(ctx context.Context, token string) (serialNumber string, err error)
}

// WebSocketConn abstracts a WebSocket connection so the manager is testable.
type WebSocketConn interface {
	// ReadMessage reads the next message from the device (blocks until available or deadline hit).
	ReadMessage() (msgType int, data []byte, err error)
	// WriteMessage writes a message to the device.
	WriteMessage(msgType int, data []byte) error
	// Close closes the connection.
	Close() error
	// SetReadDeadline sets the deadline for the next read.
	SetReadDeadline(t time.Time) error
}

// WebSocketUpgrader upgrades an HTTP connection to WebSocket.
type WebSocketUpgrader interface {
	// Upgrade performs the WebSocket handshake and returns the connection.
	Upgrade(w http.ResponseWriter, r *http.Request) (WebSocketConn, error)
}

// ── Kafka event ───────────────────────────────────────────────────────────────

// PresenceKafkaEvent is published on first connect and on disconnect.
type PresenceKafkaEvent struct {
	EventID      string    `json:"eventId"`
	CorrelationID string   `json:"correlationId"`
	SerialNumber string    `json:"serialNumber"`
	EventType    string    `json:"eventType"`   // "realtime_established" | "disconnected"
	Timestamp    time.Time `json:"timestamp"`
	SourceService string   `json:"sourceService"`
}

// ── Heartbeat message ─────────────────────────────────────────────────────────

// HeartbeatMessage is the JSON message sent from server to device on each tick.
type HeartbeatMessage struct {
	Type      string    `json:"type"`      // "heartbeat"
	Timestamp time.Time `json:"timestamp"`
	ServerSeq int64     `json:"serverSeq"`
}

// DeviceMessage is the JSON message received from a device.
type DeviceMessage struct {
	Type string `json:"type"` // "pong", "metrics", etc.
}

// ── Manager ───────────────────────────────────────────────────────────────────

// Manager manages all active device WebSocket connections.
type Manager struct {
	redis     PresenceRedis
	inventory PresenceInventory
	publisher PresencePublisher
	validator PresenceTokenValidator
	upgrader  WebSocketUpgrader

	mu          sync.RWMutex
	connections map[string]*deviceConn // serialNumber → conn
}

type deviceConn struct {
	conn       WebSocketConn
	serial     string
	connectedAt time.Time
	cancel     context.CancelFunc
}

// NewManager creates a new presence Manager.
func NewManager(
	redis PresenceRedis,
	inventory PresenceInventory,
	publisher PresencePublisher,
	validator PresenceTokenValidator,
	upgrader WebSocketUpgrader,
) *Manager {
	return &Manager{
		redis:       redis,
		inventory:   inventory,
		publisher:   publisher,
		validator:   validator,
		upgrader:    upgrader,
		connections: make(map[string]*deviceConn),
	}
}

// ServeHTTP handles the WebSocket upgrade and presence lifecycle for one device.
// Path: GET /api/v1/discovery/realtime
// Required header: X-Device-Token: <hmac-session-token>
func (m *Manager) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	corrID := r.Header.Get("X-Correlation-ID")
	if corrID == "" {
		corrID = uuid.New().String()
	}

	// Validate HMAC session token before upgrading
	token := r.Header.Get("X-Device-Token")
	if token == "" {
		http.Error(w, `{"reason":"MISSING_DEVICE_TOKEN"}`, http.StatusUnauthorized)
		return
	}

	serial, err := m.validator.ValidateToken(r.Context(), token)
	if err != nil {
		slog.Warn("presence: token validation failed", "error", err, "corrID", corrID)
		http.Error(w, `{"reason":"HMAC_INVALID"}`, http.StatusUnauthorized)
		return
	}

	// Upgrade to WebSocket
	wsConn, err := m.upgrader.Upgrade(w, r)
	if err != nil {
		slog.Error("presence: WebSocket upgrade failed", "serial", serial, "error", err)
		return
	}

	ctx, cancel := context.WithCancel(r.Context())
	dc := &deviceConn{conn: wsConn, serial: serial, connectedAt: time.Now(), cancel: cancel}

	firstConnect := m.register(dc)
	slog.Info("presence: device connected", "serial", serial, "firstConnect", firstConnect)

	if firstConnect {
		m.onFirstConnect(ctx, serial, corrID)
	}

	m.runLoop(ctx, dc)
	cancel()

	m.unregister(serial)
	m.onDisconnect(context.Background(), serial, corrID)
}

// ── Private lifecycle helpers ─────────────────────────────────────────────────

// register records the connection. Returns true if this is the first presence
// recorded for this serial in this manager instance.
func (m *Manager) register(dc *deviceConn) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	first := m.connections[dc.serial] == nil
	if prev, ok := m.connections[dc.serial]; ok {
		// Close prior connection (device reconnected without clean disconnect)
		_ = prev.conn.Close()
		prev.cancel()
	}
	m.connections[dc.serial] = dc
	return first
}

func (m *Manager) unregister(serial string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.connections, serial)
}

// onFirstConnect is called the first time a device establishes a realtime connection.
func (m *Manager) onFirstConnect(ctx context.Context, serial, corrID string) {
	now := time.Now().UTC()

	if err := m.redis.SetPresence(ctx, serial, PresenceTTL); err != nil {
		slog.Warn("presence: Redis set failed on first connect", "serial", serial, "error", err)
	}

	if err := m.inventory.MarkRealtimeEstablished(ctx, serial, now); err != nil {
		slog.Warn("presence: inventory update failed on first connect", "serial", serial, "error", err)
	}

	go func() {
		ev := PresenceKafkaEvent{
			EventID:       uuid.New().String(),
			CorrelationID: corrID,
			SerialNumber:  serial,
			EventType:     "realtime_established",
			Timestamp:     now,
			SourceService: "discovery-service",
		}
		if pubErr := m.publisher.PublishPresenceEvent(context.Background(), ev); pubErr != nil {
			slog.Warn("presence: Kafka publish failed", "serial", serial, "error", pubErr)
		}
	}()
}

// onDisconnect cleans up Redis state and marks the device offline in inventory.
func (m *Manager) onDisconnect(ctx context.Context, serial, corrID string) {
	if err := m.redis.DeletePresence(ctx, serial); err != nil {
		slog.Warn("presence: Redis delete failed on disconnect", "serial", serial, "error", err)
	}

	if err := m.inventory.MarkOffline(ctx, serial); err != nil {
		slog.Warn("presence: inventory offline update failed", "serial", serial, "error", err)
	}

	go func() {
		ev := PresenceKafkaEvent{
			EventID:       uuid.New().String(),
			CorrelationID: corrID,
			SerialNumber:  serial,
			EventType:     "disconnected",
			Timestamp:     time.Now().UTC(),
			SourceService: "discovery-service",
		}
		if pubErr := m.publisher.PublishPresenceEvent(context.Background(), ev); pubErr != nil {
			slog.Warn("presence: Kafka disconnect publish failed", "serial", serial, "error", pubErr)
		}
	}()

	slog.Info("presence: device disconnected", "serial", serial)
}

// runLoop drives the heartbeat ticker and processes incoming messages until the connection closes.
func (m *Manager) runLoop(ctx context.Context, dc *deviceConn) {
	ticker := time.NewTicker(HeartbeatInterval)
	defer ticker.Stop()

	var seq int64

	for {
		select {
		case <-ctx.Done():
			return

		case t := <-ticker.C:
			seq++
			hb := HeartbeatMessage{Type: "heartbeat", Timestamp: t.UTC(), ServerSeq: seq}
			data, _ := json.Marshal(hb)
			if err := dc.conn.WriteMessage(1 /* TextMessage */, data); err != nil {
				slog.Debug("presence: heartbeat write failed", "serial", dc.serial, "error", err)
				return
			}

			// Refresh Redis TTL on each heartbeat
			if err := m.redis.SetPresence(ctx, dc.serial, PresenceTTL); err != nil {
				slog.Warn("presence: Redis TTL refresh failed", "serial", dc.serial, "error", err)
			}

		default:
			// Non-blocking read: set a short deadline so the select can tick
			_ = dc.conn.SetReadDeadline(time.Now().Add(100 * time.Millisecond))
			_, data, err := dc.conn.ReadMessage()
			if err != nil {
				// Timeout is expected — only bail on real close errors
				if isClosedError(err) {
					return
				}
				continue
			}
			var msg DeviceMessage
			if jsonErr := json.Unmarshal(data, &msg); jsonErr != nil {
				slog.Debug("presence: unreadable message from device", "serial", dc.serial)
				continue
			}
			slog.Debug("presence: received message", "serial", dc.serial, "type", msg.Type)
		}
	}
}

// ConnectedCount returns the number of currently connected devices.
// Used for metrics / health checks.
func (m *Manager) ConnectedCount() int {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return len(m.connections)
}

// ── Utility ───────────────────────────────────────────────────────────────────

// isClosedError returns true for connection-closed / use-of-closed-network-connection errors.
func isClosedError(err error) bool {
	if err == nil {
		return false
	}
	s := err.Error()
	return contains(s, "EOF") ||
		contains(s, "use of closed network connection") ||
		contains(s, "websocket: close") ||
		contains(s, "connection reset by peer")
}

func contains(s, sub string) bool {
	return len(s) >= len(sub) && (s == sub || len(s) > 0 && containsStr(s, sub))
}

func containsStr(s, sub string) bool {
	for i := 0; i <= len(s)-len(sub); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}

// ── Redis key helper ──────────────────────────────────────────────────────────

// PresenceKey returns the Redis key for a given serial number.
func PresenceKey(serial string) string {
	return fmt.Sprintf("%s%s", PresenceKeyPrefix, serial)
}
