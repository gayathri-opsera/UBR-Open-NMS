// Package normalizer converts SNMP traps and syslog messages to canonical alarm format.
package normalizer

import (
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/gosnmp/gosnmp"
	"github.com/google/uuid"
)

// RawAlarm is the canonical alarm record published to Kafka.
type RawAlarm struct {
	EventID   string                 `json:"eventId"`
	DeviceID  string                 `json:"deviceId"`
	AlarmType string                 `json:"alarmType"`
	Severity  string                 `json:"severity"`
	Timestamp time.Time              `json:"timestamp"`
	Source    string                 `json:"source"`
	Message   string                 `json:"message"`
	RawData   map[string]interface{} `json:"rawData"`
}

// NormalizeSNMPv2Trap converts an SNMPv2c trap packet to RawAlarm.
func NormalizeSNMPv2Trap(trap *gosnmp.SnmpTrap, sourceAddr string) RawAlarm {
	deviceID := extractDeviceID(sourceAddr)
	alarmType := "SNMP_TRAP"
	severity := "WARNING"
	message := "SNMP trap received"

	rawData := make(map[string]interface{})
	for _, v := range trap.Variables {
		rawData[v.Name] = fmt.Sprintf("%v", v.Value)
		// Map standard trap OIDs to alarm severity/type
		if strings.Contains(v.Name, "linkDown") || strings.Contains(string(fmt.Sprintf("%v", v.Value)), "linkDown") {
			alarmType = "LINK_DOWN"
			severity = "CRITICAL"
			message = "Link down on device " + deviceID
		}
		if strings.Contains(v.Name, "coldStart") || strings.Contains(string(fmt.Sprintf("%v", v.Value)), "coldStart") {
			alarmType = "COLD_START"
			severity = "MAJOR"
			message = "Device cold-started: " + deviceID
		}
	}

	return RawAlarm{
		EventID:   uuid.NewString(),
		DeviceID:  deviceID,
		AlarmType: alarmType,
		Severity:  severity,
		Timestamp: time.Now().UTC(),
		Source:    sourceAddr,
		Message:   message,
		RawData:   rawData,
	}
}

// NormalizeSNMPv3Trap converts an SNMPv3 authenticated trap to RawAlarm.
// Authentication/decryption is handled by the gosnmp library before reaching this stage.
func NormalizeSNMPv3Trap(trap *gosnmp.SnmpTrap, sourceAddr string) RawAlarm {
	alarm := NormalizeSNMPv2Trap(trap, sourceAddr)
	alarm.RawData["snmpVersion"] = "v3"
	return alarm
}

// rfc5424Pattern matches: <priority>version timestamp hostname appname procid msgid structured-data message
var rfc5424Pattern = regexp.MustCompile(
	`^<(\d+)>(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S*)\s*(.*)$`,
)

// NormalizeSyslog parses a RFC 5424 syslog message to RawAlarm.
func NormalizeSyslog(raw string, sourceAddr string) RawAlarm {
	deviceID := extractDeviceID(sourceAddr)
	severity := "INFO"
	alarmType := "SYSLOG"
	message := raw

	if m := rfc5424Pattern.FindStringSubmatch(raw); m != nil {
		priority := parseInt(m[1])
		facilityCode := priority / 8
		severityCode := priority % 8
		severity = mapSyslogSeverity(severityCode)
		alarmType = fmt.Sprintf("SYSLOG_FAC%d", facilityCode)
		if m[9] != "" {
			message = m[9]
		}
		hostname := m[4]
		if hostname != "-" && hostname != "" {
			deviceID = hostname
		}
	}

	return RawAlarm{
		EventID:   uuid.NewString(),
		DeviceID:  deviceID,
		AlarmType: alarmType,
		Severity:  severity,
		Timestamp: time.Now().UTC(),
		Source:    sourceAddr,
		Message:   message,
		RawData:   map[string]interface{}{"raw": raw},
	}
}

func extractDeviceID(addr string) string {
	// Strip port if present
	parts := strings.Split(addr, ":")
	return parts[0]
}

func mapSyslogSeverity(code int) string {
	switch code {
	case 0, 1, 2: return "CRITICAL"
	case 3:        return "MAJOR"
	case 4:        return "MINOR"
	case 5:        return "WARNING"
	default:       return "INFO"
	}
}

func parseInt(s string) int {
	var v int
	fmt.Sscanf(s, "%d", &v)
	return v
}
