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

	"github.com/airtel-ubrnms/discovery-service/internal/southbound"
	"github.com/google/uuid"
)

// ── Constants ─────────────────────────────────────────────────────────────────

const (
	// DefaultPingInterval is the default server-to-device PING cadence (WO-022).
	// Devices must respond with PONG or any traffic within ReceiveTimeout.
	DefaultPingInterval = 15 * time.Second

	// DefaultReceiveTimeout is the maximum silence before the server closes the
	// connection and marks the device offline (WO-022).
	// Must exceed DefaultPingInterval so a single missed PING does not evict.
	DefaultReceiveTimeout = 30 * time.Second

	// PresenceKeyPrefix is the Redis key prefix for presence entries.
	PresenceKeyPrefix = "nms:presence:"
)

// PresenceConfig holds configurable knobs for the presence Manager (WO-022).
// Zero values are replaced with the package defaults on NewManager.
type PresenceConfig struct {
	// PingInterval is how often the server sends a heartbeat PING to the device.
	// Defaults to DefaultPingInterval (15 s).
	PingInterval time.Duration
	// ReceiveTimeout is the read deadline applied after each inbound message.
	// If no message (PONG or any payload) arrives within this window, the
	// connection is closed and the device is marked offline.
	// Defaults to DefaultReceiveTimeout (30 s). Must be > PingInterval.
	ReceiveTimeout time.Duration
}

func (c *PresenceConfig) pingInterval() time.Duration {
	if c == nil || c.PingInterval <= 0 {
		return DefaultPingInterval
	}
	return c.PingInterval
}

func (c *PresenceConfig) receiveTimeout() time.Duration {
	if c == nil || c.ReceiveTimeout <= 0 {
		return DefaultReceiveTimeout
	}
	return c.ReceiveTimeout
}

// presenceTTL returns the Redis key TTL: 2× ping interval so one missed ping
// does not expire the presence before the timeout logic can close the connection.
func (c *PresenceConfig) presenceTTL() time.Duration {
	return c.pingInterval() * 2
}

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
	cfg       PresenceConfig

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
// cfg may be nil or zero-valued; defaults are applied per PresenceConfig methods.
func NewManager(
	redis PresenceRedis,
	inventory PresenceInventory,
	publisher PresencePublisher,
	validator PresenceTokenValidator,
	upgrader WebSocketUpgrader,
	cfg ...PresenceConfig,
) *Manager {
	m := &Manager{
		redis:       redis,
		inventory:   inventory,
		publisher:   publisher,
		validator:   validator,
		upgrader:    upgrader,
		connections: make(map[string]*deviceConn),
	}
	if len(cfg) > 0 {
		m.cfg = cfg[0]
	}
	return m
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
		southbound.BadRequest(w, "X-Device-Token header is required for realtime channel", corrID)
		return
	}

	serial, err := m.validator.ValidateToken(r.Context(), token)
	if err != nil {
		slog.Warn("presence: token validation failed", "error", err, "corrID", corrID)
		southbound.HMACInvalid(w, corrID)
		return
	}

	// Upgrade to WebSocket — must write error before the upgrader hijacks the connection.
	wsConn, err := m.upgrader.Upgrade(w, r)
	if err != nil {
		// Upgrader has not yet hijacked the connection; send a proper HTTP error.
		slog.Error("presence: WebSocket upgrade failed", "serial", serial, "error", err)
		southbound.InternalError(w, corrID)
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

	if err := m.redis.SetPresence(ctx, serial, m.cfg.presenceTTL()); err != nil {
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

// runLoop drives the PING ticker and processes incoming messages until the connection
// closes or the receive timeout expires.
//
// Liveness model (WO-022):
//  - Server sends a heartbeat PING every cfg.PingInterval (default 15 s).
//  - Any inbound message from the device (PONG or payload) resets the receive deadline.
//  - If no message arrives within cfg.ReceiveTimeout (default 30 s), the connection is
//    closed deterministically and the device is marked offline with reason TIMEOUT.
func (m *Manager) runLoop(ctx context.Context, dc *deviceConn) {
	pingInterval := m.cfg.pingInterval()
	receiveTimeout := m.cfg.receiveTimeout()

	ticker := time.NewTicker(pingInterval)
	defer ticker.Stop()

	// Arm the initial receive deadline. Any inbound traffic resets it.
	_ = dc.conn.SetReadDeadline(time.Now().Add(receiveTimeout))

	// Read messages in a background goroutine so the select can fire ping ticks
	// without blocking on ReadMessage.
	type readResult struct {
		data []byte
		err  error
	}
	readCh := make(chan readResult, 1)

	go func() {
		for {
			_, data, err := dc.conn.ReadMessage()
			readCh <- readResult{data: data, err: err}
			if err != nil {
				return
			}
		}
	}()

	var seq int64

	for {
		select {
		case <-ctx.Done():
			return

		case res := <-readCh:
			if res.err != nil {
				if isTimeoutError(res.err) {
					slog.Info("presence: receive timeout — marking offline", "serial", dc.serial,
						"timeout", receiveTimeout)
				} else if !isClosedError(res.err) {
					slog.Debug("presence: read error", "serial", dc.serial, "error", res.err)
				}
				return
			}
			// Inbound traffic counts as liveness — reset the receive deadline.
			_ = dc.conn.SetReadDeadline(time.Now().Add(receiveTimeout))
			var msg DeviceMessage
			if err := json.Unmarshal(res.data, &msg); err == nil {
				slog.Debug("presence: received message", "serial", dc.serial, "type", msg.Type)
			}

		case t := <-ticker.C:
			seq++
			hb := HeartbeatMessage{Type: "heartbeat", Timestamp: t.UTC(), ServerSeq: seq}
			data, _ := json.Marshal(hb)
			if err := dc.conn.WriteMessage(1 /* TextMessage */, data); err != nil {
				slog.Debug("presence: PING write failed — closing", "serial", dc.serial, "error", err)
				return
			}
			// Refresh Redis TTL on each PING so presence survives one missed PONG.
			if err := m.redis.SetPresence(ctx, dc.serial, m.cfg.presenceTTL()); err != nil {
				slog.Warn("presence: Redis TTL refresh failed", "serial", dc.serial, "error", err)
			}
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

// isTimeoutError returns true when err represents a network read deadline expiry.
// This is distinct from a clean close and signals that the device missed the
// configured receive timeout without sending any traffic.
func isTimeoutError(err error) bool {
	if err == nil {
		return false
	}
	type netTimeout interface{ Timeout() bool }
	if t, ok := err.(netTimeout); ok && t.Timeout() {
		return true
	}
	return contains(err.Error(), "i/o timeout") ||
		contains(err.Error(), "deadline exceeded")
}

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
