'use strict';
/**
 * Expanded device seed — adds ~120 more devices across 8 sites
 * Run: NODE_PATH=/app/node_modules:/tmp/node_modules node /tmp/seed-devices-expanded.js
 */
const { MongoClient } = require('mongodb');

const MONGO_URL = process.env.MONGO_URI || 'mongodb://localhost:27017/ubr_nms';
const BASE_URL  = MONGO_URL.replace(/\/[^/]+$/, '');

function daysAgo(n)  { return new Date(Date.now() - n * 86_400_000); }
function hoursAgo(n) { return new Date(Date.now() - n * 3_600_000); }
function minsAgo(n)  { return new Date(Date.now() - n * 60_000); }
function rnd(min, max) { return +(min + Math.random() * (max - min)).toFixed(4); }
function mac(i) { return 'EE:FF:' + ('00'+(i>>8&255)).slice(-2) + ':' + ('00'+(i&255)).slice(-2) + ':' + ('00'+(i>>16&255)).slice(-2) + ':AA'; }
function ip(prefix, i) { return `${prefix}.${Math.floor(i/253)+1}.${(i%253)+1}`; }
function pad(n, len=3) { return String(n).padStart(len,'0'); }

// Org / network IDs (must match already-seeded orgs)
const ORGS = {
  delhi:  'org-airtel-delhi-001',
  mumbai: 'org-airtel-mumbai-001',
};
const NETS = {
  netDN: 'net-delhi-north-001',
  netDS: 'net-delhi-south-001',
  netMW: 'net-mumbai-west-001',
};

// 8 new BTS sites
const SITES = [
  { code:'SITE-DEL-E01', name:'Delhi East 01', lat:28.6692, lon:77.2960, org:ORGS.delhi,  net:NETS.netDN, ipPfx:'10.11', freq:5180,  ch:36,  model:'Senao ENH1750EXT' },
  { code:'SITE-DEL-W01', name:'Delhi West 01', lat:28.6280, lon:77.0840, org:ORGS.delhi,  net:NETS.netDN, ipPfx:'10.12', freq:5500,  ch:100, model:'Senao ENH1750EXT' },
  { code:'SITE-DEL-S02', name:'Delhi South 02',lat:28.4890, lon:77.2190, org:ORGS.delhi,  net:NETS.netDS, ipPfx:'10.13', freq:5745,  ch:149, model:'Senao ENH1750EXT-AC' },
  { code:'SITE-DEL-C01', name:'Delhi Central', lat:28.6430, lon:77.2190, org:ORGS.delhi,  net:NETS.netDS, ipPfx:'10.14', freq:5180,  ch:36,  model:'Senao ENH1750EXT' },
  { code:'SITE-MUM-N01', name:'Mumbai North 01',lat:19.2183, lon:72.9781, org:ORGS.mumbai, net:NETS.netMW, ipPfx:'10.31', freq:5500,  ch:100, model:'Senao ENH1750EXT-AC' },
  { code:'SITE-MUM-S01', name:'Mumbai South 01',lat:18.9220, lon:72.8347, org:ORGS.mumbai, net:NETS.netMW, ipPfx:'10.32', freq:5745,  ch:149, model:'Senao ENH1750EXT' },
  { code:'SITE-MUM-E01', name:'Mumbai East 01', lat:19.1136, lon:72.9010, org:ORGS.mumbai, net:NETS.netMW, ipPfx:'10.33', freq:5180,  ch:36,  model:'Senao ENH1750EXT-AC' },
  { code:'SITE-NCR-G01', name:'Gurugram 01',    lat:28.4595, lon:77.0266, org:ORGS.delhi,  net:NETS.netDN, ipPfx:'10.15', freq:5745,  ch:149, model:'Senao ENH1750EXT' },
];

const CPE_CUSTOMERS = [
  'Rahul Sharma','Neha Gupta','Arun Patel','Sunita Verma','Vikram Singh','Priya Mehta',
  'Suresh Kumar','Anjali Rao','Deepak Joshi','Kavita Nair','Mohan Das','Rekha Iyer',
  'Arjun Reddy','Pooja Shah','Nitin Malhotra','Swati Pandey','Ravi Choudhary','Meena Tiwari',
  'Ankit Mishra','Divya Kapoor','Sanjay Bose','Lakshmi Pillai','Hardik Desai','Preethi Nambiar',
];

const STATUSES = ['ONLINE','ONLINE','ONLINE','ONLINE','ONLINE','ONLINE','ONLINE','OFFLINE','PROVISIONING','DEGRADED'];
const FW_VERSIONS = ['v2.3.0','v2.3.0','v2.3.0','v2.2.0','v2.1.0','v3.4.1','v3.5.0'];

async function main() {
  console.log('\n📡  UBR NMS — Expanded Device Seed (120 devices)');
  const client = new MongoClient(BASE_URL);
  await client.connect();
  const db = client.db('ubr_nms');

  const devices      = db.collection('devices');
  const topoNodes    = db.collection('topology_nodes');
  const alarms       = db.collection('alarms');

  let devIdx   = 100; // start IDs from 100 to avoid collision with seed-k8s
  let alarmIdx = 100;
  const newDevices   = [];
  const newTopo      = [];
  const newAlarms    = [];

  for (let s = 0; s < SITES.length; s++) {
    const site = SITES[s];
    const sCode = `S${pad(s+2)}`; // S002-S009

    // ── BTS ──────────────────────────────────────────────────────────────────
    const btsId  = `dev-bts-${sCode}-001`;
    const btsSnr = `SN-BTS-${sCode}-001`;
    const btsIp  = `${site.ipPfx}.1.1`;
    const cpeSNs = [];
    const cpeIds = [];
    const numCpe = 8 + Math.floor(Math.random() * 7); // 8-14 CPEs per BTS

    newDevices.push({
      _id: btsId, id: btsId, deviceType: 'BTS',
      serialNumber: btsSnr, macAddress: mac(devIdx),
      ipAddress: btsIp, model: site.model,
      firmwareVersion: 'v3.4.1', softwareVersion: 'NMS-Agent-2.1',
      status: 'ONLINE', uptimeSeconds: Math.floor(Math.random()*1728000),
      latitude: site.lat + rnd(-0.01,0.01),
      longitude: site.lon + rnd(-0.01,0.01),
      channel: String(site.ch), channelBandwidth: 80, txPower: 20,
      capacityPercentage: 30 + Math.floor(Math.random()*60),
      tags: [{ key:'site', value: site.code }, { key:'model', value: site.model }],
      organizationId: site.org, networkId: site.net,
      connectedCpeSerials: [],
      createdAt: daysAgo(90+s*10), updatedAt: minsAgo(Math.floor(Math.random()*30)),
    });
    devIdx++;

    newTopo.push({
      id: `topo-${btsId}`, deviceId: btsId, serialNumber: btsSnr,
      ipAddress: btsIp, type: 'BTS', status: 'HEALTHY',
      latitude: site.lat, longitude: site.lon,
      parentDeviceId: null, childDeviceIds: [],
      cascadeHop: 0, linkHealth: 'HEALTHY', openAlarmCount: 0,
      networkId: site.net, organizationId: site.org,
      lastHealthUpdate: minsAgo(Math.floor(Math.random()*15)),
    });

    // ── CPEs ─────────────────────────────────────────────────────────────────
    for (let c = 0; c < numCpe; c++) {
      const cpeId  = `dev-cpe-${sCode}-${pad(c+1)}`;
      const cpeSn  = `SN-CPE-${sCode}-${pad(c+1)}`;
      const cpeIp  = ip(site.ipPfx, c + 101);
      const status = STATUSES[Math.floor(Math.random()*STATUSES.length)];
      const cust   = CPE_CUSTOMERS[(devIdx) % CPE_CUSTOMERS.length];
      const fw     = FW_VERSIONS[Math.floor(Math.random()*FW_VERSIONS.length)];

      cpeSNs.push(cpeSn);
      cpeIds.push(cpeId);

      newDevices.push({
        _id: cpeId, id: cpeId, deviceType: 'CPE',
        serialNumber: cpeSn, macAddress: mac(devIdx),
        ipAddress: status === 'OFFLINE' ? null : cpeIp,
        model: 'Senao EAP300', firmwareVersion: fw, softwareVersion: 'NMS-Agent-1.8',
        status, uptimeSeconds: status === 'ONLINE' ? Math.floor(Math.random()*604800) : 0,
        latitude: site.lat + rnd(-0.03, 0.03),
        longitude: site.lon + rnd(-0.03, 0.03),
        connectedBtsSerial: btsSnr,
        tags: [
          { key: 'customer', value: cust },
          { key: 'plan', value: ['FUP-50','FUP-100','FUP-200'][c%3] },
          { key: 'site', value: site.code },
        ],
        organizationId: site.org, networkId: site.net,
        createdAt: daysAgo(60 + Math.floor(Math.random()*30)),
        updatedAt: hoursAgo(Math.floor(Math.random()*24)),
      });

      newTopo.push({
        id: `topo-${cpeId}`, deviceId: cpeId, serialNumber: cpeSn,
        ipAddress: status === 'OFFLINE' ? null : cpeIp,
        type: 'CPE',
        status: status === 'ONLINE' ? 'HEALTHY' : status === 'OFFLINE' ? 'FAULTY' : 'UNKNOWN',
        latitude: site.lat + rnd(-0.03, 0.03),
        longitude: site.lon + rnd(-0.03, 0.03),
        parentDeviceId: btsId, childDeviceIds: [],
        cascadeHop: 1, linkHealth: status === 'ONLINE' ? 'HEALTHY' : 'DEGRADED',
        openAlarmCount: status === 'OFFLINE' ? 1 : 0,
        networkId: site.net, organizationId: site.org,
        lastHealthUpdate: hoursAgo(Math.floor(Math.random()*6)),
      });

      // Add an alarm for offline CPEs
      if (status === 'OFFLINE') {
        newAlarms.push({
          id: `alm-cpe-offline-${sCode}-${pad(c+1)}`,
          alarmId: `AL-OFFLINE-${sCode}-${pad(c+1)}`,
          deviceId: cpeId, deviceType: 'CPE',
          alarmType: 'DEVICE_UNREACHABLE', alarmName: 'CPE Unreachable',
          severity: 'MAJOR', state: 'ACTIVE',
          description: `CPE ${cpeSn} at ${site.name} is unreachable. Customer: ${cust}`,
          metricValue: 0, threshold: 0,
          isRootCause: true, correlatedChildCount: 0, dedupCount: 1,
          acknowledgedBy: null, acknowledgedAt: null,
          networkId: site.net, organizationId: site.org,
          source: 'NMS-POLL',
          raisedAt: hoursAgo(2 + Math.floor(Math.random()*12)),
          clearedAt: null,
          updatedAt: hoursAgo(1),
        });
        alarmIdx++;
      }

      devIdx++;
    }

    // Update BTS with CPE references
    newDevices[newDevices.length - numCpe - 1].connectedCpeSerials = cpeSNs;
    const btsTopoIdx = newTopo.findIndex(t => t.id === `topo-${btsId}`);
    if (btsTopoIdx >= 0) newTopo[btsTopoIdx].childDeviceIds = cpeIds;
  }

  // ── INSERT ─────────────────────────────────────────────────────────────────
  const existingIds = new Set(
    (await devices.find({ _id: { $in: newDevices.map(d => d._id) } }, { projection: { _id: 1 } }).toArray()).map(d => d._id)
  );
  const toInsertDevices = newDevices.filter(d => !existingIds.has(d._id));
  const toInsertTopo    = newTopo.filter(t => !existingIds.has(t.deviceId));

  if (toInsertDevices.length > 0) {
    const batchSize = 50;
    for (let i = 0; i < toInsertDevices.length; i += batchSize) {
      await devices.insertMany(toInsertDevices.slice(i, i + batchSize));
    }
    console.log(`✓ devices: ${toInsertDevices.length} new devices added`);
  } else {
    console.log('↳ devices: all already exist — skipping');
  }

  if (toInsertTopo.length > 0) {
    await topoNodes.insertMany(toInsertTopo);
    console.log(`✓ topology_nodes: ${toInsertTopo.length} new nodes added`);
  }

  if (newAlarms.length > 0) {
    await alarms.insertMany(newAlarms);
    console.log(`✓ alarms: ${newAlarms.length} new device-offline alarms added`);
  }

  const totalDevices = await devices.countDocuments();
  const totalAlarms  = await alarms.countDocuments();
  console.log(`\n📊  Total devices in DB : ${totalDevices}`);
  console.log(`📊  Total alarms in DB  : ${totalAlarms}`);

  await client.close();
  console.log('\n✅  Expanded seed complete!\n');
}

main().catch(err => { console.error('❌ Seed failed:', err.message, err.stack); process.exit(1); });
