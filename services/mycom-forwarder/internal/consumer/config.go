package consumer

import "os"

// Config holds all runtime configuration loaded from environment variables.
type Config struct {
	// Source Kafka (UBR NMS internal — written by kpi-aggregation-service)
	KafkaBrokers    string
	SourceTopic     string
	ConsumerGroupID string

	// Destination Kafka (Mycom endpoint)
	MycomBrokers string
	MycomTopic   string

	// Dead-letter queue
	DLQTopic   string
	MaxRetries int

	// Lag thresholds (in minutes)
	LagAlert1hMinutes  int
	LagAlert6hMinutes  int
	LagAlert24hMinutes int

	MetricsPort string
}

// LoadConfig loads settings from environment variables with safe defaults.
func LoadConfig() *Config {
	return &Config{
		KafkaBrokers:       getenv("KAFKA_BROKERS", "localhost:9092"),
		SourceTopic:        getenv("SOURCE_TOPIC", "mycom-kpi-export"),
		ConsumerGroupID:    getenv("CONSUMER_GROUP_ID", "mycom-forwarder"),
		MycomBrokers:       getenv("MYCOM_KAFKA_BROKERS", "localhost:9094"),
		MycomTopic:         getenv("MYCOM_TOPIC", "mycom-kpi-inbound"),
		DLQTopic:           getenv("DLQ_TOPIC", "mycom-kpi-dlq"),
		MaxRetries:         3,
		LagAlert1hMinutes:  60,
		LagAlert6hMinutes:  360,
		LagAlert24hMinutes: 1440,
		MetricsPort:        getenv("METRICS_PORT", "9091"),
	}
}

func getenv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
