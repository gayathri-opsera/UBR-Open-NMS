package consumer

import "os"

// Config holds all runtime configuration loaded from environment variables.
type Config struct {
	// Source Kafka
	KafkaBrokers    string
	SourceTopic     string
	ConsumerGroupID string

	// Syslog endpoint
	SyslogHost     string
	SyslogPort     string
	SyslogProtocol string // "udp" or "tcp"
	SyslogFacility int    // RFC 5424 facility number (1 = user, 16 = local0, …)

	// Store-and-forward buffer
	BufferSize int // max messages in memory buffer

	MetricsPort string
}

// LoadConfig loads settings from environment variables with safe defaults.
func LoadConfig() *Config {
	return &Config{
		KafkaBrokers:    getenv("KAFKA_BROKERS", "localhost:9092"),
		SourceTopic:     getenv("SOURCE_TOPIC", "operational-events"),
		ConsumerGroupID: getenv("CONSUMER_GROUP_ID", "syslog-forwarder"),
		SyslogHost:      getenv("SYSLOG_HOST", "localhost"),
		SyslogPort:      getenv("SYSLOG_PORT", "514"),
		SyslogProtocol:  getenv("SYSLOG_PROTOCOL", "udp"),
		SyslogFacility:  16, // local0
		BufferSize:      10000,
		MetricsPort:     getenv("METRICS_PORT", "9093"),
	}
}

func getenv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
