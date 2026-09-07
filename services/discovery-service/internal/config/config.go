// Package config loads Discovery Service configuration from environment variables.
package config

import (
	"os"
	"strconv"
	"strings"
	"time"
)

// Config holds all service configuration.
type Config struct {
	Port              string
	KafkaBrokers      []string
	KafkaTopicDevice  string
	KafkaTopicAlarms  string
	HMACSecret        string
	CheckInInterval   time.Duration
	MaxCheckInSeconds int
	SyslogEnabled     bool
	LogLevel          string
	// Southbound service registry configuration (WO-009)
	AuthServiceURL      string
	CheckinServiceURL   string
	EventServiceURL     string
	RealtimeServiceURL  string
	// Realtime device presence configuration (WO-022)
	// PingInterval is how often the server sends PING frames to a connected device.
	// Default: 15 seconds (firmware expects at least one ping per 15s interval).
	PingInterval time.Duration
	// ReceiveTimeout is the maximum time the server waits for any inbound traffic
	// (PONG or other message) before closing the connection and marking offline.
	// Must be > PingInterval so a single missed PING does not immediately evict.
	// Default: 30 seconds.
	ReceiveTimeout time.Duration
}

// Load reads configuration from environment, applying defaults.
func Load() *Config {
	intervalSec := parseInt(os.Getenv("CHECKIN_INTERVAL_SECONDS"), 300)
	if intervalSec > 900 {
		intervalSec = 900 // max 15 min per spec
	}

	brokers := strings.Split(getEnv("KAFKA_BROKERS", "localhost:9092"), ",")

	pingIntervalSec := parseInt(os.Getenv("REALTIME_PING_INTERVAL_SECONDS"), 15)
	if pingIntervalSec < 5 {
		pingIntervalSec = 5 // floor: firmware may not keep up below 5s
	}
	receiveTimeoutSec := parseInt(os.Getenv("REALTIME_RECEIVE_TIMEOUT_SECONDS"), 30)
	if receiveTimeoutSec <= pingIntervalSec {
		receiveTimeoutSec = pingIntervalSec * 2 // must exceed ping interval to tolerate one miss
	}

	return &Config{
		Port:             getEnv("PORT", "8081"),
		KafkaBrokers:     brokers,
		KafkaTopicDevice: getEnv("KAFKA_TOPIC_DEVICE", "device-discovered"),
		KafkaTopicAlarms: getEnv("KAFKA_TOPIC_ALARMS", "raw-alarms"),
		HMACSecret:       getEnv("HMAC_SECRET", "change-me-in-production"),
		CheckInInterval:  time.Duration(intervalSec) * time.Second,
		LogLevel:         getEnv("LOG_LEVEL", "info"),
		// Southbound service registry defaults for local/test environments (WO-009)
		AuthServiceURL:     getEnv("AUTH_SERVICE_URL", "http://localhost:3000"),
		CheckinServiceURL:  getEnv("CHECKIN_SERVICE_URL", "http://localhost:8082"),
		EventServiceURL:    getEnv("EVENT_SERVICE_URL", "http://localhost:8083"),
		RealtimeServiceURL: getEnv("REALTIME_SERVICE_URL", "ws://localhost:8084"),
		// Realtime presence (WO-022)
		PingInterval:   time.Duration(pingIntervalSec) * time.Second,
		ReceiveTimeout: time.Duration(receiveTimeoutSec) * time.Second,
	}
}

func getEnv(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func parseInt(s string, def int) int {
	if v, err := strconv.Atoi(s); err == nil {
		return v
	}
	return def
}
