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
}

// Load reads configuration from environment, applying defaults.
func Load() *Config {
	intervalSec := parseInt(os.Getenv("CHECKIN_INTERVAL_SECONDS"), 300)
	if intervalSec > 900 {
		intervalSec = 900 // max 15 min per spec
	}

	brokers := strings.Split(getEnv("KAFKA_BROKERS", "localhost:9092"), ",")

	return &Config{
		Port:             getEnv("PORT", "8081"),
		KafkaBrokers:     brokers,
		KafkaTopicDevice: getEnv("KAFKA_TOPIC_DEVICE", "device-discovered"),
		KafkaTopicAlarms: getEnv("KAFKA_TOPIC_ALARMS", "raw-alarms"),
		HMACSecret:       getEnv("HMAC_SECRET", "change-me-in-production"),
		CheckInInterval:  time.Duration(intervalSec) * time.Second,
		LogLevel:         getEnv("LOG_LEVEL", "info"),
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
