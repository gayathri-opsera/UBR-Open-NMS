#!/usr/bin/env python3
"""
Ubiquiti AirMax AC SNMP Simulator

Pure-Python SNMPv1/v2c agent simulating a Ubiquiti AirMax AC wireless backhaul radio.
Listens on UDP port (default 1164) — no root or NET_BIND_SERVICE needed.

Enterprise OID: .1.3.6.1.4.1.41112  (Ubiquiti Networks)
sysObjectID:    .1.3.6.1.4.1.41112.1.6  ← maps to AirMax in NMS

The UBR NMS SNMP probe will classify this device as:
  vendor=Ubiquiti  model=AirMax AC  genericDeviceType=RADIO
  productDefinitionId=ubiquiti-airmax-radio
  defaultLatitude=17.3850  defaultLongitude=78.4867

Test from host:
  snmpget -v2c -c public -p 1164 localhost 1.3.6.1.2.1.1.2.0
  snmpwalk -v2c -c public -p 1164 localhost 1.3.6.1.4.1.41112
"""

import os
import socket
import struct
import time
import logging
import sys

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    stream=sys.stdout,
)
log = logging.getLogger("radio-snmp-agent")

PORT       = int(os.environ.get("SNMP_PORT",      "1164"))
COMMUNITY  = os.environ.get("SNMP_COMMUNITY",     "public")
DEV_NAME   = os.environ.get("DEVICE_NAME",        "UBR-RADIO-01")
DEV_IP     = os.environ.get("DEVICE_IP",          "192.168.100.20")
DEFAULT_LAT = os.environ.get("DEFAULT_LAT",       "17.3850")
DEFAULT_LON = os.environ.get("DEFAULT_LON",       "78.4867")
START_TIME = time.time()

# ── Enterprise OID base ──────────────────────────────────────────────────────
ENT = "1.3.6.1.4.1.41112"
SYS_OID = f"{ENT}.1.6"   # Ubiquiti AirMax AC

# ── MIB-II system group ──────────────────────────────────────────────────────
DESCR   = f"AirMax AC v8.7.11 (Ubiquiti AirMax AC 5 GHz RADIO) sn:{DEV_NAME}".encode()
LOCATION = f"Hyderabad Tower Site lat:{DEFAULT_LAT} lon:{DEFAULT_LON}".encode()

# ── MIB data table ───────────────────────────────────────────────────────────
# Format: OID string → (type_tag, value)
#   0x02 = Integer, 0x04 = OctetString, 0x06 = ObjectIdentifier,
#   0x43 = Counter32, 0x41 = Counter32, 0x42 = Gauge32, 0x43 = TimeTicks

MIB_DATA = {
    # ── MIB-II system ────────────────────────────────────────────────────────
    "1.3.6.1.2.1.1.1.0":  ("OctetString", DESCR),
    "1.3.6.1.2.1.1.2.0":  ("ObjectIdentifier", SYS_OID),
    "1.3.6.1.2.1.1.3.0":  ("TimeTicks", lambda: int((time.time() - START_TIME) * 100)),
    "1.3.6.1.2.1.1.4.0":  ("OctetString", b"nms@ubrnms.local"),
    "1.3.6.1.2.1.1.5.0":  ("OctetString", DEV_NAME.encode()),
    "1.3.6.1.2.1.1.6.0":  ("OctetString", LOCATION),

    # ── Ubiquiti AirMax enterprise OIDs ──────────────────────────────────────
    # Firmware version
    f"{ENT}.1.4.1.1.0":   ("OctetString", b"8.7.11"),
    # Device model
    f"{ENT}.1.4.1.2.0":   ("OctetString", b"LBE-5AC-XR"),
    # TX power (dBm)
    f"{ENT}.1.4.1.18.0":  ("Integer", 23),
    # Frequency (MHz)
    f"{ENT}.1.4.1.17.0":  ("Integer", 5180),
    # Channel width (MHz)
    f"{ENT}.1.4.1.19.0":  ("Integer", 40),
    # Radio mode: 1=AP(BTS) 2=STA(CPE)
    f"{ENT}.1.4.1.20.0":  ("Integer", 1),
    # SSID
    f"{ENT}.1.4.1.21.0":  ("OctetString", b"UBR-BACKHAUL-5G"),
    # Link distance (metres)
    f"{ENT}.1.4.5.1.15.1": ("Integer", 2400),
    # RSSI (dBm)
    f"{ENT}.1.4.5.1.5.1":  ("Integer", -58),
    # Noise floor (dBm)
    f"{ENT}.1.4.5.1.6.1":  ("Integer", -94),
    # RX throughput (Mbps * 1000)
    f"{ENT}.1.4.5.1.9.1":  ("Gauge32", 87),
    # TX throughput (Mbps * 1000)
    f"{ENT}.1.4.5.1.10.1": ("Gauge32", 54),
    # Air utilisation (%)
    f"{ENT}.1.4.5.1.7.1":  ("Integer", 12),
}

# ── BER encoding helpers ─────────────────────────────────────────────────────

def _encode_length(n: int) -> bytes:
    if n < 0x80:
        return bytes([n])
    enc = []
    tmp = n
    while tmp:
        enc.append(tmp & 0xFF)
        tmp >>= 8
    enc.reverse()
    return bytes([0x80 | len(enc)] + enc)


def _encode_int(v: int) -> bytes:
    if v == 0:
        return b"\x02\x01\x00"
    neg = v < 0
    data = []
    tmp = v if not neg else (-v - 1)
    while tmp:
        data.append(tmp & 0xFF)
        tmp >>= 8
    if neg:
        data = [b ^ 0xFF for b in data]
        if not (data[-1] & 0x80):
            data.append(0xFF)
    else:
        if data[-1] & 0x80:
            data.append(0x00)
    data.reverse()
    return b"\x02" + _encode_length(len(data)) + bytes(data)


def _encode_oid(oid_str: str) -> bytes:
    parts = [int(x) for x in oid_str.lstrip(".").split(".")]
    if len(parts) < 2:
        parts = [1, 3] + parts
    body = bytes([40 * parts[0] + parts[1]])
    for n in parts[2:]:
        if n == 0:
            body += b"\x00"
        else:
            enc = []
            while n:
                enc.append((n & 0x7F) | (0x80 if enc else 0))
                n >>= 7
            enc.reverse()
            body += bytes(enc)
    return b"\x06" + _encode_length(len(body)) + body


def _encode_timeticks(v: int) -> bytes:
    data = struct.pack(">I", v & 0xFFFFFFFF)
    data = data.lstrip(b"\x00") or b"\x00"
    return b"\x43" + _encode_length(len(data)) + data


def _encode_gauge(v: int) -> bytes:
    data = struct.pack(">I", v & 0xFFFFFFFF)
    data = data.lstrip(b"\x00") or b"\x00"
    return b"\x42" + _encode_length(len(data)) + data


def _encode_value(type_name: str, value) -> bytes:
    if callable(value):
        value = value()
    if type_name == "Integer":
        return _encode_int(int(value))
    elif type_name == "OctetString":
        if isinstance(value, str):
            value = value.encode()
        return b"\x04" + _encode_length(len(value)) + value
    elif type_name == "ObjectIdentifier":
        return _encode_oid(value)
    elif type_name == "TimeTicks":
        return _encode_timeticks(int(value))
    elif type_name in ("Gauge32", "Counter32"):
        return _encode_gauge(int(value))
    return b"\x04\x00"


def _tlv(tag: int, body: bytes) -> bytes:
    return bytes([tag]) + _encode_length(len(body)) + body


def _parse_oid(data: bytes, offset: int) -> tuple:
    assert data[offset] == 0x06
    length = data[offset + 1]
    raw = data[offset + 2: offset + 2 + length]
    parts = [raw[0] // 40, raw[0] % 40]
    i = 1
    while i < len(raw):
        acc = 0
        while True:
            b = raw[i]; i += 1
            acc = (acc << 7) | (b & 0x7F)
            if not (b & 0x80):
                break
        parts.append(acc)
    return ".".join(str(x) for x in parts), offset + 2 + length


# ── Request handler ───────────────────────────────────────────────────────────

SORTED_OIDS = sorted(MIB_DATA.keys(), key=lambda o: [int(x) for x in o.split(".")])


def _next_oid(oid: str) -> str | None:
    for k in SORTED_OIDS:
        if [int(x) for x in k.split(".")] > [int(x) for x in oid.split(".")]:
            return k
    return None


def handle_pdu(pdu_type: int, request_id_raw: bytes, varbinds_raw: bytes) -> bytes:
    varbinds_out = b""

    i = 0
    while i < len(varbinds_raw):
        # Each varbind is a SEQUENCE
        assert varbinds_raw[i] == 0x30
        vb_len = varbinds_raw[i + 1]
        i += 2
        oid_str, after = _parse_oid(varbinds_raw, i)
        i += vb_len  # advance past entire varbind

        if pdu_type == 0xA1:  # GetNextRequest
            oid_str = _next_oid(oid_str) or oid_str

        type_name, raw_val = MIB_DATA.get(oid_str, ("OctetString", b""))
        enc_val = _encode_value(type_name, raw_val)
        enc_oid = _encode_oid(oid_str)
        vb = _tlv(0x30, enc_oid + enc_val)
        varbinds_out += vb

    resp_pdu = _tlv(0xA2,                        # GetResponse
                    request_id_raw +
                    b"\x02\x01\x00" +            # error-status = 0
                    b"\x02\x01\x00" +            # error-index  = 0
                    _tlv(0x30, varbinds_out))
    return resp_pdu


def _skip_tlv(data: bytes, off: int) -> tuple[bytes, int]:
    """Read one TLV at offset, return (raw_tlv_bytes, next_offset)."""
    tag = data[off]; off += 1
    b = data[off]; off += 1
    if b & 0x80:
        n_bytes = b & 0x7F
        length = int.from_bytes(data[off:off + n_bytes], 'big')
        off += n_bytes
    else:
        length = b
    raw = data[off - (2 + (0 if not (data[off-2] & 0x80) else (data[off-2] & 0x7F))):off + length]
    # Rebuild raw as (tag + length_bytes + value)
    val = data[off:off + length]
    off += length
    return (tag, val, off)


def parse_and_respond(data: bytes) -> bytes | None:
    try:
        assert data[0] == 0x30            # SEQUENCE (outer)
        off = 1
        # decode outer length
        b = data[off]; off += 1
        if b & 0x80:
            nb = b & 0x7F; off += nb
        # version integer
        _, ver_val, off = _skip_tlv(data, off)
        # community octet-string
        _, com_val, off = _skip_tlv(data, off)
        community = com_val.decode(errors="ignore")
        if community != COMMUNITY:
            return None
        # PDU type + length
        pdu_type = data[off]; off += 1
        b = data[off]; off += 1
        if b & 0x80:
            nb = b & 0x7F; off += nb
        # requestId integer — read as raw TLV to echo back verbatim
        req_id_start = off
        _, req_id_val, off = _skip_tlv(data, off)
        req_id_raw = data[req_id_start:off]
        # errorStatus, errorIndex
        _, _, off = _skip_tlv(data, off)
        _, _, off = _skip_tlv(data, off)
        # varbindList SEQUENCE — skip header, pass inner bytes
        _, varbinds, off = _skip_tlv(data, off)

        resp_pdu = handle_pdu(pdu_type, req_id_raw, varbinds)
        com_enc = _tlv(0x04, COMMUNITY.encode())
        msg = _tlv(0x30, b"\x02\x01\x01" + com_enc + resp_pdu)
        return msg
    except Exception as exc:
        log.debug("Parse error: %s", exc)
        return None


# ── Main loop ─────────────────────────────────────────────────────────────────

def main():
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind(("0.0.0.0", PORT))
    log.info(
        "UBR RADIO SNMP simulator started: %s  OID=%s  port=%d  GPS=%s,%s",
        DEV_NAME, SYS_OID, PORT, DEFAULT_LAT, DEFAULT_LON,
    )
    while True:
        try:
            data, addr = sock.recvfrom(4096)
            resp = parse_and_respond(data)
            if resp:
                sock.sendto(resp, addr)
        except Exception as exc:
            log.warning("Error: %s", exc)


if __name__ == "__main__":
    main()
