#!/usr/bin/env python3
"""
UBR NMS SNMP Test Agent — Cisco Simulation

A pure-Python SNMPv1/v2c agent that simulates a Cisco IOS network switch.
Listens on UDP 1161 — no root or NET_BIND_SERVICE needed.
Assigned static IP 10.10.10.25 in docker-compose.dev.yml (snmp-test-net).

MIB-II system group values served:
  sysDescr   (.1.3.6.1.2.1.1.1.0): Cisco IOS Software, Version 15.2(7)E1 ...
  sysObjectID(.1.3.6.1.2.1.1.2.0): .1.3.6.1.4.1.9.1.1  ← Cisco (enterprise OID)
  sysUpTime  (.1.3.6.1.2.1.1.3.0): live timeticks
  sysContact (.1.3.6.1.2.1.1.4.0): network-admin@ubrnms.local
  sysName    (.1.3.6.1.2.1.1.5.0): cisco-sw-core-01
  sysLocation(.1.3.6.1.2.1.1.6.0): UBR NMS Test Lab — Rack 1

Community string: "public" (read-only)

The UBR NMS classifier maps sysObjectID .1.3.6.1.4.1.9.* to:
  Vendor: Cisco  |  Model: IOS Switch  |  GenericDeviceType: SWITCH
"""

import socket
import struct
import time
import threading
import sys
import os
import logging

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s %(levelname)s %(message)s',
    stream=sys.stdout,
)
log = logging.getLogger("snmp-agent")

PORT = int(os.environ.get("SNMP_PORT", "1161"))
COMMUNITY = os.environ.get("SNMP_COMMUNITY", "public")
START_TIME = time.time()

# ── MIB-II system group OID values (Cisco IOS simulation) ────────────────────
# sysObjectID .1.3.6.1.4.1.9.1.1 is a well-known Cisco enterprise OID.
# The UBR NMS classifier will map it to:  Vendor=Cisco, Model=IOS Switch

MIB_DATA = {
    # ── MIB-II system group (1.3.6.1.2.1.1) ─────────────────────────────────
    "1.3.6.1.2.1.1.1.0": ("OctetString",
        b"Cisco IOS Software, Version 15.2(7)E1, RELEASE SOFTWARE (fc1) "
        b"Cisco Catalyst 2960 Series Switch"),
    "1.3.6.1.2.1.1.2.0": ("ObjectIdentifier", "1.3.6.1.4.1.9.1.1"),
    "1.3.6.1.2.1.1.3.0": ("TimeTicks", None),   # dynamic: centiseconds since start
    "1.3.6.1.2.1.1.4.0": ("OctetString", b"network-admin@ubrnms.local"),
    "1.3.6.1.2.1.1.5.0": ("OctetString", b"cisco-sw-core-01"),
    "1.3.6.1.2.1.1.6.0": ("OctetString", b"UBR NMS Test Lab - Rack 1"),

    # ── IF-MIB ifTable (1.3.6.1.2.1.2.2.1) ──────────────────────────────────
    # ifDescr — interface names
    "1.3.6.1.2.1.2.2.1.2.1": ("OctetString", b"GigabitEthernet0/1"),
    "1.3.6.1.2.1.2.2.1.2.2": ("OctetString", b"GigabitEthernet0/2"),

    # ifPhysAddress — MAC addresses returned by the WalkOID / BulkWalk.
    # The NMS discovery scanner walks 1.3.6.1.2.1.2.2.1.6 (ifPhysAddressPrefix)
    # and picks the first non-zero 6-byte octet string as the chassis MAC.
    # Raw bytes: 00:1A:2B:3C:4D:5E  →  formatted as "00:1a:2b:3c:4d:5e"
    "1.3.6.1.2.1.2.2.1.6.1": ("OctetString", b"\x00\x1a\x2b\x3c\x4d\x5e"),
    "1.3.6.1.2.1.2.2.1.6.2": ("OctetString", b"\x00\x1a\x2b\x3c\x4d\x5f"),
}

# ── Minimal BER/DER encoder ───────────────────────────────────────────────────

def tlv(tag: int, value: bytes) -> bytes:
    """Encode a TLV (tag, length, value) in BER."""
    n = len(value)
    if n < 128:
        return bytes([tag, n]) + value
    elif n < 256:
        return bytes([tag, 0x81, n]) + value
    else:
        return bytes([tag, 0x82, n >> 8, n & 0xFF]) + value


def encode_int(val: int) -> bytes:
    if val == 0:
        return b"\x00"
    n = val
    result = []
    while n > 0:
        result.append(n & 0xFF)
        n >>= 8
    if result[-1] & 0x80:
        result.append(0)
    return bytes(reversed(result))


def encode_oid(oid_str: str) -> bytes:
    """Encode an OID string to BER bytes."""
    parts = [int(x) for x in oid_str.strip(".").split(".")]
    if len(parts) < 2:
        return b""
    first = parts[0] * 40 + parts[1]
    encoded = []
    for n in [first] + parts[2:]:
        if n < 128:
            encoded.append(bytes([n]))
        else:
            buf = []
            buf.append(n & 0x7F)
            n >>= 7
            while n > 0:
                buf.append((n & 0x7F) | 0x80)
                n >>= 7
            encoded.append(bytes(reversed(buf)))
    return b"".join(encoded)


def snmp_integer(val: int) -> bytes:
    return tlv(0x02, encode_int(val))

def snmp_octet_string(val: bytes) -> bytes:
    return tlv(0x04, val)

def snmp_null() -> bytes:
    return b"\x05\x00"

def snmp_oid(oid_str: str) -> bytes:
    return tlv(0x06, encode_oid(oid_str))

def snmp_timeticks(val: int) -> bytes:
    return tlv(0x43, encode_int(val & 0xFFFFFFFF))

def snmp_sequence(data: bytes) -> bytes:
    return tlv(0x30, data)

def snmp_varbind(oid_str: str, val_type: str, val) -> bytes:
    oid_bytes = snmp_oid(oid_str)
    if val_type == "OctetString":
        value_bytes = snmp_octet_string(val if isinstance(val, bytes) else val.encode())
    elif val_type == "ObjectIdentifier":
        value_bytes = snmp_oid(val)
    elif val_type == "TimeTicks":
        ticks = int((time.time() - START_TIME) * 100) & 0xFFFFFFFF
        value_bytes = snmp_timeticks(ticks)
    elif val_type == "Integer":
        value_bytes = snmp_integer(val)
    else:
        value_bytes = snmp_null()
    return snmp_sequence(oid_bytes + value_bytes)


# ── Minimal BER decoder ───────────────────────────────────────────────────────

def decode_length(data: bytes, offset: int):
    length = data[offset]
    offset += 1
    if length & 0x80:
        n_bytes = length & 0x7F
        length = 0
        for _ in range(n_bytes):
            length = (length << 8) | data[offset]
            offset += 1
    return length, offset


def decode_tlv(data: bytes, offset: int):
    tag = data[offset]; offset += 1
    length, offset = decode_length(data, offset)
    value = data[offset:offset + length]
    return tag, value, offset + length


def decode_oid(data: bytes) -> str:
    if not data:
        return ""
    first = data[0]
    parts = [str(first // 40), str(first % 40)]
    i = 1
    while i < len(data):
        val = 0
        while i < len(data):
            b = data[i]; i += 1
            val = (val << 7) | (b & 0x7F)
            if not (b & 0x80):
                break
        parts.append(str(val))
    return "." + ".".join(parts)


# ── OID comparison helpers ────────────────────────────────────────────────────

def oid_tuple(oid_str: str) -> tuple:
    """Convert dotted OID string to a tuple of ints for comparison."""
    s = oid_str.strip(".")
    return tuple(int(x) for x in s.split(".")) if s else ()

# Pre-sorted list of (oid_string, (type, value)) for GETNEXT traversal.
# Rebuilt after MIB_DATA is defined (see end of this section).
SORTED_OIDS: list = []

def rebuild_sorted_oids():
    global SORTED_OIDS
    SORTED_OIDS = sorted(MIB_DATA.items(), key=lambda kv: oid_tuple(kv[0]))

def find_next_oid(requested_oid: str):
    """
    Return (oid_str, (type, value)) for the OID that lexicographically follows
    requested_oid in SORTED_OIDS.  Returns None when past the end of the MIB.
    """
    req_t = oid_tuple(requested_oid)
    for oid_str, entry in SORTED_OIDS:
        if oid_tuple(oid_str) > req_t:
            return oid_str, entry
    return None, None

# ── Packet parser — supports GET (0xA0), GETNEXT (0xA1), GETBULK (0xA5) ──────

PDU_GET      = 0xA0
PDU_GETNEXT  = 0xA1
PDU_RESPONSE = 0xA2
PDU_GETBULK  = 0xA5   # SNMPv2c bulk walk

def parse_snmp_request(packet: bytes):
    """
    Parse an SNMP request packet.
    Returns (community, request_id, pdu_type, oids, max_reps) where:
      pdu_type  — 0xA0 GET, 0xA1 GETNEXT, 0xA5 GETBULK
      max_reps  — meaningful for GETBULK; 0 for GET/GETNEXT
    Returns (None, None, None, [], 0) on parse error or unsupported PDU.
    """
    try:
        tag, msg, _ = decode_tlv(packet, 0)
        if tag != 0x30:
            return None, None, None, [], 0
        offset = 0
        # version
        _, _, offset = decode_tlv(msg, offset)
        # community
        _, community_bytes, offset = decode_tlv(msg, offset)
        community = community_bytes.decode("latin-1")
        # PDU tag
        pdu_tag = msg[offset]; offset += 1
        if pdu_tag not in (PDU_GET, PDU_GETNEXT, PDU_GETBULK):
            return None, None, None, [], 0
        pdu_len, offset = decode_length(msg, offset)
        pdu = msg[offset:offset + pdu_len]
        pdu_offset = 0
        # request-id
        _, req_id_bytes, pdu_offset = decode_tlv(pdu, pdu_offset)
        req_id = int.from_bytes(req_id_bytes, "big")
        # error-status (GET/GETNEXT) or non-repeaters (GETBULK) — skip both
        _, _, pdu_offset = decode_tlv(pdu, pdu_offset)
        # error-index (GET/GETNEXT) or max-repetitions (GETBULK)
        _, max_rep_bytes, pdu_offset = decode_tlv(pdu, pdu_offset)
        max_reps = int.from_bytes(max_rep_bytes, "big") if pdu_tag == PDU_GETBULK else 0
        # varbind list
        _, vbl_bytes, _ = decode_tlv(pdu, pdu_offset)
        oids = []
        vbl_off = 0
        while vbl_off < len(vbl_bytes):
            _, vb_bytes, vbl_off = decode_tlv(vbl_bytes, vbl_off)
            _, oid_bytes, _ = decode_tlv(vb_bytes, 0)
            oids.append(decode_oid(oid_bytes))
        return community, req_id, pdu_tag, oids, max_reps
    except Exception as e:
        log.debug(f"parse error: {e}")
        return None, None, None, [], 0


def build_snmp_response(community: str, req_id: int, varbinds_bytes: bytes) -> bytes:
    """Wrap pre-built varbinds bytes into a complete SNMPv2c GET-RESPONSE packet."""
    varbind_list = snmp_sequence(varbinds_bytes)
    pdu_contents = snmp_integer(req_id) + snmp_integer(0) + snmp_integer(0) + varbind_list
    pdu = tlv(PDU_RESPONSE, pdu_contents)
    message = snmp_sequence(snmp_integer(1) + snmp_octet_string(community.encode()) + pdu)
    return message


def resolve_get(oids: list) -> bytes:
    """Resolve a GET request: return exact OID matches."""
    varbinds = b""
    for oid in oids:
        clean = oid.lstrip(".")
        key = oid if oid.startswith(".") else "." + oid
        entry = MIB_DATA.get(key) or MIB_DATA.get(clean)
        if entry:
            varbinds += snmp_varbind(clean, entry[0], entry[1])
        else:
            # noSuchObject (context-specific primitive 0x80)
            varbinds += snmp_sequence(snmp_oid(clean) + bytes([0x80, 0x00]))
    return varbinds


def resolve_getnext(oids: list) -> bytes:
    """Resolve a GETNEXT request: return the lexicographically next OID."""
    varbinds = b""
    for oid in oids:
        next_oid, entry = find_next_oid(oid)
        if next_oid is not None and entry is not None:
            clean = next_oid.lstrip(".")
            varbinds += snmp_varbind(clean, entry[0], entry[1])
        else:
            # endOfMibView (context-specific primitive 0x82)
            clean = oid.lstrip(".")
            varbinds += snmp_sequence(snmp_oid(clean) + bytes([0x82, 0x00]))
    return varbinds


def resolve_getbulk(oids: list, max_reps: int) -> bytes:
    """
    Resolve a GETBULK request (used by MIB Browser 'walk').
    Walks up to max_reps OIDs starting from each requested OID.
    """
    reps = max(1, min(max_reps, len(SORTED_OIDS)))
    varbinds = b""
    for oid in oids:
        current = oid
        for _ in range(reps):
            next_oid, entry = find_next_oid(current)
            if next_oid is None or entry is None:
                clean = current.lstrip(".")
                varbinds += snmp_sequence(snmp_oid(clean) + bytes([0x82, 0x00]))
                break
            clean = next_oid.lstrip(".")
            varbinds += snmp_varbind(clean, entry[0], entry[1])
            current = next_oid
    return varbinds

# ── UDP SNMP server ───────────────────────────────────────────────────────────

PDU_NAMES = {PDU_GET: "GET", PDU_GETNEXT: "GETNEXT", PDU_GETBULK: "GETBULK"}

def run_agent():
    # Build sorted OID list for GETNEXT/GETBULK traversal.
    rebuild_sorted_oids()

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind(("0.0.0.0", PORT))
    log.info(f"SNMP agent listening on UDP 0.0.0.0:{PORT} (community={COMMUNITY})")
    log.info(f"Supports: GET, GETNEXT, GETBULK (SNMPv2c) — {len(MIB_DATA)} OIDs")
    log.info("Served OIDs:")
    for oid, (vtype, val) in MIB_DATA.items():
        if isinstance(val, bytes):
            # Show printable string or hex for binary values (e.g. MAC addresses)
            try:
                display = val.decode('ascii')
            except Exception:
                display = ':'.join(f'{b:02x}' for b in val)
        else:
            display = str(val) if val is not None else '<dynamic>'
        log.info(f"  {oid} ({vtype}) = {display}")

    while True:
        try:
            data, addr = sock.recvfrom(65535)
            community, req_id, pdu_type, oids, max_reps = parse_snmp_request(data)
            if community is None:
                continue
            if community != COMMUNITY:
                log.warning(f"rejected {addr}: wrong community '{community}'")
                continue

            pdu_name = PDU_NAMES.get(pdu_type, f"0x{pdu_type:02x}")
            log.info(f"{pdu_name} from {addr}: {oids}")

            if pdu_type == PDU_GET:
                varbinds = resolve_get(oids)
            elif pdu_type == PDU_GETNEXT:
                varbinds = resolve_getnext(oids)
            elif pdu_type == PDU_GETBULK:
                varbinds = resolve_getbulk(oids, max_reps)
            else:
                continue

            response = build_snmp_response(community, req_id, varbinds)
            sock.sendto(response, addr)
        except Exception as e:
            log.error(f"agent error: {e}")


if __name__ == "__main__":
    run_agent()
