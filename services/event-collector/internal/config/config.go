// Package config loads Event Collector configuration.
package config

import (
	"os"
	"strconv"
	"strings"
)

type Config struct {
	SNMPPort     int
	SyslogPort   int
	KafkaBrokers []string
	KafkaTopic   string
	MetricsPort  int
	SNMPCommunity string
	// SNMPv3
	SNMPv3User     string
	SNMPv3AuthPass string
	SNMPv3PrivPass string
	LogLevel       string
}

func Load() *Config {
	return &Config{
		SNMPPort:      parseInt(os.Getenv("SNMP_PORT"), 162),
		SyslogPort:    parseInt(os.Getenv("SYSLOG_PORT"), 514),
		KafkaBrokers:  strings.Split(getEnv("KAFKA_BROKERS", "localhost:9092"), ","),
		KafkaTopic:    getEnv("KAFKA_TOPIC_ALARMS", "raw-alarms"),
		MetricsPort:   parseInt(os.Getenv("METRICS_PORT"), 9090),
		SNMPCommunity: getEnv("SNMP_COMMUNITY", "public"),
		SNMPv3User:    getEnv("SNMPV3_USER", ""),
		SNMPv3AuthPass: getEnv("SNMPV3_AUTH_PASS", ""),
		SNMPv3PrivPass: getEnv("SNMPV3_PRIV_PASS", ""),
		LogLevel:      getEnv("LOG_LEVEL", "info"),
	}
}

func getEnv(key, def string) string {
	if v := os.Getenv(key); v != "" { return v }
	return def
}

func parseInt(s string, def int) int {
	if v, err := strconv.Atoi(s); err == nil { return v }
	return def
}
