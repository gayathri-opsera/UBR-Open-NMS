#!/usr/bin/env python3
"""
EOC640 Wireless Backhaul Unit — SNMP Simulator

Pure-Python SNMPv1/v2c agent simulating an EOC640 60GHz/5GHz P2MP backhaul unit.
Matches the fingerprints in EOC640_product_definition_fixed.xml:
  sysObjectID:     .1.3.6.1.4.1.26928.1.640
  sysDescrPattern: EOC640.*

Mode is controlled by env vars:
  DEVICE_MODE    = BTS (default) or CPE
  DEVICE_NAME    = hostname, e.g. EOC640-BTS-01
  DEVICE_IP      = IP to report
  SNMP_PORT      = UDP port to bind (default 1164)
  SNMP_COMMUNITY = community string (default "public")
  DEVICE_SERIAL  = serial number (default auto-generated)

Enterprise OID base: .1.3.6.1.4.1.26928  (EOC640 vendor)
productDefinitionId: eoc-eoc640-wireless-backhaul-unit

Test from host:
  snmpget -v2c -c public -p 1164 localhost 1.3.6.1.2.1.1.2.0
  snmpwalk -v2c -c public -p 1164 localhost 1.3.6.1.4.1.26928
"""

import os
import socket
import struct
import time
import logging
import sys
import math

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    stream=sys.stdout,
)
log = logging.getLogger("eoc640-snmp")

PORT       = int(os.environ.get("SNMP_PORT",      "1164"))
COMMUNITY  = os.environ.get("SNMP_COMMUNITY",      "public")
MODE       = os.environ.get("DEVICE_MODE",          "BTS").upper()   # BTS or CPE
DEV_NAME   = os.environ.get("DEVICE_NAME",          f"EOC640-{MODE}-01")
DEV_IP     = os.environ.get("DEVICE_IP",            "192.168.100.20")
DEV_SERIAL = os.environ.get("DEVICE_SERIAL",        f"EOC640-{MODE}-SN-001")
START_TIME = time.time()

# ── Enterprise OID base ──────────────────────────────────────────────────────
ENT      = "1.3.6.1.4.1.26928"
SYS_OID  = f"{ENT}.1.640"   # EOC640 device type OID — matches XML fingerprint

# ── BTS vs CPE mode-specific values ─────────────────────────────────────────
if MODE == "CPE":
    RADIO_MODE_VAL         = 2        # CPE(sta)
    LINK_TYPE_VAL          = 3        # PTMP
    MAX_SUS_VAL            = 0        # N/A for CPE
    DESCR                  = b"EOC640 Wireless Backhaul Unit v3.2.1 (CPE mode)"
    TX_POWER_VAL           = 23
    RSSI_VAL               = -68
    SNR_VAL                = 28
    CONNECTED_CLIENTS_VAL  = 0
    ACTIVE_CHANNEL_VAL     = 36
else:  # BTS
    RADIO_MODE_VAL         = 1        # BTS(ap)
    LINK_TYPE_VAL          = 3        # PTMP
    MAX_SUS_VAL            = 16
    DESCR                  = b"EOC640 Wireless Backhaul Unit v3.2.1 (BTS mode)"
    TX_POWER_VAL           = 27
    RSSI_VAL               = -55
    SNR_VAL                = 35
    CONNECTED_CLIENTS_VAL  = 4
    ACTIVE_CHANNEL_VAL     = 36

def _ip2bytes(ip_str: str) -> bytes:
    try:
        parts = [int(x) for x in ip_str.strip().split(".")]
        return bytes(parts)
    except Exception:
        return b"\xc0\xa8\x64\x14"   # 192.168.100.20

# ── Full MIB data table ──────────────────────────────────────────────────────
# Format: OID (dot-leading) → (type_tag, value)
# SNMPv2c type tags (BER):
#   0x02 Integer, 0x04 OctetString, 0x06 OID,
#   0x40 IpAddress, 0x41 Counter32, 0x42 Gauge32, 0x43 TimeTicks
#
# NOTE: key/password OID returns a redacted placeholder — never expose real
# credentials in a simulator (DevSecOps rule: no secrets in code).

MIB_DATA = {
    # ── System MIB (RFC 1213) ────────────────────────────────────────────────
    ".1.3.6.1.2.1.1.1.0": (0x04, DESCR),
    ".1.3.6.1.2.1.1.2.0": (0x06, SYS_OID.encode()),
    ".1.3.6.1.2.1.1.3.0": (0x43, None),   # sysUpTime (dynamic)
    ".1.3.6.1.2.1.1.4.0": (0x04, b"noc@isp.example.com"),
    ".1.3.6.1.2.1.1.5.0": (0x04, DEV_NAME.encode()),
    ".1.3.6.1.2.1.1.6.0": (0x04, f"Site: EOC-Field / IP: {DEV_IP} / Mode: {MODE}".encode()),
    ".1.3.6.1.2.1.1.7.0": (0x02, 72),    # sysServices: internet + end-to-end

    # ── EOC640 Radio Group (group: radio) ────────────────────────────────────
    # OID base: .1.3.6.1.4.1.26928.1.640.1
    f".{ENT}.1.640.1.1.0":  (0x02, 0),                          # radioStatus: Enable(0)
    f".{ENT}.1.640.1.2.0":  (0x02, LINK_TYPE_VAL),              # linktype: PTMP(3)
    f".{ENT}.1.640.1.3.0":  (0x02, RADIO_MODE_VAL),             # radioMode: BTS(1)/CPE(2)
    f".{ENT}.1.640.1.4.0":  (0x04, b"EOC640-SECTOR-1"),         # ssid
    f".{ENT}.1.640.1.5.0":  (0x02, 3),                          # bandwidth: HT80(3)
    f".{ENT}.1.640.1.6.0":  (0x02, 4),                          # country: 5GHz(4)
    f".{ENT}.1.640.1.7.0":  (0x02, ACTIVE_CHANNEL_VAL),         # configuredChannel: 36
    f".{ENT}.1.640.1.8.0":  (0x02, 0),                          # encryption: AES-256(0)
    f".{ENT}.1.640.1.9.0":  (0x04, b"[REDACTED]"),              # key — NEVER expose in sim
    f".{ENT}.1.640.1.10.0": (0x02, MAX_SUS_VAL),                # maximumSus
    f".{ENT}.1.640.1.11.0": (0x02, 1),                          # ofdma: Disable(1)
    f".{ENT}.1.640.1.12.0": (0x02, 4),                          # dlUlRatio: 75/25(4)
    # DDRS
    f".{ENT}.1.640.1.13.0": (0x02, 0),                          # ddrsStatus: Enable(0)
    f".{ENT}.1.640.1.14.0": (0x02, 2),                          # spatialStreamDdrsEnabled: Auto
    f".{ENT}.1.640.1.15.0": (0x02, 11),                         # maxDataRateSingleStream: MCS11
    f".{ENT}.1.640.1.16.0": (0x02, 11),                         # maxDataRateDualStream: MCS23 → idx 11
    f".{ENT}.1.640.1.17.0": (0x02, 0),                          # minModulationIndex: MCS0
    f".{ENT}.1.640.1.18.0": (0x02, 11),                         # maxModulationIndex: MCS11
    f".{ENT}.1.640.1.19.0": (0x02, 0),                          # spatialStreamDdrsDisabled: Single
    f".{ENT}.1.640.1.20.0": (0x02, 3),                          # modulationIndex: MCS3
    # ATPC
    f".{ENT}.1.640.1.21.0": (0x02, 1),                          # atpcStatus: Disable
    f".{ENT}.1.640.1.22.0": (0x02, TX_POWER_VAL),               # transmitPower (dBm)
    f".{ENT}.1.640.1.23.0": (0x02, 18),                         # connectorizedAntennaGain (dBi)
    f".{ENT}.1.640.1.24.0": (0x02, 36),                         # maximumEirp (dBm)
    # DCS
    f".{ENT}.1.640.1.25.0": (0x02, 1),                          # dcsStatus: Disable
    f".{ENT}.1.640.1.26.0": (0x02, 30),                         # rtxThreshold
    f".{ENT}.1.640.1.27.0": (0x02, 1),                          # backgroundScan: Disable

    # ── EOC640 Network Group (group: network) ────────────────────────────────
    # OID base: .1.3.6.1.4.1.26928.1.640.2
    f".{ENT}.1.640.2.1.0":  (0x02, 0),                          # addressType: Static(0)
    f".{ENT}.1.640.2.2.0":  (0x40, _ip2bytes(DEV_IP)),          # ipAddress
    f".{ENT}.1.640.2.3.0":  (0x40, bytes([255,255,255,0])),      # subnetMask
    f".{ENT}.1.640.2.4.0":  (0x40, _ip2bytes(
                                   ".".join(DEV_IP.split(".")[:3]+["1"]))), # gateway
    f".{ENT}.1.640.2.5.0":  (0x04, b""),                        # ipv6Address
    f".{ENT}.1.640.2.6.0":  (0x04, b""),                        # ipv6Gateway
    f".{ENT}.1.640.2.7.0":  (0x02, 1),                          # mgmtVlanId
    f".{ENT}.1.640.2.8.0":  (0x02, 0),                          # vlanMode: Transparent
    f".{ENT}.1.640.2.9.0":  (0x02, 0),                          # trunkOption
    f".{ENT}.1.640.2.10.0": (0x02, 1),                          # ingressQos: Disable
    f".{ENT}.1.640.2.11.0": (0x02, 0),                          # flowControl: Disable

    # ── EOC640 System Group (group: system) ──────────────────────────────────
    # OID base: .1.3.6.1.4.1.26928.1.640.3
    f".{ENT}.1.640.3.1.0":  (0x04, DEV_NAME.encode()),          # deviceName / hostname
    f".{ENT}.1.640.3.2.0":  (0x04, b"3.2.1"),                   # firmwareVersion
    f".{ENT}.1.640.3.3.0":  (0x04, DEV_SERIAL.encode()),        # serialNumber
    f".{ENT}.1.640.3.4.0":  (0x04, b"EOC640"),                  # model
    f".{ENT}.1.640.3.5.0":  (0x04, b"EOC"),                     # vendor
    f".{ENT}.1.640.3.6.0":  (0x04, b"AA:BB:CC:64:00:01"),       # macAddress
    f".{ENT}.1.640.3.7.0":  (0x02, 0),                          # ledStatus: Normal
    f".{ENT}.1.640.3.8.0":  (0x43, None),                       # uptime (dynamic)
    f".{ENT}.1.640.3.9.0":  (0x04, b"EOC640-FW-3.2.1.bin"),     # activeFirmwareFile
    f".{ENT}.1.640.3.10.0": (0x04, b"EOC640-FW-3.1.0.bin"),     # standbyFirmwareFile

    # ── Runtime/status (not in product definition parameters but useful) ─────
    f".{ENT}.1.640.9.1.0":  (0x42, CONNECTED_CLIENTS_VAL),      # connectedClients
    f".{ENT}.1.640.9.2.0":  (0x02, RSSI_VAL),                   # rssi (dBm)
    f".{ENT}.1.640.9.3.0":  (0x02, SNR_VAL),                    # snr (dB)
    f".{ENT}.1.640.9.4.0":  (0x02, ACTIVE_CHANNEL_VAL),         # activeChannel
    f".{ENT}.1.640.9.5.0":  (0x41, 0),                          # txBytes (Counter32, reset on start)
    f".{ENT}.1.640.9.6.0":  (0x41, 0),                          # rxBytes
}

# ── Sorted OID list for GETNEXT traversal ────────────────────────────────────

def _oid_key(oid: str):
    return tuple(int(x) for x in oid.lstrip(".").split("."))

SORTED_OIDS = sorted(MIB_DATA.keys(), key=_oid_key)


# ── BER encode helpers ────────────────────────────────────────────────────────

def _encode_length(n: int) -> bytes:
    if n < 0x80:
        return bytes([n])
    b = n.to_bytes((n.bit_length() + 7) // 8, "big")
    return bytes([0x80 | len(b)]) + b

def _encode_tlv(tag: int, value: bytes) -> bytes:
    return bytes([tag]) + _encode_length(len(value)) + value

def _encode_int(v: int) -> bytes:
    if v == 0:
        return b"\x00"
    n_bytes = (v.bit_length() + 8) // 8  # +8 for sign bit room
    return v.to_bytes(n_bytes, "big", signed=True)

def _encode_oid(oid_str: str) -> bytes:
    parts = [int(x) for x in oid_str.lstrip(".").split(".")]
    out = bytes([40 * parts[0] + parts[1]])
    for p in parts[2:]:
        if p < 0x80:
            out += bytes([p])
        else:
            enc = []
            while p:
                enc.append(p & 0x7F)
                p >>= 7
            enc.reverse()
            for i, b in enumerate(enc):
                out += bytes([b | (0x80 if i < len(enc) - 1 else 0)])
    return out

def _make_varbind(oid: str, tag: int, raw_value) -> bytes:
    oid_enc = _encode_tlv(0x06, _encode_oid(oid))
    if tag == 0x43 or (tag == 0x43 and raw_value is None):  # TimeTicks / uptime
        cs = int((time.time() - START_TIME) * 100)
        val_enc = _encode_tlv(0x43, _encode_int(cs))
    elif raw_value is None:
        cs = int((time.time() - START_TIME) * 100)
        val_enc = _encode_tlv(0x43, _encode_int(cs))
    elif tag == 0x02:   # Integer
        val_enc = _encode_tlv(0x02, _encode_int(raw_value))
    elif tag == 0x06:   # OID
        val_enc = _encode_tlv(0x06, _encode_oid(raw_value.decode()))
    elif tag == 0x40:   # IpAddress
        val_enc = _encode_tlv(0x40, raw_value)
    elif tag in (0x41, 0x42):  # Counter32/Gauge32
        val_enc = _encode_tlv(tag, _encode_int(raw_value))
    else:               # OctetString
        val_enc = _encode_tlv(0x04, raw_value)
    seq = oid_enc + val_enc
    return _encode_tlv(0x30, seq)

def _make_error_varbind(oid: str) -> bytes:
    oid_enc  = _encode_tlv(0x06, _encode_oid(oid))
    null_enc = _encode_tlv(0x05, b"")
    return _encode_tlv(0x30, oid_enc + null_enc)


# ── SNMPv2c PDU parser ────────────────────────────────────────────────────────

def _parse_length(data: bytes, pos: int):
    b = data[pos]
    pos += 1
    if b < 0x80:
        return b, pos
    n = b & 0x7F
    length = int.from_bytes(data[pos:pos+n], "big")
    return length, pos + n

def _parse_tlv(data: bytes, pos: int):
    tag = data[pos]; pos += 1
    length, pos = _parse_length(data, pos)
    value = data[pos:pos+length]
    return tag, value, pos + length

def _parse_oid(raw: bytes) -> str:
    parts = [raw[0] // 40, raw[0] % 40]
    i = 1
    while i < len(raw):
        val = 0
        while True:
            b = raw[i]; i += 1
            val = (val << 7) | (b & 0x7F)
            if not (b & 0x80):
                break
        parts.append(val)
    return "." + ".".join(str(x) for x in parts)

def _parse_int(raw: bytes) -> int:
    return int.from_bytes(raw, "big", signed=True)

def handle_request(data: bytes) -> bytes | None:
    try:
        pos = 0
        tag, seq_val, pos = _parse_tlv(data, pos)  # outer SEQUENCE
        pos2 = 0
        # version
        _, ver_raw, pos2 = _parse_tlv(seq_val, pos2)
        version = _parse_int(ver_raw)
        # community
        _, community_raw, pos2 = _parse_tlv(seq_val, pos2)
        community = community_raw.decode(errors="replace")
        if community != COMMUNITY:
            log.warning("Bad community: %s", community)
            return None
        # PDU
        pdu_tag, pdu_val, _ = _parse_tlv(seq_val, pos2)
        is_get = pdu_tag == 0xA0      # GetRequest
        is_getnext = pdu_tag == 0xA1  # GetNextRequest
        is_getbulk = pdu_tag == 0xA5  # GetBulkRequest
        if not (is_get or is_getnext or is_getbulk):
            return None

        p3 = 0
        _, req_id_raw, p3 = _parse_tlv(pdu_val, p3)
        req_id = req_id_raw
        _, err_st_raw, p3  = _parse_tlv(pdu_val, p3)  # error-status / non-repeaters
        _, err_ix_raw, p3  = _parse_tlv(pdu_val, p3)  # error-index  / max-repetitions
        max_reps = _parse_int(err_ix_raw) if is_getbulk else 1
        if max_reps < 1:
            max_reps = 10

        _, vbl_raw, _ = _parse_tlv(pdu_val, p3)  # VarBindList

        # Parse requested OIDs
        req_oids = []
        p4 = 0
        while p4 < len(vbl_raw):
            _, vb, p4 = _parse_tlv(vbl_raw, p4)
            _, oid_raw, _ = _parse_tlv(vb, 0)
            req_oids.append(_parse_oid(oid_raw))

        # Build response varbinds
        resp_vbs = b""
        err_status = 0
        err_index  = 0

        for idx, req_oid in enumerate(req_oids, 1):
            if is_get:
                if req_oid in MIB_DATA:
                    tag_v, val_v = MIB_DATA[req_oid]
                    resp_vbs += _make_varbind(req_oid, tag_v, val_v)
                else:
                    resp_vbs += _make_error_varbind(req_oid)
                    err_status = 2  # noSuchName
                    err_index  = idx
            else:  # GETNEXT / GETBULK
                reps = max_reps if is_getbulk else 1
                cur = req_oid
                for _ in range(reps):
                    nxt = None
                    for o in SORTED_OIDS:
                        if _oid_key(o) > _oid_key(cur):
                            nxt = o
                            break
                    if nxt is None:
                        # endOfMibView
                        resp_vbs += _encode_tlv(0x30,
                            _encode_tlv(0x06, _encode_oid(cur)) +
                            _encode_tlv(0x82, b""))
                        break
                    tag_v, val_v = MIB_DATA[nxt]
                    resp_vbs += _make_varbind(nxt, tag_v, val_v)
                    cur = nxt

        # Encode GetResponse PDU (0xA2)
        req_id_tlv  = _encode_tlv(0x02, req_id)
        err_st_tlv  = _encode_tlv(0x02, _encode_int(err_status))
        err_ix_tlv  = _encode_tlv(0x02, _encode_int(err_index))
        vbl_tlv     = _encode_tlv(0x30, resp_vbs)
        pdu         = _encode_tlv(0xA2, req_id_tlv + err_st_tlv + err_ix_tlv + vbl_tlv)

        ver_tlv  = _encode_tlv(0x02, _encode_int(1))  # v2c = 1
        comm_tlv = _encode_tlv(0x04, COMMUNITY.encode())
        return _encode_tlv(0x30, ver_tlv + comm_tlv + pdu)

    except Exception as e:
        log.error("Parse error: %s", e)
        return None


# ── Main loop ────────────────────────────────────────────────────────────────

def main():
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind(("0.0.0.0", PORT))
    log.info("EOC640 SNMP agent started — port=%d mode=%s OID=%s serial=%s",
             PORT, MODE, SYS_OID, DEV_SERIAL)
    while True:
        try:
            data, addr = sock.recvfrom(65535)
            resp = handle_request(data)
            if resp:
                sock.sendto(resp, addr)
        except Exception as e:
            log.error("Socket error: %s", e)

if __name__ == "__main__":
    main()
