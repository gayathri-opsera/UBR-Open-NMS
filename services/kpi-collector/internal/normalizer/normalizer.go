// Package normalizer converts raw SNMP PDU values to the canonical RawKPI model.
package normalizer

import (
	"github.com/gosnmp/gosnmp"
	"github.com/ubrnms/kpi-collector/internal/model"
)

// OIDMapping maps a KPI field name to a vendor-specific SNMP OID.
type OIDMapping struct {
	Field string
	OID   string
}

// DefaultOIDs contains the standard Mycom KPI OID mappings.
var DefaultOIDs = []OIDMapping{
	{Field: "rssi",              OID: ".1.3.6.1.4.1.12345.1.1.1"},
	{Field: "snr",               OID: ".1.3.6.1.4.1.12345.1.1.2"},
	{Field: "operatingChannel",  OID: ".1.3.6.1.4.1.12345.1.1.3"},
	{Field: "channelUtil",       OID: ".1.3.6.1.4.1.12345.1.1.4"},
	{Field: "bandwidth",         OID: ".1.3.6.1.4.1.12345.1.1.5"},
	{Field: "mcs",               OID: ".1.3.6.1.4.1.12345.1.1.6"},
	{Field: "txPower",           OID: ".1.3.6.1.4.1.12345.1.1.7"},
	{Field: "throughputUL",      OID: ".1.3.6.1.4.1.12345.1.2.1"},
	{Field: "throughputDL",      OID: ".1.3.6.1.4.1.12345.1.2.2"},
	{Field: "txPackets",         OID: ".1.3.6.1.2.1.2.2.1.17.1"},
	{Field: "rxPackets",         OID: ".1.3.6.1.2.1.2.2.1.11.1"},
	{Field: "txBytes",           OID: ".1.3.6.1.2.1.2.2.1.16.1"},
	{Field: "rxBytes",           OID: ".1.3.6.1.2.1.2.2.1.10.1"},
	{Field: "packetsDropped",    OID: ".1.3.6.1.2.1.2.2.1.19.1"},
	{Field: "packetRetransmit",  OID: ".1.3.6.1.4.1.12345.1.2.5"},
	{Field: "crcErrors",         OID: ".1.3.6.1.2.1.2.2.1.20.1"},
	{Field: "latency",           OID: ".1.3.6.1.4.1.12345.1.2.7"},
	{Field: "cpuUtilization",    OID: ".1.3.6.1.4.1.12345.1.3.1"},
	{Field: "freeMemory",        OID: ".1.3.6.1.4.1.12345.1.3.2"},
	{Field: "rebootCount",       OID: ".1.3.6.1.4.1.12345.1.3.3"},
	{Field: "dyingGaspCount",    OID: ".1.3.6.1.4.1.12345.1.3.4"},
}

// Normalize converts a slice of SNMP PDUs into a RawKPI struct.
func Normalize(pdus []gosnmp.SnmpPDU, oidMap []OIDMapping, base *model.RawKPI) *model.RawKPI {
	if base == nil {
		base = &model.RawKPI{}
	}
	if base.Raw == nil {
		base.Raw = make(map[string]interface{})
	}

	// Build reverse OID-to-field map
	rev := make(map[string]string, len(oidMap))
	for _, m := range oidMap {
		rev[m.OID] = m.Field
	}

	for _, pdu := range pdus {
		oid := pdu.Name
		field, ok := rev[oid]
		if !ok {
			base.Raw[oid] = pduValue(pdu)
			continue
		}
		applyField(base, field, pdu)
	}
	return base
}

// pduValue extracts the Go value from an SNMP PDU.
func pduValue(pdu gosnmp.SnmpPDU) interface{} {
	switch pdu.Type {
	case gosnmp.Integer, gosnmp.Gauge32, gosnmp.Counter32, gosnmp.TimeTicks:
		switch v := pdu.Value.(type) {
		case int:   return int64(v)
		case uint:  return int64(v)
		default:    return v
		}
	case gosnmp.Counter64:
		if v, ok := pdu.Value.(uint64); ok {
			return int64(v)
		}
	case gosnmp.OctetString:
		if b, ok := pdu.Value.([]byte); ok {
			return string(b)
		}
	}
	return pdu.Value
}

// applyField maps a field name to the corresponding RawKPI field.
func applyField(kpi *model.RawKPI, field string, pdu gosnmp.SnmpPDU) {
	v := pduValue(pdu)

	float64Ptr := func(val interface{}) *float64 {
		switch n := val.(type) {
		case int64:  f := float64(n); return &f
		case float64: return &n
		}
		return nil
	}
	int64Ptr := func(val interface{}) *int64 {
		if n, ok := val.(int64); ok { return &n }
		return nil
	}
	intPtr := func(val interface{}) *int {
		if n, ok := val.(int64); ok { i := int(n); return &i }
		return nil
	}

	switch field {
	case "rssi":             kpi.RSSI = float64Ptr(v)
	case "snr":              kpi.SNR = float64Ptr(v)
	case "operatingChannel": kpi.OperatingChannel = intPtr(v)
	case "channelUtil":      kpi.ChannelUtilization = float64Ptr(v)
	case "bandwidth":        kpi.Bandwidth = intPtr(v)
	case "mcs":              kpi.MCS = intPtr(v)
	case "txPower":          kpi.TxPower = float64Ptr(v)
	case "throughputUL":     kpi.ThroughputUL = float64Ptr(v)
	case "throughputDL":     kpi.ThroughputDL = float64Ptr(v)
	case "txPackets":        kpi.TxPackets = int64Ptr(v)
	case "rxPackets":        kpi.RxPackets = int64Ptr(v)
	case "txBytes":          kpi.TxBytes = int64Ptr(v)
	case "rxBytes":          kpi.RxBytes = int64Ptr(v)
	case "packetsDropped":   kpi.PacketsDropped = int64Ptr(v)
	case "packetRetransmit": kpi.PacketRetransmit = int64Ptr(v)
	case "crcErrors":        kpi.CRCErrors = int64Ptr(v)
	case "latency":          kpi.Latency = float64Ptr(v)
	case "cpuUtilization":   kpi.CPUUtilization = float64Ptr(v)
	case "freeMemory":       kpi.FreeMemory = int64Ptr(v)
	case "rebootCount":      kpi.RebootCount = int64Ptr(v)
	case "dyingGaspCount":   kpi.DyingGaspCount = int64Ptr(v)
	default:
		kpi.Raw[field] = v
	}
}
