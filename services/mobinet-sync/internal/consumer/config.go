package consumer

import "os"

// Config holds all runtime configuration loaded from environment variables.
type Config struct {
	// Source Kafka (UBR NMS internal — written by inventory-service)
	KafkaBrokers    string
	SyncTopic       string
	DeleteTopic     string
	ConsumerGroupID string

	// Destination Kafka (Mobinet/Telemedia endpoint)
	MobinetBrokers string
	MobinetTopic   string

	// Dead-letter queue
	DLQTopic   string
	MaxRetries int

	MetricsPort string
}

// LoadConfig loads settings from environment variables with safe defaults.
func LoadConfig() *Config {
	return &Config{
		KafkaBrokers:    getenv("KAFKA_BROKERS", "localhost:9092"),
		SyncTopic:       getenv("SYNC_TOPIC", "inventory-sync"),
		DeleteTopic:     getenv("DELETE_TOPIC", "inventory-delete"),
		ConsumerGroupID: getenv("CONSUMER_GROUP_ID", "mobinet-sync"),
		MobinetBrokers:  getenv("MOBINET_KAFKA_BROKERS", "localhost:9095"),
		MobinetTopic:    getenv("MOBINET_TOPIC", "mobinet-inventory"),
		DLQTopic:        getenv("DLQ_TOPIC", "mobinet-inventory-dlq"),
		MaxRetries:      3,
		MetricsPort:     getenv("METRICS_PORT", "9092"),
	}
}

func getenv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
