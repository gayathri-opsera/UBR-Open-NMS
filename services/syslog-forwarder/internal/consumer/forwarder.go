package consumer

import (
	"fmt"
	"log/slog"
	"net"
	"sync"
	"time"

	kafka "github.com/confluentinc/confluent-kafka-go/v2/kafka"
	"github.com/ubrnms/syslog-forwarder/internal/metrics"
	syslogfmt "github.com/ubrnms/syslog-forwarder/internal/syslog"
)

// SyslogWriter abstracts the syslog network connection for testing.
type SyslogWriter interface {
	Write(msg string) error
	Close() error
}

// Forwarder reads from Kafka, formats RFC 5424 messages, and writes to syslog.
// When the syslog endpoint is unreachable, messages are buffered in memory and
// flushed when connectivity is restored.
type Forwarder struct {
	cfg      *Config
	log      *slog.Logger
	consumer *kafka.Consumer
	writer   SyslogWriter
	buf      []string
	bufMu    sync.Mutex
	stopCh   chan struct{}
}

// NewForwarder creates a real Kafka + syslog forwarder.
func NewForwarder(cfg *Config, log *slog.Logger) (*Forwarder, error) {
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
	if err := c.SubscribeTopics([]string{cfg.SourceTopic}, nil); err != nil {
		return nil, fmt.Errorf("subscribe: %w", err)
	}

	w, err := newNetWriter(cfg)
	if err != nil {
		log.Warn("syslog endpoint unreachable at startup, starting in buffer mode", "err", err)
	}

	return &Forwarder{
		cfg:    cfg,
		log:    log,
		consumer: c,
		writer: w,
		stopCh: make(chan struct{}),
	}, nil
}

// NewForwarderWithWriter creates a forwarder with an injectable writer (for tests).
func NewForwarderWithWriter(cfg *Config, log *slog.Logger, writer SyslogWriter) *Forwarder {
	return &Forwarder{
		cfg:    cfg,
		log:    log,
		writer: writer,
		stopCh: make(chan struct{}),
	}
}

// Run is the main processing loop.
func (f *Forwarder) Run() error {
	f.log.Info("syslog forwarder started", "topic", f.cfg.SourceTopic)
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
		f.ProcessMessage(msg.Value)
		if f.consumer != nil {
			if _, err := f.consumer.CommitMessage(msg); err != nil {
				f.log.Warn("commit failed", "err", err)
			}
		}
	}
}

// ProcessMessage formats and forwards one event (exported for testing).
// If the syslog writer is unavailable, the message is added to the in-memory buffer.
func (f *Forwarder) ProcessMessage(payload []byte) {
	event, err := syslogfmt.ParseEvent(payload)
	if err != nil {
		f.log.Warn("parse event failed, dropping", "err", err)
		metrics.ErrorsTotal.Inc()
		return
	}

	line := syslogfmt.FormatRFC5424(f.cfg.SyslogFacility, event)

	// Flush any buffered messages first
	f.flushBuffer()

	if err := f.send(line); err != nil {
		f.log.Warn("syslog send failed, buffering", "err", err)
		f.buffer(line)
		metrics.ErrorsTotal.Inc()
		return
	}
	metrics.ForwardedTotal.Inc()
}

// BufferDepth returns the number of messages currently in the in-memory buffer (for tests).
func (f *Forwarder) BufferDepth() int {
	f.bufMu.Lock()
	defer f.bufMu.Unlock()
	return len(f.buf)
}

func (f *Forwarder) send(msg string) error {
	if f.writer == nil {
		return fmt.Errorf("no syslog writer")
	}
	return f.writer.Write(msg)
}

func (f *Forwarder) buffer(msg string) {
	f.bufMu.Lock()
	defer f.bufMu.Unlock()
	if len(f.buf) >= f.cfg.BufferSize {
		// Drop oldest when buffer is full
		f.buf = f.buf[1:]
	}
	f.buf = append(f.buf, msg)
	metrics.BufferDepth.Set(float64(len(f.buf)))
}

func (f *Forwarder) flushBuffer() {
	f.bufMu.Lock()
	if len(f.buf) == 0 {
		f.bufMu.Unlock()
		return
	}
	pending := make([]string, len(f.buf))
	copy(pending, f.buf)
	f.bufMu.Unlock()

	flushed := 0
	for _, msg := range pending {
		if err := f.send(msg); err != nil {
			// Still unreachable — stop trying
			break
		}
		flushed++
		metrics.ForwardedTotal.Inc()
	}

	if flushed > 0 {
		f.bufMu.Lock()
		f.buf = f.buf[flushed:]
		metrics.BufferDepth.Set(float64(len(f.buf)))
		f.bufMu.Unlock()
	}
}

// Stop shuts down the forwarder gracefully.
func (f *Forwarder) Stop() {
	close(f.stopCh)
	if f.consumer != nil {
		_ = f.consumer.Close()
	}
	if f.writer != nil {
		_ = f.writer.Close()
	}
}

// netWriter is the real syslog network writer.
type netWriter struct {
	network string
	addr    string
	conn    net.Conn
}

func newNetWriter(cfg *Config) (SyslogWriter, error) {
	addr := cfg.SyslogHost + ":" + cfg.SyslogPort
	conn, err := net.DialTimeout(cfg.SyslogProtocol, addr, 3*time.Second)
	if err != nil {
		return nil, err
	}
	return &netWriter{network: cfg.SyslogProtocol, addr: addr, conn: conn}, nil
}

func (w *netWriter) Write(msg string) error {
	if w.conn == nil {
		conn, err := net.DialTimeout(w.network, w.addr, 3*time.Second)
		if err != nil {
			return err
		}
		w.conn = conn
	}
	_, err := fmt.Fprintln(w.conn, msg)
	if err != nil {
		_ = w.conn.Close()
		w.conn = nil
	}
	return err
}

func (w *netWriter) Close() error {
	if w.conn != nil {
		return w.conn.Close()
	}
	return nil
}
