/**
 * V2 Configuration Management — NMS-CF-01 to CF-05
 *
 * Tabs:
 *  1. Templates     — CRUD config templates, mark as default (CF-02/05)
 *  2. Push Config   — Push template to single device or bulk (CF-01/03)
 *  3. Firmware      — Firmware upgrade individual or bulk (CF-01 item 10)
 *  4. Jobs          — Live job status tracker
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchTemplates, createTemplate, updateTemplate, deleteTemplate,
  pushConfig, bulkPush, getJobStatus, getVersionHistory,
  pushFirmware, bulkFirmware,
  fetchDefinitionParams,
} from '../../api/config.api';
import type { DefinitionParam, OidSetItem } from '../../api/config.api';
import type { ConfigTemplate, ConfigJob, ConfigVersion, PushResult, SnmpSetItem, CustomFieldEntry } from '../../api/config.types';
import { validateTemplate } from '../../api/config.types';
import { fetchDevices } from '../../api/devices.api';
import type { Device } from '../../api/devices.types';
import {
  listAllUploadHistory,
  getVersionSchema,
} from '../../api/productDefinitions.api';
import type { ProductDefinitionSchema } from '../../api/productDefinitions.api';
import type { ProductDefinitionVersion } from '../../api/productDefinitions.types';
import { Badge } from '../components/common/Badge';
import { Button } from '../components/common/Button';
import { Input } from '../components/common/Input';
import { Select } from '../components/common/Select';
import { Modal } from '../components/common/Modal';
import { MetricCard } from '../components/common/MetricCard';
import { LoadingState, EmptyState } from '../components/common/States';
import { useToast } from '../components/common/Toast';
import { logger } from '../utils/logger';

type ConfigTab = 'templates' | 'push' | 'firmware' | 'jobs';

function TabBtn({ id, active, label, onClick }: { id: ConfigTab; active: boolean; label: string; onClick: (t: ConfigTab) => void }) {
  return (
    <button onClick={() => onClick(id)}
      style={{
        padding: '10px 18px', border: 'none', background: 'none', cursor: 'pointer',
        fontSize: 13, fontWeight: active ? 700 : 500, whiteSpace: 'nowrap',
        color: active ? 'var(--vf-accent)' : 'var(--vf-text-secondary)',
        borderBottom: active ? '2px solid var(--vf-accent)' : '2px solid transparent',
      }}>
      {label}
    </button>
  );
}

function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <label style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--vf-text-muted)' }}>{label}</label>
      {children}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Device-type field definitions (NMS-CF-01)
// ═══════════════════════════════════════════════════════════════════════════════
type FieldDef = {
  key: string; label: string; type: 'text' | 'number' | 'select' | 'boolean';
  options?: string[]; min?: number; max?: number; unit?: string; placeholder?: string;
  showIf?: (params: Record<string, string | number | boolean>) => boolean;
};

type SectionDef = { title: string; icon: string; fields: FieldDef[] };

const BTS_SECTIONS: SectionDef[] = [
  {
    title: 'Wireless (SSID)', icon: '📶',
    fields: [
      { key: 'ssid5',    label: 'SSID (5 GHz)',         type: 'text',   placeholder: 'Airtel_UBR_5G' },
      { key: 'wpaKey5',  label: 'WPA Key (5 GHz)',      type: 'text',   placeholder: 'passphrase (8–63 chars)' },
      { key: 'ssid24',   label: 'SSID (2.4 GHz)',       type: 'text',   placeholder: 'Airtel_UBR_2G' },
      { key: 'wpaKey24', label: 'WPA Key (2.4 GHz)',    type: 'text',   placeholder: 'passphrase (8–63 chars)' },
    ],
  },
  {
    title: 'Radio (RF)', icon: '📡',
    fields: [
      { key: 'txPowerDbm',          label: 'TX Power',             type: 'number', min: 0,  max: 30,   unit: 'dBm', placeholder: '23' },
      { key: 'operatingChannel',    label: 'Channel',              type: 'select', options: ['36','40','44','48','52','56','60','64','100','104','108','112','116','120','124','128','132','136','140'] },
      { key: 'channelBandwidthMHz', label: 'Channel Bandwidth',    type: 'select', options: ['20','40','80','160'], unit: 'MHz' },
      { key: 'beaconInterval',      label: 'Beacon Interval',      type: 'number', min: 100, max: 1000, unit: 'ms', placeholder: '100' },
      { key: 'dtimPeriod',          label: 'DTIM Period',          type: 'number', min: 1,   max: 10,   placeholder: '1' },
      { key: 'shortGuardInterval',  label: 'Short Guard Interval', type: 'boolean' },
      { key: 'bandSteering',        label: 'Band Steering',        type: 'boolean' },
    ],
  },
  {
    title: 'Ethernet', icon: '🔌',
    fields: [
      { key: 'ethernetSpeed', label: 'Speed / Duplex', type: 'select', options: ['Auto','100Mbps Half','100Mbps Full','1000Mbps Full'] },
      { key: 'ethernetPort0', label: 'Port 0 (eth0) Enabled', type: 'boolean' },
      { key: 'ethernetPort1', label: 'Port 1 (eth1) Enabled', type: 'boolean' },
    ],
  },
  {
    title: 'Network (IP)', icon: '🌐',
    fields: [
      { key: 'ipMode',    label: 'IP Mode',    type: 'select', options: ['DHCP','Static','SLAAC'] },
      { key: 'ipAddress', label: 'IP Address', type: 'text',   placeholder: '10.10.1.1',
        showIf: (p) => p.ipMode === 'Static' },
      { key: 'subnetMask',label: 'Subnet Mask',type: 'text',   placeholder: '255.255.255.0',
        showIf: (p) => p.ipMode === 'Static' },
      { key: 'gateway',   label: 'Gateway',    type: 'text',   placeholder: '10.10.1.254',
        showIf: (p) => p.ipMode === 'Static' },
      { key: 'dnsServer1',label: 'DNS Server 1',type: 'text',  placeholder: '8.8.8.8' },
      { key: 'dnsServer2',label: 'DNS Server 2',type: 'text',  placeholder: '8.8.4.4' },
    ],
  },
  {
    title: 'VLAN', icon: '🔀',
    fields: [
      { key: 'vlanMode',    label: 'VLAN Mode',     type: 'select', options: ['None','Single','Double'] },
      { key: 'vlanId',      label: 'VLAN ID',       type: 'number', min: 1, max: 4094, placeholder: '100',
        showIf: (p) => p.vlanMode === 'Single' || p.vlanMode === 'Double' },
      { key: 'outerVlanId', label: 'Outer VLAN ID', type: 'number', min: 1, max: 4094, placeholder: '200',
        showIf: (p) => p.vlanMode === 'Double' },
      { key: 'vlanPriority',label: 'VLAN Priority', type: 'number', min: 0, max: 7, placeholder: '0' },
    ],
  },
  {
    title: 'QoS', icon: '⚡',
    fields: [
      { key: 'qosProfile',       label: 'QoS Profile',        type: 'select', options: ['BEST_EFFORT','AF11','AF21','AF31','EF','CS6'] },
      { key: 'ulBandwidthLimit', label: 'UL Bandwidth Limit', type: 'number', min: 0, max: 10000, unit: 'Mbps', placeholder: '100' },
      { key: 'dlBandwidthLimit', label: 'DL Bandwidth Limit', type: 'number', min: 0, max: 10000, unit: 'Mbps', placeholder: '200' },
    ],
  },
  {
    title: 'Management', icon: '🛠',
    fields: [
      { key: 'snmpCommunity', label: 'SNMP Community', type: 'text',   placeholder: 'public' },
      { key: 'snmpTrapHost',  label: 'SNMP Trap Host', type: 'text',   placeholder: '10.0.0.1' },
      { key: 'ntpServer',     label: 'NTP Server',     type: 'text',   placeholder: 'pool.ntp.org' },
      { key: 'timezone',      label: 'Timezone',       type: 'text',   placeholder: 'Asia/Kolkata' },
      { key: 'syslogServer',  label: 'Syslog Server',  type: 'text',   placeholder: '10.0.0.2' },
      { key: 'logLevel',      label: 'Log Level',      type: 'select', options: ['DEBUG','INFO','WARN','ERROR'] },
      { key: 'httpPort',      label: 'HTTP Port',      type: 'number', min: 1, max: 65535, placeholder: '80' },
      { key: 'httpsPort',     label: 'HTTPS Port',     type: 'number', min: 1, max: 65535, placeholder: '443' },
    ],
  },
];

const CPE_SECTIONS: SectionDef[] = [
  {
    title: 'Wireless (SSID)', icon: '📶',
    fields: [
      { key: 'ssid5',    label: 'SSID (5 GHz)',      type: 'text', placeholder: 'Airtel_UBR_5G' },
      { key: 'wpaKey5',  label: 'WPA Key (5 GHz)',   type: 'text', placeholder: 'passphrase (8–63 chars)' },
      { key: 'ssid24',   label: 'SSID (2.4 GHz)',    type: 'text', placeholder: 'Airtel_UBR_2G' },
      { key: 'wpaKey24', label: 'WPA Key (2.4 GHz)', type: 'text', placeholder: 'passphrase (8–63 chars)' },
    ],
  },
  {
    title: 'Ethernet', icon: '🔌',
    fields: [
      { key: 'ethernetSpeed', label: 'Speed / Duplex',          type: 'select', options: ['Auto','100Mbps Half','100Mbps Full','1000Mbps Full'] },
      { key: 'ethernetPort0', label: 'Port 0 (eth0) Enabled',   type: 'boolean' },
    ],
  },
  {
    title: 'Network (IP)', icon: '🌐',
    fields: [
      { key: 'ipMode',    label: 'IP Mode',    type: 'select', options: ['DHCP','Static','SLAAC'] },
      { key: 'ipAddress', label: 'IP Address', type: 'text',   placeholder: '10.30.1.100',
        showIf: (p) => p.ipMode === 'Static' },
      { key: 'subnetMask',label: 'Subnet Mask',type: 'text',   placeholder: '255.255.255.0',
        showIf: (p) => p.ipMode === 'Static' },
      { key: 'gateway',   label: 'Gateway',    type: 'text',   placeholder: '10.30.1.254',
        showIf: (p) => p.ipMode === 'Static' },
      { key: 'dnsServer', label: 'DNS Server', type: 'text',   placeholder: '8.8.8.8' },
    ],
  },
  {
    title: 'VLAN', icon: '🔀',
    fields: [
      { key: 'vlanMode',    label: 'VLAN Mode',     type: 'select', options: ['None','Single','Double'] },
      { key: 'vlanId',      label: 'VLAN ID',       type: 'number', min: 1, max: 4094, placeholder: '100',
        showIf: (p) => p.vlanMode === 'Single' || p.vlanMode === 'Double' },
      { key: 'outerVlanId', label: 'Outer VLAN ID', type: 'number', min: 1, max: 4094, placeholder: '200',
        showIf: (p) => p.vlanMode === 'Double' },
      { key: 'vlanPriority',label: 'VLAN Priority', type: 'number', min: 0, max: 7,   placeholder: '0' },
    ],
  },
  {
    title: 'QoS', icon: '⚡',
    fields: [
      { key: 'qosProfile',       label: 'QoS Profile',        type: 'select', options: ['BEST_EFFORT','AF11','AF21','AF31','EF'] },
      { key: 'ulBandwidthLimit', label: 'UL Bandwidth Limit', type: 'number', min: 0, max: 1000, unit: 'Mbps', placeholder: '50' },
      { key: 'dlBandwidthLimit', label: 'DL Bandwidth Limit', type: 'number', min: 0, max: 1000, unit: 'Mbps', placeholder: '100' },
    ],
  },
  {
    title: 'Management', icon: '🛠',
    fields: [
      { key: 'snmpCommunity', label: 'SNMP Community', type: 'text',   placeholder: 'public' },
      { key: 'ntpServer',     label: 'NTP Server',     type: 'text',   placeholder: 'pool.ntp.org' },
      { key: 'timezone',      label: 'Timezone',       type: 'text',   placeholder: 'Asia/Kolkata' },
      { key: 'logLevel',      label: 'Log Level',      type: 'select', options: ['DEBUG','INFO','WARN','ERROR'] },
    ],
  },
];

const IDU_SECTIONS: SectionDef[] = [
  {
    title: 'Network (IP)', icon: '🌐',
    fields: [
      { key: 'ipMode',    label: 'IP Mode',    type: 'select', options: ['DHCP','Static'] },
      { key: 'ipAddress', label: 'IP Address', type: 'text', showIf: (p) => p.ipMode === 'Static' },
      { key: 'subnetMask',label: 'Subnet Mask',type: 'text', showIf: (p) => p.ipMode === 'Static' },
      { key: 'gateway',   label: 'Gateway',    type: 'text', showIf: (p) => p.ipMode === 'Static' },
    ],
  },
  {
    title: 'VLAN', icon: '🔀',
    fields: [
      { key: 'vlanId',      label: 'VLAN ID',      type: 'number', min: 1, max: 4094 },
      { key: 'vlanPriority',label: 'VLAN Priority', type: 'number', min: 0, max: 7 },
    ],
  },
  {
    title: 'Management', icon: '🛠',
    fields: [
      { key: 'snmpCommunity', label: 'SNMP Community', type: 'text' },
      { key: 'ntpServer',     label: 'NTP Server',     type: 'text' },
      { key: 'logLevel',      label: 'Log Level',      type: 'select', options: ['DEBUG','INFO','WARN','ERROR'] },
    ],
  },
];

// ── SWITCH sections — for SNMP-discovered Cisco / Juniper / multivendor switches ──
const SWITCH_SECTIONS: SectionDef[] = [
  {
    title: 'Management', icon: '🛠',
    fields: [
      { key: 'hostname',       label: 'Hostname',               type: 'text',   placeholder: 'sw-core-01' },
      { key: 'snmpCommunity',  label: 'SNMP Community (RO)',    type: 'text',   placeholder: 'public' },
      { key: 'snmpTrapHost',   label: 'SNMP Trap Host',         type: 'text',   placeholder: '10.0.0.1' },
      { key: 'snmpVersion',    label: 'SNMP Version',           type: 'select', options: ['v1','v2c','v3'] },
      { key: 'ntpServer',      label: 'NTP Server',             type: 'text',   placeholder: 'pool.ntp.org' },
      { key: 'syslogServer',   label: 'Syslog Server',          type: 'text',   placeholder: '10.0.0.2' },
      { key: 'logLevel',       label: 'Log Level',              type: 'select', options: ['DEBUG','INFO','WARNING','ERROR','CRITICAL'] },
    ],
  },
  {
    title: 'Network (IP)', icon: '🌐',
    fields: [
      { key: 'mgmtInterface',   label: 'Management Interface',  type: 'text',   placeholder: 'Vlan1 or GigabitEthernet0/0' },
      { key: 'mgmtIpMode',      label: 'Management IP Mode',    type: 'select', options: ['DHCP','Static'] },
      { key: 'mgmtIpAddress',   label: 'Management IP',         type: 'text',   placeholder: '192.168.1.1', showIf: (p) => p.mgmtIpMode === 'Static' },
      { key: 'mgmtSubnetMask',  label: 'Subnet Mask',           type: 'text',   placeholder: '255.255.255.0', showIf: (p) => p.mgmtIpMode === 'Static' },
      { key: 'mgmtGateway',     label: 'Default Gateway',       type: 'text',   placeholder: '192.168.1.254', showIf: (p) => p.mgmtIpMode === 'Static' },
      { key: 'dnsServer',       label: 'DNS Server',            type: 'text',   placeholder: '8.8.8.8' },
    ],
  },
  {
    title: 'VLANs', icon: '🔀',
    fields: [
      { key: 'nativeVlan',      label: 'Native VLAN',           type: 'number', min: 1, max: 4094, placeholder: '1' },
      { key: 'mgmtVlan',        label: 'Management VLAN',       type: 'number', min: 1, max: 4094, placeholder: '100' },
      { key: 'voiceVlan',       label: 'Voice VLAN',            type: 'number', min: 1, max: 4094, placeholder: '200' },
      { key: 'allowedVlans',    label: 'Allowed VLANs (trunk)', type: 'text',   placeholder: '10,20,100-200' },
    ],
  },
  {
    title: 'Spanning Tree', icon: '🌳',
    fields: [
      { key: 'stpMode',         label: 'STP Mode',              type: 'select', options: ['PVST+','Rapid-PVST+','MST','RSTP'] },
      { key: 'stpPriority',     label: 'Bridge Priority',       type: 'select', options: ['4096','8192','16384','24576','32768','40960','49152','57344','61440'] },
      { key: 'portFast',        label: 'PortFast (edge ports)',  type: 'boolean' },
      { key: 'bpduGuard',       label: 'BPDU Guard',            type: 'boolean' },
    ],
  },
  {
    title: 'Port Settings', icon: '🔌',
    fields: [
      { key: 'defaultPortMode', label: 'Default Port Mode',     type: 'select', options: ['access','trunk','dynamic'] },
      { key: 'portSpeed',       label: 'Default Speed',         type: 'select', options: ['Auto','10','100','1000','10000'] },
      { key: 'portDuplex',      label: 'Duplex',                type: 'select', options: ['auto','full','half'] },
      { key: 'poeEnabled',      label: 'PoE Enabled',           type: 'boolean' },
      { key: 'stormControl',    label: 'Storm Control',         type: 'boolean' },
    ],
  },
  {
    title: 'Security', icon: '🔐',
    fields: [
      { key: 'portSecurity',    label: 'Port Security',         type: 'boolean' },
      { key: 'dhcpSnooping',    label: 'DHCP Snooping',         type: 'boolean' },
      { key: 'arpInspection',   label: 'Dynamic ARP Inspection',type: 'boolean' },
      { key: 'dot1xAuth',       label: '802.1X Authentication', type: 'boolean' },
    ],
  },
];

// ── ROUTER sections — for Cisco IOS, Juniper JunOS, multivendor routers ──────
const ROUTER_SECTIONS: SectionDef[] = [
  {
    title: 'Management', icon: '🛠',
    fields: [
      { key: 'hostname',       label: 'Hostname',               type: 'text',   placeholder: 'rtr-edge-01' },
      { key: 'snmpCommunity',  label: 'SNMP Community (RO)',    type: 'text',   placeholder: 'public' },
      { key: 'snmpVersion',    label: 'SNMP Version',           type: 'select', options: ['v1','v2c','v3'] },
      { key: 'ntpServer',      label: 'NTP Server',             type: 'text',   placeholder: 'pool.ntp.org' },
      { key: 'syslogServer',   label: 'Syslog Server',          type: 'text',   placeholder: '10.0.0.2' },
    ],
  },
  {
    title: 'Interfaces', icon: '🔌',
    fields: [
      { key: 'wanInterface',   label: 'WAN Interface',          type: 'text',   placeholder: 'GigabitEthernet0/0' },
      { key: 'wanIpMode',      label: 'WAN IP Mode',            type: 'select', options: ['DHCP','Static','PPPoE'] },
      { key: 'wanIpAddress',   label: 'WAN IP Address',         type: 'text',   placeholder: '203.0.113.1', showIf: (p) => p.wanIpMode === 'Static' },
      { key: 'wanSubnetMask',  label: 'WAN Subnet Mask',        type: 'text',   placeholder: '255.255.255.252', showIf: (p) => p.wanIpMode === 'Static' },
      { key: 'lanInterface',   label: 'LAN Interface',          type: 'text',   placeholder: 'GigabitEthernet0/1' },
      { key: 'lanIpAddress',   label: 'LAN IP Address',         type: 'text',   placeholder: '192.168.1.1' },
    ],
  },
  {
    title: 'Routing', icon: '🌐',
    fields: [
      { key: 'defaultRoute',   label: 'Default Route (nexthop)',type: 'text',   placeholder: '203.0.113.254' },
      { key: 'ospfEnabled',    label: 'OSPF Enabled',           type: 'boolean' },
      { key: 'ospfProcessId',  label: 'OSPF Process ID',        type: 'number', min: 1, max: 65535, placeholder: '1', showIf: (p) => Boolean(p.ospfEnabled) },
      { key: 'ospfAreaId',     label: 'OSPF Area',              type: 'text',   placeholder: '0.0.0.0', showIf: (p) => Boolean(p.ospfEnabled) },
      { key: 'bgpEnabled',     label: 'BGP Enabled',            type: 'boolean' },
      { key: 'bgpAsn',         label: 'BGP ASN',                type: 'number', min: 1, max: 4294967295, placeholder: '65001', showIf: (p) => Boolean(p.bgpEnabled) },
    ],
  },
  {
    title: 'QoS', icon: '⚡',
    fields: [
      { key: 'qosPolicy',      label: 'QoS Policy',             type: 'select', options: ['None','DSCP','Cos','Traffic-Shaping'] },
      { key: 'bandwidthLimit', label: 'WAN Bandwidth Limit',    type: 'number', min: 0, max: 100000, unit: 'Mbps', placeholder: '1000' },
    ],
  },
  {
    title: 'Security', icon: '🔐',
    fields: [
      { key: 'aclInbound',     label: 'ACL Inbound',            type: 'text',   placeholder: 'ACL-WAN-IN' },
      { key: 'aclOutbound',    label: 'ACL Outbound',           type: 'text',   placeholder: 'ACL-WAN-OUT' },
      { key: 'natEnabled',     label: 'NAT / PAT',              type: 'boolean' },
      { key: 'firewallZones',  label: 'Firewall Zones',         type: 'boolean' },
    ],
  },
];

// ── RADIO sections — for EOC640 and other SNMP-discovered radio devices ───────
// (mirrors BTS but without VLAN double-tagging and UBR-specific QoS profiles)
const RADIO_SECTIONS: SectionDef[] = [
  {
    title: 'Radio (RF)', icon: '📡',
    fields: [
      { key: 'operatingFrequency', label: 'Operating Frequency', type: 'select', options: ['5180','5200','5220','5240','5260','5280','5300','5320','5500','5520','5540','5560','5580','5600','5660','5680','5700','5745','5765','5785','5805','5825'], unit: 'MHz' },
      { key: 'channelBandwidth',   label: 'Channel Bandwidth',   type: 'select', options: ['20','40','80','160'], unit: 'MHz' },
      { key: 'txPowerDbm',         label: 'TX Power',            type: 'number', min: 0, max: 30, unit: 'dBm', placeholder: '23' },
      { key: 'antennaGain',        label: 'Antenna Gain',        type: 'number', min: 0, max: 40, unit: 'dBi', placeholder: '16' },
      { key: 'linkMode',           label: 'Link Mode',           type: 'select', options: ['PtP','PtMP','Mesh'] },
      { key: 'encryptionType',     label: 'Encryption',          type: 'select', options: ['AES-128','AES-256','None'] },
    ],
  },
  {
    title: 'Network (IP)', icon: '🌐',
    fields: [
      { key: 'ipMode',    label: 'IP Mode',    type: 'select', options: ['DHCP','Static'] },
      { key: 'ipAddress', label: 'IP Address', type: 'text',   placeholder: '10.100.1.50', showIf: (p) => p.ipMode === 'Static' },
      { key: 'subnetMask',label: 'Subnet Mask',type: 'text',   placeholder: '255.255.255.0', showIf: (p) => p.ipMode === 'Static' },
      { key: 'gateway',   label: 'Gateway',    type: 'text',   placeholder: '10.100.1.254', showIf: (p) => p.ipMode === 'Static' },
      { key: 'dnsServer', label: 'DNS Server', type: 'text',   placeholder: '8.8.8.8' },
    ],
  },
  {
    title: 'VLAN', icon: '🔀',
    fields: [
      { key: 'vlanMode',    label: 'VLAN Mode',     type: 'select', options: ['None','Single'] },
      { key: 'vlanId',      label: 'VLAN ID',       type: 'number', min: 1, max: 4094, placeholder: '100', showIf: (p) => p.vlanMode === 'Single' },
    ],
  },
  {
    title: 'Management', icon: '🛠',
    fields: [
      { key: 'snmpCommunity', label: 'SNMP Community', type: 'text',   placeholder: 'public' },
      { key: 'snmpVersion',   label: 'SNMP Version',   type: 'select', options: ['v1','v2c','v3'] },
      { key: 'snmpTrapHost',  label: 'SNMP Trap Host', type: 'text',   placeholder: '10.0.0.1' },
      { key: 'ntpServer',     label: 'NTP Server',     type: 'text',   placeholder: 'pool.ntp.org' },
      { key: 'syslogServer',  label: 'Syslog Server',  type: 'text',   placeholder: '10.0.0.2' },
      { key: 'webPort',       label: 'Web UI Port',    type: 'number', min: 1, max: 65535, placeholder: '80' },
    ],
  },
];

function getSections(deviceType?: string): SectionDef[] {
  if (deviceType === 'CPE')    return CPE_SECTIONS;
  if (deviceType === 'IDU')    return IDU_SECTIONS;
  if (deviceType === 'SWITCH') return SWITCH_SECTIONS;
  if (deviceType === 'ROUTER') return ROUTER_SECTIONS;
  if (deviceType === 'RADIO')  return RADIO_SECTIONS;
  return BTS_SECTIONS;
}

/** Returns sections with custom fields merged in and hidden fields removed. */
function getEffectiveSections(template: ConfigTemplate): SectionDef[] {
  const base = getSections(template.deviceType);
  const hidden = new Set(template.hiddenFields ?? []);
  const customFields = template.customFields ?? [];

  // Group custom fields by section title
  const customBySection: Record<string, FieldDef[]> = {};
  customFields.forEach((cf) => {
    if (!customBySection[cf.section]) customBySection[cf.section] = [];
    customBySection[cf.section].push({
      key: cf.key, label: cf.label, type: cf.type,
      options: cf.options, min: cf.min, max: cf.max, unit: cf.unit, placeholder: cf.placeholder,
    });
  });

  const result: SectionDef[] = base.map((sec) => ({
    ...sec,
    fields: [
      ...sec.fields.filter((f) => !hidden.has(f.key)),
      ...(customBySection[sec.title] ?? []),
    ],
  }));

  // Add brand-new custom sections not in base
  Object.entries(customBySection).forEach(([title, fields]) => {
    if (!base.find((s) => s.title === title)) {
      result.push({ title, icon: '⚙', fields });
    }
  });

  return result.filter((s) => s.fields.length > 0);
}

// ── Field Schema Editor (admin customises which fields appear) ──────────────
const BLANK_FIELD: Omit<CustomFieldEntry, 'section'> = {
  key: '', label: '', type: 'text', unit: '', placeholder: '', options: [], min: undefined, max: undefined,
};

function labelToKey(label: string): string {
  return label.trim().replace(/[^a-zA-Z0-9 ]/g, '').split(' ').map((w, i) => i === 0 ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join('');
}

interface FieldSchemaEditorProps {
  template: ConfigTemplate;
  onChange: (patch: Partial<ConfigTemplate>) => void;
}

function FieldSchemaEditor({ template, onChange }: FieldSchemaEditorProps) {
  const base = getSections(template.deviceType);
  const hidden = new Set(template.hiddenFields ?? []);
  const customFields = template.customFields ?? [];
  const [addingToSection, setAddingToSection] = useState<string | null>(null);
  const [newSection, setNewSection] = useState('');
  const [addingSec, setAddingSec] = useState(false);
  const [draft, setDraft] = useState<Omit<CustomFieldEntry, 'section'>>({ ...BLANK_FIELD });

  // All section titles (base + custom)
  const customSections = [...new Set(customFields.map((c) => c.section))].filter((s) => !base.find((b) => b.title === s));
  const allSectionTitles = [...base.map((s) => s.title), ...customSections];

  const toggleHide = (key: string) => {
    const next = hidden.has(key) ? [...hidden].filter((k) => k !== key) : [...hidden, key];
    onChange({ hiddenFields: next });
  };

  const removeCustomField = (key: string) => {
    onChange({ customFields: customFields.filter((c) => c.key !== key) });
  };

  const confirmAddField = (section: string) => {
    if (!draft.label.trim()) return;
    const key = draft.key.trim() || labelToKey(draft.label);
    if (!key) return;
    const existing = [...base.flatMap((s) => s.fields.map((f) => f.key)), ...customFields.map((c) => c.key)];
    if (existing.includes(key)) { alert(`Key "${key}" already exists.`); return; }
    const entry: CustomFieldEntry = {
      key, label: draft.label, type: draft.type, section,
      ...(draft.unit ? { unit: draft.unit } : {}),
      ...(draft.placeholder ? { placeholder: draft.placeholder } : {}),
      ...(draft.type === 'select' && draft.options?.length ? { options: draft.options } : {}),
      ...(draft.type === 'number' && draft.min !== undefined ? { min: draft.min } : {}),
      ...(draft.type === 'number' && draft.max !== undefined ? { max: draft.max } : {}),
    };
    onChange({ customFields: [...customFields, entry] });
    setDraft({ ...BLANK_FIELD });
    setAddingToSection(null);
  };

  const BOX: React.CSSProperties = {
    background: 'var(--vf-elevated)', borderRadius: 10, marginBottom: 10,
    border: '1px solid var(--vf-border-subtle)', overflow: 'hidden',
  };
  const ROW: React.CSSProperties = {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '6px 12px', fontSize: 12, borderBottom: '1px solid var(--vf-border-subtle)',
    gap: 8,
  };
  const CHIP: React.CSSProperties = {
    fontSize: 10, padding: '2px 7px', borderRadius: 5, fontWeight: 600,
    background: 'rgba(59,130,246,0.15)', color: '#60a5fa', border: '1px solid rgba(59,130,246,0.3)',
  };
  const GHOST_BTN: React.CSSProperties = {
    background: 'none', border: 'none', cursor: 'pointer', padding: '2px 6px',
    borderRadius: 4, fontSize: 11, color: 'var(--vf-text-muted)',
  };

  return (
    <div>
      <div style={{ fontSize: 12, color: 'var(--vf-text-muted)', marginBottom: 12 }}>
        Toggle visibility of built-in fields or add your own. Changes are saved with the template.
      </div>

      {allSectionTitles.map((sectionTitle) => {
        const baseFields = base.find((s) => s.title === sectionTitle)?.fields ?? [];
        const sectionCustom = customFields.filter((c) => c.section === sectionTitle);
        const isAddingHere = addingToSection === sectionTitle;

        return (
          <div key={sectionTitle} style={BOX}>
            {/* Section header */}
            <div style={{ padding: '8px 12px', background: 'rgba(255,255,255,0.03)', borderBottom: '1px solid var(--vf-border-subtle)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'var(--vf-text-muted)' }}>{sectionTitle}</span>
              <span style={{ fontSize: 10, color: 'var(--vf-text-muted)' }}>{baseFields.filter((f) => !hidden.has(f.key)).length + sectionCustom.length} visible</span>
            </div>

            {/* Built-in fields */}
            {baseFields.map((f) => (
              <div key={f.key} style={{ ...ROW, opacity: hidden.has(f.key) ? 0.45 : 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1 }}>
                  <span style={{ fontSize: 12, color: 'var(--vf-text-primary)', fontWeight: 500 }}>{f.label}</span>
                  <span style={{ ...CHIP, background: 'rgba(255,255,255,0.06)', color: 'var(--vf-text-muted)', border: '1px solid var(--vf-border-subtle)' }}>{f.type}</span>
                  {f.unit && <span style={{ fontSize: 10, color: 'var(--vf-text-muted)' }}>{f.unit}</span>}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <span style={{ fontSize: 10, color: 'var(--vf-text-muted)', fontFamily: 'monospace' }}>{f.key}</span>
                  <button style={{ ...GHOST_BTN, color: hidden.has(f.key) ? '#60a5fa' : '#ef4444', fontSize: 13 }}
                    title={hidden.has(f.key) ? 'Show field' : 'Hide field'}
                    onClick={() => toggleHide(f.key)}>
                    {hidden.has(f.key) ? '👁' : '🚫'}
                  </button>
                </div>
              </div>
            ))}

            {/* Custom fields */}
            {sectionCustom.map((cf) => (
              <div key={cf.key} style={{ ...ROW, background: 'rgba(59,130,246,0.04)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1 }}>
                  <span style={{ fontSize: 12, color: 'var(--vf-text-primary)', fontWeight: 500 }}>{cf.label}</span>
                  <span style={CHIP}>{cf.type}</span>
                  {cf.unit && <span style={{ fontSize: 10, color: 'var(--vf-text-muted)' }}>{cf.unit}</span>}
                  <span style={{ fontSize: 10, background: '#22c55e22', color: '#22c55e', padding: '1px 5px', borderRadius: 4, border: '1px solid #22c55e44' }}>custom</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <span style={{ fontSize: 10, color: 'var(--vf-text-muted)', fontFamily: 'monospace' }}>{cf.key}</span>
                  <button style={{ ...GHOST_BTN, color: '#ef4444' }} title="Remove custom field" onClick={() => removeCustomField(cf.key)}>✕</button>
                </div>
              </div>
            ))}

            {/* Add field inline form */}
            {isAddingHere ? (
              <div style={{ padding: '12px 12px', background: 'rgba(59,130,246,0.06)', borderTop: '1px solid var(--vf-border-subtle)', display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: 8 }}>
                  <div>
                    <label style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', color: 'var(--vf-text-muted)', display: 'block', marginBottom: 3 }}>Label *</label>
                    <input value={draft.label} onChange={(e) => setDraft((d) => ({ ...d, label: e.target.value, key: labelToKey(e.target.value) }))}
                      placeholder="e.g. RSSI Threshold" style={{ ...INLINE_INPUT, fontSize: 12 }} />
                  </div>
                  <div>
                    <label style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', color: 'var(--vf-text-muted)', display: 'block', marginBottom: 3 }}>Key (auto)</label>
                    <input value={draft.key} onChange={(e) => setDraft((d) => ({ ...d, key: e.target.value }))}
                      placeholder="rssiThreshold" style={{ ...INLINE_INPUT, fontSize: 12, fontFamily: 'monospace' }} />
                  </div>
                  <div>
                    <label style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', color: 'var(--vf-text-muted)', display: 'block', marginBottom: 3 }}>Type</label>
                    <select value={draft.type} onChange={(e) => setDraft((d) => ({ ...d, type: e.target.value as CustomFieldEntry['type'] }))} style={{ ...INLINE_INPUT, fontSize: 12, width: 100 }}>
                      <option value="text">Text</option>
                      <option value="number">Number</option>
                      <option value="select">Select</option>
                      <option value="boolean">Toggle</option>
                    </select>
                  </div>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 8 }}>
                  <div>
                    <label style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', color: 'var(--vf-text-muted)', display: 'block', marginBottom: 3 }}>Unit</label>
                    <input value={draft.unit ?? ''} onChange={(e) => setDraft((d) => ({ ...d, unit: e.target.value }))} placeholder="dBm / Mbps…" style={{ ...INLINE_INPUT, fontSize: 12 }} />
                  </div>
                  <div>
                    <label style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', color: 'var(--vf-text-muted)', display: 'block', marginBottom: 3 }}>Placeholder</label>
                    <input value={draft.placeholder ?? ''} onChange={(e) => setDraft((d) => ({ ...d, placeholder: e.target.value }))} placeholder="default hint" style={{ ...INLINE_INPUT, fontSize: 12 }} />
                  </div>
                  {draft.type === 'number' && (
                    <>
                      <div>
                        <label style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', color: 'var(--vf-text-muted)', display: 'block', marginBottom: 3 }}>Min</label>
                        <input type="number" value={draft.min ?? ''} onChange={(e) => setDraft((d) => ({ ...d, min: e.target.value ? Number(e.target.value) : undefined }))} style={{ ...INLINE_INPUT, fontSize: 12 }} />
                      </div>
                      <div>
                        <label style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', color: 'var(--vf-text-muted)', display: 'block', marginBottom: 3 }}>Max</label>
                        <input type="number" value={draft.max ?? ''} onChange={(e) => setDraft((d) => ({ ...d, max: e.target.value ? Number(e.target.value) : undefined }))} style={{ ...INLINE_INPUT, fontSize: 12 }} />
                      </div>
                    </>
                  )}
                  {draft.type === 'select' && (
                    <div style={{ gridColumn: 'span 2' }}>
                      <label style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', color: 'var(--vf-text-muted)', display: 'block', marginBottom: 3 }}>Options (comma-separated)</label>
                      <input value={(draft.options ?? []).join(',')} onChange={(e) => setDraft((d) => ({ ...d, options: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) }))} placeholder="Option1, Option2, Option3" style={{ ...INLINE_INPUT, fontSize: 12 }} />
                    </div>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                  <button onClick={() => { setAddingToSection(null); setDraft({ ...BLANK_FIELD }); }} style={{ ...GHOST_BTN, color: 'var(--vf-text-secondary)', fontSize: 12, padding: '4px 10px' }}>Cancel</button>
                  <button onClick={() => confirmAddField(sectionTitle)} disabled={!draft.label.trim()}
                    style={{ background: 'var(--vf-accent)', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', padding: '4px 12px', fontSize: 12, fontWeight: 600, opacity: draft.label.trim() ? 1 : 0.4 }}>
                    Add Field
                  </button>
                </div>
              </div>
            ) : (
              <div style={{ padding: '6px 12px', borderTop: baseFields.length + sectionCustom.length > 0 ? '1px solid var(--vf-border-subtle)' : undefined }}>
                <button onClick={() => { setAddingToSection(sectionTitle); setDraft({ ...BLANK_FIELD }); }}
                  style={{ ...GHOST_BTN, color: 'var(--vf-accent)', fontSize: 12, padding: '4px 8px' }}>
                  + Add Field to {sectionTitle}
                </button>
              </div>
            )}
          </div>
        );
      })}

      {/* Add new section */}
      {addingSec ? (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 4 }}>
          <input value={newSection} onChange={(e) => setNewSection(e.target.value)} placeholder="Section name (e.g. Security)"
            style={{ ...INLINE_INPUT, fontSize: 12, flex: 1 }} onKeyDown={(e) => { if (e.key === 'Enter' && newSection.trim()) { setAddingToSection(newSection.trim()); setNewSection(''); setAddingSec(false); } }} />
          <button onClick={() => { if (newSection.trim()) { setAddingToSection(newSection.trim()); setNewSection(''); setAddingSec(false); } }}
            style={{ background: 'var(--vf-accent)', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', padding: '6px 14px', fontSize: 12, fontWeight: 600 }}>
            Create
          </button>
          <button onClick={() => { setAddingSec(false); setNewSection(''); }}
            style={{ ...GHOST_BTN, fontSize: 13 }}>✕</button>
        </div>
      ) : (
        <button onClick={() => setAddingSec(true)}
          style={{ background: 'none', border: '1px dashed var(--vf-border-subtle)', color: 'var(--vf-text-muted)', borderRadius: 8, cursor: 'pointer', padding: '8px 16px', fontSize: 12, width: '100%', marginTop: 4 }}>
          + Add New Section
        </button>
      )}
    </div>
  );
}

// ── Template Preview Panel ────────────────────────────────────────────────────
function TemplatePreview({ template }: { template: ConfigTemplate }) {
  // Use effective sections (base + custom fields merged) so custom fields
  // appear under their named section with friendly labels, not under "Other"
  const sections = getEffectiveSections(template);
  const params = template.parameters;

  // Build a key→{label, unit, section} lookup from ALL effective sections
  const fieldMeta: Record<string, { label: string; unit?: string; section: string }> = {};
  sections.forEach((sec) => {
    sec.fields.forEach((f) => {
      fieldMeta[f.key] = { label: f.label, unit: f.unit, section: sec.title };
    });
  });

  // Group filled parameters by section
  const grouped: Record<string, { key: string; label: string; value: string | number | boolean; unit?: string }[]> = {};
  let uncategorised: { key: string; value: string | number | boolean }[] = [];

  Object.entries(params ?? {}).forEach(([k, v]) => {
    if (v === '' || v === null || v === undefined) return;
    const meta = fieldMeta[k];
    if (meta) {
      const sec = meta.section;
      if (!grouped[sec]) grouped[sec] = [];
      grouped[sec].push({ key: k, label: meta.label, value: v, unit: meta.unit });
    } else {
      uncategorised.push({ key: k, value: v });
    }
  });

  const hasParams = Object.keys(grouped).length > 0 || uncategorised.length > 0;

  const formatValue = (v: string | number | boolean) => {
    if (typeof v === 'boolean') return v ? '✓ Enabled' : '✗ Disabled';
    return String(v);
  };

  return (
    <div style={{
      border: 'var(--vf-card-border)', borderRadius: 10,
      background: 'var(--vf-surface)', overflow: 'hidden',
      marginBottom: 14, boxShadow: 'var(--vf-shadow-low)',
    }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '10px 16px', background: 'var(--vf-elevated)',
        borderBottom: 'var(--vf-card-border)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 16 }}>
            {template.deviceType === 'BTS' ? '📡' : template.deviceType === 'CPE' ? '🖥' : template.deviceType === 'IDU' ? '📦' : template.deviceType === 'SWITCH' ? '🔀' : template.deviceType === 'ROUTER' ? '🌐' : template.deviceType === 'RADIO' ? '📻' : '📦'}
          </span>
          <div>
            <div style={{ fontWeight: 700, fontSize: 13, color: 'var(--vf-text-primary)' }}>{template.name}</div>
            {template.description && (
              <div style={{ fontSize: 11, color: 'var(--vf-text-muted)', marginTop: 1 }}>{template.description}</div>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {template.deviceType && (
            <span style={{ background: 'var(--vf-accent-subtle)', border: '1px solid var(--vf-accent)', color: 'var(--vf-accent)', padding: '2px 8px', borderRadius: 6, fontSize: 10, fontWeight: 700 }}>
              {template.deviceType}
            </span>
          )}
          {template.isDefault && (
            <span style={{ background: 'var(--vf-success-bg)', border: '1px solid var(--vf-success)', color: 'var(--vf-success)', padding: '2px 8px', borderRadius: 6, fontSize: 10, fontWeight: 700 }}>
              DEFAULT
            </span>
          )}
          <span style={{ background: 'var(--vf-elevated)', border: 'var(--vf-card-border)', color: 'var(--vf-text-muted)', padding: '2px 8px', borderRadius: 6, fontSize: 10 }}>
            {Object.keys(params ?? {}).filter((k) => params[k] !== '' && params[k] !== null && params[k] !== undefined).length} params
          </span>
        </div>
      </div>

      {/* Body */}
      <div style={{ padding: '12px 16px' }}>
        {!hasParams ? (
          <div style={{ color: 'var(--vf-text-muted)', fontSize: 12, fontStyle: 'italic', padding: '8px 0' }}>
            No parameters configured in this template.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {Object.entries(grouped).map(([sectionTitle, fields]) => (
              <div key={sectionTitle}>
                <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--vf-text-muted)', marginBottom: 6 }}>
                  {sectionTitle}
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '4px 16px' }}>
                  {fields.map(({ key, label, value, unit }) => (
                    <div key={key} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 8px', background: 'var(--vf-elevated)', borderRadius: 5 }}>
                      <span style={{ fontSize: 11, color: 'var(--vf-text-muted)', flexShrink: 0 }}>{label}</span>
                      <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--vf-text-primary)', fontFamily: 'var(--vf-font-mono)', marginLeft: 8, whiteSpace: 'nowrap' }}>
                        {formatValue(value)}{unit ? ` ${unit}` : ''}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
            {uncategorised.length > 0 && (
              <div>
                <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--vf-text-muted)', marginBottom: 6 }}>Other</div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '4px 16px' }}>
                  {uncategorised.map(({ key, value }) => (
                    <div key={key} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 8px', background: 'var(--vf-elevated)', borderRadius: 5 }}>
                      <span style={{ fontSize: 11, color: 'var(--vf-text-muted)', fontFamily: 'var(--vf-font-mono)' }}>{key}</span>
                      <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--vf-text-primary)', fontFamily: 'var(--vf-font-mono)', marginLeft: 8 }}>{String(value)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Inline field renderer ─────────────────────────────────────────────────────
const INLINE_INPUT = {
  width: '100%', padding: '7px 10px', borderRadius: 6,
  border: '1px solid var(--vf-border-subtle)', background: 'var(--vf-surface)',
  color: 'var(--vf-text-primary)', fontSize: 13, outline: 'none',
  boxSizing: 'border-box' as const,
};

function ParamField({ def, value, onChange }: {
  def: FieldDef;
  value: string | number | boolean;
  onChange: (v: string | number | boolean) => void;
}) {
  if (def.type === 'boolean') {
    return (
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13 }}>
        <input type="checkbox" checked={Boolean(value)}
          onChange={(e) => onChange(e.target.checked)}
          style={{ width: 16, height: 16, cursor: 'pointer' }} />
        <span style={{ color: 'var(--vf-text-secondary)' }}>Enabled</span>
      </label>
    );
  }
  if (def.type === 'select') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <select value={String(value ?? '')} onChange={(e) => onChange(e.target.value)}
          style={{ ...INLINE_INPUT, flex: 1 }}>
          <option value="">— Select —</option>
          {(def.options ?? []).map((o, i) => <option key={`${i}-${o}`} value={o}>{o}</option>)}
        </select>
        {def.unit && <span style={{ fontSize: 11, color: 'var(--vf-text-muted)', whiteSpace: 'nowrap' }}>{def.unit}</span>}
      </div>
    );
  }
  if (def.type === 'number') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <input type="number" min={def.min} max={def.max}
          value={value === '' ? '' : Number(value)}
          onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
          placeholder={def.placeholder}
          style={{ ...INLINE_INPUT, flex: 1 }} />
        {def.unit && <span style={{ fontSize: 11, color: 'var(--vf-text-muted)', whiteSpace: 'nowrap' }}>{def.unit}</span>}
      </div>
    );
  }
  return (
    <input type="text" value={String(value ?? '')} onChange={(e) => onChange(e.target.value)}
      placeholder={def.placeholder} style={INLINE_INPUT} />
  );
}

// ── Group icon map (mirrors DiscoveryTriggerForm) ────────────────────────────
const GROUP_ICON_MAP: Record<string, string> = {
  cpu: '⚙️', memory: '💾', interface: '🔌', environment: '🌡️',
  bgp: '🔗', spanning_tree: '🌳', wireless: '📶', radio: '📡',
  network: '🌐', vlan: '🔀', qos: '⚡', management: '🛠',
  routing: '🗺️', security: '🔒', snmp: '📡', system: '🖥️',
  power: '⚡', fan: '💨', port: '🔌', switching: '🔀',
};

/**
 * Converts a ProductDefinitionSchema's parameter groups into SectionDef[]
 * so they can drive the config template editor exactly like the hardcoded
 * BTS_SECTIONS / CPE_SECTIONS arrays do.
 */
function pdSchemaToSections(schema: ProductDefinitionSchema): SectionDef[] {
  return schema.groups.map((g) => {
    const groupKey = g.groupName.toLowerCase().replace(/[^a-z0-9_]/g, '_');
    const icon = GROUP_ICON_MAP[groupKey] ?? '📋';
    const title = g.groupName.charAt(0).toUpperCase() + g.groupName.slice(1).replace(/_/g, ' ');
    return {
      title,
      icon,
      fields: g.parameters.map((p): FieldDef => {
        const dt = p.dataType.toUpperCase();
        // NormalizedProductDefinition uses NUMERIC; raw files use GAUGE/COUNTER/FLOAT/INTEGER
        const fieldType: FieldDef['type'] =
          dt === 'BOOLEAN'                                                      ? 'boolean' :
          dt === 'ENUM'                                                         ? 'select'  :
          (dt === 'NUMERIC' || dt === 'GAUGE' || dt === 'COUNTER' ||
           dt === 'FLOAT'   || dt === 'INTEGER')                               ? 'number'  :
          'text';
        return {
          key:         p.id,
          label:       p.displayName,
          type:        fieldType,
          unit:        p.unit,
          min:         p.minValue,
          max:         p.maxValue,
          placeholder: p.snmpOid ? `OID: ${p.snmpOid}` : undefined,
          options:     p.enumValues,
        };
      }),
    };
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. Templates tab — split-view master-detail (no modal)
// ═══════════════════════════════════════════════════════════════════════════════
const BLANK: ConfigTemplate = { name: '', description: '', deviceType: 'BTS', isDefault: false, parameters: {}, customFields: [], hiddenFields: [] };

function TemplatesTab() {
  const { addToast } = useToast();
  const [templates, setTemplates] = useState<ConfigTemplate[]>([]);
  const [loading, setLoading]     = useState(true);
  const [editing, setEditing]     = useState<ConfigTemplate | null>(null);
  const [saving, setSaving]       = useState(false);
  const [dirty, setDirty]         = useState(false);
  const [customizeMode, setCustomizeMode] = useState(false);

  // ── Product Definition dynamic sections ─────────────────────────────────
  // Admins can choose an uploaded product definition to dynamically populate
  // the template editor with parameter groups extracted from the XML/JSON/XLS.
  const [uploadedVersions, setUploadedVersions] = useState<ProductDefinitionVersion[]>([]);
  const [selectedVersionKey, setSelectedVersionKey] = useState<string>('');
  const [pdSchema, setPdSchema]    = useState<ProductDefinitionSchema | null>(null);
  const [pdLoading, setPdLoading]  = useState(false);

  useEffect(() => {
    listAllUploadHistory()
      .then(setUploadedVersions)
      .catch(() => {/* non-fatal */});
  }, []);

  useEffect(() => {
    if (!selectedVersionKey) { setPdSchema(null); return; }
    const [definitionId, versionId] = selectedVersionKey.split('::');
    if (!definitionId || !versionId) { setPdSchema(null); return; }
    setPdLoading(true);
    getVersionSchema(definitionId, versionId)
      .then(setPdSchema)
      .catch(() => setPdSchema(null))
      .finally(() => setPdLoading(false));
  }, [selectedVersionKey]);

  // Sections are either from the product definition (if one is selected) or
  // from the hardcoded device-type arrays.
  const dynamicSections: SectionDef[] | null = pdSchema ? pdSchemaToSections(pdSchema) : null;

  const pdVersionOptions = [
    { value: '', label: '— Use device type defaults —' },
    ...uploadedVersions.map((v) => ({
      // Use versionId (UUID) not id (MongoDB ObjectId) — the API route expects the UUID
      value: `${v.definitionId}::${v.versionId}`,
      label: `${v.vendor ?? ''} ${v.model ?? v.name ?? ''} · v${v.registryVersion ?? v.versionId?.slice(-6)} [${v.lifecycleStatus}]`,
    })),
  ];

  const load = useCallback(() => {
    setLoading(true);
    fetchTemplates()
      .then(setTemplates)
      .catch((e) => { logger.error('Templates fetch failed', e); addToast('Failed to load templates', 'error'); })
      .finally(() => setLoading(false));
  }, [addToast]);

  useEffect(load, [load]);

  const startNew = () => { setEditing({ ...BLANK, parameters: {} }); setDirty(false); };

  const selectTemplate = (t: ConfigTemplate) => {
    if (dirty && !window.confirm('You have unsaved changes. Discard?')) return;
    setEditing({ ...t }); setDirty(false);
  };

  const handleSave = async () => {
    if (!editing) return;
    if (!editing.name.trim()) { addToast('Template name is required', 'error'); return; }
    const errors = validateTemplate(editing.parameters);
    if (errors.length) { addToast(errors[0], 'error'); return; }
    setSaving(true);
    try {
      if (editing.id) {
        await updateTemplate(editing.id, editing);
        addToast('Template updated', 'success');
      } else {
        await createTemplate(editing);
        addToast('Template created', 'success');
      }
      setDirty(false);
      load();
    } catch (e) { logger.error('Template save failed', e); addToast('Failed to save template', 'error'); }
    finally { setSaving(false); }
  };

  const handleDelete = async (t: ConfigTemplate) => {
    if (!window.confirm(`Delete template "${t.name}"?`)) return;
    try {
      await deleteTemplate(t.id!);
      addToast('Template deleted', 'success');
      if (editing?.id === t.id) { setEditing(null); setDirty(false); }
      load();
    } catch { addToast('Failed to delete template', 'error'); }
  };

  const setParam = (key: string, val: string | number | boolean) => {
    setEditing((e) => e ? { ...e, parameters: { ...e.parameters, [key]: val } } : e);
    setDirty(true);
  };

  const setField = <K extends keyof ConfigTemplate>(k: K, v: ConfigTemplate[K]) => {
    setEditing((e) => e ? { ...e, [k]: v } : e);
    setDirty(true);
  };

  const patchSchema = (patch: Partial<ConfigTemplate>) => {
    setEditing((e) => e ? { ...e, ...patch } : e);
    setDirty(true);
  };

  // Use dynamically generated sections when a product definition is selected;
  // otherwise fall back to the hardcoded device-type section definitions.
  const sections = dynamicSections ?? (editing ? getEffectiveSections(editing) : getSections(undefined));

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '300px 1fr', gap: 0, minHeight: 600, border: '1px solid var(--vf-border-subtle)', borderRadius: 12, overflow: 'hidden' }}>

      {/* ── LEFT: Template list ─────────────────────────────────────────────── */}
      <div style={{ background: 'var(--vf-elevated)', borderRight: '1px solid var(--vf-border-subtle)', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--vf-border-subtle)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontWeight: 700, fontSize: 13, color: 'var(--vf-text-primary)' }}>Templates ({templates.length})</span>
          <Button variant="primary" size="sm" onClick={startNew}>+ New</Button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: 8 }}>
          {loading ? <LoadingState label="Loading…" /> : templates.length === 0 ? (
            <div style={{ padding: '24px 12px', textAlign: 'center', color: 'var(--vf-text-muted)', fontSize: 12 }}>
              No templates yet.<br />Click "+ New" to create one.
            </div>
          ) : templates.map((t) => {
            const isActive = editing?.id === t.id || (!editing?.id && !t.id);
            const typeColor: Record<string, string> = { BTS: '#3b82f6', CPE: '#22c55e', IDU: '#f59e0b', SWITCH: '#8b5cf6', ROUTER: '#06b6d4', RADIO: '#ec4899' };
            return (
              <div key={t.id} onClick={() => selectTemplate(t)}
                style={{
                  padding: '10px 12px', borderRadius: 8, cursor: 'pointer', marginBottom: 4,
                  background: isActive ? 'rgba(59,130,246,0.12)' : 'transparent',
                  border: `1px solid ${isActive ? 'rgba(59,130,246,0.4)' : 'transparent'}`,
                  transition: 'all 0.12s',
                }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 6 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--vf-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.name}</div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 3 }}>
                      <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 6px', borderRadius: 4, background: typeColor[t.deviceType ?? 'BTS'] + '22', color: typeColor[t.deviceType ?? 'BTS'] }}>{t.deviceType ?? 'BTS'}</span>
                      {t.isDefault && <span style={{ fontSize: 10, color: '#22c55e' }}>● Default</span>}
                      <span style={{ fontSize: 10, color: 'var(--vf-text-muted)' }}>{Object.keys(t.parameters ?? {}).length}p</span>
                    </div>
                  </div>
                  <button onClick={(e) => { e.stopPropagation(); handleDelete(t); }}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#ef4444', fontSize: 13, padding: 2, opacity: 0.6 }}>✕</button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── RIGHT: Template editor ──────────────────────────────────────────── */}
      <div style={{ background: 'var(--vf-surface)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {!editing ? (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, color: 'var(--vf-text-muted)' }}>
            <span style={{ fontSize: 40 }}>⚙</span>
            <p style={{ fontSize: 14, margin: 0 }}>Select a template to edit or create a new one</p>
            <Button variant="primary" onClick={startNew}>+ New Template</Button>
          </div>
        ) : (
          <>
            {/* Editor header */}
            <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--vf-border-subtle)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexShrink: 0, flexWrap: 'wrap', gap: 8 }}>
              <span style={{ fontWeight: 700, fontSize: 14, color: 'var(--vf-text-primary)' }}>
                {editing.id ? `Editing: ${editing.name}` : 'New Template'}
                {dirty && <span style={{ fontSize: 11, color: '#f59e0b', marginLeft: 8 }}>● Unsaved</span>}
              </span>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <button
                  onClick={() => setCustomizeMode((m) => !m)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 5,
                    background: customizeMode ? 'rgba(59,130,246,0.15)' : 'var(--vf-elevated)',
                    border: `1px solid ${customizeMode ? 'rgba(59,130,246,0.5)' : 'var(--vf-border-subtle)'}`,
                    color: customizeMode ? '#60a5fa' : 'var(--vf-text-secondary)',
                    borderRadius: 6, padding: '5px 12px', fontSize: 12, fontWeight: 600, cursor: 'pointer',
                  }}>
                  ⚙ {customizeMode ? 'Exit Field Editor' : 'Customize Fields'}
                </button>
                <Button variant="ghost" size="sm" onClick={() => { setEditing(null); setDirty(false); setCustomizeMode(false); }}>Discard</Button>
                <Button variant="primary" size="sm" onClick={handleSave} loading={saving}>
                  {saving ? 'Saving…' : editing.id ? 'Update Template' : 'Save Template'}
                </Button>
              </div>
            </div>

            {/* Scrollable form body */}
            <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 20 }}>

              {/* ── Identity row ── */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: 14, alignItems: 'end' }}>
                <FieldRow label="Template Name *">
                  <Input value={editing.name} onChange={(e) => setField('name', e.target.value)} placeholder="e.g. Default BTS Config" />
                </FieldRow>
                <FieldRow label="Description">
                  <Input value={editing.description ?? ''} onChange={(e) => setField('description', e.target.value)} placeholder="Optional description" />
                </FieldRow>
                <FieldRow label="Device Type">
                  <select value={editing.deviceType ?? 'BTS'}
                    onChange={(e) => { setField('deviceType', e.target.value as 'BTS' | 'CPE' | 'IDU' | 'SWITCH' | 'ROUTER' | 'RADIO'); setField('parameters', {}); }}
                    style={{ ...INLINE_INPUT, width: 200 }}>
                    <optgroup label="UBR Radio Equipment">
                      <option value="BTS">BTS (A60 — Sector Base Station)</option>
                      <option value="CPE">CPE (A61 — Customer Premises)</option>
                      <option value="IDU">IDU (Indoor Unit / Backhaul)</option>
                      <option value="RADIO">RADIO (Generic Wireless Link)</option>
                    </optgroup>
                    <optgroup label="SNMP-Discovered Network Equipment">
                      <option value="SWITCH">SWITCH (Cisco / Juniper / Multivendor)</option>
                      <option value="ROUTER">ROUTER (Edge / Core Router)</option>
                    </optgroup>
                  </select>
                </FieldRow>
              </div>

              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
                <input type="checkbox" checked={editing.isDefault}
                  onChange={(e) => setField('isDefault', e.target.checked)}
                  style={{ width: 16, height: 16, cursor: 'pointer' }} />
                <span>Set as <strong>default</strong> template — auto-applied during provisioning</span>
              </label>

              <hr style={{ border: 'none', borderTop: '1px solid var(--vf-border-subtle)', margin: 0 }} />

              {/* ── Product Definition Loader ─────────────────────────────────────────
                  When an admin selects an uploaded product definition, the parameter
                  groups from that XML/JSON/XLS file dynamically replace the static
                  device-type sections below. This gives a fully model-driven form.   */}
              {uploadedVersions.length > 0 && (
                <div style={{
                  background: 'rgba(96,165,250,0.04)',
                  border: '1px solid rgba(96,165,250,0.15)',
                  borderRadius: 8, padding: '12px 14px',
                  display: 'flex', flexDirection: 'column', gap: 10,
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 16 }}>📂</span>
                    <span style={{ fontWeight: 700, fontSize: 12, color: '#60a5fa', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                      Load Fields from Product Definition
                    </span>
                    {pdLoading && (
                      <span style={{ fontSize: 11, color: 'var(--vf-text-muted)', marginLeft: 4 }}>Loading…</span>
                    )}
                  </div>
                  <div>
                    <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--vf-text-secondary)', letterSpacing: '0.03em', display: 'block', marginBottom: 4 }}>
                      Uploaded Product Definition
                    </label>
                    <select
                      value={selectedVersionKey}
                      onChange={(e) => { setSelectedVersionKey(e.target.value); }}
                      style={{ ...INLINE_INPUT, width: '100%' }}
                    >
                      {pdVersionOptions.map((o) => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                      ))}
                    </select>
                    <span style={{ fontSize: 11, color: 'var(--vf-text-muted)', marginTop: 3, display: 'block' }}>
                      Selecting a definition replaces the sections below with parameter groups from the uploaded file
                    </span>
                  </div>
                  {pdSchema && !pdLoading && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <span style={{ fontWeight: 600, fontSize: 12, color: 'var(--vf-text-primary)' }}>
                        {pdSchema.vendor} {pdSchema.model}
                      </span>
                      {pdSchema.groups.map((g) => (
                        <span key={g.groupName} style={{
                          fontSize: 10, padding: '2px 7px', borderRadius: 10,
                          background: 'rgba(96,165,250,0.12)', border: '1px solid rgba(96,165,250,0.25)',
                          color: '#60a5fa',
                        }}>
                          {g.groupName} ({g.parameters.length})
                        </span>
                      ))}
                      <button
                        type="button"
                        onClick={() => {
                          // Pre-populate template name from the schema if empty
                          if (!editing?.name) {
                            setEditing((e) => e ? { ...e, name: `${pdSchema.vendor} ${pdSchema.model} Template` } : e);
                          }
                          addToast(`Loaded ${pdSchema.groups.length} parameter groups from ${pdSchema.vendor} ${pdSchema.model}`, 'success');
                        }}
                        style={{
                          marginLeft: 'auto', fontSize: 11, padding: '3px 10px',
                          background: 'rgba(96,165,250,0.15)', border: '1px solid rgba(96,165,250,0.3)',
                          borderRadius: 6, color: '#60a5fa', cursor: 'pointer', fontWeight: 600,
                        }}
                      >
                        ✓ Apply
                      </button>
                    </div>
                  )}
                </div>
              )}

              {/* ── Field Schema Editor (admin mode) ── */}
              {customizeMode && (
                <div style={{ background: 'var(--vf-elevated)', borderRadius: 10, padding: '14px 16px', border: '1px solid rgba(59,130,246,0.3)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
                    <span style={{ fontSize: 13, fontWeight: 700, color: '#60a5fa' }}>⚙ Field Schema Editor</span>
                    <span style={{ fontSize: 11, color: 'var(--vf-text-muted)' }}>— 🚫 hides a field · ✕ deletes a custom field · 👁 restores a hidden field</span>
                  </div>
                  <FieldSchemaEditor template={editing} onChange={patchSchema} />
                </div>
              )}

              {/* ── Device-type-specific parameter sections ── */}
              {!customizeMode && sections.map((section) => {
                const visibleFields = section.fields.filter((f) => !f.showIf || f.showIf(editing.parameters));
                if (visibleFields.length === 0) return null;
                return (
                  <div key={section.title} style={{ background: 'var(--vf-elevated)', borderRadius: 10, overflow: 'hidden' }}>
                    <div style={{
                      padding: '10px 16px', background: 'rgba(255,255,255,0.03)',
                      borderBottom: '1px solid var(--vf-border-subtle)',
                      fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em',
                      color: 'var(--vf-text-muted)', display: 'flex', alignItems: 'center', gap: 8,
                    }}>
                      <span>{section.icon}</span> {section.title}
                    </div>
                    <div style={{ padding: '14px 16px', display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '12px 16px' }}>
                      {visibleFields.map((f) => (
                        <div key={f.key}>
                          <label style={{ display: 'block', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--vf-text-muted)', marginBottom: 5 }}>
                            {f.label}
                            {f.min !== undefined && f.max !== undefined && (
                              <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}> ({f.min}–{f.max})</span>
                            )}
                          </label>
                          <ParamField def={f} value={editing.parameters[f.key] ?? ''} onChange={(v) => setParam(f.key, v)} />
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}

              {/* ── Params summary ── */}
              {!customizeMode && Object.keys(editing.parameters ?? {}).filter((k) => editing.parameters[k] !== '' && editing.parameters[k] !== false).length > 0 && (
                <div style={{ background: 'var(--vf-elevated)', borderRadius: 8, padding: '12px 16px' }}>
                  <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--vf-text-muted)', marginBottom: 10 }}>
                    Configured Parameters ({Object.keys(editing.parameters ?? {}).filter((k) => editing.parameters[k] !== '' && editing.parameters[k] !== false).length})
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {Object.entries(editing.parameters ?? {})
                      .filter(([, v]) => v !== '' && v !== false)
                      .map(([k, v]) => (
                        <div key={k} style={{ background: 'rgba(59,130,246,0.1)', border: '1px solid rgba(59,130,246,0.2)', borderRadius: 6, padding: '3px 8px', fontSize: 11 }}>
                          <span style={{ color: 'var(--vf-text-muted)' }}>{k}:</span>{' '}
                          <span style={{ color: '#60a5fa', fontFamily: 'var(--vf-font-mono)' }}>{String(v)}</span>
                        </div>
                      ))}
                  </div>
                </div>
              )}

            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ── DefinitionParamPusher: OID-aware push from product definition ─────────────
interface DefGroup {
  groupId: string;
  label: string;
  subGroups: Array<{ subGroupId: string; label: string; parameters: DefinitionParam[] }>;
  parameters: DefinitionParam[];
}

function DefinitionParamPusher({
  deviceId,
  onPushComplete,
}: {
  deviceId: string;
  onPushComplete: (result: PushResult) => void;
}) {
  const { addToast } = useToast();
  const [loading, setLoading]   = useState(false);
  const [groups, setGroups]     = useState<DefGroup[]>([]);
  const [pdId, setPdId]         = useState('');
  const [paramCount, setParamCount] = useState(0);
  const [values, setValues]     = useState<Record<string, string>>({});
  const [pushing, setPushing]   = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [pushResult, setPushResult] = useState<PushResult | null>(null);

  // Auto-load definition params whenever the selected device changes
  useEffect(() => {
    if (!deviceId) { setGroups([]); setPdId(''); setParamCount(0); setValues({}); setPushResult(null); return; }
    loadDef();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceId]);

  const loadDef = async () => {
    setLoading(true);
    try {
      const data = await fetchDefinitionParams(deviceId);
      setGroups(data.groups ?? []);
      setPdId(data.productDefinitionId);
      setParamCount(data.parameterCount ?? 0);
      // Pre-fill defaults
      const defaults: Record<string, string> = {};
      for (const g of data.groups ?? []) {
        for (const p of g.parameters ?? []) {
          if (p.defaultValue != null) defaults[p.parameterId] = String(p.defaultValue);
        }
      }
      setValues(defaults);
      // Expand first group by default
      if (data.groups?.length) setExpanded({ [data.groups[0].groupId]: true });
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { message?: string } } })?.response?.data?.message || (e instanceof Error ? e.message : 'Unknown error');
      addToast(`Could not load definition: ${msg}`, 'error');
    } finally { setLoading(false); }
  };

  const handlePush = async () => {
    if (!groups.length) { addToast('Load parameters first', 'warning'); return; }
    setPushing(true);
    try {
      // Build OID mapping for all params that have an OID and a value
      const oidMapping: OidSetItem[] = [];
      for (const g of groups) {
        for (const p of g.parameters) {
          if (p.snmpOid && !p.readOnly && values[p.parameterId] !== undefined && values[p.parameterId] !== '') {
            oidMapping.push({
              parameterId: p.parameterId,
              snmpOid:     p.snmpOid,
              value:       values[p.parameterId],
              displayName: p.displayName,
            });
          }
        }
      }
      const result = await pushConfig(deviceId, 'definition-push', undefined, oidMapping);
      setPushResult(result);
      onPushComplete(result);
      addToast(
        `✅ ${oidMapping.length} OID(s) SET via SNMP — config applied to ${deviceId}`,
        result.status === 'PUSHED' ? 'success' : 'warning',
      );
    } catch { addToast('Push failed — check device SNMP accessibility', 'error'); }
    finally { setPushing(false); }
  };

  const setValue = (parameterId: string, val: string) =>
    setValues((prev) => ({ ...prev, [parameterId]: val }));

  const toggleGroup = (gid: string) =>
    setExpanded((prev) => ({ ...prev, [gid]: !prev[gid] }));

  const OID_BADGE = (oid: string | null) => oid ? (
    <span style={{
      fontSize: 10, fontFamily: 'var(--vf-font-mono)', color: 'var(--vf-text-muted)',
      background: 'var(--vf-elevated)', border: '1px solid var(--vf-border-subtle)',
      borderRadius: 3, padding: '1px 5px', marginLeft: 6,
    }}>OID: {oid}</span>
  ) : null;

  return (
    <div style={{ marginTop: 20, background: 'var(--vf-surface)', border: '1px solid #8b5cf655', borderRadius: 10, padding: 20 }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div>
          <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: 'var(--vf-text-primary)' }}>
            📋 Push from Product Definition
            {pdId && <span style={{ fontSize: 12, color: '#8b5cf6', marginLeft: 8 }}>{pdId}</span>}
          </h3>
          {paramCount > 0 && (
            <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--vf-text-muted)' }}>
              {paramCount} parameter(s) — values with OIDs will be applied via SNMP SET
            </p>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Button variant="ghost" size="sm" onClick={loadDef} loading={loading}>
            {groups.length ? '🔄 Reload' : '📥 Load Parameters'}
          </Button>
          {groups.length > 0 && (
            <Button variant="primary" size="sm" onClick={handlePush} loading={pushing}>
              {pushing ? 'Pushing…' : '🚀 Push with OIDs'}
            </Button>
          )}
        </div>
      </div>

      {/* Parameter groups */}
      {groups.map((g) => (
        <div key={g.groupId} style={{ marginBottom: 12, border: '1px solid var(--vf-border-subtle)', borderRadius: 8, overflow: 'hidden' }}>
          {/* Group header */}
          <button
            onClick={() => toggleGroup(g.groupId)}
            style={{
              width: '100%', background: 'var(--vf-elevated)', border: 'none', cursor: 'pointer',
              padding: '10px 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              color: 'var(--vf-text-primary)', fontSize: 13, fontWeight: 600,
            }}
          >
            <span>📂 {g.label}</span>
            <span style={{ color: 'var(--vf-text-muted)', fontSize: 11 }}>
              {g.parameters.length} params {expanded[g.groupId] ? '▲' : '▼'}
            </span>
          </button>

          {expanded[g.groupId] && (
            <div style={{ padding: '12px 14px' }}>
              {/* If subGroups exist, render by subgroup */}
              {g.subGroups.length > 0 ? (
                g.subGroups.map((sg) => (
                  <div key={sg.subGroupId} style={{ marginBottom: 12 }}>
                    <div style={{ fontSize: 11, fontWeight: 600, color: '#8b5cf6', textTransform: 'uppercase', marginBottom: 8, letterSpacing: '0.05em' }}>
                      {sg.label}
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 10 }}>
                      {sg.parameters.map((p) => (
                        <div key={p.parameterId} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                          <label style={{ fontSize: 12, color: 'var(--vf-text-secondary)', display: 'flex', alignItems: 'center', flexWrap: 'wrap' }}>
                            {p.displayName}
                            {p.readOnly && <span style={{ fontSize: 10, color: '#f59e0b', marginLeft: 6 }}>read-only</span>}
                            {OID_BADGE(p.snmpOid)}
                          </label>
                          {p.enumValues?.length > 0 ? (
                            <select
                              value={values[p.parameterId] ?? p.defaultValue ?? ''}
                              onChange={(e) => setValue(p.parameterId, e.target.value)}
                              disabled={p.readOnly}
                              style={{ fontSize: 12, padding: '5px 8px', borderRadius: 5, border: '1px solid var(--vf-border-subtle)', background: 'var(--vf-elevated)', color: 'var(--vf-text-primary)' }}
                            >
                              {p.enumValues.map((v) => <option key={v} value={v}>{v}</option>)}
                            </select>
                          ) : (
                            <input
                              type={p.dataType === 'UINT' || p.dataType === 'NUMERIC' || p.dataType === 'FLOAT' ? 'number' : 'text'}
                              value={values[p.parameterId] ?? p.defaultValue ?? ''}
                              onChange={(e) => setValue(p.parameterId, e.target.value)}
                              disabled={p.readOnly}
                              min={p.minValue ?? undefined}
                              max={p.maxValue ?? undefined}
                              placeholder={p.snmpOid ? `OID: ${p.snmpOid}` : p.displayName}
                              style={{ fontSize: 12, padding: '5px 8px', borderRadius: 5, border: '1px solid var(--vf-border-subtle)', background: 'var(--vf-elevated)', color: 'var(--vf-text-primary)' }}
                            />
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                ))
              ) : (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 10 }}>
                  {g.parameters.map((p) => (
                    <div key={p.parameterId} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <label style={{ fontSize: 12, color: 'var(--vf-text-secondary)', display: 'flex', alignItems: 'center', flexWrap: 'wrap' }}>
                        {p.displayName}
                        {p.readOnly && <span style={{ fontSize: 10, color: '#f59e0b', marginLeft: 6 }}>read-only</span>}
                        {OID_BADGE(p.snmpOid)}
                      </label>
                      {p.enumValues?.length > 0 ? (
                        <select
                          value={values[p.parameterId] ?? p.defaultValue ?? ''}
                          onChange={(e) => setValue(p.parameterId, e.target.value)}
                          disabled={p.readOnly}
                          style={{ fontSize: 12, padding: '5px 8px', borderRadius: 5, border: '1px solid var(--vf-border-subtle)', background: 'var(--vf-elevated)', color: 'var(--vf-text-primary)' }}
                        >
                          {p.enumValues.map((v) => <option key={v} value={v}>{v}</option>)}
                        </select>
                      ) : (
                        <input
                          type={p.dataType === 'UINT' || p.dataType === 'NUMERIC' || p.dataType === 'FLOAT' ? 'number' : 'text'}
                          value={values[p.parameterId] ?? p.defaultValue ?? ''}
                          onChange={(e) => setValue(p.parameterId, e.target.value)}
                          disabled={p.readOnly}
                          min={p.minValue ?? undefined}
                          max={p.maxValue ?? undefined}
                          placeholder={p.snmpOid ? `OID: ${p.snmpOid}` : p.displayName}
                          style={{ fontSize: 12, padding: '5px 8px', borderRadius: 5, border: '1px solid var(--vf-border-subtle)', background: 'var(--vf-elevated)', color: 'var(--vf-text-primary)' }}
                        />
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      ))}

      {!groups.length && !loading && (
        <div style={{ textAlign: 'center', padding: '20px 0' }}>
          <p style={{ color: 'var(--vf-text-muted)', fontSize: 13, margin: '0 0 12px' }}>
            {deviceId
              ? 'Loading OID-mapped parameters from the activated product definition…'
              : 'Select a device above to load its product definition parameters.'}
          </p>
          {deviceId && (
            <button
              onClick={loadDef}
              disabled={loading}
              style={{
                padding: '6px 16px', borderRadius: 6, cursor: 'pointer',
                border: '1px solid rgba(139,92,246,0.5)', background: 'rgba(139,92,246,0.1)',
                color: '#a78bfa', fontSize: 12, fontWeight: 600,
              }}
            >
              {loading ? 'Loading…' : '📥 Load Parameters'}
            </button>
          )}
        </div>
      )}

      {/* SNMP SET Trace — shown after a successful push */}
      {pushResult?.snmpSets && pushResult.snmpSets.length > 0 && (
        <div style={{
          marginTop: 16, padding: '12px 14px', borderRadius: 8,
          background: 'rgba(34,197,94,0.07)', border: '1px solid rgba(34,197,94,0.3)',
        }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#22c55e', marginBottom: 8 }}>
            🔧 SNMP SET Trace — {pushResult.snmpSets.length} OID{pushResult.snmpSets.length !== 1 ? 's' : ''} applied
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {pushResult.snmpSets.map((s, i) => (
              <div key={i} style={{
                display: 'flex', alignItems: 'center', gap: 10, fontSize: 11,
                fontFamily: 'var(--vf-font-mono)', padding: '3px 6px',
                borderRadius: 4, background: 'rgba(255,255,255,0.03)',
              }}>
                <span style={{
                  padding: '1px 6px', borderRadius: 3, fontSize: 10, fontWeight: 700,
                  background: s.status === 'SET' ? 'rgba(34,197,94,0.2)' : 'rgba(239,68,68,0.2)',
                  color: s.status === 'SET' ? '#22c55e' : '#f87171',
                }}>{s.status}</span>
                <span style={{ color: '#60a5fa', minWidth: 200 }}>{s.oid}</span>
                <span style={{ color: 'var(--vf-text-muted)', minWidth: 160 }}>{s.displayName || s.parameterId}</span>
                <span style={{ color: 'var(--vf-text-primary)', fontWeight: 600 }}>=&nbsp;{s.value}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// 2. Push Config tab (individual + bulk)
// ═══════════════════════════════════════════════════════════════════════════════
function PushConfigTab() {
  const { addToast } = useToast();
  const [templates, setTemplates]   = useState<ConfigTemplate[]>([]);
  const [devices, setDevices]       = useState<Device[]>([]);
  const [selectedTemplate, setTmpl] = useState('');
  const [selectedDevice, setDev]    = useState('');
  const [filterType, setFilterType] = useState('');
  const [bulkMode, setBulkMode]     = useState(false);
  const [result, setResult]         = useState<PushResult | ConfigJob | null>(null);
  const [pushing, setPushing]       = useState(false);
  const [history, setHistory]       = useState<ConfigVersion[]>([]);
  const [showHistory, setShowHistory] = useState(false);

  useEffect(() => {
    Promise.all([fetchTemplates(), fetchDevices({})])
      .then(([t, d]) => { setTemplates(t); setDevices(d); })
      .catch(() => {});
  }, []);

  const handlePush = async () => {
    if (!selectedTemplate) { addToast('Select a template first', 'warning'); return; }
    setPushing(true); setResult(null);
    try {
      if (bulkMode) {
        const filter: Record<string, string> = {};
        if (filterType) filter.deviceType = filterType;
        const job = await bulkPush(filter, selectedTemplate);
        setResult(job);
        addToast(`Bulk push started — ${job.totalDevices} devices`, 'success');
        // Poll for live progress every 1 s until COMPLETED / FAILED
        const poll = async (jobId: string) => {
          try {
            const updated = await getJobStatus(jobId);
            setResult(updated);
            if (updated.status === 'RUNNING' || updated.status === 'QUEUED') {
              setTimeout(() => poll(jobId), 1000);
            }
          } catch { /* ignore poll errors */ }
        };
        if (job.jobId && (job.status === 'RUNNING' || job.status === 'QUEUED')) {
          setTimeout(() => poll(job.jobId), 1000);
        }
      } else {
        if (!selectedDevice) { addToast('Select a device', 'warning'); setPushing(false); return; }
        const tpl = templates.find((t) => t.id === selectedTemplate);
        const res = await pushConfig(selectedDevice, selectedTemplate, tpl?.parameters);
        setResult(res);
        addToast(`Config pushed: ${res.status}`, res.status === 'PUSHED' ? 'success' : 'warning');
      }
    } catch (e) { logger.error('Push failed', e); addToast('Push failed', 'error'); }
    finally { setPushing(false); }
  };

  const loadHistory = async () => {
    if (!selectedDevice) { addToast('Select a device to view history', 'warning'); return; }
    try {
      const h = await getVersionHistory(selectedDevice);
      setHistory(h);
      setShowHistory(true);
    } catch { addToast('Failed to load history', 'error'); }
  };

  const templateOptions = [
    { value: '', label: 'Select template…' },
    ...templates.map((t) => ({ value: t.id!, label: t.name + (t.isDefault ? ' ★ default' : '') })),
  ];
  const deviceOptions = [
    { value: '', label: 'Select device…' },
    ...devices.map((d) => ({ value: d.serialNumber || d.deviceId || d.id, label: `${d.serialNumber} — ${d.ipAddress} (${d.deviceType})` })),
  ];

  const isPushResult = (r: PushResult | ConfigJob): r is PushResult => 'commandId' in r || ('totalDevices' in r === false && ['PUSHED','REJECTED','DEVICE_OFFLINE'].includes((r as PushResult).status));

  return (
    <>
      {/* Mode toggle */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
        <Button variant={!bulkMode ? 'primary' : 'ghost'} size="sm" onClick={() => setBulkMode(false)}>Single Device</Button>
        <Button variant={bulkMode ? 'primary' : 'ghost'}  size="sm" onClick={() => setBulkMode(true)}>Bulk Push</Button>
      </div>

      <div style={{ background: 'var(--vf-surface)', border: '1px solid var(--vf-border-subtle)', borderRadius: 10, padding: '20px', marginBottom: 16 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 14, marginBottom: 16 }}>
          <FieldRow label="Config Template">
            <Select options={templateOptions} value={selectedTemplate} onChange={(e) => setTmpl(e.target.value)} />
          </FieldRow>
          {!bulkMode ? (
            <FieldRow label="Target Device">
              <Select options={deviceOptions} value={selectedDevice} onChange={(e) => setDev(e.target.value)} />
            </FieldRow>
          ) : (
            <FieldRow label="Filter by Type (blank = all)">
              <Select
                options={[{value:'',label:'All device types'},{value:'BTS',label:'BTS'},{value:'CPE',label:'CPE'},{value:'IDU',label:'IDU'},{value:'RADIO',label:'RADIO'},{value:'SWITCH',label:'SWITCH'},{value:'ROUTER',label:'ROUTER'}]}
                value={filterType} onChange={(e) => setFilterType(e.target.value)}
              />
            </FieldRow>
          )}
        </div>

        {selectedTemplate && templates.find((t) => t.id === selectedTemplate) && (
          <TemplatePreview template={templates.find((t) => t.id === selectedTemplate)!} />
        )}

        <div style={{ display: 'flex', gap: 8 }}>
          <Button variant="primary" onClick={handlePush} loading={pushing}>
            {pushing ? 'Pushing…' : bulkMode ? 'Bulk Push' : 'Push Config'}
          </Button>
          {!bulkMode && selectedDevice && (
            <Button variant="ghost" size="sm" onClick={loadHistory}>View History</Button>
          )}
        </div>
      </div>

      {/* Definition-based OID push — shown when a single device is selected */}
      {!bulkMode && selectedDevice && (
        <DefinitionParamPusher
          deviceId={selectedDevice}
          onPushComplete={(r) => setResult(r)}
        />
      )}

      {/* Result card */}
      {result && (
        <div style={{ background: 'var(--vf-surface)', border: '1px solid var(--vf-border-subtle)', borderRadius: 10, padding: '16px 20px', marginTop: 16 }}>
          {isPushResult(result) ? (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <Badge variant={result.status === 'PUSHED' ? 'success' : 'warning'} dot>{result.status}</Badge>
                <span style={{ fontSize: 13, color: 'var(--vf-text-secondary)' }}>{result.message}</span>
                {result.commandId && <span style={{ fontSize: 11, fontFamily: 'var(--vf-font-mono)', color: 'var(--vf-text-muted)' }}>CMD: {result.commandId}</span>}
              </div>
              {/* SNMP SET trace table */}
              {result.snmpSets && result.snmpSets.length > 0 && (
                <div style={{ marginTop: 12 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--vf-text-secondary)', marginBottom: 6 }}>
                    🔧 SNMP SET trace ({result.snmpSets.length} OID{result.snmpSets.length > 1 ? 's' : ''})
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {result.snmpSets.map((s: SnmpSetItem) => (
                      <div key={s.oid} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12, background: 'var(--vf-elevated)', borderRadius: 5, padding: '4px 10px' }}>
                        <Badge variant={s.status === 'SET' ? 'success' : 'danger'}>{s.status}</Badge>
                        <span style={{ fontFamily: 'var(--vf-font-mono)', color: '#8b5cf6', minWidth: 200 }}>{s.oid}</span>
                        <span style={{ color: 'var(--vf-text-secondary)' }}>{s.displayName}</span>
                        <span style={{ marginLeft: 'auto', fontFamily: 'var(--vf-font-mono)', color: 'var(--vf-accent)' }}>= {String(s.value)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          ) : (
            <div>
              <div style={{ display: 'flex', gap: 12, marginBottom: 10 }}>
                <MetricCard label="Total" value={(result as ConfigJob).totalDevices} />
                <MetricCard label="Success" value={(result as ConfigJob).successCount} variant="success" />
                <MetricCard label="Failed" value={(result as ConfigJob).failureCount} variant={(result as ConfigJob).failureCount > 0 ? 'danger' : 'default'} />
                <MetricCard label="Pending" value={(result as ConfigJob).pendingCount} />
              </div>
              <div style={{ height: 8, background: 'var(--vf-elevated)', borderRadius: 4, overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${(result as ConfigJob).progressPercent}%`, background: 'var(--vf-accent)', borderRadius: 4, transition: 'width 0.5s' }} />
              </div>
              <div style={{ fontSize: 12, color: 'var(--vf-text-muted)', marginTop: 6 }}>{(result as ConfigJob).progressPercent}% complete</div>
            </div>
          )}
        </div>
      )}

      {/* History modal */}
      <Modal open={showHistory} onClose={() => setShowHistory(false)} title="Config Version History" size="lg">
        {history.length === 0 ? <EmptyState title="No history" description="No config changes recorded for this device." compact /> : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {history.map((v, i) => (
              <div key={v.id ?? i} style={{ background: 'var(--vf-elevated)', borderRadius: 8, padding: '12px 14px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <Badge variant="default">v{v.versionNumber}</Badge>
                  <span style={{ fontSize: 12, color: 'var(--vf-text-muted)' }}>by {v.actor} · {new Date(v.appliedAt).toLocaleString()}</span>
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {Object.entries(v.newValues ?? {}).map(([k, val]) => (
                    <div key={k} style={{ fontSize: 11, background: 'var(--vf-surface)', padding: '3px 8px', borderRadius: 4 }}>
                      <span style={{ color: 'var(--vf-text-muted)' }}>{k}:</span> <span style={{ fontFamily: 'var(--vf-font-mono)', color: 'var(--vf-accent)' }}>{val}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </Modal>
    </>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// 3. Firmware tab
// ═══════════════════════════════════════════════════════════════════════════════
function FirmwareTab() {
  const { addToast } = useToast();
  const [devices, setDevices]       = useState<Device[]>([]);
  const [firmwareVersion, setFwVer] = useState('');
  const [firmwareUrl, setFwUrl]     = useState('');
  const [selectedDevice, setDev]    = useState('');
  const [selectedDevices, setDevs]  = useState<Set<string>>(new Set());
  const [bulkMode, setBulkMode]     = useState(false);
  const [result, setResult]         = useState<PushResult | ConfigJob | null>(null);
  const [pushing, setPushing]       = useState(false);

  useEffect(() => {
    fetchDevices({}).then(setDevices).catch(() => {});
  }, []);

  // Firmware version breakdown
  const byFirmware: Record<string, number> = {};
  devices.forEach((d) => { const v = d.firmwareVersion ?? 'Unknown'; byFirmware[v] = (byFirmware[v] ?? 0) + 1; });

  const handlePush = async () => {
    if (!firmwareVersion.trim()) { addToast('Enter firmware version', 'warning'); return; }
    setPushing(true); setResult(null);
    try {
      if (bulkMode) {
        const ids = Array.from(selectedDevices);
        if (!ids.length) { addToast('Select at least one device', 'warning'); setPushing(false); return; }
        const job = await bulkFirmware(ids, firmwareVersion, firmwareUrl || undefined);
        setResult(job);
        addToast(`Firmware upgrade started for ${ids.length} devices`, 'success');
      } else {
        if (!selectedDevice) { addToast('Select a device', 'warning'); setPushing(false); return; }
        const res = await pushFirmware(selectedDevice, firmwareVersion, firmwareUrl || undefined);
        setResult(res);
        addToast(`Firmware push: ${res.status}`, res.status === 'PUSHED' ? 'success' : 'warning');
      }
    } catch (e) { logger.error('Firmware push failed', e); addToast('Firmware upgrade failed', 'error'); }
    finally { setPushing(false); }
  };

  const toggleDevice = (id: string) => {
    setDevs((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  };

  const deviceOptions = [
    { value: '', label: 'Select device…' },
    ...devices.map((d) => ({ value: d.id, label: `${d.serialNumber} — ${d.firmwareVersion ?? '?'} (${d.deviceType})` })),
  ];

  const isPushResult = (r: PushResult | ConfigJob): r is PushResult =>
    'commandId' in r || ('totalDevices' in r === false && ['PUSHED','REJECTED','DEVICE_OFFLINE'].includes((r as PushResult).status));

  return (
    <>
      {/* Firmware summary */}
      <div style={{ background: 'var(--vf-surface)', border: '1px solid var(--vf-border-subtle)', borderRadius: 10, padding: '14px 18px', marginBottom: 16 }}>
        <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--vf-text-muted)', marginBottom: 10 }}>Firmware Versions in Fleet</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {Object.entries(byFirmware).sort((a, b) => b[1] - a[1]).map(([ver, count]) => (
            <div key={ver} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 10px', background: 'var(--vf-elevated)', borderRadius: 6, fontSize: 12 }}>
              <span style={{ fontFamily: 'var(--vf-font-mono)', color: 'var(--vf-accent)' }}>{ver}</span>
              <Badge variant="default">{count}</Badge>
            </div>
          ))}
        </div>
      </div>

      {/* Mode toggle */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <Button variant={!bulkMode ? 'primary' : 'ghost'} size="sm" onClick={() => setBulkMode(false)}>Individual</Button>
        <Button variant={bulkMode ? 'primary' : 'ghost'}  size="sm" onClick={() => setBulkMode(true)}>Bulk Upgrade</Button>
      </div>

      <div style={{ background: 'var(--vf-surface)', border: '1px solid var(--vf-border-subtle)', borderRadius: 10, padding: '20px', marginBottom: 16 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 14, marginBottom: 16 }}>
          <FieldRow label="Target Firmware Version">
            <Input value={firmwareVersion} onChange={(e) => setFwVer(e.target.value)} placeholder="e.g. 0.0.0.500" />
          </FieldRow>
          <FieldRow label="Firmware URL (optional)">
            <Input value={firmwareUrl} onChange={(e) => setFwUrl(e.target.value)} placeholder="https://cdn.example.com/fw.bin" />
          </FieldRow>
        </div>

        {!bulkMode ? (
          <FieldRow label="Target Device">
            <Select options={deviceOptions} value={selectedDevice} onChange={(e) => setDev(e.target.value)} style={{ maxWidth: 400 }} />
          </FieldRow>
        ) : (
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--vf-text-muted)', marginBottom: 8 }}>
              Select Devices ({selectedDevices.size} selected)
            </div>
            <div style={{ maxHeight: 200, overflowY: 'auto', border: '1px solid var(--vf-border-subtle)', borderRadius: 8, padding: '4px' }}>
              {devices.map((d) => (
                <label key={d.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 10px', cursor: 'pointer', borderRadius: 6, background: selectedDevices.has(d.id) ? 'rgba(59,130,246,0.08)' : 'transparent' }}>
                  <input type="checkbox" checked={selectedDevices.has(d.id)} onChange={() => toggleDevice(d.id)} />
                  <span style={{ fontSize: 12 }}>{d.serialNumber}</span>
                  <span style={{ fontSize: 11, color: 'var(--vf-text-muted)' }}>({d.deviceType}) v{d.firmwareVersion ?? '?'}</span>
                </label>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <Button variant="ghost" size="sm" onClick={() => setDevs(new Set(devices.map((d) => d.id)))}>Select All</Button>
              <Button variant="ghost" size="sm" onClick={() => setDevs(new Set())}>Clear</Button>
            </div>
          </div>
        )}

        <div style={{ marginTop: 16 }}>
          <Button variant="primary" onClick={handlePush} loading={pushing}>
            {pushing ? 'Upgrading…' : bulkMode ? `Upgrade ${selectedDevices.size} Devices` : 'Upgrade Firmware'}
          </Button>
        </div>
      </div>

      {/* Result */}
      {result && (
        <div style={{ background: 'var(--vf-surface)', border: '1px solid var(--vf-border-subtle)', borderRadius: 10, padding: '16px 20px' }}>
          {isPushResult(result) ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <Badge variant={result.status === 'PUSHED' ? 'success' : 'warning'} dot>{result.status}</Badge>
              <span style={{ fontSize: 13 }}>{result.message}</span>
            </div>
          ) : (
            <div>
              <div style={{ display: 'flex', gap: 12, marginBottom: 10 }}>
                <MetricCard label="Total" value={(result as ConfigJob).totalDevices} />
                <MetricCard label="Success" value={(result as ConfigJob).successCount} variant="success" />
                <MetricCard label="Failed" value={(result as ConfigJob).failureCount} variant={(result as ConfigJob).failureCount > 0 ? 'danger' : 'default'} />
              </div>
              <div style={{ height: 8, background: 'var(--vf-elevated)', borderRadius: 4, overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${(result as ConfigJob).progressPercent}%`, background: '#22c55e', borderRadius: 4, transition: 'width 0.5s' }} />
              </div>
              <span style={{ fontSize: 12, color: 'var(--vf-text-muted)' }}>{(result as ConfigJob).progressPercent}% complete</span>
            </div>
          )}
        </div>
      )}
    </>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// 4. Jobs tab
// ═══════════════════════════════════════════════════════════════════════════════
function JobsTab() {
  const { addToast } = useToast();
  const [jobId, setJobId]     = useState('');
  const [job, setJob]         = useState<ConfigJob | null>(null);
  const [loading, setLoading] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const checkJob = useCallback(async () => {
    if (!jobId.trim()) return;
    setLoading(true);
    try {
      const j = await getJobStatus(jobId.trim());
      setJob(j);
      // Auto-stop polling when done
      if (j.status === 'COMPLETED' || j.status === 'FAILED') {
        if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
      }
    } catch { addToast('Job not found', 'error'); }
    finally { setLoading(false); }
  }, [jobId, addToast]);

  const startPolling = () => {
    checkJob();
    if (intervalRef.current) clearInterval(intervalRef.current);
    intervalRef.current = setInterval(checkJob, 5_000);
  };

  useEffect(() => () => { if (intervalRef.current) clearInterval(intervalRef.current); }, []);

  const statusColor: Record<string, string> = {
    RUNNING: '#60a5fa', COMPLETED: '#22c55e', FAILED: '#ef4444', PARTIAL: '#fbbf24',
  };

  return (
    <div style={{ maxWidth: 640 }}>
      <p style={{ fontSize: 13, color: 'var(--vf-text-muted)', marginTop: 0, marginBottom: 16 }}>
        Enter a Job ID returned from a bulk push or firmware upgrade to track its live status.
      </p>
      <div style={{ display: 'flex', gap: 10, marginBottom: 20 }}>
        <Input value={jobId} onChange={(e) => setJobId(e.target.value)} placeholder="job-xxxxxxxx" style={{ flex: 1 }} />
        <Button variant="primary" onClick={startPolling} loading={loading} disabled={!jobId.trim()}>Track</Button>
        {intervalRef.current && <Button variant="ghost" onClick={() => { if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; } }}>Stop</Button>}
      </div>

      {job && (
        <div style={{ background: 'var(--vf-surface)', border: '1px solid var(--vf-border-subtle)', borderRadius: 10, padding: '20px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <span style={{ fontFamily: 'var(--vf-font-mono)', fontSize: 12, color: 'var(--vf-text-muted)' }}>{job.jobId}</span>
            <span style={{ fontWeight: 700, color: statusColor[job.status] ?? 'var(--vf-text-primary)', fontSize: 14 }}>{job.status}</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 16 }}>
            <MetricCard label="Total"   value={job.totalDevices} />
            <MetricCard label="Success" value={job.successCount} variant="success" />
            <MetricCard label="Failed"  value={job.failureCount} variant={job.failureCount > 0 ? 'danger' : 'default'} />
            <MetricCard label="Pending" value={job.pendingCount} />
          </div>
          <div style={{ height: 10, background: 'var(--vf-elevated)', borderRadius: 5, overflow: 'hidden', marginBottom: 8 }}>
            <div style={{ height: '100%', width: `${job.progressPercent}%`, background: statusColor[job.status] ?? '#60a5fa', borderRadius: 5, transition: 'width 0.5s' }} />
          </div>
          <span style={{ fontSize: 12, color: 'var(--vf-text-muted)' }}>{job.progressPercent}%</span>

          {job.perDeviceStatus && Object.keys(job.perDeviceStatus).length > 0 && (
            <div style={{ marginTop: 16 }}>
              <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--vf-text-muted)', marginBottom: 8 }}>Per Device</div>
              <div style={{ maxHeight: 200, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
                {Object.entries(job.perDeviceStatus).map(([deviceId, status]) => (
                  <div key={deviceId} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, padding: '4px 8px', background: 'var(--vf-elevated)', borderRadius: 6 }}>
                    <span style={{ fontFamily: 'var(--vf-font-mono)', color: 'var(--vf-text-secondary)' }}>{deviceId}</span>
                    <Badge variant={status === 'SUCCESS' ? 'success' : status === 'FAILED' ? 'danger' : 'default'}>{status}</Badge>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Main Config Page
// ═══════════════════════════════════════════════════════════════════════════════
export default function V2ConfigPage() {
  const [tab, setTab] = useState<ConfigTab>('templates');

  return (
    <div className="vf-page">
      <div className="vf-page-header">
        <h1 className="vf-page-title">Configuration Management</h1>
        <p style={{ fontSize: 12, color: 'var(--vf-text-muted)', margin: 0 }}>NMS-CF-01 to CF-05 · Templates · Bulk Push · Firmware Upgrade</p>
      </div>

      <div style={{ display: 'flex', background: 'var(--vf-surface)', borderBottom: '1px solid rgba(77,158,255,0.1)', marginBottom: 24, marginLeft: -28, marginRight: -28, paddingLeft: 28, overflowX: 'auto' }}>
        <TabBtn id="templates" active={tab === 'templates'} label="Templates"    onClick={setTab} />
        <TabBtn id="push"      active={tab === 'push'}      label="Push Config"  onClick={setTab} />
        <TabBtn id="firmware"  active={tab === 'firmware'}  label="Firmware"     onClick={setTab} />
        <TabBtn id="jobs"      active={tab === 'jobs'}      label="Jobs"         onClick={setTab} />
      </div>

      {tab === 'templates' && <TemplatesTab />}
      {tab === 'push'      && <PushConfigTab />}
      {tab === 'firmware'  && <FirmwareTab />}
      {tab === 'jobs'      && <JobsTab />}
    </div>
  );
}
