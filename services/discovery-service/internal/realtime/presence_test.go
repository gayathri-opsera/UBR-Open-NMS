package realtime

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// ── Fakes ─────────────────────────────────────────────────────────────────────

type fakeRedis struct {
	mu      sync.Mutex
	keys    map[string]time.Duration
	delKeys []string
	setErr  error
	delErr  error
}

func newFakeRedis() *fakeRedis { return &fakeRedis{keys: make(map[string]time.Duration)} }

func (r *fakeRedis) SetPresence(_ context.Context, serial string, ttl time.Duration) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.setErr != nil {
		return r.setErr
	}
	r.keys[serial] = ttl
	return nil
}

func (r *fakeRedis) DeletePresence(_ context.Context, serial string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.delKeys = append(r.delKeys, serial)
	delete(r.keys, serial)
	return r.delErr
}

// ─────────────────────────────────────────────────────────────────────────────

type fakeInventory struct {
	realtimeCalls []string
	offlineCalls  []string
	realtimeErr   error
	offlineErr    error
}

func (f *fakeInventory) MarkRealtimeEstablished(_ context.Context, serial string, _ time.Time) error {
	f.realtimeCalls = append(f.realtimeCalls, serial)
	return f.realtimeErr
}

func (f *fakeInventory) MarkOffline(_ context.Context, serial string) error {
	f.offlineCalls = append(f.offlineCalls, serial)
	return f.offlineErr
}

// ─────────────────────────────────────────────────────────────────────────────

type fakePublisher struct {
	mu     sync.Mutex
	events []PresenceKafkaEvent
}

func (f *fakePublisher) PublishPresenceEvent(_ context.Context, ev PresenceKafkaEvent) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.events = append(f.events, ev)
	return nil
}

// ─────────────────────────────────────────────────────────────────────────────

type fakeValidator struct {
	serial string
	err    error
}

func (f *fakeValidator) ValidateToken(_ context.Context, _ string) (string, error) {
	return f.serial, f.err
}

// ─────────────────────────────────────────────────────────────────────────────

// fakeWebSocketConn simulates a WebSocket connection.
// The test controls when it closes by closing the done channel.
type fakeWebSocketConn struct {
	mu         sync.Mutex
	written    [][]byte
	done       chan struct{}
	closeOnce  sync.Once
	closeCalled bool
}

func newFakeConn() *fakeWebSocketConn {
	return &fakeWebSocketConn{done: make(chan struct{})}
}

func (c *fakeWebSocketConn) ReadMessage() (int, []byte, error) {
	select {
	case <-c.done:
		return 0, nil, errors.New("EOF")
	case <-time.After(60 * time.Millisecond):
		// Simulate a pong
		return 1, []byte(`{"type":"pong"}`), nil
	}
}

func (c *fakeWebSocketConn) WriteMessage(_ int, data []byte) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.written = append(c.written, data)
	return nil
}

func (c *fakeWebSocketConn) Close() error {
	c.closeOnce.Do(func() {
		c.closeCalled = true
		close(c.done)
	})
	return nil
}

func (c *fakeWebSocketConn) SetReadDeadline(_ time.Time) error { return nil }

// ─────────────────────────────────────────────────────────────────────────────

type fakeUpgrader struct {
	conn *fakeWebSocketConn
	err  error
}

func (f *fakeUpgrader) Upgrade(_ http.ResponseWriter, _ *http.Request) (WebSocketConn, error) {
	return f.conn, f.err
}

// ── Tests ─────────────────────────────────────────────────────────────────────

func newManager(redis *fakeRedis, inv *fakeInventory, pub *fakePublisher, v *fakeValidator, up *fakeUpgrader) *Manager {
	return NewManager(redis, inv, pub, v, up)
}

func TestManager_FirstConnect_SetsPresenceAndMarksRealtime(t *testing.T) {
	redis := newFakeRedis()
	inv := &fakeInventory{}
	pub := &fakePublisher{}
	conn := newFakeConn()

	mgr := newManager(redis, inv, pub,
		&fakeValidator{serial: "SN-001"},
		&fakeUpgrader{conn: conn},
	)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/discovery/realtime", nil)
	req.Header.Set("X-Device-Token", "valid-token")
	rec := httptest.NewRecorder()

	// Close connection after short delay so the loop exits
	go func() {
		time.Sleep(20 * time.Millisecond)
		conn.Close()
	}()

	mgr.ServeHTTP(rec, req)

	redis.mu.Lock()
	_, hasPresence := redis.keys["SN-001"]
	redis.mu.Unlock()

	// Presence should have been set then deleted on disconnect
	if len(redis.delKeys) == 0 || redis.delKeys[0] != "SN-001" {
		t.Error("expected presence to be deleted on disconnect")
	}

	if len(inv.realtimeCalls) == 0 || inv.realtimeCalls[0] != "SN-001" {
		t.Error("expected MarkRealtimeEstablished to be called with SN-001")
	}

	if len(inv.offlineCalls) == 0 || inv.offlineCalls[0] != "SN-001" {
		t.Error("expected MarkOffline to be called on disconnect")
	}

	_ = hasPresence
}

func TestManager_MissingToken_Returns401(t *testing.T) {
	mgr := newManager(newFakeRedis(), &fakeInventory{}, &fakePublisher{},
		&fakeValidator{serial: "SN-001"},
		&fakeUpgrader{conn: newFakeConn()},
	)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/discovery/realtime", nil)
	// No X-Device-Token header
	rec := httptest.NewRecorder()

	mgr.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Errorf("expected 401 for missing token, got %d", rec.Code)
	}
}

func TestManager_InvalidToken_Returns401(t *testing.T) {
	mgr := newManager(newFakeRedis(), &fakeInventory{}, &fakePublisher{},
		&fakeValidator{err: errors.New("token invalid")},
		&fakeUpgrader{conn: newFakeConn()},
	)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/discovery/realtime", nil)
	req.Header.Set("X-Device-Token", "bad-token")
	rec := httptest.NewRecorder()

	mgr.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Errorf("expected 401 for invalid token, got %d", rec.Code)
	}
}

func TestManager_UpgradeFailure_NoPresenceSet(t *testing.T) {
	redis := newFakeRedis()
	mgr := newManager(redis, &fakeInventory{}, &fakePublisher{},
		&fakeValidator{serial: "SN-001"},
		&fakeUpgrader{err: errors.New("websocket: upgrade failed")},
	)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/discovery/realtime", nil)
	req.Header.Set("X-Device-Token", "valid-token")
	rec := httptest.NewRecorder()

	mgr.ServeHTTP(rec, req)

	redis.mu.Lock()
	count := len(redis.keys)
	redis.mu.Unlock()

	if count != 0 {
		t.Error("expected no Redis keys when WebSocket upgrade fails")
	}
}

func TestManager_ConnectedCount(t *testing.T) {
	mgr := newManager(newFakeRedis(), &fakeInventory{}, &fakePublisher{},
		&fakeValidator{}, &fakeUpgrader{},
	)

	if mgr.ConnectedCount() != 0 {
		t.Error("expected 0 connections initially")
	}
}

func TestPresenceKey(t *testing.T) {
	key := PresenceKey("SN-001")
	if !strings.HasPrefix(key, PresenceKeyPrefix) {
		t.Errorf("expected key to start with %q, got %q", PresenceKeyPrefix, key)
	}
	if !strings.Contains(key, "SN-001") {
		t.Errorf("expected key to contain serial, got %q", key)
	}
}

func TestHeartbeatMessage_JSON(t *testing.T) {
	hb := HeartbeatMessage{Type: "heartbeat", Timestamp: time.Now().UTC(), ServerSeq: 1}
	data, err := json.Marshal(hb)
	if err != nil {
		t.Fatalf("marshal heartbeat: %v", err)
	}
	var decoded HeartbeatMessage
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("unmarshal heartbeat: %v", err)
	}
	if decoded.Type != "heartbeat" || decoded.ServerSeq != 1 {
		t.Error("heartbeat round-trip failed")
	}
}

func TestIsClosedError(t *testing.T) {
	cases := []struct {
		err    error
		closed bool
	}{
		{nil, false},
		{errors.New("EOF"), true},
		{errors.New("use of closed network connection"), true},
		{errors.New("websocket: close 1000 normal"), true},
		{errors.New("some transient error"), false},
	}
	for _, tc := range cases {
		if got := isClosedError(tc.err); got != tc.closed {
			t.Errorf("isClosedError(%v) = %v, want %v", tc.err, got, tc.closed)
		}
	}
}
