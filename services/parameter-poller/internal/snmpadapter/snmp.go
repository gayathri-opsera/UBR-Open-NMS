// Package snmpadapter provides a minimal SNMPv2c GET adapter for the parameter poller.
//
// It implements the poller.AdapterClient interface using a pure-Go, zero-dependency
// SNMPv2c GET implementation (BER/DER encoding inline). Only GetRequest is supported
// — the poller is read-only by design.
//
// Concurrency: each Get call opens and closes its own UDP socket so multiple goroutines
// may call Get concurrently without sharing state.
//
// Security: no credential material is logged. Community strings are passed as opaque
// parameters and must never appear in parameter value records.
package snmpadapter

import (
	"context"
	"encoding/binary"
	"fmt"
	"math/rand"
	"net"
	"strconv"
	"strings"
	"time"
)

// Adapter is a read-only SNMPv2c adapter that performs GET requests over UDP.
type Adapter struct {
	community string
	port      uint16
	timeout   time.Duration
}

// New creates a new SNMP adapter.
//   - community is the SNMPv2c community string (e.g. "public").
//   - port is the UDP port (usually 161; the test simulator listens on 1161).
//   - timeout is the per-request deadline.
func New(community string, port uint16, timeout time.Duration) *Adapter {
	if timeout <= 0 {
		timeout = 5 * time.Second
	}
	return &Adapter{community: community, port: port, timeout: timeout}
}

// Get performs an SNMPv2c GetRequest for the given OIDs against target (IP or hostname).
// Returns a map of OID → string value for each successfully retrieved OID.
// OIDs not found or that produced an error are omitted from the result.
//
// Implements poller.AdapterClient.
func (a *Adapter) Get(ctx context.Context, target string, keys []string) (map[string]string, error) {
	if len(keys) == 0 {
		return map[string]string{}, nil
	}

	addr := net.JoinHostPort(target, strconv.Itoa(int(a.port)))

	deadline, ok := ctx.Deadline()
	if !ok {
		deadline = time.Now().Add(a.timeout)
	}

	conn, err := net.DialUDP("udp", nil, resolveUDP(addr))
	if err != nil {
		return nil, fmt.Errorf("snmp: dial %s: %w", addr, err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(deadline)

	reqID := rand.Int31() //nolint:gosec — non-cryptographic request ID
	pkt, err := buildGetRequest(a.community, reqID, keys)
	if err != nil {
		return nil, fmt.Errorf("snmp: build request: %w", err)
	}

	if _, err := conn.Write(pkt); err != nil {
		return nil, fmt.Errorf("snmp: write: %w", err)
	}

	buf := make([]byte, 65535)
	n, err := conn.Read(buf)
	if err != nil {
		return nil, fmt.Errorf("snmp: read response: %w", err)
	}

	return parseGetResponse(buf[:n])
}

// resolveUDP resolves addr to a UDP address, panicking on bad input (callers control addr).
func resolveUDP(addr string) *net.UDPAddr {
	a, err := net.ResolveUDPAddr("udp", addr)
	if err != nil {
		panic(fmt.Sprintf("snmpadapter: invalid address %q: %v", addr, err))
	}
	return a
}

// ── BER / ASN.1 encoding ────────────────────────────────────────────────────

// tlv encodes a tag-length-value triplet in BER short-form.
func tlv(tag byte, value []byte) []byte {
	n := len(value)
	var hdr []byte
	if n < 128 {
		hdr = []byte{tag, byte(n)}
	} else if n < 256 {
		hdr = []byte{tag, 0x81, byte(n)}
	} else {
		hdr = []byte{tag, 0x82, byte(n >> 8), byte(n)}
	}
	return append(hdr, value...)
}

// encodeInt encodes a Go int32 as BER INTEGER bytes (positive, unsigned-safe).
func encodeInt(v int32) []byte {
	if v == 0 {
		return []byte{0x00}
	}
	var b [4]byte
	binary.BigEndian.PutUint32(b[:], uint32(v))
	// Strip leading zero bytes (but keep at least one)
	i := 0
	for i < 3 && b[i] == 0 && b[i+1]&0x80 == 0 {
		i++
	}
	return b[i:]
}

// encodeOID encodes a dotted-decimal OID string to BER bytes.
func encodeOID(oid string) ([]byte, error) {
	oid = strings.TrimPrefix(oid, ".")
	parts := strings.Split(oid, ".")
	if len(parts) < 2 {
		return nil, fmt.Errorf("OID too short: %q", oid)
	}
	nums := make([]int64, len(parts))
	for i, p := range parts {
		n, err := strconv.ParseInt(p, 10, 64)
		if err != nil {
			return nil, fmt.Errorf("OID part %q: %w", p, err)
		}
		nums[i] = n
	}
	first := nums[0]*40 + nums[1]
	var buf []byte
	for _, n := range append([]int64{first}, nums[2:]...) {
		if n < 128 {
			buf = append(buf, byte(n))
		} else {
			var tmp []byte
			tmp = append(tmp, byte(n&0x7F))
			n >>= 7
			for n > 0 {
				tmp = append(tmp, byte(n&0x7F)|0x80)
				n >>= 7
			}
			// Reverse tmp
			for l, r := 0, len(tmp)-1; l < r; l, r = l+1, r-1 {
				tmp[l], tmp[r] = tmp[r], tmp[l]
			}
			buf = append(buf, tmp...)
		}
	}
	return buf, nil
}

// buildGetRequest constructs a minimal SNMPv2c GetRequest packet.
func buildGetRequest(community string, reqID int32, oids []string) ([]byte, error) {
	// Version: INTEGER 1 (= SNMPv2c)
	ver := tlv(0x02, []byte{0x01})
	// Community: OctetString
	comm := tlv(0x04, []byte(community))

	// Build varbind list: each varbind is SEQUENCE { OID, NULL }
	var varbinds []byte
	for _, oid := range oids {
		oidBytes, err := encodeOID(oid)
		if err != nil {
			return nil, err
		}
		oidTlv := tlv(0x06, oidBytes)
		null := []byte{0x05, 0x00}
		varbind := tlv(0x30, append(oidTlv, null...))
		varbinds = append(varbinds, varbind...)
	}
	varBindList := tlv(0x30, varbinds)

	// GetRequest PDU: tag 0xa0
	errorStatus := tlv(0x02, []byte{0x00})
	errorIndex  := tlv(0x02, []byte{0x00})
	requestID   := tlv(0x02, encodeInt(reqID))
	pdu := tlv(0xa0, append(requestID, append(errorStatus, append(errorIndex, varBindList...)...)...))

	// Top-level SEQUENCE
	msg := tlv(0x30, append(ver, append(comm, pdu...)...))
	return msg, nil
}

// ── Response parsing ─────────────────────────────────────────────────────────

// parseGetResponse extracts OID → string value pairs from a raw SNMP GetResponse packet.
func parseGetResponse(buf []byte) (map[string]string, error) {
	result := make(map[string]string)

	// Unwrap outer SEQUENCE
	if len(buf) < 2 || buf[0] != 0x30 {
		return result, nil
	}
	buf = skipTLVHeader(buf)

	// Skip version INTEGER
	buf = skipField(buf, 0x02)
	// Skip community OctetString
	buf = skipField(buf, 0x04)

	// Expect GetResponse PDU (tag 0xa2)
	if len(buf) < 2 || buf[0] != 0xa2 {
		return result, nil
	}
	buf = skipTLVHeader(buf)

	// Skip requestID, errorStatus, errorIndex
	buf = skipField(buf, 0x02)
	buf = skipField(buf, 0x02)
	buf = skipField(buf, 0x02)

	// VarBindList SEQUENCE
	if len(buf) < 2 || buf[0] != 0x30 {
		return result, nil
	}
	buf = skipTLVHeader(buf)

	// Each varbind: SEQUENCE { OID, Value }
	for len(buf) >= 2 {
		if buf[0] != 0x30 {
			break
		}
		vbBuf := extractContent(buf)
		buf = skipField(buf, 0x30)

		// OID
		oidStr := parseOID(vbBuf)
		vbBuf = skipField(vbBuf, 0x06)
		if vbBuf == nil || len(vbBuf) < 2 {
			continue
		}

		// Value — handle common SNMP types
		valStr := parseValue(vbBuf)
		if oidStr != "" {
			result["."+oidStr] = valStr
		}
	}
	return result, nil
}

// ── BER parsing helpers ──────────────────────────────────────────────────────

func decodeLength(buf []byte) (length int, consumed int) {
	if len(buf) == 0 {
		return 0, 0
	}
	if buf[0] < 128 {
		return int(buf[0]), 1
	}
	numBytes := int(buf[0] & 0x7F)
	if numBytes == 0 || numBytes > 4 || len(buf) < 1+numBytes {
		return 0, 0
	}
	var l int
	for i := 1; i <= numBytes; i++ {
		l = (l << 8) | int(buf[i])
	}
	return l, 1 + numBytes
}

func skipTLVHeader(buf []byte) []byte {
	if len(buf) < 2 {
		return nil
	}
	_, lc := decodeLength(buf[1:])
	skip := 1 + lc
	if skip >= len(buf) {
		return nil
	}
	return buf[skip:]
}

func extractContent(buf []byte) []byte {
	if len(buf) < 2 {
		return nil
	}
	l, lc := decodeLength(buf[1:])
	start := 1 + lc
	if start+l > len(buf) {
		return nil
	}
	return buf[start : start+l]
}

func skipField(buf []byte, expectedTag byte) []byte {
	if len(buf) < 2 || buf[0] != expectedTag {
		return buf
	}
	l, lc := decodeLength(buf[1:])
	skip := 1 + lc + l
	if skip > len(buf) {
		return nil
	}
	return buf[skip:]
}

func parseOID(buf []byte) string {
	if len(buf) < 2 || buf[0] != 0x06 {
		return ""
	}
	l, lc := decodeLength(buf[1:])
	content := buf[1+lc : 1+lc+l]
	if len(content) == 0 {
		return ""
	}
	// First octet encodes first two components
	first := int(content[0])
	parts := []string{strconv.Itoa(first / 40), strconv.Itoa(first % 40)}
	i := 1
	for i < len(content) {
		var n int
		for i < len(content) {
			b := content[i]
			i++
			n = (n << 7) | int(b&0x7F)
			if b&0x80 == 0 {
				break
			}
		}
		parts = append(parts, strconv.Itoa(n))
	}
	return strings.Join(parts, ".")
}

func parseValue(buf []byte) string {
	if len(buf) < 2 {
		return ""
	}
	tag := buf[0]
	l, lc := decodeLength(buf[1:])
	if 1+lc+l > len(buf) {
		return ""
	}
	content := buf[1+lc : 1+lc+l]

	switch tag {
	case 0x02: // INTEGER
		var n int64
		for _, b := range content {
			n = (n << 8) | int64(b)
		}
		return strconv.FormatInt(n, 10)
	case 0x04: // OctetString
		return string(content)
	case 0x06: // OID (nested)
		return parseOID(buf)
	case 0x43: // TimeTicks — unsigned 32-bit counter (centiseconds since sysUpTime)
		var n uint32
		for _, b := range content {
			n = (n << 8) | uint32(b)
		}
		return strconv.FormatUint(uint64(n), 10)
	case 0x41: // Counter32
		var n uint32
		for _, b := range content {
			n = (n << 8) | uint32(b)
		}
		return strconv.FormatUint(uint64(n), 10)
	case 0x42: // Gauge32
		var n uint32
		for _, b := range content {
			n = (n << 8) | uint32(b)
		}
		return strconv.FormatUint(uint64(n), 10)
	case 0x46: // Counter64
		var n uint64
		for _, b := range content {
			n = (n << 8) | uint64(b)
		}
		return strconv.FormatUint(n, 10)
	default:
		// Unknown type: return hex representation
		return fmt.Sprintf("0x%x", content)
	}
}
