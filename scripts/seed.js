/**
 * UBR Open NMS — Comprehensive Seed Script
 * ─────────────────────────────────────────
 * Seeds all MongoDB collections with realistic data so every UI feature
 * can be tested immediately after docker compose up.
 *
 * Usage:
 *   cd scripts && npm install && node seed.js
 *   node seed.js --reset   (drop collections first)
 *
 * Databases seeded:
 *   ubrnms               → users
 *   ubrnms_inventory     → organizations, hierarchy_views, networks, devices, birth_certificates
 *   ubrnms_alarms        → alarms, alarm_thresholds
 *   ubrnms_kpi           → kpi_warm
 *   ubrnms_config        → config_templates, config_versions
 *   ubrnms_topology      → topology_nodes
 */

'use strict';

const { MongoClient } = require('mongodb');
const bcrypt = require('bcryptjs');

const MONGO_URL = process.env.MONGO_URL || 'mongodb://localhost:27017';
const RESET = process.argv.includes('--reset');
const BCRYPT_ROUNDS = 10;

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────
function now() { return new Date(); }
function daysAgo(n) { return new Date(Date.now() - n * 86_400_000); }
function hoursAgo(n) { return new Date(Date.now() - n * 3_600_000); }
function minsAgo(n) { return new Date(Date.now() - n * 60_000); }

/** Generate KPI aggregate buckets for a device going back `days` days at hourly granularity */
function kpiBuckets(deviceId, deviceType, networkId, days = 7) {
  const buckets = [];
  const now = Date.now();
  const hourMs = 3_600_000;
  const totalHours = days * 24;

  for (let h = totalHours; h >= 0; h--) {
    const bucketStart = new Date(now - h * hourMs);
    const bucketEnd   = new Date(now - (h - 1) * hourMs);

    // Simulate realistic ranges with some daily variation
    const dayPhase = Math.sin((h / 24) * Math.PI * 2);   // daily cycle
    const noise = () => (Math.random() - 0.5) * 4;

    if (deviceType === 'BTS') {
      buckets.push({
        deviceId, deviceType, networkId,
        granularity: '1HOUR',
        bucketStart, bucketEnd,
        sampleCount: 12,
        ttlExpiry: new Date(bucketEnd.getTime() + 30 * 86_400_000),
        metrics: {
          channelUtilization: stats(55 + dayPhase * 20 + noise(), 5, 10),
          connectedClients:   stats(8  + Math.round(dayPhase * 4), 1, 3),
          throughputUL:       stats(85 + dayPhase * 30 + noise(), 10, 15),
          throughputDL:       stats(40 + dayPhase * 15 + noise(), 5, 8),
          txPower:            stats(20 + noise() * 0.5, 0.5, 1),
          cpuUtilization:     stats(35 + dayPhase * 15 + noise(), 5, 8),
          memoryUtilization:  stats(55 + dayPhase * 10 + noise(), 3, 6),
          retryRate:          stats(Math.max(0, 0.5 + noise() * 0.3), 0.1, 0.5),
          temperature:        stats(42 + dayPhase * 5 + noise(), 1, 3),
        },
      });
    } else if (deviceType === 'CPE') {
      const rssiBase = -62 + noise();
      buckets.push({
        deviceId, deviceType, networkId,
        granularity: '1HOUR',
        bucketStart, bucketEnd,
        sampleCount: 12,
        ttlExpiry: new Date(bucketEnd.getTime() + 30 * 86_400_000),
        metrics: {
          rssi:             stats(rssiBase, 2, 5),
          snr:              stats(Math.max(5, 25 + (rssiBase + 62)), 1, 3),
          throughputUL:     stats(15 + dayPhase * 8 + noise(), 2, 4),
          throughputDL:     stats(30 + dayPhase * 10 + noise(), 3, 6),
          cpuUtilization:   stats(28 + dayPhase * 10 + noise(), 4, 8),
          memoryUtilization:stats(45 + dayPhase * 8  + noise(), 3, 5),
          retryRate:        stats(Math.max(0, 0.8 + noise() * 0.5), 0.1, 0.8),
          connectedClients: stats(3 + Math.round(dayPhase * 2), 1, 2),
        },
      });
    } else { // IDU — connects via Ethernet+PoE (wired), no wireless RSSI/SNR metrics
      buckets.push({
        deviceId, deviceType, networkId,
        granularity: '1HOUR',
        bucketStart, bucketEnd,
        sampleCount: 12,
        ttlExpiry: new Date(bucketEnd.getTime() + 30 * 86_400_000),
        metrics: {
          throughputUL:  stats(200 + dayPhase * 50 + noise(), 10, 20),
          throughputDL:  stats(200 + dayPhase * 50 + noise(), 10, 20),
          latencyMs:     stats(Math.max(0.5, 2.5 + noise() * 0.5), 0.2, 1.0),
          errorRate:     stats(Math.max(0, 0.05 + noise() * 0.02), 0.01, 0.05),
          cpuUtilization:stats(20 + dayPhase * 8 + noise(), 2, 4),
          memoryUtilization: stats(35 + dayPhase * 5 + noise(), 2, 4),
        },
      });
    }
  }
  return buckets;
}

function stats(avg, spread, range) {
  const min = +(avg - spread).toFixed(2);
  const max = +(avg + range).toFixed(2);
  const a   = +avg.toFixed(2);
  return { min, max, avg: a, count: 12, sum: +(a * 12).toFixed(2) };
}

// ─────────────────────────────────────────────────────────────────────────────
// DATA DEFINITIONS
// ─────────────────────────────────────────────────────────────────────────────

// ── IDs ────────────────────────────────────────────────────────────────────
const IDS = {
  // Orgs
  orgDelhi:   'org-airtel-delhi-001',
  orgMumbai:  'org-airtel-mumbai-001',
  // Circles
  circleDelhi: 'circle-delhi-north-001',
  circleMumbai:'circle-mumbai-west-001',
  // Networks
  netDN: 'net-delhi-north-001',
  netDS: 'net-delhi-south-001',
  netMW: 'net-mumbai-west-001',
  // Devices — BTS
  btsDN:  'dev-bts-dn-001',
  btsDS:  'dev-bts-ds-001',
  btsMW:  'dev-bts-mw-001',
  // Devices — CPE
  cpeDN1: 'dev-cpe-dn-001',
  cpeDN2: 'dev-cpe-dn-002',
  cpeDN3: 'dev-cpe-dn-003',
  cpeDS1: 'dev-cpe-ds-001',
  cpeDS2: 'dev-cpe-ds-002',
  cpeMW1: 'dev-cpe-mw-001',
  cpeMW2: 'dev-cpe-mw-002',
  cpeMW3: 'dev-cpe-mw-003',
  // Devices — IDU
  iduDN:  'dev-idu-dn-001',
  iduDS:  'dev-idu-ds-001',
  iduMW:  'dev-idu-mw-001',
  // Birth certs
  bcBtsDN:  'bc-bts-dn-001',
  bcBtsDS:  'bc-bts-ds-001',
  bcBtsMW:  'bc-bts-mw-001',
  bcIduDN:  'bc-idu-dn-001',
  bcCpeDN1: 'bc-cpe-dn-001',
  // Templates
  tmplBTS:   'tmpl-bts-std-001',
  tmplCPE:   'tmpl-cpe-home-001',
  tmplCPEEnt:'tmpl-cpe-ent-001',
  tmplIDU:   'tmpl-idu-p2p-001',
  // Alarms
  almCrit1: 'alm-crit-link-dn-001',
  almCrit2: 'alm-crit-dev-unreach-001',
  almMaj1:  'alm-maj-cpu-dn-001',
  almMaj2:  'alm-maj-sig-deg-001',
  almMin1:  'alm-min-low-sig-001',
  almMin2:  'alm-min-chan-intf-001',
  almWarn1: 'alm-warn-mem-001',
  almAck1:  'alm-ack-temp-001',
  almClr1:  'alm-clr-pwr-001',
  almClr2:  'alm-clr-dhcp-001',
};

// ─────────────────────────────────────────────────────────────────────────────
// SEED FUNCTIONS
// ─────────────────────────────────────────────────────────────────────────────

async function seedAuth(db, reset) {
  const users = db.collection('users');
  if (reset) await users.deleteMany({});

  const existing = await users.countDocuments();
  if (existing > 0) { console.log('  ↳ users already seeded — skipping'); return; }

  const hash = (pw) => bcrypt.hash(pw, BCRYPT_ROUNDS);
  const docs = [
    {
      username: 'admin',
      email: 'admin@ubrnms.local',
      passwordHash: await hash('Admin@NMS2024!'),
      role: 'admin',
      permissions: { canManageUsers: true, canPushConfig: true, canAcknowledgeAlarms: true },
      isActive: true, isLdapUser: false,
      failedAttempts: 0, lockoutUntil: null, lastLogin: hoursAgo(1),
      passwordChangedAt: daysAgo(30),
      createdAt: daysAgo(90), updatedAt: hoursAgo(1),
    },
    {
      username: 'operator',
      email: 'operator@ubrnms.local',
      passwordHash: await hash('Operator@NMS2024!'),
      role: 'operator',
      permissions: { canPushConfig: true, canAcknowledgeAlarms: true },
      isActive: true, isLdapUser: false,
      failedAttempts: 0, lockoutUntil: null, lastLogin: hoursAgo(3),
      passwordChangedAt: daysAgo(15),
      createdAt: daysAgo(60), updatedAt: hoursAgo(3),
    },
    {
      username: 'viewer',
      email: 'viewer@ubrnms.local',
      passwordHash: await hash('Viewer@NMS2024!'),
      role: 'user',
      permissions: {},
      isActive: true, isLdapUser: false,
      failedAttempts: 0, lockoutUntil: null, lastLogin: daysAgo(2),
      passwordChangedAt: daysAgo(7),
      createdAt: daysAgo(30), updatedAt: daysAgo(2),
    },
    {
      username: 'noc_operator',
      email: 'noc@ubrnms.local',
      passwordHash: await hash('NocOp@NMS2024!'),
      role: 'operator',
      permissions: { canAcknowledgeAlarms: true },
      isActive: true, isLdapUser: false,
      failedAttempts: 0, lockoutUntil: null, lastLogin: minsAgo(30),
      passwordChangedAt: daysAgo(5),
      createdAt: daysAgo(45), updatedAt: minsAgo(30),
    },
    {
      username: 'disabled_user',
      email: 'disabled@ubrnms.local',
      passwordHash: await hash('Disabled@NMS2024!'),
      role: 'user',
      permissions: {},
      isActive: false, isLdapUser: false,
      failedAttempts: 5, lockoutUntil: daysAgo(-1),
      passwordChangedAt: daysAgo(90),
      createdAt: daysAgo(120), updatedAt: daysAgo(1),
    },
  ];

  await users.insertMany(docs);
  console.log(`  ✓ users: ${docs.length} inserted`);
}

async function seedInventory(db, reset) {
  if (reset) {
    for (const c of ['organizations', 'hierarchy_views', 'networks', 'devices', 'birth_certificates']) {
      await db.collection(c).deleteMany({});
    }
  }

  // ── Organizations ──────────────────────────────────────────────────────────
  const orgs = db.collection('organizations');
  if (await orgs.countDocuments() === 0) {
    await orgs.insertMany([
      { _id: IDS.orgDelhi,  id: IDS.orgDelhi,  name: 'Airtel Delhi',  description: 'Airtel telecom circle — Delhi & NCR', active: true, createdAt: daysAgo(180), updatedAt: daysAgo(10) },
      { _id: IDS.orgMumbai, id: IDS.orgMumbai, name: 'Airtel Mumbai', description: 'Airtel telecom circle — Mumbai Metropolitan', active: true, createdAt: daysAgo(180), updatedAt: daysAgo(5) },
    ]);
    console.log('  ✓ organizations: 2 inserted');
  }

  // ── Hierarchy Views (Circles) ──────────────────────────────────────────────
  const hvs = db.collection('hierarchy_views');
  if (await hvs.countDocuments() === 0) {
    await hvs.insertMany([
      { _id: IDS.circleDelhi,  id: IDS.circleDelhi,  organizationId: IDS.orgDelhi,  name: 'Delhi North Circle', type: 'CIRCLE', active: true, createdAt: daysAgo(180), updatedAt: daysAgo(10) },
      { _id: IDS.circleMumbai, id: IDS.circleMumbai, organizationId: IDS.orgMumbai, name: 'Mumbai West Circle',  type: 'CIRCLE', active: true, createdAt: daysAgo(180), updatedAt: daysAgo(5)  },
    ]);
    console.log('  ✓ hierarchy_views: 2 inserted');
  }

  // ── Networks ────────────────────────────────────────────────────────────────
  const nets = db.collection('networks');
  if (await nets.countDocuments() === 0) {
    await nets.insertMany([
      { _id: IDS.netDN, id: IDS.netDN, organizationId: IDS.orgDelhi,  hierarchyId: IDS.circleDelhi,  name: 'Delhi-North-NET', active: true, createdAt: daysAgo(150), updatedAt: daysAgo(5) },
      { _id: IDS.netDS, id: IDS.netDS, organizationId: IDS.orgDelhi,  hierarchyId: IDS.circleDelhi,  name: 'Delhi-South-NET', active: true, createdAt: daysAgo(150), updatedAt: daysAgo(3) },
      { _id: IDS.netMW, id: IDS.netMW, organizationId: IDS.orgMumbai, hierarchyId: IDS.circleMumbai, name: 'Mumbai-West-NET',  active: true, createdAt: daysAgo(140), updatedAt: daysAgo(2) },
    ]);
    console.log('  ✓ networks: 3 inserted');
  }

  // ── Birth Certificates ─────────────────────────────────────────────────────
  const bcs = db.collection('birth_certificates');
  if (await bcs.countDocuments() === 0) {
    await bcs.insertMany([
      {
        _id: IDS.bcBtsDN, id: IDS.bcBtsDN, serialNumber: 'SN-BTS-DN-001',
        latitude: 28.6139, longitude: 77.2090, azimuth: 90, rssi: -48,
        frequency: 5180, channel: 36, channelBandwidth: 80, snr: 36,
        connectedBtsSerial: null,
        capturedAt: daysAgo(120),
      },
      {
        _id: IDS.bcBtsDS, id: IDS.bcBtsDS, serialNumber: 'SN-BTS-DS-001',
        latitude: 28.5355, longitude: 77.3910, azimuth: 270, rssi: -51,
        frequency: 5500, channel: 100, channelBandwidth: 80, snr: 32,
        connectedBtsSerial: null,
        capturedAt: daysAgo(115),
      },
      {
        _id: IDS.bcBtsMW, id: IDS.bcBtsMW, serialNumber: 'SN-BTS-MW-001',
        latitude: 19.0760, longitude: 72.8777, azimuth: 180, rssi: -45,
        frequency: 5745, channel: 149, channelBandwidth: 80, snr: 38,
        connectedBtsSerial: null,
        capturedAt: daysAgo(110),
      },
      {
        _id: IDS.bcIduDN, id: IDS.bcIduDN, serialNumber: 'SN-IDU-DN-001',
        latitude: 28.6210, longitude: 77.2110, azimuth: 270, rssi: -52,
        frequency: 5800, channel: 160, channelBandwidth: 40, snr: 30,
        // IDU connects to CPE via Ethernet+PoE — not directly to BTS
        linkedCpeSerial: 'SN-CPE-DN-001',
        capturedAt: daysAgo(100),
      },
      {
        _id: IDS.bcCpeDN1, id: IDS.bcCpeDN1, serialNumber: 'SN-CPE-DN-001',
        latitude: 28.6200, longitude: 77.2100, azimuth: null, rssi: -62,
        frequency: 5180, channel: 36, channelBandwidth: 80, snr: 24,
        connectedBtsSerial: 'SN-BTS-DN-001',
        capturedAt: daysAgo(90),
      },
    ]);
    console.log('  ✓ birth_certificates: 5 inserted');
  }

  // ── Devices ─────────────────────────────────────────────────────────────────
  const devs = db.collection('devices');
  if (await devs.countDocuments() === 0) {
    const devices = [
      // ── BTS ──────────────────────────────────────────────────────────────
      {
        _id: IDS.btsDN, id: IDS.btsDN, deviceType: 'BTS',
        serialNumber: 'SN-BTS-DN-001', macAddress: 'AA:BB:CC:DD:E1:01',
        ipAddress: '10.10.1.1', model: 'A60',
        firmwareVersion: 'v3.4.1', softwareVersion: 'NMS-Agent-2.1',
        status: 'ONLINE', uptimeSeconds: 864000,
        latitude: 28.6139, longitude: 77.2090, elevation: 18.5, azimuth: 90, tilt: 3,
        location: [77.2090, 28.6139],
        channel: '36', channelBandwidth: '80', txPower: 20, capacityPercentage: 68,
        connectedCpeSerials: ['SN-CPE-DN-001','SN-CPE-DN-002','SN-CPE-DN-003'],
        cascadedBtsSerials: [],
        tags: [{ key: 'site', value: 'SITE-DELHI-NORTH-01' }, { key: 'circle', value: 'DELHI' }, { key: 'tier', value: 'production' }],
        organizationId: IDS.orgDelhi, networkId: IDS.netDN,
        birthCertificateId: IDS.bcBtsDN,
        createdAt: daysAgo(120), updatedAt: minsAgo(5),
      },
      {
        _id: IDS.btsDS, id: IDS.btsDS, deviceType: 'BTS',
        serialNumber: 'SN-BTS-DS-001', macAddress: 'AA:BB:CC:DD:E1:02',
        ipAddress: '10.10.2.1', model: 'A60',
        firmwareVersion: 'v3.4.1', softwareVersion: 'NMS-Agent-2.1',
        status: 'ONLINE', uptimeSeconds: 432000,
        latitude: 28.5355, longitude: 77.3910, elevation: 21.0, azimuth: 270, tilt: 5,
        location: [77.3910, 28.5355],
        channel: '100', channelBandwidth: '80', txPower: 20, capacityPercentage: 42,
        connectedCpeSerials: ['SN-CPE-DS-001','SN-CPE-DS-002'],
        cascadedBtsSerials: [],
        tags: [{ key: 'site', value: 'SITE-DELHI-SOUTH-01' }, { key: 'circle', value: 'DELHI' }],
        organizationId: IDS.orgDelhi, networkId: IDS.netDS,
        birthCertificateId: IDS.bcBtsDS,
        createdAt: daysAgo(115), updatedAt: minsAgo(15),
      },
      {
        _id: IDS.btsMW, id: IDS.btsMW, deviceType: 'BTS',
        serialNumber: 'SN-BTS-MW-001', macAddress: 'AA:BB:CC:DD:E1:03',
        ipAddress: '10.30.1.1', model: 'A60',
        firmwareVersion: 'v3.5.0', softwareVersion: 'NMS-Agent-2.2',
        status: 'ONLINE', uptimeSeconds: 1728000,
        latitude: 19.0760, longitude: 72.8777, elevation: 25.0, azimuth: 180, tilt: 2,
        location: [72.8777, 19.0760],
        channel: '149', channelBandwidth: '80', txPower: 23, capacityPercentage: 55,
        connectedCpeSerials: ['SN-CPE-MW-001','SN-CPE-MW-002','SN-CPE-MW-003'],
        cascadedBtsSerials: [],
        tags: [{ key: 'site', value: 'SITE-MUMBAI-WEST-01' }, { key: 'circle', value: 'MUMBAI' }, { key: 'tier', value: 'production' }],
        organizationId: IDS.orgMumbai, networkId: IDS.netMW,
        birthCertificateId: IDS.bcBtsMW,
        createdAt: daysAgo(110), updatedAt: minsAgo(2),
      },
      // ── CPE — Delhi North ─────────────────────────────────────────────────
      {
        _id: IDS.cpeDN1, id: IDS.cpeDN1, deviceType: 'CPE',
        serialNumber: 'SN-CPE-DN-001', macAddress: 'BB:CC:DD:EE:FF:01',
        ipAddress: '10.10.1.101', model: 'A61',
        firmwareVersion: 'v2.3.0', softwareVersion: 'NMS-Agent-1.8',
        status: 'ONLINE', uptimeSeconds: 259200,
        latitude: 28.6210, longitude: 77.2110, elevation: 2.0,
        connectedBtsSerial: 'SN-BTS-DN-001',
        tags: [{ key: 'customer', value: 'Rajesh Kumar' }, { key: 'plan', value: 'FUP-100' }],
        organizationId: IDS.orgDelhi, networkId: IDS.netDN,
        birthCertificateId: IDS.bcCpeDN1,
        createdAt: daysAgo(90), updatedAt: hoursAgo(2),
      },
      {
        _id: IDS.cpeDN2, id: IDS.cpeDN2, deviceType: 'CPE',
        serialNumber: 'SN-CPE-DN-002', macAddress: 'BB:CC:DD:EE:FF:02',
        ipAddress: '10.10.1.102', model: 'A61',
        firmwareVersion: 'v2.3.0', softwareVersion: 'NMS-Agent-1.8',
        status: 'ONLINE', uptimeSeconds: 172800,
        latitude: 28.6230, longitude: 77.2080, elevation: 1.5,
        connectedBtsSerial: 'SN-BTS-DN-001',
        tags: [{ key: 'customer', value: 'Priya Sharma' }, { key: 'plan', value: 'FUP-50' }],
        organizationId: IDS.orgDelhi, networkId: IDS.netDN,
        createdAt: daysAgo(85), updatedAt: hoursAgo(4),
      },
      {
        _id: IDS.cpeDN3, id: IDS.cpeDN3, deviceType: 'CPE',
        serialNumber: 'SN-CPE-DN-003', macAddress: 'BB:CC:DD:EE:FF:03',
        ipAddress: '10.10.1.103', model: 'A61',
        firmwareVersion: 'v2.1.0', softwareVersion: 'NMS-Agent-1.6',
        status: 'OFFLINE', uptimeSeconds: 0,
        latitude: 28.6190, longitude: 77.2140, elevation: 3.0,
        connectedBtsSerial: 'SN-BTS-DN-001',
        tags: [{ key: 'customer', value: 'Mohammed Ali' }, { key: 'plan', value: 'FUP-100' }, { key: 'issue', value: 'power-outage' }],
        organizationId: IDS.orgDelhi, networkId: IDS.netDN,
        createdAt: daysAgo(80), updatedAt: hoursAgo(6),
      },
      // ── CPE — Delhi South ─────────────────────────────────────────────────
      {
        _id: IDS.cpeDS1, id: IDS.cpeDS1, deviceType: 'CPE',
        serialNumber: 'SN-CPE-DS-001', macAddress: 'BB:CC:DD:EE:FF:04',
        ipAddress: '10.10.2.101', model: 'A61',
        firmwareVersion: 'v2.3.0', softwareVersion: 'NMS-Agent-1.8',
        status: 'ONLINE', uptimeSeconds: 518400,
        latitude: 28.5400, longitude: 77.3950, elevation: 1.0,
        connectedBtsSerial: 'SN-BTS-DS-001',
        tags: [{ key: 'customer', value: 'Sunita Patel' }, { key: 'plan', value: 'FUP-200' }],
        organizationId: IDS.orgDelhi, networkId: IDS.netDS,
        createdAt: daysAgo(75), updatedAt: hoursAgo(1),
      },
      {
        _id: IDS.cpeDS2, id: IDS.cpeDS2, deviceType: 'CPE',
        serialNumber: 'SN-CPE-DS-002', macAddress: 'BB:CC:DD:EE:FF:05',
        ipAddress: '10.10.2.102', model: 'A61',
        firmwareVersion: 'v2.3.0', softwareVersion: 'NMS-Agent-1.8',
        status: 'PROVISIONING', uptimeSeconds: 0,
        latitude: 28.5380, longitude: 77.3920, elevation: 2.5,
        connectedBtsSerial: 'SN-BTS-DS-001',
        tags: [{ key: 'customer', value: 'Vijay Singh' }, { key: 'plan', value: 'FUP-100' }],
        organizationId: IDS.orgDelhi, networkId: IDS.netDS,
        createdAt: daysAgo(1), updatedAt: minsAgo(45),
      },
      // ── CPE — Mumbai West ─────────────────────────────────────────────────
      {
        _id: IDS.cpeMW1, id: IDS.cpeMW1, deviceType: 'CPE',
        serialNumber: 'SN-CPE-MW-001', macAddress: 'BB:CC:DD:EE:FF:06',
        ipAddress: '10.30.1.101', model: 'A61',
        firmwareVersion: 'v2.3.0', softwareVersion: 'NMS-Agent-1.8',
        status: 'ONLINE', uptimeSeconds: 691200,
        latitude: 19.0810, longitude: 72.8820, elevation: 3.0,
        connectedBtsSerial: 'SN-BTS-MW-001',
        tags: [{ key: 'customer', value: 'Amit Desai' }, { key: 'plan', value: 'FUP-200' }],
        organizationId: IDS.orgMumbai, networkId: IDS.netMW,
        createdAt: daysAgo(70), updatedAt: hoursAgo(1),
      },
      {
        _id: IDS.cpeMW2, id: IDS.cpeMW2, deviceType: 'CPE',
        serialNumber: 'SN-CPE-MW-002', macAddress: 'BB:CC:DD:EE:FF:07',
        ipAddress: '10.30.1.102', model: 'A61',
        firmwareVersion: 'v2.3.0', softwareVersion: 'NMS-Agent-1.8',
        status: 'ONLINE', uptimeSeconds: 345600,
        latitude: 19.0740, longitude: 72.8750, elevation: 4.5,
        connectedBtsSerial: 'SN-BTS-MW-001',
        tags: [{ key: 'customer', value: 'Nandini Joshi' }, { key: 'plan', value: 'FUP-100' }],
        organizationId: IDS.orgMumbai, networkId: IDS.netMW,
        createdAt: daysAgo(65), updatedAt: hoursAgo(3),
      },
      {
        _id: IDS.cpeMW3, id: IDS.cpeMW3, deviceType: 'CPE',
        serialNumber: 'SN-CPE-MW-003', macAddress: 'BB:CC:DD:EE:FF:08',
        ipAddress: '10.30.1.103', model: 'A61',
        firmwareVersion: 'v2.2.0', softwareVersion: 'NMS-Agent-1.7',
        status: 'ONLINE', uptimeSeconds: 129600,
        latitude: 19.0790, longitude: 72.8800, elevation: 2.0,
        connectedBtsSerial: 'SN-BTS-MW-001',
        tags: [{ key: 'customer', value: 'Rohan Mehta' }, { key: 'plan', value: 'FUP-50' }],
        organizationId: IDS.orgMumbai, networkId: IDS.netMW,
        createdAt: daysAgo(60), updatedAt: hoursAgo(5),
      },
      // ── IDU ───────────────────────────────────────────────────────────────
      // IDU coordinates must exactly match the co-located CPE (topology rule: same lat/lon)
      // ── IDU — Delhi North (2 per CPE per architecture diagram) ──────────────
      // SN-CPE-DN-001 → IDU A (existing) + IDU B (2nd unit on same site)
      {
        _id: IDS.iduDN, id: IDS.iduDN, deviceType: 'IDU',
        serialNumber: 'SN-IDU-DN-001', macAddress: 'CC:DD:EE:FF:00:01',
        ipAddress: '10.10.1.200', model: 'Senao IDU-5000',
        firmwareVersion: 'v1.9.2', softwareVersion: 'NMS-Agent-2.0',
        status: 'ONLINE', uptimeSeconds: 1209600,
        latitude: 28.6210, longitude: 77.2110, elevation: 20.0, azimuth: 270, tilt: 0,
        linkedCpeSerial: 'SN-CPE-DN-001',
        tags: [{ key: 'site', value: 'SITE-DELHI-NORTH-01' }, { key: 'unit', value: 'A' }],
        organizationId: IDS.orgDelhi, networkId: IDS.netDN,
        birthCertificateId: IDS.bcIduDN,
        createdAt: daysAgo(100), updatedAt: minsAgo(10),
      },
      {
        _id: 'dev-idu-dn-001b', id: 'dev-idu-dn-001b', deviceType: 'IDU',
        serialNumber: 'SN-IDU-DN-001B', macAddress: 'CC:DD:EE:FF:00:11',
        ipAddress: '10.10.1.201', model: 'Senao IDU-5000',
        firmwareVersion: 'v1.9.2', softwareVersion: 'NMS-Agent-2.0',
        status: 'ONLINE', uptimeSeconds: 1100000,
        // Same site as SN-CPE-DN-001 — co-located (Ethernet+PoE)
        latitude: 28.6210, longitude: 77.2110, elevation: 20.5, azimuth: 90, tilt: 0,
        linkedCpeSerial: 'SN-CPE-DN-001',
        tags: [{ key: 'site', value: 'SITE-DELHI-NORTH-01' }, { key: 'unit', value: 'B' }],
        organizationId: IDS.orgDelhi, networkId: IDS.netDN,
        createdAt: daysAgo(100), updatedAt: minsAgo(12),
      },
      // SN-CPE-DN-002 → IDU A + IDU B
      {
        _id: 'dev-idu-dn-002a', id: 'dev-idu-dn-002a', deviceType: 'IDU',
        serialNumber: 'SN-IDU-DN-002A', macAddress: 'CC:DD:EE:FF:00:12',
        ipAddress: '10.10.1.202', model: 'Senao IDU-5000',
        firmwareVersion: 'v1.9.0', softwareVersion: 'NMS-Agent-2.0',
        status: 'ONLINE', uptimeSeconds: 900000,
        latitude: 28.6230, longitude: 77.2080, elevation: 18.0, azimuth: 270, tilt: 0,
        linkedCpeSerial: 'SN-CPE-DN-002',
        tags: [{ key: 'site', value: 'SITE-DELHI-NORTH-02' }, { key: 'unit', value: 'A' }],
        organizationId: IDS.orgDelhi, networkId: IDS.netDN,
        createdAt: daysAgo(85), updatedAt: hoursAgo(3),
      },
      {
        _id: 'dev-idu-dn-002b', id: 'dev-idu-dn-002b', deviceType: 'IDU',
        serialNumber: 'SN-IDU-DN-002B', macAddress: 'CC:DD:EE:FF:00:13',
        ipAddress: '10.10.1.203', model: 'Senao IDU-5000',
        firmwareVersion: 'v1.9.0', softwareVersion: 'NMS-Agent-2.0',
        status: 'ONLINE', uptimeSeconds: 880000,
        latitude: 28.6230, longitude: 77.2080, elevation: 18.5, azimuth: 90, tilt: 0,
        linkedCpeSerial: 'SN-CPE-DN-002',
        tags: [{ key: 'site', value: 'SITE-DELHI-NORTH-02' }, { key: 'unit', value: 'B' }],
        organizationId: IDS.orgDelhi, networkId: IDS.netDN,
        createdAt: daysAgo(85), updatedAt: hoursAgo(4),
      },
      // SN-CPE-DN-003 → IDU A + IDU B
      {
        _id: 'dev-idu-dn-003a', id: 'dev-idu-dn-003a', deviceType: 'IDU',
        serialNumber: 'SN-IDU-DN-003A', macAddress: 'CC:DD:EE:FF:00:14',
        ipAddress: '10.10.1.204', model: 'Senao IDU-5000',
        firmwareVersion: 'v2.1.0', softwareVersion: 'NMS-Agent-1.6',
        status: 'OFFLINE', uptimeSeconds: 0,
        latitude: 28.6190, longitude: 77.2140, elevation: 21.0, azimuth: 270, tilt: 0,
        linkedCpeSerial: 'SN-CPE-DN-003',
        tags: [{ key: 'site', value: 'SITE-DELHI-NORTH-03' }, { key: 'unit', value: 'A' }, { key: 'issue', value: 'power-outage' }],
        organizationId: IDS.orgDelhi, networkId: IDS.netDN,
        createdAt: daysAgo(80), updatedAt: hoursAgo(6),
      },
      {
        _id: 'dev-idu-dn-003b', id: 'dev-idu-dn-003b', deviceType: 'IDU',
        serialNumber: 'SN-IDU-DN-003B', macAddress: 'CC:DD:EE:FF:00:15',
        ipAddress: '10.10.1.205', model: 'Senao IDU-5000',
        firmwareVersion: 'v2.1.0', softwareVersion: 'NMS-Agent-1.6',
        status: 'OFFLINE', uptimeSeconds: 0,
        latitude: 28.6190, longitude: 77.2140, elevation: 21.5, azimuth: 90, tilt: 0,
        linkedCpeSerial: 'SN-CPE-DN-003',
        tags: [{ key: 'site', value: 'SITE-DELHI-NORTH-03' }, { key: 'unit', value: 'B' }, { key: 'issue', value: 'power-outage' }],
        organizationId: IDS.orgDelhi, networkId: IDS.netDN,
        createdAt: daysAgo(80), updatedAt: hoursAgo(6),
      },
      // ── IDU — Delhi South (2 per CPE) ────────────────────────────────────────
      {
        _id: IDS.iduDS, id: IDS.iduDS, deviceType: 'IDU',
        serialNumber: 'SN-IDU-DS-001', macAddress: 'CC:DD:EE:FF:00:02',
        ipAddress: '10.10.2.200', model: 'Senao IDU-5000',
        firmwareVersion: 'v1.8.5', softwareVersion: 'NMS-Agent-1.9',
        status: 'OFFLINE', uptimeSeconds: 0,
        latitude: 28.5400, longitude: 77.3950, elevation: 22.0, azimuth: 90, tilt: 0,
        linkedCpeSerial: 'SN-CPE-DS-001',
        tags: [{ key: 'site', value: 'SITE-DELHI-SOUTH-01' }, { key: 'unit', value: 'A' }, { key: 'issue', value: 'device-unreachable' }],
        organizationId: IDS.orgDelhi, networkId: IDS.netDS,
        createdAt: daysAgo(95), updatedAt: hoursAgo(8),
      },
      {
        _id: 'dev-idu-ds-001b', id: 'dev-idu-ds-001b', deviceType: 'IDU',
        serialNumber: 'SN-IDU-DS-001B', macAddress: 'CC:DD:EE:FF:00:21',
        ipAddress: '10.10.2.201', model: 'Senao IDU-5000',
        firmwareVersion: 'v1.8.5', softwareVersion: 'NMS-Agent-1.9',
        status: 'OFFLINE', uptimeSeconds: 0,
        latitude: 28.5400, longitude: 77.3950, elevation: 22.5, azimuth: 270, tilt: 0,
        linkedCpeSerial: 'SN-CPE-DS-001',
        tags: [{ key: 'site', value: 'SITE-DELHI-SOUTH-01' }, { key: 'unit', value: 'B' }, { key: 'issue', value: 'device-unreachable' }],
        organizationId: IDS.orgDelhi, networkId: IDS.netDS,
        createdAt: daysAgo(95), updatedAt: hoursAgo(8),
      },
      {
        _id: 'dev-idu-ds-002a', id: 'dev-idu-ds-002a', deviceType: 'IDU',
        serialNumber: 'SN-IDU-DS-002A', macAddress: 'CC:DD:EE:FF:00:22',
        ipAddress: '10.10.2.202', model: 'Senao IDU-5000',
        firmwareVersion: 'v1.8.5', softwareVersion: 'NMS-Agent-1.9',
        status: 'PROVISIONING', uptimeSeconds: 0,
        latitude: 28.5380, longitude: 77.3920, elevation: 20.0, azimuth: 90, tilt: 0,
        linkedCpeSerial: 'SN-CPE-DS-002',
        tags: [{ key: 'site', value: 'SITE-DELHI-SOUTH-02' }, { key: 'unit', value: 'A' }],
        organizationId: IDS.orgDelhi, networkId: IDS.netDS,
        createdAt: daysAgo(1), updatedAt: minsAgo(45),
      },
      {
        _id: 'dev-idu-ds-002b', id: 'dev-idu-ds-002b', deviceType: 'IDU',
        serialNumber: 'SN-IDU-DS-002B', macAddress: 'CC:DD:EE:FF:00:23',
        ipAddress: '10.10.2.203', model: 'Senao IDU-5000',
        firmwareVersion: 'v1.8.5', softwareVersion: 'NMS-Agent-1.9',
        status: 'PROVISIONING', uptimeSeconds: 0,
        latitude: 28.5380, longitude: 77.3920, elevation: 20.5, azimuth: 270, tilt: 0,
        linkedCpeSerial: 'SN-CPE-DS-002',
        tags: [{ key: 'site', value: 'SITE-DELHI-SOUTH-02' }, { key: 'unit', value: 'B' }],
        organizationId: IDS.orgDelhi, networkId: IDS.netDS,
        createdAt: daysAgo(1), updatedAt: minsAgo(45),
      },
      // ── IDU — Mumbai West (2 per CPE) ─────────────────────────────────────────
      {
        _id: IDS.iduMW, id: IDS.iduMW, deviceType: 'IDU',
        serialNumber: 'SN-IDU-MW-001', macAddress: 'CC:DD:EE:FF:00:03',
        ipAddress: '10.30.1.200', model: 'Senao IDU-5000-AC',
        firmwareVersion: 'v1.9.2', softwareVersion: 'NMS-Agent-2.0',
        status: 'ONLINE', uptimeSeconds: 2592000,
        latitude: 19.0810, longitude: 72.8820, elevation: 28.0, azimuth: 0, tilt: 0,
        linkedCpeSerial: 'SN-CPE-MW-001',
        tags: [{ key: 'site', value: 'SITE-MUMBAI-WEST-01' }, { key: 'unit', value: 'A' }],
        organizationId: IDS.orgMumbai, networkId: IDS.netMW,
        createdAt: daysAgo(90), updatedAt: minsAgo(3),
      },
      {
        _id: 'dev-idu-mw-001b', id: 'dev-idu-mw-001b', deviceType: 'IDU',
        serialNumber: 'SN-IDU-MW-001B', macAddress: 'CC:DD:EE:FF:00:31',
        ipAddress: '10.30.1.201', model: 'Senao IDU-5000-AC',
        firmwareVersion: 'v1.9.2', softwareVersion: 'NMS-Agent-2.0',
        status: 'ONLINE', uptimeSeconds: 2500000,
        latitude: 19.0810, longitude: 72.8820, elevation: 28.5, azimuth: 180, tilt: 0,
        linkedCpeSerial: 'SN-CPE-MW-001',
        tags: [{ key: 'site', value: 'SITE-MUMBAI-WEST-01' }, { key: 'unit', value: 'B' }],
        organizationId: IDS.orgMumbai, networkId: IDS.netMW,
        createdAt: daysAgo(90), updatedAt: minsAgo(5),
      },
      {
        _id: 'dev-idu-mw-002a', id: 'dev-idu-mw-002a', deviceType: 'IDU',
        serialNumber: 'SN-IDU-MW-002A', macAddress: 'CC:DD:EE:FF:00:32',
        ipAddress: '10.30.1.202', model: 'Senao IDU-5000-AC',
        firmwareVersion: 'v1.9.0', softwareVersion: 'NMS-Agent-2.0',
        status: 'ONLINE', uptimeSeconds: 800000,
        latitude: 19.0740, longitude: 72.8750, elevation: 25.0, azimuth: 0, tilt: 0,
        linkedCpeSerial: 'SN-CPE-MW-002',
        tags: [{ key: 'site', value: 'SITE-MUMBAI-WEST-02' }, { key: 'unit', value: 'A' }],
        organizationId: IDS.orgMumbai, networkId: IDS.netMW,
        createdAt: daysAgo(65), updatedAt: hoursAgo(2),
      },
      {
        _id: 'dev-idu-mw-002b', id: 'dev-idu-mw-002b', deviceType: 'IDU',
        serialNumber: 'SN-IDU-MW-002B', macAddress: 'CC:DD:EE:FF:00:33',
        ipAddress: '10.30.1.203', model: 'Senao IDU-5000-AC',
        firmwareVersion: 'v1.9.0', softwareVersion: 'NMS-Agent-2.0',
        status: 'ONLINE', uptimeSeconds: 780000,
        latitude: 19.0740, longitude: 72.8750, elevation: 25.5, azimuth: 180, tilt: 0,
        linkedCpeSerial: 'SN-CPE-MW-002',
        tags: [{ key: 'site', value: 'SITE-MUMBAI-WEST-02' }, { key: 'unit', value: 'B' }],
        organizationId: IDS.orgMumbai, networkId: IDS.netMW,
        createdAt: daysAgo(65), updatedAt: hoursAgo(3),
      },
      {
        _id: 'dev-idu-mw-003a', id: 'dev-idu-mw-003a', deviceType: 'IDU',
        serialNumber: 'SN-IDU-MW-003A', macAddress: 'CC:DD:EE:FF:00:34',
        ipAddress: '10.30.1.204', model: 'Senao IDU-5000',
        firmwareVersion: 'v1.8.0', softwareVersion: 'NMS-Agent-1.8',
        status: 'ONLINE', uptimeSeconds: 300000,
        latitude: 19.0790, longitude: 72.8800, elevation: 22.0, azimuth: 0, tilt: 0,
        linkedCpeSerial: 'SN-CPE-MW-003',
        tags: [{ key: 'site', value: 'SITE-MUMBAI-WEST-03' }, { key: 'unit', value: 'A' }],
        organizationId: IDS.orgMumbai, networkId: IDS.netMW,
        createdAt: daysAgo(60), updatedAt: hoursAgo(4),
      },
      {
        _id: 'dev-idu-mw-003b', id: 'dev-idu-mw-003b', deviceType: 'IDU',
        serialNumber: 'SN-IDU-MW-003B', macAddress: 'CC:DD:EE:FF:00:35',
        ipAddress: '10.30.1.205', model: 'Senao IDU-5000',
        firmwareVersion: 'v1.8.0', softwareVersion: 'NMS-Agent-1.8',
        status: 'ONLINE', uptimeSeconds: 280000,
        latitude: 19.0790, longitude: 72.8800, elevation: 22.5, azimuth: 180, tilt: 0,
        linkedCpeSerial: 'SN-CPE-MW-003',
        tags: [{ key: 'site', value: 'SITE-MUMBAI-WEST-03' }, { key: 'unit', value: 'B' }],
        organizationId: IDS.orgMumbai, networkId: IDS.netMW,
        createdAt: daysAgo(60), updatedAt: hoursAgo(5),
      },
    ];

    await devs.insertMany(devices);
    console.log(`  ✓ devices: ${devices.length} inserted (3 BTS, 8 CPE, 16 IDU — 2 per CPE per architecture diagram)`);
  }
}

async function seedAlarms(db, reset) {
  const alarms = db.collection('alarms');
  const thresholds = db.collection('alarm_thresholds');
  if (reset) { await alarms.deleteMany({}); await thresholds.deleteMany({}); }

  if (await alarms.countDocuments() === 0) {
    const now = new Date();
    const docs = [
      // ── CRITICAL — ACTIVE ──
      {
        _id: IDS.almCrit1, id: IDS.almCrit1,
        alarmId: 'AL-CRIT-0001', deviceId: IDS.btsDN, deviceType: 'BTS',
        alarmType: 'LINK_DOWN', alarmName: 'Ethernet Backhaul Link Down',
        severity: 'CRITICAL', state: 'ACTIVE',
        description: 'Primary Ethernet backhaul link failure on eth0. All downstream CPE traffic affected.',
        metricValue: 0, threshold: 0,
        isRootCause: true, correlatedChildCount: 3, dedupCount: 1,
        acknowledgedBy: null, acknowledgedAt: null,
        networkId: IDS.netDN, organizationId: IDS.orgDelhi,
        latitude: 28.6139, longitude: 77.2090,
        source: 'NETCOOL',
        raisedAt: hoursAgo(2), clearedAt: null,
        ttlExpiry: new Date(now.getTime() + 7 * 86_400_000),
        updatedAt: hoursAgo(2),
      },
      {
        _id: IDS.almCrit2, id: IDS.almCrit2,
        alarmId: 'AL-CRIT-0002', deviceId: IDS.iduDS, deviceType: 'IDU',
        alarmType: 'DEVICE_UNREACHABLE', alarmName: 'Device Unreachable',
        severity: 'CRITICAL', state: 'ACTIVE',
        description: 'ICMP ping timeout — IDU-DS-001 has not responded for 20+ minutes. Backhaul link suspected down.',
        metricValue: 0, threshold: 0,
        isRootCause: true, correlatedChildCount: 0, dedupCount: 4,
        acknowledgedBy: null, acknowledgedAt: null,
        networkId: IDS.netDS, organizationId: IDS.orgDelhi,
        latitude: 28.5355, longitude: 77.3915,
        source: 'NMS-POLL',
        raisedAt: hoursAgo(8), clearedAt: null,
        ttlExpiry: new Date(now.getTime() + 7 * 86_400_000),
        updatedAt: hoursAgo(3),
      },
      // ── MAJOR — ACTIVE ────
      {
        _id: IDS.almMaj1, id: IDS.almMaj1,
        alarmId: 'AL-MAJOR-0001', deviceId: IDS.cpeDN3, deviceType: 'CPE',
        alarmType: 'HIGH_CPU_UTILIZATION', alarmName: 'CPU Utilization Critical',
        severity: 'MAJOR', state: 'ACTIVE',
        description: 'CPU utilization sustained above 90% for 10+ minutes. Possible traffic storm or firmware issue.',
        metricValue: 93.5, threshold: 85.0,
        isRootCause: false, rootCauseAlarmId: IDS.almCrit1,
        correlatedChildCount: 0, dedupCount: 2,
        acknowledgedBy: null, acknowledgedAt: null,
        networkId: IDS.netDN, organizationId: IDS.orgDelhi,
        latitude: 28.6190, longitude: 77.2140,
        source: 'NMS-KPI',
        raisedAt: hoursAgo(5), clearedAt: null,
        ttlExpiry: new Date(now.getTime() + 7 * 86_400_000),
        updatedAt: hoursAgo(5),
      },
      {
        _id: IDS.almMaj2, id: IDS.almMaj2,
        alarmId: 'AL-MAJOR-0002', deviceId: IDS.btsDS, deviceType: 'BTS',
        alarmType: 'SIGNAL_DEGRADED', alarmName: 'RF Signal Level Degraded',
        severity: 'MAJOR', state: 'ACTIVE',
        description: 'Average RSSI of connected CPEs degraded below -78 dBm threshold. Potential antenna misalignment.',
        metricValue: -80.3, threshold: -78.0,
        isRootCause: true, correlatedChildCount: 2,
        dedupCount: 1,
        acknowledgedBy: null, acknowledgedAt: null,
        networkId: IDS.netDS, organizationId: IDS.orgDelhi,
        latitude: 28.5355, longitude: 77.3910,
        source: 'NMS-KPI',
        raisedAt: hoursAgo(3), clearedAt: null,
        ttlExpiry: new Date(now.getTime() + 7 * 86_400_000),
        updatedAt: hoursAgo(3),
      },
      // ── MINOR — ACTIVE ────
      {
        _id: IDS.almMin1, id: IDS.almMin1,
        alarmId: 'AL-MINOR-0001', deviceId: IDS.cpeDN2, deviceType: 'CPE',
        alarmType: 'LOW_SIGNAL_STRENGTH', alarmName: 'Low Signal Strength',
        severity: 'MINOR', state: 'ACTIVE',
        description: 'RSSI dropped to -76 dBm, below the -75 dBm minor threshold. Customer may experience intermittent connectivity.',
        metricValue: -76.2, threshold: -75.0,
        isRootCause: false, rootCauseAlarmId: IDS.almCrit1,
        correlatedChildCount: 0, dedupCount: 1,
        acknowledgedBy: null, acknowledgedAt: null,
        networkId: IDS.netDN, organizationId: IDS.orgDelhi,
        latitude: 28.6230, longitude: 77.2080,
        source: 'NMS-KPI',
        raisedAt: hoursAgo(4), clearedAt: null,
        ttlExpiry: new Date(now.getTime() + 7 * 86_400_000),
        updatedAt: hoursAgo(4),
      },
      {
        _id: IDS.almMin2, id: IDS.almMin2,
        alarmId: 'AL-MINOR-0002', deviceId: IDS.cpeMW3, deviceType: 'CPE',
        alarmType: 'CHANNEL_INTERFERENCE', alarmName: 'Wi-Fi Channel Interference Detected',
        severity: 'MINOR', state: 'ACTIVE',
        description: 'High interference detected on channel 149. Adjacent channel overlap from external AP.',
        metricValue: 0, threshold: 0,
        isRootCause: false, correlatedChildCount: 0, dedupCount: 1,
        acknowledgedBy: null, acknowledgedAt: null,
        networkId: IDS.netMW, organizationId: IDS.orgMumbai,
        latitude: 19.0790, longitude: 72.8800,
        source: 'SYSLOG',
        raisedAt: hoursAgo(1), clearedAt: null,
        ttlExpiry: new Date(now.getTime() + 7 * 86_400_000),
        updatedAt: hoursAgo(1),
      },
      // ── WARNING — ACTIVE ──
      {
        _id: IDS.almWarn1, id: IDS.almWarn1,
        alarmId: 'AL-WARN-0001', deviceId: IDS.cpeDS1, deviceType: 'CPE',
        alarmType: 'HIGH_MEMORY_USAGE', alarmName: 'High Memory Usage',
        severity: 'WARNING', state: 'ACTIVE',
        description: 'Memory usage at 82%, approaching the 85% warning threshold.',
        metricValue: 82.1, threshold: 80.0,
        isRootCause: false, correlatedChildCount: 0, dedupCount: 1,
        acknowledgedBy: null, acknowledgedAt: null,
        networkId: IDS.netDS, organizationId: IDS.orgDelhi,
        latitude: 28.5400, longitude: 77.3950,
        source: 'NMS-KPI',
        raisedAt: hoursAgo(1), clearedAt: null,
        ttlExpiry: new Date(now.getTime() + 7 * 86_400_000),
        updatedAt: hoursAgo(1),
      },
      // ── ACKNOWLEDGED ──────
      {
        _id: IDS.almAck1, id: IDS.almAck1,
        alarmId: 'AL-ACK-0001', deviceId: IDS.btsMW, deviceType: 'BTS',
        alarmType: 'TEMPERATURE_HIGH', alarmName: 'Device Temperature High',
        severity: 'MAJOR', state: 'ACKNOWLEDGED',
        description: 'BTS internal temperature reached 68°C, above the 65°C threshold. Equipment room AC may need servicing.',
        metricValue: 68.2, threshold: 65.0,
        isRootCause: true, correlatedChildCount: 0, dedupCount: 3,
        acknowledgedBy: 'operator', acknowledgedAt: hoursAgo(1),
        networkId: IDS.netMW, organizationId: IDS.orgMumbai,
        latitude: 19.0760, longitude: 72.8777,
        source: 'NMS-KPI',
        raisedAt: hoursAgo(6), clearedAt: null,
        ttlExpiry: new Date(now.getTime() + 7 * 86_400_000),
        updatedAt: hoursAgo(1),
      },
      // ── CLEARED ───────────
      {
        _id: IDS.almClr1, id: IDS.almClr1,
        alarmId: 'AL-CLR-0001', deviceId: IDS.iduDN, deviceType: 'IDU',
        alarmType: 'POWER_FLUCTUATION', alarmName: 'Power Supply Fluctuation',
        severity: 'MAJOR', state: 'CLEARED',
        description: 'Intermittent power supply issue detected. UPS log shows 3 micro-outages.',
        metricValue: 0, threshold: 0,
        isRootCause: false, correlatedChildCount: 0, dedupCount: 2,
        acknowledgedBy: 'admin', acknowledgedAt: hoursAgo(12),
        networkId: IDS.netDN, organizationId: IDS.orgDelhi,
        latitude: 28.6139, longitude: 72.2095,
        source: 'SYSLOG',
        raisedAt: daysAgo(1), clearedAt: hoursAgo(10),
        ttlExpiry: new Date(now.getTime() + 7 * 86_400_000),
        updatedAt: hoursAgo(10),
      },
      {
        _id: IDS.almClr2, id: IDS.almClr2,
        alarmId: 'AL-CLR-0002', deviceId: IDS.cpeDS2, deviceType: 'CPE',
        alarmType: 'DHCP_POOL_EXHAUSTION', alarmName: 'DHCP Pool Exhausted',
        severity: 'MINOR', state: 'CLEARED',
        description: 'DHCP address pool exhausted. All 254 addresses were in use. Auto-reclaim resolved the issue.',
        metricValue: 254, threshold: 240,
        isRootCause: false, correlatedChildCount: 0, dedupCount: 1,
        acknowledgedBy: 'operator', acknowledgedAt: hoursAgo(18),
        networkId: IDS.netDS, organizationId: IDS.orgDelhi,
        latitude: 28.5380, longitude: 77.3920,
        source: 'SYSLOG',
        raisedAt: daysAgo(1), clearedAt: hoursAgo(18),
        ttlExpiry: new Date(now.getTime() + 7 * 86_400_000),
        updatedAt: hoursAgo(18),
      },
    ];

    await alarms.insertMany(docs);
    console.log(`  ✓ alarms: ${docs.length} inserted (2 CRITICAL, 2 MAJOR, 2 MINOR, 1 WARNING, 1 ACK, 2 CLEARED)`);
  }

  if (await thresholds.countDocuments() === 0) {
    await thresholds.insertMany([
      { deviceId: null, deviceType: 'CPE', parameter: 'rssiDbm',           raiseThreshold: -75.0, clearThreshold: -70.0, severity: 'MINOR',    alarmType: 'LOW_SIGNAL_STRENGTH',     enabled: true },
      { deviceId: null, deviceType: 'CPE', parameter: 'rssiDbm',           raiseThreshold: -85.0, clearThreshold: -80.0, severity: 'CRITICAL',  alarmType: 'CRITICAL_SIGNAL',         enabled: true },
      { deviceId: null, deviceType: 'BTS', parameter: 'channelUtilizationPct', raiseThreshold: 90.0, clearThreshold: 80.0, severity: 'MAJOR',   alarmType: 'HIGH_CHANNEL_UTILIZATION',enabled: true },
      { deviceId: null, deviceType: 'BTS', parameter: 'temperature',       raiseThreshold: 65.0,  clearThreshold: 60.0,  severity: 'MAJOR',    alarmType: 'TEMPERATURE_HIGH',        enabled: true },
      { deviceId: null, deviceType: null,  parameter: 'cpuPct',            raiseThreshold: 85.0,  clearThreshold: 75.0,  severity: 'MAJOR',    alarmType: 'HIGH_CPU_UTILIZATION',    enabled: true },
      { deviceId: null, deviceType: null,  parameter: 'memoryPct',         raiseThreshold: 80.0,  clearThreshold: 70.0,  severity: 'WARNING',  alarmType: 'HIGH_MEMORY_USAGE',       enabled: true },
      { deviceId: null, deviceType: null,  parameter: 'packetLossPct',     raiseThreshold: 2.0,   clearThreshold: 1.0,   severity: 'MINOR',    alarmType: 'PACKET_LOSS',             enabled: true },
      { deviceId: null, deviceType: 'IDU', parameter: 'rssiDbm',           raiseThreshold: -65.0, clearThreshold: -60.0, severity: 'MAJOR',    alarmType: 'IDU_SIGNAL_DEGRADED',     enabled: true },
    ]);
    console.log('  ✓ alarm_thresholds: 8 inserted');
  }
}

async function seedKpi(db, reset) {
  const kpi = db.collection('kpi_warm');
  if (reset) await kpi.deleteMany({});
  if (await kpi.countDocuments() > 0) { console.log('  ↳ kpi_warm already seeded — skipping'); return; }

  const allBuckets = [
    ...kpiBuckets(IDS.btsDN,  'BTS', IDS.netDN, 7),
    ...kpiBuckets(IDS.btsDS,  'BTS', IDS.netDS, 7),
    ...kpiBuckets(IDS.btsMW,  'BTS', IDS.netMW, 7),
    ...kpiBuckets(IDS.cpeDN1, 'CPE', IDS.netDN, 7),
    ...kpiBuckets(IDS.cpeDN2, 'CPE', IDS.netDN, 7),
    ...kpiBuckets(IDS.cpeMW1, 'CPE', IDS.netMW, 7),
    ...kpiBuckets(IDS.cpeMW2, 'CPE', IDS.netMW, 7),
    ...kpiBuckets(IDS.iduDN,  'IDU', IDS.netDN, 7),
    ...kpiBuckets(IDS.iduMW,  'IDU', IDS.netMW, 7),
  ];

  // Insert in batches to avoid document size limits
  const batchSize = 200;
  for (let i = 0; i < allBuckets.length; i += batchSize) {
    await kpi.insertMany(allBuckets.slice(i, i + batchSize));
  }
  console.log(`  ✓ kpi_warm: ${allBuckets.length} hourly buckets inserted (7 days × 9 devices)`);
}

async function seedConfig(db, reset) {
  const templates = db.collection('config_templates');
  const versions  = db.collection('config_versions');
  const pending   = db.collection('pending_commands');
  if (reset) { await templates.deleteMany({}); await versions.deleteMany({}); await pending.deleteMany({}); }

  if (await templates.countDocuments() === 0) {
    await templates.insertMany([
      {
        _id: IDS.tmplBTS, id: IDS.tmplBTS,
        name: 'BTS-Standard-5GHz', description: 'Standard 5 GHz configuration for all Senao BTS units in production',
        deviceType: 'BTS', isDefault: true,
        channel24: null, channel5: 36, txPower24: null, txPower5: 20,
        ssid24: null, password24: null, ssid5: 'UBR-AIRTEL-5G', password5: null,
        channelBandwidth: 80, beaconInterval: 100, dtimPeriod: 1,
        firmwareVersion: 'v3.4.1', firmwareUrl: 'http://fw.ubrnms.local/bts/v3.4.1.bin',
        qosProfile: 'BEST_EFFORT', vlanId: 100,
        additionalParams: { roamingEnabled: true, fastBssTransition: true },
        createdBy: 'admin', createdAt: daysAgo(90), updatedAt: daysAgo(15),
      },
      {
        _id: IDS.tmplCPE, id: IDS.tmplCPE,
        name: 'CPE-Home-Basic', description: 'Default home subscriber CPE profile — FUP 50/100',
        deviceType: 'CPE', isDefault: true,
        managementIpType: 'DHCP',
        channel24: 6, channel5: 36, txPower24: 17, txPower5: 20,
        ssid24: 'UBR-Home-2G', password24: null, ssid5: 'UBR-Home-5G', password5: null,
        speedDuplex: 'AUTO', portUpDown: 'UP',
        firmwareVersion: 'v2.3.0', firmwareUrl: 'http://fw.ubrnms.local/cpe/v2.3.0.bin',
        qosProfile: 'BEST_EFFORT',
        additionalParams: { dhcpEnabled: true, natEnabled: true, firewallEnabled: true },
        createdBy: 'admin', createdAt: daysAgo(90), updatedAt: daysAgo(10),
      },
      {
        _id: IDS.tmplCPEEnt, id: IDS.tmplCPEEnt,
        name: 'CPE-Enterprise-200', description: 'Enterprise subscriber CPE — 200 Mbps with VLAN and QoS',
        deviceType: 'CPE', isDefault: false,
        managementIpType: 'STATIC',
        staticSubnet: '255.255.255.0', staticGateway: '192.168.10.1',
        channel24: null, channel5: 149, txPower24: null, txPower5: 23,
        ssid24: null, ssid5: 'UBR-ENTERPRISE', password5: null,
        vlanId: 200, qosProfile: 'PREMIUM',
        firmwareVersion: 'v2.3.0', firmwareUrl: 'http://fw.ubrnms.local/cpe/v2.3.0.bin',
        additionalParams: { wpaEnterprise: true, radiusServer: '192.168.1.100' },
        createdBy: 'admin', createdAt: daysAgo(60), updatedAt: daysAgo(5),
      },
      {
        _id: IDS.tmplIDU, id: IDS.tmplIDU,
        name: 'IDU-P2P-Backhaul', description: 'Point-to-point backhaul IDU template for BTS backhaul links',
        deviceType: 'IDU', isDefault: true,
        channel24: null, channel5: 160, txPower24: null, txPower5: 23,
        channelBandwidth: 40,
        firmwareVersion: 'v1.9.2', firmwareUrl: 'http://fw.ubrnms.local/idu/v1.9.2.bin',
        qosProfile: 'REALTIME',
        additionalParams: { encryptionMode: 'AES-256', linkAggregation: false },
        createdBy: 'admin', createdAt: daysAgo(80), updatedAt: daysAgo(20),
      },
    ]);
    console.log('  ✓ config_templates: 4 inserted');
  }

  if (await versions.countDocuments() === 0) {
    await versions.insertMany([
      {
        deviceId: IDS.btsDN, versionNumber: 1, templateId: IDS.tmplBTS,
        actor: 'admin',
        previousValues: { channel5: 100, txPower5: 17, firmwareVersion: 'v3.3.0' },
        newValues:      { channel5: 36,  txPower5: 20, firmwareVersion: 'v3.4.1' },
        appliedAt: daysAgo(30), status: 'SUCCESS',
      },
      {
        deviceId: IDS.btsDN, versionNumber: 2, templateId: IDS.tmplBTS,
        actor: 'operator',
        previousValues: { ssid5: 'OLD-SSID', qosProfile: 'BEST_EFFORT' },
        newValues:      { ssid5: 'UBR-AIRTEL-5G', qosProfile: 'BEST_EFFORT' },
        appliedAt: daysAgo(15), status: 'SUCCESS',
      },
      {
        deviceId: IDS.cpeDN1, versionNumber: 1, templateId: IDS.tmplCPE,
        actor: 'admin',
        previousValues: { channel5: 40, txPower24: 15 },
        newValues:      { channel5: 36, txPower24: 17 },
        appliedAt: daysAgo(20), status: 'SUCCESS',
      },
      {
        deviceId: IDS.btsDS, versionNumber: 1, templateId: IDS.tmplBTS,
        actor: 'operator',
        previousValues: { firmwareVersion: 'v3.3.0' },
        newValues:      { firmwareVersion: 'v3.4.1' },
        appliedAt: daysAgo(10), status: 'FAILED',
      },
    ]);
    console.log('  ✓ config_versions: 4 inserted');
  }

  if (await pending.countDocuments() === 0) {
    await pending.insertMany([
      {
        deviceId: IDS.cpeDN3, commandType: 'REBOOT', templateId: null,
        params: { reason: 'CPU storm recovery' },
        status: 'PENDING', jobId: null,
        expiresAt: new Date(Date.now() + 3600_000),
        createdAt: minsAgo(15), actor: 'operator',
      },
      {
        deviceId: IDS.cpeDS2, commandType: 'FIRMWARE_UPGRADE', templateId: IDS.tmplCPE,
        params: { targetVersion: 'v2.3.0', downloadUrl: 'http://fw.ubrnms.local/cpe/v2.3.0.bin' },
        status: 'DELIVERED', jobId: null,
        expiresAt: new Date(Date.now() + 7200_000),
        createdAt: minsAgo(45), deliveredAt: minsAgo(30), actor: 'admin',
      },
    ]);
    console.log('  ✓ pending_commands: 2 inserted');
  }
}

async function seedTopology(db, reset) {
  const nodes = db.collection('topology_nodes');
  if (reset) await nodes.deleteMany({});
  if (await nodes.countDocuments() > 0) { console.log('  ↳ topology_nodes already seeded — skipping'); return; }

  const topoNodes = [
    // BTS
    { _id: `topo-${IDS.btsDN}`, id: `topo-${IDS.btsDN}`, deviceId: IDS.btsDN, serialNumber: 'SN-BTS-DN-001', macAddress: 'AA:BB:CC:DD:E1:01', ipAddress: '10.10.1.1', type: 'BTS', status: 'HEALTHY', latitude: 28.6139, longitude: 77.2090, parentDeviceId: null, childDeviceIds: [IDS.cpeDN1, IDS.cpeDN2, IDS.cpeDN3, IDS.iduDN], cascadeHop: 0, linkHealth: 'HEALTHY', openAlarmCount: 1, lastHealthUpdate: minsAgo(5), networkId: IDS.netDN, organizationId: IDS.orgDelhi },
    { _id: `topo-${IDS.btsDS}`, id: `topo-${IDS.btsDS}`, deviceId: IDS.btsDS, serialNumber: 'SN-BTS-DS-001', macAddress: 'AA:BB:CC:DD:E1:02', ipAddress: '10.10.2.1', type: 'BTS', status: 'DEGRADED', latitude: 28.5355, longitude: 77.3910, parentDeviceId: null, childDeviceIds: [IDS.cpeDS1, IDS.cpeDS2], cascadeHop: 0, linkHealth: 'DEGRADED', openAlarmCount: 1, lastHealthUpdate: minsAgo(15), networkId: IDS.netDS, organizationId: IDS.orgDelhi },
    { _id: `topo-${IDS.btsMW}`, id: `topo-${IDS.btsMW}`, deviceId: IDS.btsMW, serialNumber: 'SN-BTS-MW-001', macAddress: 'AA:BB:CC:DD:E1:03', ipAddress: '10.30.1.1', type: 'BTS', status: 'HEALTHY', latitude: 19.0760, longitude: 72.8777, parentDeviceId: null, childDeviceIds: [IDS.cpeMW1, IDS.cpeMW2, IDS.cpeMW3, IDS.iduMW], cascadeHop: 0, linkHealth: 'HEALTHY', openAlarmCount: 1, lastHealthUpdate: minsAgo(2), networkId: IDS.netMW, organizationId: IDS.orgMumbai },
    // CPE — Delhi North
    { _id: `topo-${IDS.cpeDN1}`, id: `topo-${IDS.cpeDN1}`, deviceId: IDS.cpeDN1, serialNumber: 'SN-CPE-DN-001', macAddress: 'BB:CC:DD:EE:FF:01', ipAddress: '10.10.1.101', type: 'CPE', status: 'HEALTHY', latitude: 28.6210, longitude: 77.2110, parentDeviceId: IDS.btsDN, childDeviceIds: [], cascadeHop: 1, linkHealth: 'HEALTHY', openAlarmCount: 0, lastHealthUpdate: hoursAgo(2), networkId: IDS.netDN, organizationId: IDS.orgDelhi },
    { _id: `topo-${IDS.cpeDN2}`, id: `topo-${IDS.cpeDN2}`, deviceId: IDS.cpeDN2, serialNumber: 'SN-CPE-DN-002', macAddress: 'BB:CC:DD:EE:FF:02', ipAddress: '10.10.1.102', type: 'CPE', status: 'DEGRADED', latitude: 28.6230, longitude: 77.2080, parentDeviceId: IDS.btsDN, childDeviceIds: [], cascadeHop: 1, linkHealth: 'DEGRADED', openAlarmCount: 1, lastHealthUpdate: hoursAgo(4), networkId: IDS.netDN, organizationId: IDS.orgDelhi },
    { _id: `topo-${IDS.cpeDN3}`, id: `topo-${IDS.cpeDN3}`, deviceId: IDS.cpeDN3, serialNumber: 'SN-CPE-DN-003', macAddress: 'BB:CC:DD:EE:FF:03', ipAddress: '10.10.1.103', type: 'CPE', status: 'FAULTY', latitude: 28.6190, longitude: 77.2140, parentDeviceId: IDS.btsDN, childDeviceIds: [], cascadeHop: 1, linkHealth: 'FAULTY', openAlarmCount: 1, lastHealthUpdate: hoursAgo(6), networkId: IDS.netDN, organizationId: IDS.orgDelhi },
    // CPE — Delhi South
    { _id: `topo-${IDS.cpeDS1}`, id: `topo-${IDS.cpeDS1}`, deviceId: IDS.cpeDS1, serialNumber: 'SN-CPE-DS-001', macAddress: 'BB:CC:DD:EE:FF:04', ipAddress: '10.10.2.101', type: 'CPE', status: 'HEALTHY', latitude: 28.5400, longitude: 77.3950, parentDeviceId: IDS.btsDS, childDeviceIds: [], cascadeHop: 1, linkHealth: 'DEGRADED', openAlarmCount: 1, lastHealthUpdate: hoursAgo(1), networkId: IDS.netDS, organizationId: IDS.orgDelhi },
    { _id: `topo-${IDS.cpeDS2}`, id: `topo-${IDS.cpeDS2}`, deviceId: IDS.cpeDS2, serialNumber: 'SN-CPE-DS-002', macAddress: 'BB:CC:DD:EE:FF:05', ipAddress: null, type: 'CPE', status: 'UNKNOWN', latitude: 28.5380, longitude: 77.3920, parentDeviceId: IDS.btsDS, childDeviceIds: [], cascadeHop: 1, linkHealth: 'UNKNOWN', openAlarmCount: 0, lastHealthUpdate: minsAgo(45), networkId: IDS.netDS, organizationId: IDS.orgDelhi },
    // CPE — Mumbai West
    { _id: `topo-${IDS.cpeMW1}`, id: `topo-${IDS.cpeMW1}`, deviceId: IDS.cpeMW1, serialNumber: 'SN-CPE-MW-001', macAddress: 'BB:CC:DD:EE:FF:06', ipAddress: '10.30.1.101', type: 'CPE', status: 'HEALTHY', latitude: 19.0810, longitude: 72.8820, parentDeviceId: IDS.btsMW, childDeviceIds: [], cascadeHop: 1, linkHealth: 'HEALTHY', openAlarmCount: 0, lastHealthUpdate: hoursAgo(1), networkId: IDS.netMW, organizationId: IDS.orgMumbai },
    { _id: `topo-${IDS.cpeMW2}`, id: `topo-${IDS.cpeMW2}`, deviceId: IDS.cpeMW2, serialNumber: 'SN-CPE-MW-002', macAddress: 'BB:CC:DD:EE:FF:07', ipAddress: '10.30.1.102', type: 'CPE', status: 'HEALTHY', latitude: 19.0740, longitude: 72.8750, parentDeviceId: IDS.btsMW, childDeviceIds: [], cascadeHop: 1, linkHealth: 'HEALTHY', openAlarmCount: 0, lastHealthUpdate: hoursAgo(3), networkId: IDS.netMW, organizationId: IDS.orgMumbai },
    { _id: `topo-${IDS.cpeMW3}`, id: `topo-${IDS.cpeMW3}`, deviceId: IDS.cpeMW3, serialNumber: 'SN-CPE-MW-003', macAddress: 'BB:CC:DD:EE:FF:08', ipAddress: '10.30.1.103', type: 'CPE', status: 'DEGRADED', latitude: 19.0790, longitude: 72.8800, parentDeviceId: IDS.btsMW, childDeviceIds: [], cascadeHop: 1, linkHealth: 'DEGRADED', openAlarmCount: 1, lastHealthUpdate: hoursAgo(1), networkId: IDS.netMW, organizationId: IDS.orgMumbai },
    // IDU
    { _id: `topo-${IDS.iduDN}`, id: `topo-${IDS.iduDN}`, deviceId: IDS.iduDN, serialNumber: 'SN-IDU-DN-001', macAddress: 'CC:DD:EE:FF:00:01', ipAddress: '10.10.1.200', type: 'IDU', status: 'HEALTHY', latitude: 28.6139, longitude: 72.2095, parentDeviceId: IDS.btsDN, childDeviceIds: [], cascadeHop: 1, linkHealth: 'HEALTHY', openAlarmCount: 0, lastHealthUpdate: minsAgo(10), networkId: IDS.netDN, organizationId: IDS.orgDelhi },
    { _id: `topo-${IDS.iduDS}`, id: `topo-${IDS.iduDS}`, deviceId: IDS.iduDS, serialNumber: 'SN-IDU-DS-001', macAddress: 'CC:DD:EE:FF:00:02', ipAddress: null, type: 'IDU', status: 'FAULTY', latitude: 28.5355, longitude: 77.3915, parentDeviceId: null, childDeviceIds: [], cascadeHop: 0, linkHealth: 'FAULTY', openAlarmCount: 1, lastHealthUpdate: hoursAgo(8), networkId: IDS.netDS, organizationId: IDS.orgDelhi },
    { _id: `topo-${IDS.iduMW}`, id: `topo-${IDS.iduMW}`, deviceId: IDS.iduMW, serialNumber: 'SN-IDU-MW-001', macAddress: 'CC:DD:EE:FF:00:03', ipAddress: '10.30.1.200', type: 'IDU', status: 'HEALTHY', latitude: 19.0760, longitude: 72.8785, parentDeviceId: IDS.btsMW, childDeviceIds: [], cascadeHop: 1, linkHealth: 'HEALTHY', openAlarmCount: 0, lastHealthUpdate: minsAgo(3), networkId: IDS.netMW, organizationId: IDS.orgMumbai },
  ];

  await nodes.insertMany(topoNodes);
  console.log(`  ✓ topology_nodes: ${topoNodes.length} inserted`);
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  const client = new MongoClient(MONGO_URL);

  console.log('\n🌱  UBR Open NMS — Seed Script');
  console.log(`   MongoDB : ${MONGO_URL}`);
  console.log(`   Mode    : ${RESET ? 'RESET + seed' : 'skip if exists'}\n`);

  try {
    await client.connect();
    console.log('✓ Connected to MongoDB\n');

    console.log('── ubrnms (auth-service) ─────────────────────────────────');
    await seedAuth(client.db('ubrnms'), RESET);

    console.log('\n── ubrnms_inventory ──────────────────────────────────────');
    await seedInventory(client.db('ubrnms_inventory'), RESET);

    console.log('\n── ubrnms_alarms ─────────────────────────────────────────');
    await seedAlarms(client.db('ubrnms_alarms'), RESET);

    console.log('\n── ubrnms_kpi ────────────────────────────────────────────');
    await seedKpi(client.db('ubrnms_kpi'), RESET);

    console.log('\n── ubrnms_config ─────────────────────────────────────────');
    await seedConfig(client.db('ubrnms_config'), RESET);

    console.log('\n── ubrnms_topology ───────────────────────────────────────');
    await seedTopology(client.db('ubrnms_topology'), RESET);

    console.log('\n' + '═'.repeat(56));
    console.log('✅  Seed complete! Login credentials:');
    console.log('');
    console.log('  Role      │ Username    │ Password');
    console.log('  ──────────┼─────────────┼──────────────────');
    console.log('  Admin     │ admin       │ Admin@NMS2024!');
    console.log('  Operator  │ operator    │ Operator@NMS2024!');
    console.log('  NOC Ops   │ noc_operator│ NocOp@NMS2024!');
    console.log('  Viewer    │ viewer      │ Viewer@NMS2024!');
    console.log('');
    console.log('  Frontend : http://localhost:5173');
    console.log('  API GW   : http://localhost:3100');
    console.log('═'.repeat(56) + '\n');

  } catch (err) {
    console.error('\n❌  Seed failed:', err.message);
    if (err.message.includes('ECONNREFUSED')) {
      console.error('\n   ⚠  MongoDB is not running. Start the stack first:');
      console.error('   docker compose -f docker-compose.dev.yml up -d mongo\n');
    }
    process.exit(1);
  } finally {
    await client.close();
  }
}

main();
