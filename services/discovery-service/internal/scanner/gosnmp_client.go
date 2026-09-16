// Package scanner — real SNMP GET client backed by gosnmp.
//
// GoSNMPClient implements the SNMPClient interface using the gosnmp library
// for SNMPv1 and SNMPv2c GET requests over UDP port 161 (default).
//
// Security constraints:
//   - Community strings are never included in log output.
//   - One UDP connection is opened per GetOIDs call and closed immediately after.
//   - Timeout is enforced via context deadline; gosnmp's internal timeout mirrors it.
package scanner

import (
	"context"
	"encoding/hex"
	"fmt"
	"strings"
	"time"

	"github.com/gosnmp/gosnmp"
)

// ── OID constants ──────────────────────────────────────────────────────────────

// ifPhysAddressPrefix is the SNMP table OID for interface physical (MAC) addresses.
// Walking this prefix returns one entry per interface index.
// RFC 2863 IF-MIB: 1.3.6.1.2.1.2.2.1.6.<ifIndex>
const ifPhysAddressPrefix = ".1.3.6.1.2.1.2.2.1.6"

// MACWalker is an optional interface that SNMP clients may implement to support
// BulkWalk operations.  SNMPFingerprinter and its tests only rely on SNMPClient
// (GetOIDs), so adding MACWalker as a separate interface keeps the tests green.
type MACWalker interface {
	// WalkOID issues an SNMP BulkWalk from rootOID and returns all (OID, value) pairs
	// beneath that subtree.  The caller receives raw byte values; callers that need
	// formatted MAC strings should use FormatMAC.
	WalkOID(ctx context.Context, host string, rootOID string) ([]WalkEntry, error)
}

// WalkEntry is a single (OID, raw-bytes) pair returned by WalkOID.
type WalkEntry struct {
	OID   string
	Bytes []byte
}

// FormatMAC converts 6 raw bytes to a colon-separated MAC string (e.g. "00:1A:2B:3C:4D:5E").
// Returns "" for zero-length, nil, or all-zeros inputs.
func FormatMAC(b []byte) string {
	if len(b) != 6 {
		return ""
	}
	allZero := true
	for _, v := range b {
		if v != 0 {
			allZero = false
			break
		}
	}
	if allZero {
		return ""
	}
	return strings.ToUpper(hex.EncodeToString(b[:1])) + ":" +
		strings.ToUpper(hex.EncodeToString(b[1:2])) + ":" +
		strings.ToUpper(hex.EncodeToString(b[2:3])) + ":" +
		strings.ToUpper(hex.EncodeToString(b[3:4])) + ":" +
		strings.ToUpper(hex.EncodeToString(b[4:5])) + ":" +
		strings.ToUpper(hex.EncodeToString(b[5:6]))
}

// FetchChassisMAC walks ifPhysAddress on the target host and returns the first
// non-zero 6-byte MAC address found (formatted as XX:XX:XX:XX:XX:XX).
// Returns ("", nil) when the client does not implement MACWalker or when no
// non-zero MAC is present — this is intentionally non-fatal.
func FetchChassisMAC(ctx context.Context, client SNMPClient, host string) string {
	walker, ok := client.(MACWalker)
	if !ok {
		return ""
	}
	entries, err := walker.WalkOID(ctx, host, ifPhysAddressPrefix)
	if err != nil {
		// Non-fatal: log at debug level; caller continues with empty MAC.
		return ""
	}
	for _, e := range entries {
		if mac := FormatMAC(e.Bytes); mac != "" {
			return mac
		}
	}
	return ""
}

// GoSNMPClient is a production SNMPClient backed by gosnmp.
// Community strings are set at construction time and never exposed through any method.
type GoSNMPClient struct {
	community string
	port      uint16
	version   gosnmp.SnmpVersion
	timeout   time.Duration
}

// NewGoSNMPClient constructs a GoSNMPClient for v1/v2c community-based access.
//
// protocolHint maps to gosnmp versions:
//   - "SNMP_V1", "v1", "1"  → SNMPv1
//   - "" or anything else   → SNMPv2c (default, recommended)
//
// port defaults to 161 when 0.
// timeout defaults to 5 s when ≤ 0.
func NewGoSNMPClient(community, protocolHint string, port uint16, timeout time.Duration) *GoSNMPClient {
	version := gosnmp.Version2c
	switch strings.ToUpper(protocolHint) {
	case "SNMP_V1", "V1", "1":
		version = gosnmp.Version1
	}
	if port == 0 {
		port = 161
	}
	if timeout <= 0 {
		timeout = 5 * time.Second
	}
	return &GoSNMPClient{
		community: community,
		port:      port,
		version:   version,
		timeout:   timeout,
	}
}

// GetOIDs opens a UDP SNMP session, issues a single GET for all requested OIDs,
// and returns a map of OID → string value. The OID keys in the returned map are
// normalised to include a leading dot (e.g. ".1.3.6.1.2.1.1.1.0").
//
// Errors propagate the gosnmp error message so classifyError in snmp_fingerprinter.go
// can categorise them (timeout, auth, version, etc.).
func (c *GoSNMPClient) GetOIDs(ctx context.Context, host string, oids []string) (map[string]string, error) {
	// Derive a per-request timeout from the context deadline (if set) or the
	// configured client timeout, whichever is shorter.
	clientTimeout := c.timeout
	if dl, ok := ctx.Deadline(); ok {
		remaining := time.Until(dl)
		if remaining > 0 && remaining < clientTimeout {
			clientTimeout = remaining
		}
	}

	// Strip leading dots — gosnmp accepts both but normalise for consistency.
	normalised := make([]string, len(oids))
	for i, oid := range oids {
		normalised[i] = strings.TrimPrefix(oid, ".")
	}

	// Build a per-request GoSNMP session. Sessions are NOT reused across calls
	// because FingerprintBatch runs hosts concurrently from separate goroutines.
	g := &gosnmp.GoSNMP{
		Target:    host,
		Port:      c.port,
		Community: c.community,
		Version:   c.version,
		Timeout:   clientTimeout,
		// Retries are handled by SNMPFingerprinter's retry loop; set to 0 here.
		Retries: 0,
		// Suppress gosnmp's own log output; the fingerprinter logs at the right level.
		Logger: gosnmp.NewLogger(&silentLogger{}),
	}

	if err := g.Connect(); err != nil {
		return nil, fmt.Errorf("snmp connect to %s: %w", host, err)
	}
	defer g.Conn.Close()

	// Check context before issuing the GET — skip if already cancelled.
	select {
	case <-ctx.Done():
		return nil, fmt.Errorf("snmp context timeout before GET: %w", ctx.Err())
	default:
	}

	result, err := g.Get(normalised)
	if err != nil {
		return nil, fmt.Errorf("snmp get: %w", err)
	}

	values := make(map[string]string, len(result.Variables))
	for _, pdu := range result.Variables {
		// Normalise OID key to always have a leading dot.
		key := pdu.Name
		if !strings.HasPrefix(key, ".") {
			key = "." + key
		}
		values[key] = pduValueToString(pdu)
	}
	return values, nil
}

// pduValueToString converts a gosnmp PDU value to its string representation.
// TimeTicks are returned as decimal ticks (hundredths of a second) to match the
// parseSysUpTime function in snmp_fingerprinter.go.
func pduValueToString(pdu gosnmp.SnmpPDU) string {
	switch pdu.Type {
	case gosnmp.OctetString:
		if bs, ok := pdu.Value.([]byte); ok {
			return string(bs)
		}
	case gosnmp.ObjectIdentifier:
		if s, ok := pdu.Value.(string); ok {
			return s
		}
	case gosnmp.TimeTicks:
		if v, ok := pdu.Value.(uint32); ok {
			return fmt.Sprintf("%d", v)
		}
	case gosnmp.Integer:
		return fmt.Sprintf("%d", gosnmp.ToBigInt(pdu.Value))
	case gosnmp.Gauge32, gosnmp.Counter32, gosnmp.Counter64:
		return fmt.Sprintf("%d", gosnmp.ToBigInt(pdu.Value))
	case gosnmp.IPAddress:
		if s, ok := pdu.Value.(string); ok {
			return s
		}
	case gosnmp.NoSuchObject, gosnmp.NoSuchInstance, gosnmp.EndOfMibView:
		// OID not supported by agent — return empty so caller can handle gracefully.
		return ""
	}
	return fmt.Sprintf("%v", pdu.Value)
}

// silentLogger discards all gosnmp internal log output.
// The fingerprinter layer already emits structured log events at the right level.
type silentLogger struct{}

func (l *silentLogger) Print(v ...interface{})                 {}
func (l *silentLogger) Printf(format string, v ...interface{}) {}

// WalkOID issues an SNMP BulkWalk from rootOID and returns all sub-tree entries
// as WalkEntry values carrying the raw PDU bytes.  OctetString PDUs are returned
// as-is so that MAC addresses remain as 6-byte slices rather than being coerced
// to ASCII strings (which would corrupt non-printable bytes).
//
// Implements MACWalker so FetchChassisMAC can use this client.
func (c *GoSNMPClient) WalkOID(ctx context.Context, host string, rootOID string) ([]WalkEntry, error) {
	clientTimeout := c.timeout
	if dl, ok := ctx.Deadline(); ok {
		if remaining := time.Until(dl); remaining > 0 && remaining < clientTimeout {
			clientTimeout = remaining
		}
	}

	g := &gosnmp.GoSNMP{
		Target:    host,
		Port:      c.port,
		Community: c.community,
		Version:   c.version,
		Timeout:   clientTimeout,
		Retries:   0,
		Logger:    gosnmp.NewLogger(&silentLogger{}),
	}
	if err := g.Connect(); err != nil {
		return nil, fmt.Errorf("snmp walk connect to %s: %w", host, err)
	}
	defer g.Conn.Close()

	select {
	case <-ctx.Done():
		return nil, fmt.Errorf("snmp walk context cancelled: %w", ctx.Err())
	default:
	}

	stripped := strings.TrimPrefix(rootOID, ".")
	pdus, err := g.BulkWalkAll(stripped)
	if err != nil {
		return nil, fmt.Errorf("snmp bulkwalk %s: %w", rootOID, err)
	}

	entries := make([]WalkEntry, 0, len(pdus))
	for _, pdu := range pdus {
		oid := pdu.Name
		if !strings.HasPrefix(oid, ".") {
			oid = "." + oid
		}
		// Preserve raw bytes for OctetString — MAC addresses must not be coerced to ASCII.
		var raw []byte
		if pdu.Type == gosnmp.OctetString {
			if bs, ok := pdu.Value.([]byte); ok {
				raw = bs
			}
		}
		entries = append(entries, WalkEntry{OID: oid, Bytes: raw})
	}
	return entries, nil
}

// Confirm GoSNMPClient satisfies both SNMPClient and MACWalker at compile time.
var _ SNMPClient = (*GoSNMPClient)(nil)
var _ MACWalker  = (*GoSNMPClient)(nil)
