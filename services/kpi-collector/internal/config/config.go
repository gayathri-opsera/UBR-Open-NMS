package config

import (
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	Port              string
	KafkaBrokers      string
	KafkaGroupID      string
	KafkaTopicRawKPI  string
	KafkaTopicAlarms  string
	PollIntervalSec   int
	InventoryURL      string
	InventoryCacheTTL time.Duration
	MetricsPort       string
	SNMPCommunity     string
	SNMPv3User        string
	SNMPv3AuthPass    string
	SNMPv3PrivPass    string
	PushTimeout       int
}

func Load() *Config {
	return &Config{
		Port:              getEnv("PORT", "8087"),
		KafkaBrokers:      getEnv("KAFKA_BROKERS", "localhost:9092"),
		KafkaGroupID:      getEnv("KAFKA_GROUP_ID", "kpi-collector"),
		KafkaTopicRawKPI:  getEnv("KAFKA_TOPIC_RAW_KPI", "raw-kpi"),
		KafkaTopicAlarms:  getEnv("KAFKA_TOPIC_ALARMS", "raw-alarms"),
		PollIntervalSec:   getEnvInt("POLL_INTERVAL_SEC", 300),
		InventoryURL:      getEnv("INVENTORY_URL", "http://inventory-service:8082"),
		InventoryCacheTTL: time.Duration(getEnvInt("INVENTORY_CACHE_TTL_SEC", 300)) * time.Second,
		MetricsPort:       getEnv("METRICS_PORT", "9090"),
		SNMPCommunity:     getEnv("SNMP_COMMUNITY", "public"),
		SNMPv3User:        getEnv("SNMPV3_USER", ""),
		SNMPv3AuthPass:    getEnv("SNMPV3_AUTH_PASS", ""),
		SNMPv3PrivPass:    getEnv("SNMPV3_PRIV_PASS", ""),
		PushTimeout:       getEnvInt("SNMP_TIMEOUT_SEC", 10),
	}
}

func getEnv(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func getEnvInt(key string, def int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(strings.TrimSpace(v)); err == nil {
			return n
		}
	}
	return def
}
