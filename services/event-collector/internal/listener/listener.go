// Package listener provides SNMP trap and syslog UDP listeners.
package listener

import (
	"log/slog"
	"net"
	"time"

	"github.com/gosnmp/gosnmp"
	"github.com/airtel-ubrnms/event-collector/internal/normalizer"
)

// AlarmSink receives normalized alarms from listeners.
type AlarmSink interface {
	Publish(alarm normalizer.RawAlarm) error
}

// SNMPListener listens for SNMP trap packets on UDP.
type SNMPListener struct {
	port      int
	community string
	sink      AlarmSink
}

func NewSNMPListener(port int, community string, sink AlarmSink) *SNMPListener {
	return &SNMPListener{port: port, community: community, sink: sink}
}

func (l *SNMPListener) Listen() error {
	tl := gosnmp.NewTrapListener()
	tl.OnNewTrap = func(s *gosnmp.SnmpPacket, addr *net.UDPAddr) {
		trap := gosnmp.SnmpTrap{Variables: s.Variables}
		var alarm normalizer.RawAlarm
		if s.Version == gosnmp.Version3 {
			alarm = normalizer.NormalizeSNMPv3Trap(&trap, addr.String())
		} else {
			alarm = normalizer.NormalizeSNMPv2Trap(&trap, addr.String())
		}
		if err := l.sink.Publish(alarm); err != nil {
			slog.Error("Failed to publish SNMP alarm", "error", err, "device", alarm.DeviceID)
		}
	}
	tl.Params = gosnmp.Default
	tl.Params.Port = uint16(l.port)
	tl.Params.Community = l.community

	slog.Info("SNMP listener started", "port", l.port)
	return tl.Listen(net.JoinHostPort("0.0.0.0", string(rune(l.port))))
}

// SyslogListener listens for syslog messages on UDP.
type SyslogListener struct {
	port int
	sink AlarmSink
}

func NewSyslogListener(port int, sink AlarmSink) *SyslogListener {
	return &SyslogListener{port: port, sink: sink}
}

func (l *SyslogListener) Listen() error {
	addr := &net.UDPAddr{Port: l.port, IP: net.ParseIP("0.0.0.0")}
	conn, err := net.ListenUDP("udp", addr)
	if err != nil {
		return err
	}
	defer conn.Close()

	buf := make([]byte, 65535)
	slog.Info("Syslog listener started", "port", l.port)
	for {
		conn.SetReadDeadline(time.Now().Add(1 * time.Second))
		n, remoteAddr, err := conn.ReadFromUDP(buf)
		if err != nil {
			if netErr, ok := err.(net.Error); ok && netErr.Timeout() {
				continue
			}
			return err
		}
		msg := string(buf[:n])
		alarm := normalizer.NormalizeSyslog(msg, remoteAddr.String())
		if pubErr := l.sink.Publish(alarm); pubErr != nil {
			slog.Error("Failed to publish syslog alarm", "error", pubErr)
		}
	}
}
