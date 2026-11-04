#!/usr/bin/env python3
"""
EnGenius EOC655 SNMP Simulator  (SENAO-MIB / ENGENIUS-MIB)

Pure-Python SNMPv1/v2c agent simulating a real EnGenius EOC655 outdoor
wireless device as described by SENAO-MIB.mib uploaded via UBR NMS MIB Builder.

Enterprise OID:  1.3.6.1.4.1.14125         (EnGenius Networks)
UBR subtree:     1.3.6.1.4.1.14125.123     (EOC655 product range)
sysObjectID:     1.3.6.1.4.1.14125.123.2.2  (ptmp = outdoor Point-to-MultiPoint)

Mode is controlled by env vars:
  DEVICE_MODE    = BTS (default) or CPE
  DEVICE_NAME    = hostname, e.g. ENB-BTS-01
  DEVICE_IP      = IP shown in management OIDs
  SNMP_PORT      = UDP port to bind (default 1165)
  SNMP_COMMUNITY = community string (default "public")
  SSID           = wireless SSID (default "UBR-EOC655-SECTOR1")

Covers all major OID groups from SENAO-MIB.mib:
  - MIB-II system (sysDescr, sysObjectID, sysUpTime, sysName …)
  - wirelessTable  — radio config (mode, SSID, channel, power, bandwidth)
  - linkProfileTable — DDRS/ATPC parameters
  - networkIPAddress, netmask, gateway
  - sysInfoTable — CPU, memory, temperature, GPS, serial number
  - sysInventory — model, firmware version
  - wirelessStatsTable — Rx/Tx throughput, channel utilisation, RSSI
  - assocTable — per-peer statistics (MAC, IP, SNR, signal, throughput)

Test from host:
  snmpget  -v2c -c public -p 1165 localhost 1.3.6.1.2.1.1.2.0
  snmpwalk -v2c -c public -p 1165 localhost 1.3.6.1.4.1.14125.123

Discovery in NMS (from MIB Builder publish flow):
  1. MIB Builder → upload SENAO-MIB.mib → select fields → publish
  2. Discovery → select the published EnGenius screen
  3. Scope: host.docker.internal:1165
  4. Provision → Node View shows the custom Screen Builder layout
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
log = logging.getLogger("senao-snmp-agent")

PORT       = int(os.environ.get("SNMP_PORT",       "1165"))
COMMUNITY  = os.environ.get("SNMP_COMMUNITY",      "public")
MODE       = os.environ.get("DEVICE_MODE",          "BTS").upper()   # BTS or CPE
DEV_NAME   = os.environ.get("DEVICE_NAME",          f"ENB-{MODE}-01")
DEV_IP     = os.environ.get("DEVICE_IP",            "192.168.100.50")
SSID_STR   = os.environ.get("SSID",                 "UBR-EOC655-SECTOR1")
START_TIME = time.time()

# ── EnGenius enterprise OID tree ─────────────────────────────────────────────
ENT  = "1.3.6.1.4.1.14125"
UBR  = f"{ENT}.123"           # EOC655 subtree
OBJ  = f"{UBR}.1"             # objects
CFG  = f"{OBJ}.1"             # configuration
MGMT = f"{OBJ}.2"             # management
MON  = f"{OBJ}.3"             # monitor
PROD = f"{UBR}.2"             # products
SYS_OID = f"{PROD}.2"         # ptmp (outdoor Point-to-MultiPoint)

# ── Mode-specific values ──────────────────────────────────────────────────────
if MODE == "CPE":
    OPMODE      = b"sta"
    RADIO_MODE  = b"sta"
    MAX_SUS     = 0
    LINK_TYPE   = 1       # PTP
    DESCR       = f"EOC655 CPE v3.6.4 ({DEV_NAME}) EnGenius Networks sn:ENGCPE001".encode()
    PEER_MAC    = b"\x00\x26\x66\xAA\xBB\x01"
    PEER_IP     = b"\xc0\xa8\x64\x01"   # 192.168.100.1
    LOCAL_SNR   = 28
    REMOTE_SNR  = 30
    LOCAL_SIG   = -62
    REMOTE_SIG  = -60
else:  # BTS
    OPMODE      = b"ap"
    RADIO_MODE  = b"ap"
    MAX_SUS     = 16
    LINK_TYPE   = 3       # PTMP
    DESCR       = f"EOC655 BTS v3.6.4 ({DEV_NAME}) EnGenius Networks sn:ENGBTS001".encode()
    PEER_MAC    = b"\x00\x26\x66\xCC\xDD\x01"
    PEER_IP     = b"\xc0\xa8\x64\x64"   # 192.168.100.100
    LOCAL_SNR   = 32
    REMOTE_SNR  = 29
    LOCAL_SIG   = -58
    REMOTE_SIG  = -63

SSID = SSID_STR.encode()

def _ip2bytes(ip_str: str) -> bytes:
    try:
        return bytes(int(x) for x in ip_str.strip().split("."))
    except Exception:
        return b"\xc0\xa8\x64\x32"

# ── MIB data table ────────────────────────────────────────────────────────────
# Format: OID-string (dot-prefixed) → (type, value)
# Dynamic values can be callables: lambda → int/bytes

MIB_DATA = {
    # ══════════════════════════════════════════════════════════════════════════
    # MIB-II system group  (1.3.6.1.2.1.1.*)
    # ══════════════════════════════════════════════════════════════════════════
    ".1.3.6.1.2.1.1.1.0": ("OctetString", DESCR),
    ".1.3.6.1.2.1.1.2.0": ("ObjectIdentifier", SYS_OID),
    ".1.3.6.1.2.1.1.3.0": ("TimeTicks",   lambda: int((time.time() - START_TIME) * 100)),
    ".1.3.6.1.2.1.1.4.0": ("OctetString", b"noc@ubrnms.local"),
    ".1.3.6.1.2.1.1.5.0": ("OctetString", DEV_NAME.encode()),
    ".1.3.6.1.2.1.1.6.0": ("OctetString", b"UBR NMS EnGenius Simulator Lab"),

    # IF-MIB — chassis MAC for discovery fingerprinting
    ".1.3.6.1.2.1.2.2.1.2.1": ("OctetString", b"eth0"),
    ".1.3.6.1.2.1.2.2.1.6.1": ("OctetString", b"\x00\x26\x66\x14\x12\x50"),

    # ══════════════════════════════════════════════════════════════════════════
    # wirelessTable  CFG.1.1.1.*  (config → wireless → wirelessTable → entry)
    # Index: radioIndex=1 (single radio device)
    # ══════════════════════════════════════════════════════════════════════════
    f".{CFG}.1.1.1.2.1":  ("OctetString", RADIO_MODE),     # wirelessRadioMode
    f".{CFG}.1.1.1.3.1":  ("OctetString", SSID),           # wirelessSSID
    f".{CFG}.1.1.1.4.1":  ("Integer",     840),            # wirelessCountry (India)
    f".{CFG}.1.1.1.5.1":  ("OctetString", OPMODE),         # wirelessOpmode
    f".{CFG}.1.1.1.6.1":  ("OctetString", b"80"),          # wirelessSupportedBandwidths (read-only)
    f".{CFG}.1.1.1.7.1":  ("OctetString", b"80"),          # wirelessBandwidth
    f".{CFG}.1.1.1.8.1":  ("OctetString", b"36,40,44,48,149,153,157,161"), # wirelessSupportedChannels (ro)
    f".{CFG}.1.1.1.9.1":  ("OctetString", b"149"),         # wirelessChannel
    f".{CFG}.1.1.1.10.1": ("Integer",     3),              # wirelessAMSDU (3=4K)
    f".{CFG}.1.1.1.11.1": ("Integer",     0),              # wirelessUplinkLimit (0=unlimited)
    f".{CFG}.1.1.1.12.1": ("Integer",     0),              # wirelessDownlinkLimit
    f".{CFG}.1.1.1.13.1": ("Integer",     0),              # wirelessHideESSID (0=visible)
    f".{CFG}.1.1.1.14.1": ("OctetString", DEV_NAME.encode()),  # wirelessCustomerName
    f".{CFG}.1.1.1.15.1": ("OctetString", b"LINK-001"),    # wirelessLinkId
    f".{CFG}.1.1.1.16.1": ("OctetString", b"AES-256"),     # wirelessSecurityEncryption
    f".{CFG}.1.1.1.17.1": ("OctetString", b"<redacted>"),  # wirelessSecurityKey — never expose real key
    f".{CFG}.1.1.1.20.1": ("Integer",     1000),           # wirelessDistance (metres)
    f".{CFG}.1.1.1.21.1": ("Integer",     1),              # wirelessShortGI (1=enable)
    f".{CFG}.1.1.1.22.1": ("Integer",     3),              # wirelessRxChainmask (all chains)
    f".{CFG}.1.1.1.23.1": ("OctetString", b"149"),         # wirelessActiveChannel (ro)
    f".{CFG}.1.1.1.24.1": ("Integer",     20),             # wirelessAntennaGain (dBi)
    f".{CFG}.1.1.1.25.1": ("Integer",     5745),           # wirelessActiveFrequency (MHz)
    f".{CFG}.1.1.1.26.1": ("Integer",     0),              # wirelessTrafficShaping (0=off)
    f".{CFG}.1.1.1.27.1": ("Integer",     1),              # wirelessAMPDU (1=enable)
    f".{CFG}.1.1.1.28.1": ("Integer",     300),            # wirelessInactivityTimer (s)
    f".{CFG}.1.1.1.29.1": ("Integer",     3600),           # wirelessLinkInactivityTimer (s)
    f".{CFG}.1.1.1.30.1": ("Integer",     49),             # wirelessMaximumEIRP (dBm)
    f".{CFG}.1.1.1.31.1": ("Integer",     0),              # wirelessRate (0=auto)
    f".{CFG}.1.1.1.33.1": ("Integer",     0),              # wirelessRadioStatus (0=enable)
    f".{CFG}.1.1.1.35.1": ("Integer",     LINK_TYPE),      # wirelessLinktype (1=PTP,3=PTMP)
    f".{CFG}.1.1.1.37.1": ("Integer",     MAX_SUS),        # wirelessMaximumSUs
    f".{CFG}.1.1.1.51.1": ("OctetString", b"80"),          # wirelessActiveBandwidth (ro)
    f".{CFG}.1.1.1.57.1": ("Integer",     75),             # wirelessDlUlRatio (75/25)

    # ══════════════════════════════════════════════════════════════════════════
    # linkProfileTable  CFG.1.1.2.*  (DDRS / ATPC link profiles)
    # Index: profileIndex=1, secIndex=1
    # ══════════════════════════════════════════════════════════════════════════
    f".{CFG}.1.1.2.1.1.1":  ("Integer", 1),    # linkProfileIndex
    f".{CFG}.1.1.2.1.1.2":  ("Integer", 1),    # linkProfileSecIndex
    f".{CFG}.1.1.2.1.1.3":  ("Integer", 1),    # linkProfileDDRSStatus (1=enable)
    f".{CFG}.1.1.2.1.1.4":  ("Integer", 0),    # linkProfileSpatialStream
    f".{CFG}.1.1.2.1.1.5":  ("Integer", 0),    # linkProfileDDRSMinRate (MCS0)
    f".{CFG}.1.1.2.1.1.6":  ("Integer", 11),   # linkProfileDDRSMaxRate (MCS11)
    f".{CFG}.1.1.2.1.1.11": ("Integer", 0),    # linkProfileATPCStatus (0=disable)
    f".{CFG}.1.1.2.1.1.12": ("Integer", 26),   # linkProfilePower (dBm)

    # ══════════════════════════════════════════════════════════════════════════
    # dcsTable  CFG.1.1.3.*  (Dynamic Channel Selection)
    # ══════════════════════════════════════════════════════════════════════════
    f".{CFG}.1.1.3.1.1":  ("Integer", 1),     # dcsIndex
    f".{CFG}.1.1.3.1.2":  ("Integer", 0),     # dcsStatus (0=disable)
    f".{CFG}.1.1.3.1.3":  ("Integer", 25),    # dcsThreshold (%)
    f".{CFG}.1.1.3.1.4":  ("Integer", 0),     # dcsSelection (0=auto)
    f".{CFG}.1.1.3.1.5":  ("OctetString", b"149,153,157,161"),  # dcsFreqList
    f".{CFG}.1.1.3.1.11": ("Integer", 0),     # dcsBackgroundScan (0=off)

    # ══════════════════════════════════════════════════════════════════════════
    # networkIPAddress group  CFG.2.*  (IP config — scalar OIDs)
    # ══════════════════════════════════════════════════════════════════════════
    f".{CFG}.2.1.0":  ("Integer",     0),                              # networkAddressType (0=static)
    f".{CFG}.2.2.0":  ("OctetString", _ip2bytes(DEV_IP)),              # networkIPAddress
    f".{CFG}.2.3.0":  ("OctetString", b"\xff\xff\xff\x00"),            # networkNetMask (255.255.255.0)
    f".{CFG}.2.4.0":  ("OctetString", _ip2bytes(DEV_IP[:-2] + "1") if DEV_IP.count(".") == 3 else b"\xc0\xa8\x64\x01"),  # networkGateway
    f".{CFG}.2.5.0":  ("OctetString", b"\x08\x08\x08\x08"),           # networkDNSIP (8.8.8.8)
    f".{CFG}.2.7.0":  ("Integer",     0),                              # networkMode (0=router)

    # ══════════════════════════════════════════════════════════════════════════
    # VLAN group  CFG.4.*
    # ══════════════════════════════════════════════════════════════════════════
    f".{CFG}.4.1.0":  ("Integer", 0),    # vlanStatus (0=disable)
    f".{CFG}.4.2.0":  ("Integer", 0),    # vlanMode (0=access)

    # ══════════════════════════════════════════════════════════════════════════
    # Management — sysInfoTable  MGMT.2.*
    # ══════════════════════════════════════════════════════════════════════════
    f".{MGMT}.2.1.0":  ("OctetString", DEV_NAME.encode()),             # sysInfoName
    f".{MGMT}.2.2.0":  ("OctetString", b"UBR NMS Simulator Site"),    # sysInfoLocation
    f".{MGMT}.2.3.0":  ("OctetString", b"noc@ubrnms.local"),          # sysInfoContact
    f".{MGMT}.2.4.0":  ("OctetString", DESCR),                        # sysInfoDescription
    f".{MGMT}.2.5.0":  ("OctetString", b"17.385044"),                  # sysInfoGeolat
    f".{MGMT}.2.6.0":  ("OctetString", b"78.486671"),                  # sysInfoGeolong
    f".{MGMT}.2.7.0":  ("Integer",     42),                            # sysInfoTemperature (°C)
    f".{MGMT}.2.8.0":  ("OctetString", b"admin@ubrnms.local"),        # sysInfoEmail
    f".{MGMT}.2.9.0":  ("OctetString", b"BST-001"),                   # sysInfoBaseStationID
    f".{MGMT}.2.13.0": ("Integer",     lambda: 25 + int((time.time() % 60) / 10)),  # sysInfoCPUUsage (%)
    f".{MGMT}.2.14.0": ("Integer",     58),                            # sysInfoMemoryUsage (%)
    f".{MGMT}.2.15.0": ("OctetString", b"120"),                        # sysInfoGeoAltitude (m)

    # ══════════════════════════════════════════════════════════════════════════
    # Management — sysInventory  MGMT.3.*
    # ══════════════════════════════════════════════════════════════════════════
    f".{MGMT}.3.1.0":  ("OctetString", b"ENG655001234"),               # sysInventorySerialNo
    f".{MGMT}.3.2.0":  ("OctetString", b"EOC655"),                     # sysInventoryModel
    f".{MGMT}.3.3.0":  ("OctetString", b"3"),                          # sysInventoryRelnum
    f".{MGMT}.3.4.0":  ("OctetString", b"6"),                          # sysInventoryMajnum
    f".{MGMT}.3.5.0":  ("OctetString", b"4"),                          # sysInventoryMinnum
    f".{MGMT}.3.6.0":  ("OctetString", b"EOC655-PTMP"),                # sysInventoryProductid
    f".{MGMT}.3.7.0":  ("OctetString", b"20241001"),                   # sysInventoryBuildno
    f".{MGMT}.3.8.0":  ("Integer",     MAX_SUS),                       # sysInventoryMaxsu
    f".{MGMT}.3.9.0":  ("OctetString", b"v2.0"),                       # sysInventoryHardwareVersion
    f".{MGMT}.3.10.0": ("Integer",     20),                            # sysInventoryAntennagain1 (dBi)
    f".{MGMT}.3.11.0": ("Integer",     20),                            # sysInventoryAntennagain2 (dBi)
    f".{MGMT}.3.14.0": ("OctetString", b"UBRCUST001"),                 # sysInventoryCustomerID
    f".{MGMT}.3.15.0": ("OctetString", b"BL-3.6.4"),                   # sysInventoryBootloaderVersion
    f".{MGMT}.3.16.0": ("OctetString", b"EOC655"),                     # sysInventoryModelName

    # Management — NTP  MGMT.6.*
    f".{MGMT}.6.1.0":  ("Integer",     1),                             # ntpStatus (1=enable)
    f".{MGMT}.6.2.0":  ("OctetString", b"pool.ntp.org"),              # ntpServerAddress
    f".{MGMT}.6.3.0":  ("OctetString", b"Asia/Kolkata"),              # ntpTimeZone

    # Management — SNMP config  MGMT.13.*
    f".{MGMT}.13.1.0": ("Integer",     1),    # snmpStatus (1=enable)
    f".{MGMT}.13.2.0": ("Integer",     2),    # snmpVersion (2=v2c)

    # ══════════════════════════════════════════════════════════════════════════
    # Monitor — wirelessStatsTable  MON.1.*
    # Row index: radioIndex=1
    # ══════════════════════════════════════════════════════════════════════════
    f".{MON}.1.1.1.1":  ("Integer",     1),                            # wirelessStatsRadioIndex
    f".{MON}.1.1.2.1":  ("OctetString", b"\x00\x26\x66\x14\x12\x50"),  # wirelessStatsMACAddress
    f".{MON}.1.1.3.1":  ("Integer",     lambda: 1 + int(time.time() % 4)),  # wirelessStatsRemotePartners
    f".{MON}.1.1.4.1":  ("Integer",     lambda: 150000 + int(time.time() % 1000)),  # wirelessStatsDataTxTotalPackets
    f".{MON}.1.1.5.1":  ("Integer",     lambda: 148000 + int(time.time() % 1000)),  # wirelessStatsDataRxTotalPackets
    f".{MON}.1.1.30.1": ("Integer",     lambda: 85000 + int((time.time() % 60) * 100)),   # wirelessStatsTxThroughput (kbps)
    f".{MON}.1.1.31.1": ("Integer",     lambda: 72000 + int((time.time() % 60) * 80)),    # wirelessStatsRxThroughput (kbps)
    f".{MON}.1.1.34.1": ("Integer",     lambda: 1200 + int(time.time() % 200)),   # wirelessStatsTxPPS
    f".{MON}.1.1.35.1": ("Integer",     lambda: 1100 + int(time.time() % 180)),   # wirelessStatsRxPPS
    f".{MON}.1.1.36.1": ("OctetString", b"\x00\x26\x66\x14\x12\x50"),  # wirelessStatsAthMACAddress
    f".{MON}.1.1.37.1": ("Integer",     lambda: 2 + int((time.time() % 20))),     # wirelessStatsRTXPercent (%)
    f".{MON}.1.1.38.1": ("Integer",     lambda: 15 + int((time.time() % 10))),    # wirelessStatsChanUtil (%)
    f".{MON}.1.1.39.1": ("Integer",     lambda: 3 + int((time.time() % 5))),      # wirelessStatsOBSS (%)
    f".{MON}.1.1.40.1": ("Integer",     550),   # wirelessStatsCapacity (Mbps)
    f".{MON}.1.1.41.1": ("Integer",     lambda: 480000 + int((time.time() % 60) * 500)),  # wirelessStatsIncomingBW (kbps)

    # ══════════════════════════════════════════════════════════════════════════
    # Monitor — assocTable  MON.3.*
    # assocTable is indexed by { assocRadioIndex, assocSecIndex } — two indices.
    # Instance OID format: column.radioIndex.secIndex  → suffix .1.1 for first peer.
    # ══════════════════════════════════════════════════════════════════════════
    f".{MON}.3.1.1.1.1":  ("Integer",     1),                           # assocRadioIndex
    f".{MON}.3.1.2.1.1":  ("Integer",     1),                           # assocSecIndex
    f".{MON}.3.1.3.1.1":  ("OctetString", PEER_MAC),                   # assocMAC
    f".{MON}.3.1.4.1.1":  ("OctetString", PEER_IP),                    # assocIP
    f".{MON}.3.1.5.1.1":  ("OctetString", b"17.388000"),                # assocRemoteLat
    f".{MON}.3.1.6.1.1":  ("OctetString", b"78.491000"),                # assocRemoteLong
    f".{MON}.3.1.7.1.1":  ("OctetString", b"17.385044"),                # assocLocalLat
    f".{MON}.3.1.8.1.1":  ("OctetString", b"78.486671"),                # assocLocalLong
    f".{MON}.3.1.9.1.1":  ("Integer",     lambda: 450 + int((time.time() % 60) * 5)),   # assocRxRate (Mbps*10)
    f".{MON}.3.1.10.1.1": ("Integer",     lambda: 480 + int((time.time() % 60) * 5)),   # assocTxRate (Mbps*10)
    f".{MON}.3.1.11.1.1": ("Integer",     lambda: 72000 + int((time.time() % 60) * 80)),  # assocRxTput (kbps)
    f".{MON}.3.1.12.1.1": ("Integer",     lambda: 85000 + int((time.time() % 60) * 100)), # assocTxTput (kbps)
    f".{MON}.3.1.13.1.1": ("Integer",     LOCAL_SNR),                  # assocLocalSNRA1 (dB)
    f".{MON}.3.1.14.1.1": ("Integer",     LOCAL_SNR - 1),              # assocLocalSNRA2 (dB)
    f".{MON}.3.1.15.1.1": ("Integer",     REMOTE_SNR),                 # assocRemoteSNRA1 (dB)
    f".{MON}.3.1.16.1.1": ("Integer",     REMOTE_SNR - 2),             # assocRemoteSNRA2 (dB)
    f".{MON}.3.1.17.1.1": ("Integer",     lambda: 2 + int(time.time() % 5)),   # assocLocalPhyErr
    f".{MON}.3.1.18.1.1": ("Integer",     lambda: 1 + int(time.time() % 3)),   # assocRemotePhyErr
    f".{MON}.3.1.19.1.1": ("Integer",     lambda: 1 + int(time.time() % 4)),   # assocLocalMPDUErr
    f".{MON}.3.1.20.1.1": ("Integer",     lambda: 1 + int(time.time() % 3)),   # assocRemoteMPDUErr
    f".{MON}.3.1.21.1.1": ("Integer",     lambda: 3 + int(time.time() % 5)),   # assocLocalRetries
    f".{MON}.3.1.22.1.1": ("Integer",     lambda: 2 + int(time.time() % 4)),   # assocRemoteRetries
    f".{MON}.3.1.23.1.1": ("Integer",     lambda: 15000 + int(time.time() % 100)), # assocLocalTxPackets
    f".{MON}.3.1.24.1.1": ("Integer",     lambda: 14800 + int(time.time() % 100)), # assocLocalRxPackets
    f".{MON}.3.1.26.1.1": ("Integer",     LOCAL_SNR - 2),              # assocLocalNoiseFloor (dBm)
    f".{MON}.3.1.27.1.1": ("Integer",     REMOTE_SNR - 3),             # assocRemoteNoiseFloor (dBm)
    f".{MON}.3.1.28.1.1": ("OctetString", DEV_NAME.encode()),           # assocLocalCustomername
    f".{MON}.3.1.29.1.1": ("OctetString", b"PEER-NODE-01"),             # assocRemoteCustomername
    f".{MON}.3.1.30.1.1": ("OctetString", b"LINK-001"),                 # assocLocalLinkid
    f".{MON}.3.1.31.1.1": ("OctetString", b"LINK-001"),                 # assocRemoteLinkid
    f".{MON}.3.1.33.1.1": ("Integer",     0),                           # assocDisconnect (0=connected)
    f".{MON}.3.1.34.1.1": ("Integer",     lambda: LOCAL_SNR + 1),       # assocCombRSSI (composite)
    f".{MON}.3.1.35.1.1": ("Integer",     LOCAL_SIG),                  # assocLocalSignalA1 (dBm)
    f".{MON}.3.1.36.1.1": ("Integer",     LOCAL_SIG - 1),              # assocLocalSignalA2 (dBm)
    f".{MON}.3.1.37.1.1": ("Integer",     REMOTE_SIG),                 # assocRemoteSignalA1 (dBm)
    f".{MON}.3.1.38.1.1": ("Integer",     REMOTE_SIG - 1),             # assocRemoteSignalA2 (dBm)
    f".{MON}.3.1.39.1.1": ("Integer",     LOCAL_SNR + 2),              # assocLocalTxPower (dBm)
    f".{MON}.3.1.40.1.1": ("Integer",     REMOTE_SNR + 1),             # assocRemoteTxPower (dBm)
    f".{MON}.3.1.41.1.1": ("Integer",     20),                          # assocLocalAntennaGain (dBi)
    f".{MON}.3.1.42.1.1": ("Integer",     20),                          # assocRemoteAntennaGain (dBi)
    f".{MON}.3.1.43.1.1": ("Integer",     lambda: 150000 + int(time.time() % 1000)), # assocLocalTotalTxPackets
    f".{MON}.3.1.44.1.1": ("Integer",     lambda: 148000 + int(time.time() % 1000)), # assocLocalTotalRxPackets
    f".{MON}.3.1.45.1.1": ("Integer",     lambda: 148000 + int(time.time() % 900)),  # assocRemoteTotalTxPackets
    f".{MON}.3.1.46.1.1": ("Integer",     lambda: 150000 + int(time.time() % 900)),  # assocRemoteTotalRxPackets
    f".{MON}.3.1.47.1.1": ("Integer",     lambda: 2 + int(time.time() % 4)),   # assocLocalRTXPercent (%)
    f".{MON}.3.1.48.1.1": ("Integer",     lambda: 2 + int(time.time() % 3)),   # assocRemoteRTXPercent (%)
    f".{MON}.3.1.50.1.1": ("Integer",     lambda: int(time.time() % 20)),       # assocLocalDropped
    f".{MON}.3.1.51.1.1": ("Integer",     lambda: int(time.time() % 15)),       # assocRemoteDropped
    f".{MON}.3.1.52.1.1": ("Integer",     lambda: int((time.time() - START_TIME) * 100)), # assocLinkUptime (ticks)
    f".{MON}.3.1.53.1.1": ("Integer",     9),    # assocLocalTxMCSIndex (MCS9)
    f".{MON}.3.1.54.1.1": ("Integer",     1200), # assocLinkDistance (metres)
    f".{MON}.3.1.65.1.1": ("Integer",     9),    # assocLocalModulationScheme (MCS9)
    f".{MON}.3.1.66.1.1": ("Integer",     9),    # assocRemoteModulationScheme
    f".{MON}.3.1.70.1.1": ("Integer",     lambda: int(time.time() % 5) + 1),   # assocLocalMaxLatency (ms)
    f".{MON}.3.1.71.1.1": ("Integer",     lambda: int(time.time() % 3) + 1),   # assocLocalAvgLatency (ms)
    f".{MON}.3.1.72.1.1": ("Integer",     lambda: 25 + int(time.time() % 10)), # assocLocalCPUUsage (%)
    f".{MON}.3.1.73.1.1": ("Integer",     58),   # assocLocalMemoryUsage (%)
    f".{MON}.3.1.74.1.1": ("Integer",     lambda: 15 + int(time.time() % 10)), # assocRemoteChanUtil (%)
    f".{MON}.3.1.75.1.1": ("Integer",     lambda: 15 + int(time.time() % 10)), # assocLocalChanUtil (%)
    f".{MON}.3.1.84.1.1": ("Integer",     550),  # assocLinkCapacity (Mbps)
    f".{MON}.3.1.85.1.1": ("Integer",     lambda: 480000 + int(time.time() % 1000)), # assocLinkIncomingBw (kbps)

    # Monitor — Ethernet stats table  MON.2.*
    f".{MON}.2.1.1.1":  ("Integer",     1),     # ethernetStatsIndex
    f".{MON}.2.1.2.1":  ("Integer",     1),     # ethernetStatus (1=up)
    f".{MON}.2.1.3.1":  ("OctetString", b"\x00\x26\x66\x14\x12\x50"),  # ethernetMACAddress
    f".{MON}.2.1.4.1":  ("Integer",     1000),  # ethernetSpeed (Mbps)
    f".{MON}.2.1.5.1":  ("Integer",     1),     # ethernetDuplex (1=full)
    f".{MON}.2.1.7.1":  ("Integer",     lambda: 200000 + int(time.time() % 5000)),  # ethernetRxTotalPackets
    f".{MON}.2.1.8.1":  ("Integer",     lambda: 190000 + int(time.time() % 5000)),  # ethernetTxTotalBytes
    f".{MON}.2.1.9.1":  ("Integer",     lambda: 1200000 + int(time.time() % 10000)), # ethernetRxTotalBytes
    f".{MON}.2.1.29.1": ("Integer",     lambda: 85000 + int(time.time() % 500)),    # ethernetTxThroughput (kbps)
    f".{MON}.2.1.30.1": ("Integer",     lambda: 75000 + int(time.time() % 400)),    # ethernetRxThroughput (kbps)
}

# ── BER encoder ───────────────────────────────────────────────────────────────

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
    negative = val < 0
    if negative:
        val = (-val - 1)
    result = []
    while val > 0:
        result.append(val & 0xFF)
        val >>= 8
    if negative:
        result = [b ^ 0xFF for b in result]
        if not result or result[-1] < 0x80:
            result.append(0xFF)
    else:
        if result and result[-1] & 0x80:
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

def snmp_integer(val: int)       -> bytes: return tlv(0x02, encode_int(int(val)))
def snmp_octet_string(val: bytes)-> bytes: return tlv(0x04, val)
def snmp_oid(oid_str: str)       -> bytes: return tlv(0x06, encode_oid(oid_str))
def snmp_timeticks(val: int)     -> bytes: return tlv(0x43, encode_int(val & 0xFFFFFFFF))
def snmp_gauge32(val: int)       -> bytes: return tlv(0x42, encode_int(val & 0xFFFFFFFF))
def snmp_sequence(data: bytes)   -> bytes: return tlv(0x30, data)

def snmp_varbind(oid_str: str, val_type: str, val) -> bytes:
    oid_bytes = snmp_oid(oid_str)
    # Resolve dynamic (callable) values
    if callable(val):
        val = val()
    if val_type == "OctetString":
        value_bytes = snmp_octet_string(val if isinstance(val, bytes) else str(val).encode())
    elif val_type == "ObjectIdentifier":
        value_bytes = snmp_oid(val)
    elif val_type == "TimeTicks":
        ticks = int(val) & 0xFFFFFFFF if not callable(val) else int(val()) & 0xFFFFFFFF
        value_bytes = snmp_timeticks(ticks)
    elif val_type in ("Integer", "Gauge32", "Counter32"):
        value_bytes = snmp_integer(int(val))
    elif val_type == "IpAddress":
        value_bytes = tlv(0x40, val if isinstance(val, bytes) else _ip2bytes(str(val)))
    else:
        value_bytes = b"\x05\x00"
    return snmp_sequence(oid_bytes + value_bytes)

# ── BER decoder ───────────────────────────────────────────────────────────────

def decode_length(data: bytes, offset: int):
    length = data[offset]; offset += 1
    if length & 0x80:
        n_bytes = length & 0x7F
        length = 0
        for _ in range(n_bytes):
            length = (length << 8) | data[offset]; offset += 1
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

# ── SNMP PDU constants ────────────────────────────────────────────────────────

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
        _, _, offset = decode_tlv(msg, offset)                    # version
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
        _, _, pdu_offset = decode_tlv(pdu, pdu_offset)            # error-status / non-repeaters
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
    return snmp_sequence(snmp_integer(1) + snmp_octet_string(community.encode()) + pdu)

def _resolve_varbind(oid_str: str) -> bytes:
    key = oid_str if oid_str.startswith(".") else "." + oid_str
    entry = MIB_DATA.get(key)
    if entry:
        return snmp_varbind(oid_str.lstrip("."), entry[0], entry[1])
    return snmp_sequence(snmp_oid(oid_str.lstrip(".")) + bytes([0x80, 0x00]))  # noSuchObject

def resolve_get(oids: list) -> bytes:
    return b"".join(_resolve_varbind(oid) for oid in oids)

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

# ── UDP agent ─────────────────────────────────────────────────────────────────

PDU_NAMES = {PDU_GET: "GET", PDU_GETNEXT: "GETNEXT", PDU_GETBULK: "GETBULK"}

def run_agent():
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind(("0.0.0.0", PORT))

    log.info("=" * 70)
    log.info(f"EnGenius EOC655 SNMP Simulator  (SENAO-MIB)  [{MODE} mode]")
    log.info(f"Device   : {DEV_NAME}   IP: {DEV_IP}")
    log.info(f"sysOID   : .{SYS_OID}   (Enterprise: .{ENT})")
    log.info(f"Community: {COMMUNITY}   Port: {PORT}/udp")
    log.info(f"OIDs     : {len(MIB_DATA)}")
    log.info("-" * 70)
    log.info("Quick tests from host:")
    log.info(f"  snmpget  -v2c -c {COMMUNITY} -p {PORT} localhost 1.3.6.1.2.1.1.2.0")
    log.info(f"  snmpwalk -v2c -c {COMMUNITY} -p {PORT} localhost {UBR}")
    log.info("NMS Discovery (from MIB Builder flow):")
    log.info(f"  Scope: host.docker.internal:{PORT}  Community: {COMMUNITY}")
    log.info("=" * 70)

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
            log.info(f"{pdu_name} {addr[0]}:{addr[1]} OIDs={oids[:3]}{'…' if len(oids) > 3 else ''}")

            if pdu_type == PDU_GET:
                varbinds = resolve_get(oids)
            elif pdu_type == PDU_GETNEXT:
                varbinds = resolve_getnext(oids)
            elif pdu_type == PDU_GETBULK:
                varbinds = resolve_getbulk(oids, max_reps)
            else:
                continue

            sock.sendto(build_snmp_response(community, req_id, varbinds), addr)
        except Exception as e:
            log.error(f"agent error: {e}")

if __name__ == "__main__":
    run_agent()
