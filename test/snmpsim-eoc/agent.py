#!/usr/bin/env python3
"""
EOC Configurations_GUI SNMP Simulator

Pure-Python SNMPv1/v2c agent simulating an EOC A60/A61 wireless unit.
Listens on UDP port (default 1162) — no root or NET_BIND_SERVICE needed.

Enterprise OID: .1.3.6.1.4.1.52619  (EOC Networks)
sysObjectID:    .1.3.6.1.4.1.52619.1.1  ← maps to Configurations_GUI in NMS

Mode is controlled by env vars:
  DEVICE_MODE   = BTS (default) or CPE
  DEVICE_NAME   = hostname, e.g. EOC-BTS-01
  DEVICE_IP     = IP to report in sysLocation / DHCP OIDs
  SNMP_PORT     = UDP port to bind (default 1162)
  SNMP_COMMUNITY= community string (default "public")

All 56 OIDs from Configurations_GUI product definition are served.
The UBR NMS SNMP probe will classify this device as:
  vendor=EOC  model=Configurations_GUI  genericDeviceType=RADIO
  productDefinitionId=Configurations_GUI

Test from host:
  snmpget -v2c -c public -p 1162 localhost 1.3.6.1.2.1.1.2.0
  snmpwalk -v2c -c public -p 1162 localhost 1.3.6.1.4.1.52619
"""

import os
import socket
import time
import logging
import sys

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    stream=sys.stdout,
)
log = logging.getLogger("eoc-snmp-agent")

PORT       = int(os.environ.get("SNMP_PORT",      "1162"))
COMMUNITY  = os.environ.get("SNMP_COMMUNITY",      "public")
MODE       = os.environ.get("DEVICE_MODE",          "BTS").upper()   # BTS or CPE
DEV_NAME   = os.environ.get("DEVICE_NAME",          f"EOC-{MODE}-01")
DEV_IP     = os.environ.get("DEVICE_IP",            "192.168.100.10")
START_TIME = time.time()

# ── Enterprise OID base ──────────────────────────────────────────────────────
ENT = "1.3.6.1.4.1.52619"
SYS_OID = f"{ENT}.1.1"   # Generic EOC A60/A61 device type OID

# ── BTS vs CPE mode-specific values ─────────────────────────────────────────
if MODE == "CPE":
    RADIO_MODE_VAL   = 2       # CPE(sta)
    SSID             = b"UBR650-SECTOR1"
    LINK_TYPE        = 3       # PTMP
    MAX_SUS          = 0       # N/A for CPE
    DESCR            = b"Configurations_GUI v2.1.3 (EOC A61 CPE)"
else:  # BTS
    RADIO_MODE_VAL   = 1       # BTS(ap)
    SSID             = b"UBR650-SECTOR1"
    LINK_TYPE        = 3       # PTMP
    MAX_SUS          = 16
    DESCR            = b"Configurations_GUI v2.1.3 (EOC A60 BTS)"

# ── Helpers (must be defined before MIB_DATA) ────────────────────────────────

def _ip2bytes(ip_str: str) -> bytes:
    """Convert dotted IPv4 string to 4 raw bytes."""
    try:
        parts = [int(x) for x in ip_str.strip().split(".")]
        return bytes(parts)
    except Exception:
        return b"\xc0\xa8\x64\x0a"   # fallback 192.168.100.10

# ── Full MIB data table ──────────────────────────────────────────────────────
# Format: OID (dot-leading) → (type, value)
# Types: OctetString, ObjectIdentifier, Integer, TimeTicks, Gauge32, Counter32
# NOTE: key/password OID (.1.1.1.1.17) returns a redacted placeholder — never
# expose real credentials in a simulator.

MIB_DATA = {
    # ── MIB-II system group (1.3.6.1.2.1.1) ─────────────────────────────────
    ".1.3.6.1.2.1.1.1.0": ("OctetString",        DESCR),
    ".1.3.6.1.2.1.1.2.0": ("ObjectIdentifier",   SYS_OID),
    ".1.3.6.1.2.1.1.3.0": ("TimeTicks",          None),       # dynamic
    ".1.3.6.1.2.1.1.4.0": ("OctetString",        b"noc@ubrnms.local"),
    ".1.3.6.1.2.1.1.5.0": ("OctetString",        DEV_NAME.encode()),
    ".1.3.6.1.2.1.1.6.0": ("OctetString",        b"UBR NMS EOC Simulator Lab"),

    # ── IF-MIB basic interface ───────────────────────────────────────────────
    ".1.3.6.1.2.1.2.2.1.2.1": ("OctetString",    b"eth0"),
    ".1.3.6.1.2.1.2.2.1.6.1": ("OctetString",    b"\x00\x50\x56\xAA\xBB\xCC"),

    # ════════════════════════════════════════════════════════════════════════════
    # EOC Enterprise OIDs — Configurations_GUI product definition
    # Base: .1.3.6.1.4.1.52619  (Enterprise 52619 — EOC Networks)
    # ════════════════════════════════════════════════════════════════════════════

    # ── Radio → Properties ───────────────────────────────────────────────────
    f".{ENT}.1.1.1.1.1.2":  ("Integer", RADIO_MODE_VAL),  # radioMode: 1=BTS 2=CPE
    f".{ENT}.1.1.1.1.1.3":  ("OctetString", SSID),        # ssid
    f".{ENT}.1.1.1.1.1.4":  ("Integer", 5019),            # country: 5GHz
    f".{ENT}.1.1.1.1.1.7":  ("Integer", 3),               # bandwidth: HT80
    f".{ENT}.1.1.1.1.1.9":  ("Integer", 36),              # configuredChannel
    f".{ENT}.1.1.1.1.1.16": ("Integer", 1),               # encryption: AES-256
    f".{ENT}.1.1.1.1.1.17": ("OctetString", b"<redacted>"),  # key — never expose real key
    f".{ENT}.1.1.1.1.1.30": ("Integer", 49),              # maximumEirp (dBm)
    f".{ENT}.1.1.1.1.1.33": ("Integer", 0),               # radioStatus: 0=Enable
    f".{ENT}.1.1.1.1.1.35": ("Integer", LINK_TYPE),       # linktype: 1=PTP 3=PTMP
    f".{ENT}.1.1.1.1.1.37": ("Integer", MAX_SUS),         # maximumSus
    f".{ENT}.1.1.1.1.1.57": ("Integer", 75),              # dlUlRatio: 75/25

    # ── Radio → DDRS ─────────────────────────────────────────────────────────
    f".{ENT}.1.1.1.2.1.3":  ("Integer", 1),               # ddrsStatus: 1=Enable
    f".{ENT}.1.1.1.2.1.4":  ("Integer", 3),               # spatialStream: 3=Auto
    f".{ENT}.1.1.1.2.1.5":  ("Integer", 0),               # minModulationIndex
    f".{ENT}.1.1.1.2.1.6":  ("Integer", 11),              # maxModulationIndex
    f".{ENT}.1.1.1.2.1.9":  ("Integer", 3),               # modulationIndex: MCS3
    f".{ENT}.1.1.1.2.1.11": ("Integer", 0),               # atpcStatus: 0=Disable
    f".{ENT}.1.1.1.2.1.12": ("Integer", 26),              # transmitPower (dBm)
    f".{ENT}.1.1.1.2.1.17": ("Integer", 11),              # maxDataRateSingleStream: MCS11
    f".{ENT}.1.1.1.2.1.18": ("Integer", 23),              # maxDataRateDualStream: MCS23

    # ── Radio → DCS ──────────────────────────────────────────────────────────
    f".{ENT}.1.1.1.3.1.2":  ("Integer", 0),               # dcsStatus: 0=Disable
    f".{ENT}.1.1.1.3.1.3":  ("Integer", 25),              # rtxThreshold (%)
    f".{ENT}.1.1.1.3.1.11": ("Integer", 0),               # backgroundScan: 0=Disable

    # ── Network → IP Configuration ────────────────────────────────────────────
    f".{ENT}.1.1.2.1.0":  ("Integer", 0),                 # addressType: 0=Static
    f".{ENT}.1.1.2.2.0":  ("OctetString", _ip2bytes(DEV_IP)),  # ipAddress
    f".{ENT}.1.1.2.3.0":  ("OctetString", b"\xff\xff\xff\x00"),  # subnetMask 255.255.255.0
    f".{ENT}.1.1.2.4.0":  ("OctetString", b"\xc0\xa8\x64\x01"),  # gateway 192.168.100.1
    f".{ENT}.1.1.2.15.0": ("OctetString", b""),            # ipv6Address (empty)
    f".{ENT}.1.1.2.17.0": ("OctetString", b""),            # ipv6Gateway (empty)

    # ── Network → VLAN ────────────────────────────────────────────────────────
    f".{ENT}.1.1.4.18.1.3":  ("Integer", 0),              # mode: 0=Transparent
    f".{ENT}.1.1.4.18.1.5":  ("Integer", 1),              # trunkOption: List
    f".{ENT}.1.1.4.18.1.6":  ("Integer", 0),              # trunkVlanId (empty)
    f".{ENT}.1.1.4.18.1.8":  ("Integer", 100),            # svlanId
    f".{ENT}.1.1.4.18.1.9":  ("Integer", 0x8100),         # svlanEthertype
    f".{ENT}.1.1.4.18.1.11": ("Integer", 1),              # mgmtVlanId
    f".{ENT}.1.1.4.18.1.14": ("Integer", 0),              # svlanPriority
    f".{ENT}.1.1.4.18.1.15": ("Integer", 0x8100),         # cvlanEthertype
    f".{ENT}.1.1.4.18.1.16": ("Integer", 0),              # cvlanPriority
    f".{ENT}.1.1.4.18.1.17": ("Integer", 101),            # cvlanId

    # ── Network → Ethernet ────────────────────────────────────────────────────
    f".{ENT}.1.1.5.6.1.2": ("Integer", 0),                # speedDuplex: 0=Auto
    f".{ENT}.1.1.5.6.1.4": ("Integer", 1500),             # mtu

    # ── Network → DHCP ───────────────────────────────────────────────────────
    f".{ENT}.1.1.6.1.0":   ("Integer", 1),                # dhcpServer: 1=Disable
    f".{ENT}.1.1.6.2.0":   ("OctetString", b"\xc0\xa8\x64\x64"),  # startIp 192.168.100.100
    f".{ENT}.1.1.6.3.0":   ("OctetString", b"\xc0\xa8\x64\x96"),  # endIp   192.168.100.150
    f".{ENT}.1.1.6.4.0":   ("Integer", 43200),            # leaseTime (seconds)

    # ── Network → DHCP 2.4 (link-local pool) ─────────────────────────────────
    f".{ENT}.1.1.6.5.1.0": ("OctetString", b"\xa9\xfe\xfe\x01"),  # 169.254.254.1
    f".{ENT}.1.1.6.5.2.0": ("OctetString", b"\xff\xff\xff\x00"),  # 255.255.255.0
    f".{ENT}.1.1.6.5.3.0": ("Integer", 1),                # dhcpServerPool: Enable
    f".{ENT}.1.1.6.5.4.0": ("OctetString", b"\xa9\xfe\xfe\x64"),  # 169.254.254.100
    f".{ENT}.1.1.6.5.5.0": ("OctetString", b"\xa9\xfe\xfe\x66"),  # 169.254.254.102
    f".{ENT}.1.1.6.5.6.0": ("Integer", 300),              # leaseTime 300s
}

# ── BER encoder ──────────────────────────────────────────────────────────────

# ── BER encoder ──────────────────────────────────────────────────────────────

def tlv(tag: int, value: bytes) -> bytes:
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

def snmp_oid(oid_str: str) -> bytes:
    return tlv(0x06, encode_oid(oid_str))

def snmp_timeticks(val: int) -> bytes:
    return tlv(0x43, encode_int(val & 0xFFFFFFFF))

def snmp_gauge32(val: int) -> bytes:
    return tlv(0x42, encode_int(val & 0xFFFFFFFF))

def snmp_sequence(data: bytes) -> bytes:
    return tlv(0x30, data)


def snmp_varbind(oid_str: str, val_type: str, val) -> bytes:
    oid_bytes = snmp_oid(oid_str)
    if val_type == "OctetString":
        value_bytes = snmp_octet_string(val if isinstance(val, bytes) else str(val).encode())
    elif val_type == "ObjectIdentifier":
        value_bytes = snmp_oid(val)
    elif val_type == "TimeTicks":
        ticks = int((time.time() - START_TIME) * 100) & 0xFFFFFFFF
        value_bytes = snmp_timeticks(ticks)
    elif val_type in ("Integer", "Gauge32", "Counter32"):
        value_bytes = snmp_integer(int(val))
    else:
        value_bytes = b"\x05\x00"
    return snmp_sequence(oid_bytes + value_bytes)

# ── BER decoder ──────────────────────────────────────────────────────────────

def decode_length(data: bytes, offset: int):
    length = data[offset]; offset += 1
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

# ── OID traversal ─────────────────────────────────────────────────────────────

def oid_tuple(oid_str: str) -> tuple:
    s = oid_str.strip(".")
    return tuple(int(x) for x in s.split(".")) if s else ()

SORTED_OIDS = sorted(MIB_DATA.items(), key=lambda kv: oid_tuple(kv[0]))


def find_next_oid(requested_oid: str):
    req_t = oid_tuple(requested_oid)
    for oid_str, entry in SORTED_OIDS:
        if oid_tuple(oid_str) > req_t:
            return oid_str, entry
    return None, None

# ── Packet parser ─────────────────────────────────────────────────────────────

PDU_GET      = 0xA0
PDU_GETNEXT  = 0xA1
PDU_RESPONSE = 0xA2
PDU_GETBULK  = 0xA5


def parse_snmp_request(packet: bytes):
    try:
        tag, msg, _ = decode_tlv(packet, 0)
        if tag != 0x30:
            return None, None, None, [], 0
        offset = 0
        _, _, offset = decode_tlv(msg, offset)           # version
        _, community_bytes, offset = decode_tlv(msg, offset)
        community = community_bytes.decode("latin-1")
        pdu_tag = msg[offset]; offset += 1
        if pdu_tag not in (PDU_GET, PDU_GETNEXT, PDU_GETBULK):
            return None, None, None, [], 0
        pdu_len, offset = decode_length(msg, offset)
        pdu = msg[offset:offset + pdu_len]
        pdu_offset = 0
        _, req_id_bytes, pdu_offset = decode_tlv(pdu, pdu_offset)
        req_id = int.from_bytes(req_id_bytes, "big")
        _, _, pdu_offset = decode_tlv(pdu, pdu_offset)   # error-status / non-repeaters
        _, max_rep_bytes, pdu_offset = decode_tlv(pdu, pdu_offset)
        max_reps = int.from_bytes(max_rep_bytes, "big") if pdu_tag == PDU_GETBULK else 0
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
    varbind_list = snmp_sequence(varbinds_bytes)
    pdu_contents = snmp_integer(req_id) + snmp_integer(0) + snmp_integer(0) + varbind_list
    pdu = tlv(PDU_RESPONSE, pdu_contents)
    message = snmp_sequence(snmp_integer(1) + snmp_octet_string(community.encode()) + pdu)
    return message


def resolve_get(oids: list) -> bytes:
    varbinds = b""
    for oid in oids:
        key = oid if oid.startswith(".") else "." + oid
        entry = MIB_DATA.get(key)
        if entry:
            varbinds += snmp_varbind(oid.lstrip("."), entry[0], entry[1])
        else:
            varbinds += snmp_sequence(snmp_oid(oid.lstrip(".")) + bytes([0x80, 0x00]))
    return varbinds


def resolve_getnext(oids: list) -> bytes:
    varbinds = b""
    for oid in oids:
        next_oid, entry = find_next_oid(oid)
        if next_oid and entry:
            varbinds += snmp_varbind(next_oid.lstrip("."), entry[0], entry[1])
        else:
            varbinds += snmp_sequence(snmp_oid(oid.lstrip(".")) + bytes([0x82, 0x00]))
    return varbinds


def resolve_getbulk(oids: list, max_reps: int) -> bytes:
    reps = max(1, min(max_reps, len(SORTED_OIDS)))
    varbinds = b""
    for oid in oids:
        current = oid
        for _ in range(reps):
            next_oid, entry = find_next_oid(current)
            if next_oid is None:
                varbinds += snmp_sequence(snmp_oid(current.lstrip(".")) + bytes([0x82, 0x00]))
                break
            varbinds += snmp_varbind(next_oid.lstrip("."), entry[0], entry[1])
            current = next_oid
    return varbinds


# ── UDP server ────────────────────────────────────────────────────────────────

PDU_NAMES = {PDU_GET: "GET", PDU_GETNEXT: "GETNEXT", PDU_GETBULK: "GETBULK"}


def run_agent():
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind(("0.0.0.0", PORT))
    log.info("=" * 60)
    log.info(f"EOC Configurations_GUI SNMP Simulator ({MODE} mode)")
    log.info(f"Device: {DEV_NAME}  IP: {DEV_IP}")
    log.info(f"sysObjectID: .{SYS_OID}  (Enterprise: .{ENT}.*)")
    log.info(f"Community: {COMMUNITY}  Port: {PORT}/udp")
    log.info(f"OIDs served: {len(MIB_DATA)}")
    log.info("=" * 60)
    log.info("NMS Discovery command (from host):")
    log.info(f"  POST /api/v1/discovery/snmp-probe")
    log.info(f'  Body: {{"targets":["host.docker.internal:{PORT}"],"community":"{COMMUNITY}","provision":true}}')
    log.info("snmpget test:")
    log.info(f"  snmpget -v2c -c {COMMUNITY} -p {PORT} localhost 1.3.6.1.2.1.1.2.0")
    log.info("=" * 60)

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
            log.info(f"{pdu_name} from {addr[0]}:{addr[1]}: {oids[:4]}{'...' if len(oids) > 4 else ''}")

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
