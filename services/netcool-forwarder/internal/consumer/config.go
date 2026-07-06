package consumer

import "os"

// Config holds all runtime configuration loaded from environment variables.
type Config struct {
	// Source Kafka (UBR NMS internal)
	KafkaBrokers      string
	SourceTopic       string
	ConsumerGroupID   string

	// Destination Kafka (Netcool endpoint)
	NetcoolBrokers    string
	NetcoolTopic      string

	// Dead-letter queue
	DLQTopic          string
	MaxRetries        int

	// Lag monitoring
	LagAlertTopic     string

	MetricsPort       string
}

func LoadConfig() *Config {
	return &Config{
		KafkaBrokers:    getenv("KAFKA_BROKERS", "localhost:9092"),
		SourceTopic:     getenv("KAFKA_SOURCE_TOPIC", "netcool-alarms-forward"),
		ConsumerGroupID: getenv("CONSUMER_GROUP_ID", "netcool-forwarder"),
		NetcoolBrokers:  getenv("NETCOOL_KAFKA_BROKERS", "localhost:9093"),
		NetcoolTopic:    getenv("NETCOOL_TOPIC", "netcool-inbound"),
		DLQTopic:        getenv("KAFKA_DLQ_TOPIC", "netcool-alarms-dlq"),
		MaxRetries:      3,
		LagAlertTopic:   getenv("LAG_ALERT_TOPIC", "self-health-alarms"),
		MetricsPort:     getenv("METRICS_PORT", "9090"),
	}
}

func getenv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
