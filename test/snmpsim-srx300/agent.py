#!/usr/bin/env python3
"""
Juniper SRX300 Firewall — SNMP Simulator

Pure-Python SNMPv1/v2c agent simulating a Juniper SRX300 Series firewall.
Matches the fingerprints in juniper-srx300-firewall.xml:
  sysObjectID:     .1.3.6.1.4.1.2636.1.1.1.2.151
  sysDescrPattern: .*Juniper.*SRX300.*

Env vars:
  SNMP_PORT      = UDP port to bind (default 1168)
  SNMP_COMMUNITY = community string (default "public")
  DEVICE_NAME    = hostname (default "srx300-fw-01")
  DEVICE_IP      = IP to report (default "192.168.100.30")

Enterprise OID base:  .1.3.6.1.4.1.2636  (Juniper Networks)
sysObjectID:          .1.3.6.1.4.1.2636.1.1.1.2.151
productDefinitionId:  juniper-srx300-firewall

Test from host:
  snmpget -v2c -c public -p 1168 localhost 1.3.6.1.2.1.1.2.0
  snmpget -v2c -c public -p 1168 localhost 1.3.6.1.2.1.1.1.0
  snmpwalk -v2c -c public -p 1168 localhost 1.3.6.1.4.1.2636
"""

import os
import socket
import struct
import time
import logging
import sys
import math
import random

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    stream=sys.stdout,
)
log = logging.getLogger("srx300-snmp")

PORT       = int(os.environ.get("SNMP_PORT",      "1168"))
COMMUNITY  = os.environ.get("SNMP_COMMUNITY",     "public").encode()
DEV_NAME   = os.environ.get("DEVICE_NAME",        "srx300-fw-01")
DEV_IP     = os.environ.get("DEVICE_IP",          "192.168.100.30")
START_TIME = time.time()

# ── Enterprise OID ───────────────────────────────────────────────────────────
SYS_OID = "1.3.6.1.4.1.2636.1.1.1.2.151"   # SRX300 — matches XML fingerprint

# ── Simulated values (realistic for a small branch firewall) ─────────────────
CPU_UTIL         = 18      # % routing engine CPU
CHASSIS_TEMP     = 42      # Celsius — healthy
ACTIVE_SESSIONS  = 1247    # current security sessions
MAX_SESSIONS     = 131072  # SRX300 max (128k)
IKE_SA_COUNT     = 3       # IKE SAs (3 VPN tunnels)
IPSEC_SA_COUNT   = 3       # IPsec SAs
IF_IN_OCTETS     = 2_847_293_104
IF_OUT_OCTETS    = 1_593_847_921

# ── BER encode helpers ───────────────────────────────────────────────────────

def _len(n):
    if n < 0x80:
        return bytes([n])
    elif n < 0x100:
        return bytes([0x81, n])
    else:
        return bytes([0x82, (n >> 8) & 0xFF, n & 0xFF])

def tlv(tag, val):
    return bytes([tag]) + _len(len(val)) + val

def encode_int(v):
    if v == 0:
        return tlv(0x02, b'\x00')
    bs = []
    while v:
        bs.append(v & 0xFF)
        v >>= 8
    bs.reverse()
    if bs[0] & 0x80:
        bs.insert(0, 0x00)
    return tlv(0x02, bytes(bs))

def encode_uint32(v):
    v = int(v) & 0xFFFFFFFF
    return tlv(0x42, v.to_bytes(4, 'big'))   # Counter32 / Gauge32

def encode_uint64(v):
    v = int(v) & 0xFFFFFFFFFFFFFFFF
    return tlv(0x46, v.to_bytes(8, 'big'))   # Counter64

def encode_str(s):
    if isinstance(s, str):
        s = s.encode()
    return tlv(0x04, s)

def encode_oid(oid_str):
    parts = [int(x) for x in oid_str.lstrip('.').split('.')]
    first = parts[0] * 40 + parts[1]
    encoded = []
    for p in [first] + parts[2:]:
        if p < 128:
            encoded.append(p)
        else:
            bs = []
            while p:
                bs.append(p & 0x7F)
                p >>= 7
            bs.reverse()
            for i, b in enumerate(bs):
                encoded.append(b | (0x80 if i < len(bs) - 1 else 0))
    return tlv(0x06, bytes(encoded))

def encode_timeticks(secs):
    ticks = int(secs * 100) & 0xFFFFFFFF
    return tlv(0x43, ticks.to_bytes(4, 'big'))

def encode_null():
    return b'\x05\x00'

def varbind(oid, val_bytes):
    inner = encode_oid(oid) + val_bytes
    return tlv(0x30, inner)

def sequence(data):
    return tlv(0x30, data)

# ── OID database ─────────────────────────────────────────────────────────────

def uptime_ticks():
    return encode_timeticks(time.time() - START_TIME)

def jitter(base, pct=0.05):
    """Add ±5% noise to simulate real readings."""
    return int(base * (1 + random.uniform(-pct, pct)))

def build_oid_db():
    up = time.time() - START_TIME
    return {
        # ── MIB-II system group ──────────────────────────────────────────────
        "1.3.6.1.2.1.1.1.0": encode_str(
            f"Juniper Networks, Inc. srx300 internet router, kernel JUNOS 21.4R3-S4.8, "
            f"Build date: 2023-06-15 16:00:00 UTC "
            f"Copyright (c) 1996-2023 Juniper Networks, Inc."
        ),
        "1.3.6.1.2.1.1.2.0": encode_oid(SYS_OID),
        "1.3.6.1.2.1.1.3.0": uptime_ticks(),
        "1.3.6.1.2.1.1.4.0": encode_str("noc@ubrnms.local"),
        "1.3.6.1.2.1.1.5.0": encode_str(DEV_NAME),
        "1.3.6.1.2.1.1.6.0": encode_str("UBR NMS Test Lab - Edge Rack"),

        # ── Interface table (ifTable) — 2 entries ────────────────────────────
        # ge-0/0/0 inbound octets
        "1.3.6.1.2.1.2.2.1.10.1": encode_uint32(IF_IN_OCTETS + jitter(100000)),
        "1.3.6.1.2.1.2.2.1.10.2": encode_uint32(int(IF_IN_OCTETS * 0.3) + jitter(50000)),
        # ge-0/0/0 outbound octets
        "1.3.6.1.2.1.2.2.1.16.1": encode_uint32(IF_OUT_OCTETS + jitter(80000)),
        "1.3.6.1.2.1.2.2.1.16.2": encode_uint32(int(IF_OUT_OCTETS * 0.2) + jitter(30000)),

        # ── Juniper enterprise — CPU ─────────────────────────────────────────
        # jnxOperatingCPU (routing engine, slot 0, fpc 9, pic 1)
        "1.3.6.1.4.1.2636.3.1.13.1.8.9.1.0.0": encode_int(jitter(CPU_UTIL, 0.15)),

        # ── Juniper enterprise — Temperature ─────────────────────────────────
        # jnxOperatingTemp
        "1.3.6.1.4.1.2636.3.1.13.1.7.9.1.0.0": encode_int(jitter(CHASSIS_TEMP, 0.04)),

        # ── Juniper enterprise — Security sessions ───────────────────────────
        # jnxJsSPUMonitoringSPUActiveSessions
        "1.3.6.1.4.1.2636.3.39.1.12.1.1.1.2.0": encode_uint32(jitter(ACTIVE_SESSIONS, 0.1)),
        # jnxJsSPUMonitoringSPUMaxSessions
        "1.3.6.1.4.1.2636.3.39.1.12.1.1.1.3.0": encode_uint32(MAX_SESSIONS),

        # ── Juniper enterprise — VPN / IKE ───────────────────────────────────
        # jnxIkeTotalActiveTunnels
        "1.3.6.1.4.1.2636.3.52.1.1.1.1.0": encode_uint32(IKE_SA_COUNT),
        # jnxIpsecTotalActiveTunnels
        "1.3.6.1.4.1.2636.3.52.1.1.2.1.0": encode_uint32(IPSEC_SA_COUNT),
    }

SORTED_OIDS = []

def refresh_db():
    global SORTED_OIDS
    db = build_oid_db()
    SORTED_OIDS = sorted(db.keys(), key=lambda o: [int(x) for x in o.split('.')])
    return db

# ── SNMP packet parser / builder ──────────────────────────────────────────────

def parse_length(data, pos):
    b = data[pos]; pos += 1
    if b < 0x80:
        return b, pos
    n = b & 0x7F
    length = int.from_bytes(data[pos:pos+n], 'big')
    return length, pos + n

def parse_oid(data):
    parts = []
    first = data[0]
    parts += [first // 40, first % 40]
    i = 1
    while i < len(data):
        val = 0
        while True:
            b = data[i]; i += 1
            val = (val << 7) | (b & 0x7F)
            if not (b & 0x80):
                break
        parts.append(val)
    return '.'.join(str(p) for p in parts)

def parse_varbinds(data):
    oids = []
    pos = 0
    while pos < len(data):
        # SEQUENCE
        pos += 1
        seq_len, pos = parse_length(data, pos)
        end = pos + seq_len
        # OID
        pos += 1
        oid_len, pos = parse_length(data, pos)
        oid = parse_oid(data[pos:pos+oid_len])
        oids.append(oid)
        pos = end
    return oids

def build_response(req_id, oids, db):
    varbinds_bytes = b''
    for oid in oids:
        val = db.get(oid)
        if val is None:
            val = encode_null()
        varbinds_bytes += varbind(oid, val)

    varbind_list = tlv(0x30, varbinds_bytes)
    pdu_inner = (
        encode_int(req_id) +
        encode_int(0) +          # error-status
        encode_int(0) +          # error-index
        varbind_list
    )
    pdu = tlv(0xA2, pdu_inner)  # GetResponse-PDU

    msg = (
        encode_int(1) +          # version = v2c
        encode_str(COMMUNITY) +
        pdu
    )
    return sequence(msg)

def next_oid(oid):
    """Return the lexicographically next OID in our table."""
    for i, o in enumerate(SORTED_OIDS):
        if o > oid:
            return o
    return None

def build_getnext_response(req_id, oids, db):
    varbinds_bytes = b''
    for oid in oids:
        noid = next_oid(oid)
        if noid is None:
            varbinds_bytes += varbind(oid, encode_null())
        else:
            varbinds_bytes += varbind(noid, db.get(noid, encode_null()))
    varbind_list = tlv(0x30, varbinds_bytes)
    pdu_inner = (
        encode_int(req_id) +
        encode_int(0) +
        encode_int(0) +
        varbind_list
    )
    pdu = tlv(0xA2, pdu_inner)
    msg = encode_int(1) + encode_str(COMMUNITY) + pdu
    return sequence(msg)

# ── Main loop ─────────────────────────────────────────────────────────────────

def main():
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind(("0.0.0.0", PORT))
    log.info(f"Juniper SRX300 SNMP agent listening on UDP 0.0.0.0:{PORT} (community={COMMUNITY.decode()})")
    log.info(f"  sysObjectID : .{SYS_OID}")
    log.info(f"  sysDescr    : Juniper Networks, Inc. srx300 internet router, kernel JUNOS 21.4R3-S4.8")
    log.info(f"  hostname    : {DEV_NAME}")
    log.info(f"  OIDs served : {len(build_oid_db())}")

    LAST_REFRESH = time.time()

    while True:
        data, addr = sock.recvfrom(4096)
        db = refresh_db()

        try:
            pos = 0
            # Outer SEQUENCE
            pos += 1
            _, pos = parse_length(data, pos)
            # version
            pos += 1; vl, pos = parse_length(data, pos); pos += vl
            # community
            pos += 1; cl, pos = parse_length(data, pos)
            comm = data[pos:pos+cl]; pos += cl
            if comm != COMMUNITY:
                log.warning(f"Wrong community from {addr}: {comm}")
                continue
            # PDU type
            pdu_type = data[pos]; pos += 1
            _, pos = parse_length(data, pos)
            # request-id
            pos += 1; rl, pos = parse_length(data, pos)
            req_id = int.from_bytes(data[pos:pos+rl], 'big', signed=True); pos += rl
            # error-status, error-index
            pos += 1; el, pos = parse_length(data, pos); pos += el
            pos += 1; ei, pos = parse_length(data, pos); pos += ei
            # varbind list SEQUENCE
            pos += 1; vbl, pos = parse_length(data, pos)
            oids = parse_varbinds(data[pos:pos+vbl])

            if pdu_type == 0xA0:   # GetRequest
                log.info(f"GET from {addr}: {oids}")
                resp = build_response(req_id, oids, db)
            elif pdu_type == 0xA1:  # GetNextRequest
                log.info(f"GETNEXT from {addr}: {oids}")
                resp = build_getnext_response(req_id, oids, db)
            elif pdu_type == 0xA5:  # GetBulkRequest
                log.info(f"GETBULK from {addr}: {oids}")
                resp = build_getnext_response(req_id, oids, db)
            else:
                log.warning(f"Unsupported PDU type 0x{pdu_type:02x} from {addr}")
                continue

            sock.sendto(resp, addr)
        except Exception as e:
            log.error(f"Parse error from {addr}: {e}")

if __name__ == "__main__":
    main()
