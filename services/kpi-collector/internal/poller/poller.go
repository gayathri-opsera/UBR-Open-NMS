// Package poller implements SNMP GET polling for KPI collection.
package poller

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/gosnmp/gosnmp"
	"github.com/ubrnms/kpi-collector/internal/model"
	"github.com/ubrnms/kpi-collector/internal/normalizer"
)

// KPISink receives normalized KPI events for publishing.
type KPISink interface {
	PublishKPI(ctx context.Context, kpi *model.RawKPI) error
	PublishMissingData(ctx context.Context, ev *model.MissingDataEvent) error
}

// Poller orchestrates SNMP polling of a device list.
type Poller struct {
	sink      KPISink
	community string
	v3User    string
	v3AuthP   string
	v3PrivP   string
	timeout   time.Duration
	oidMap    []normalizer.OIDMapping
}

func New(sink KPISink, community, v3User, v3Auth, v3Priv string,
	timeoutSec int, oidMap []normalizer.OIDMapping) *Poller {
	return &Poller{
		sink:      sink,
		community: community,
		v3User:    v3User,
		v3AuthP:   v3Auth,
		v3PrivP:   v3Priv,
		timeout:   time.Duration(timeoutSec) * time.Second,
		oidMap:    oidMap,
	}
}

// PollAll polls a slice of devices concurrently (up to maxConcurrency goroutines).
func (p *Poller) PollAll(ctx context.Context, devices []model.Device,
	pollCycle int64, maxConcurrency int) {

	sem := make(chan struct{}, maxConcurrency)
	var wg sync.WaitGroup

	for _, dev := range devices {
		if ctx.Err() != nil {
			break
		}
		dev := dev
		sem <- struct{}{}
		wg.Add(1)
		go func() {
			defer func() { <-sem; wg.Done() }()
			p.pollDevice(ctx, dev, pollCycle)
		}()
	}
	wg.Wait()
}

// pollDevice performs SNMP GET for a single device.
func (p *Poller) pollDevice(ctx context.Context, dev model.Device, pollCycle int64) {
	oids := extractOIDs(p.oidMap)

	g := buildSNMPSession(dev, p.community, p.v3User, p.v3AuthP, p.v3PrivP, p.timeout)
	if err := g.Connect(); err != nil {
		slog.Error("SNMP connect failed", "device", dev.DeviceID, "err", err)
		p.reportMissing(ctx, dev, pollCycle)
		return
	}
	defer g.Conn.Close()

	result, err := g.Get(oids)
	if err != nil {
		slog.Error("SNMP GET failed", "device", dev.DeviceID, "err", err)
		p.reportMissing(ctx, dev, pollCycle)
		return
	}

	base := &model.RawKPI{
		DeviceID:     dev.DeviceID,
		DeviceType:   dev.Type,
		SerialNumber: dev.SerialNumber,
		NetworkID:    dev.NetworkID,
		Timestamp:    time.Now().UTC(),
		PollCycle:    pollCycle,
	}
	kpi := normalizer.Normalize(result.Variables, p.oidMap, base)

	if err := p.sink.PublishKPI(ctx, kpi); err != nil {
		slog.Error("Failed to publish KPI", "device", dev.DeviceID, "err", err)
	}
}

func (p *Poller) reportMissing(ctx context.Context, dev model.Device, cycle int64) {
	ev := &model.MissingDataEvent{
		DeviceID:   dev.DeviceID,
		DeviceType: dev.Type,
		Timestamp:  time.Now().UTC(),
		PollCycle:  cycle,
		AlarmType:  "MISSING_DATA",
		Severity:   "WARNING",
		Source:     "KPI_COLLECTOR",
	}
	if err := p.sink.PublishMissingData(ctx, ev); err != nil {
		slog.Error("Failed to publish missing-data event", "device", dev.DeviceID, "err", err)
	}
}

// BuildSNMPRequest returns the list of OIDs to poll (exported for tests).
func BuildSNMPRequest(oidMap []normalizer.OIDMapping) []string {
	return extractOIDs(oidMap)
}

func extractOIDs(oidMap []normalizer.OIDMapping) []string {
	oids := make([]string, len(oidMap))
	for i, m := range oidMap {
		oids[i] = m.OID
	}
	return oids
}

func buildSNMPSession(dev model.Device, community, v3User, v3Auth, v3Priv string,
	timeout time.Duration) *gosnmp.GoSNMP {

	port := dev.SNMPPort
	if port == 0 {
		port = 161
	}

	g := &gosnmp.GoSNMP{
		Target:    dev.IPAddress,
		Port:      port,
		Transport: "udp",
		Timeout:   timeout,
		Retries:   1,
	}

	if dev.SNMPVersion == "v3" && v3User != "" {
		g.Version = gosnmp.Version3
		g.SecurityModel = gosnmp.UserSecurityModel
		g.MsgFlags = gosnmp.AuthPriv
		g.SecurityParameters = &gosnmp.UsmSecurityParameters{
			UserName:                 v3User,
			AuthenticationProtocol:   gosnmp.SHA,
			AuthenticationPassphrase: v3Auth,
			PrivacyProtocol:          gosnmp.AES,
			PrivacyPassphrase:        v3Priv,
		}
	} else {
		g.Version = gosnmp.Version2c
		g.Community = community
	}
	return g
}

// FormatKafkaMessage serialises a RawKPI to JSON for the Kafka message value.
func FormatKafkaMessage(kpi *model.RawKPI) ([]byte, error) {
	return json.Marshal(kpi)
}
