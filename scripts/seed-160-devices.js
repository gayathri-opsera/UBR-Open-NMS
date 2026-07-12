/**
 * Seed 160+ devices into ubrnms_inventory for UI demo/testing.
 * Run via: docker exec nms-mongo mongosh ubrnms_inventory /tmp/seed-160-devices.js
 */
'use strict';

const STATUSES     = ['ONLINE','ONLINE','ONLINE','ONLINE','ONLINE','ONLINE','ONLINE','OFFLINE','PROVISIONING','DEGRADED'];
const FW_VERSIONS  = ['v3.5.0','v3.5.0','v3.4.1','v3.4.1','v3.3.0','v2.3.0','v2.2.0'];
const BTS_MODELS   = ['A60'];
const CPE_MODELS   = ['A61'];
const IDU_MODELS   = ['IDU'];

const ORGS = [
  'org-airtel-delhi-001', 'org-airtel-mumbai-001',
  'org-jio-pune-001',     'org-bsnl-chennai-001',
  'org-vi-kolkata-001',
];
const NETS = [
  'net-delhi-north-001', 'net-delhi-south-001', 'net-mumbai-west-001',
  'net-pune-central-001','net-chennai-north-001','net-kolkata-east-001',
];

const SITES = [
  { code:'S001', name:'Delhi North Tower',    lat:28.7041, lon:77.1025, org:ORGS[0], net:NETS[0], ipPfx:'10.10' },
  { code:'S002', name:'Delhi South Hub',      lat:28.4595, lon:77.0266, org:ORGS[0], net:NETS[1], ipPfx:'10.11' },
  { code:'S003', name:'Mumbai West Central',  lat:19.0760, lon:72.8777, org:ORGS[1], net:NETS[2], ipPfx:'10.20' },
  { code:'S004', name:'Mumbai Andheri Tower', lat:19.1136, lon:72.8697, org:ORGS[1], net:NETS[2], ipPfx:'10.21' },
  { code:'S005', name:'Pune Camp Station',    lat:18.5204, lon:73.8567, org:ORGS[2], net:NETS[3], ipPfx:'10.30' },
  { code:'S006', name:'Chennai Anna Nagar',   lat:13.0827, lon:80.2707, org:ORGS[3], net:NETS[4], ipPfx:'10.40' },
  { code:'S007', name:'Chennai T Nagar Hub',  lat:13.0418, lon:80.2341, org:ORGS[3], net:NETS[4], ipPfx:'10.41' },
  { code:'S008', name:'Kolkata Salt Lake',    lat:22.5726, lon:88.3639, org:ORGS[4], net:NETS[5], ipPfx:'10.50' },
  { code:'S009', name:'Gurugram Cyber Hub',   lat:28.4949, lon:77.0851, org:ORGS[0], net:NETS[0], ipPfx:'10.12' },
  { code:'S010', name:'Noida Sector 62',      lat:28.6271, lon:77.3812, org:ORGS[0], net:NETS[1], ipPfx:'10.13' },
  { code:'S011', name:'Navi Mumbai Node',     lat:19.0330, lon:73.0297, org:ORGS[1], net:NETS[2], ipPfx:'10.22' },
  { code:'S012', name:'Thane East Tower',     lat:19.2183, lon:72.9781, org:ORGS[1], net:NETS[2], ipPfx:'10.23' },
];

const CUSTOMERS = [
  'Rahul Sharma','Neha Gupta','Arun Patel','Sunita Verma','Vikram Singh','Priya Mehta',
  'Suresh Kumar','Anjali Rao','Deepak Joshi','Kavita Nair','Mohan Das','Rekha Iyer',
  'Arjun Reddy','Pooja Shah','Nitin Malhotra','Swati Pandey','Ravi Choudhary','Meena Tiwari',
  'Ankit Mishra','Divya Kapoor','Sanjay Bose','Lakshmi Pillai','Hardik Desai','Preethi Nambiar',
  'Rohit Sharma','Smita Patil','Vishal Gupta','Nisha Jain','Kartik Verma','Asha Bhonsle',
];

function rnd(min, max) { return parseFloat((min + Math.random() * (max - min)).toFixed(4)); }
function mac(i) {
  const h = (n) => ('00' + n.toString(16)).slice(-2).toUpperCase();
  return `EE:${h(i>>16&255)}:${h(i>>8&255)}:${h(i&255)}:BB:AA`;
}
function ip(pfx, n) { return `${pfx}.${Math.floor(n/253)+1}.${(n%253)+2}`; }
function daysAgo(n)  { return new Date(Date.now() - n * 86_400_000); }
function hoursAgo(n) { return new Date(Date.now() - n * 3_600_000); }
function minsAgo(n)  { return new Date(Date.now() - n * 60_000); }
function pick(arr)   { return arr[Math.floor(Math.random() * arr.length)]; }

const devices   = db.getCollection('devices');
const topo      = db.getCollection('topology_nodes');
const birthCerts = db.getCollection('birth_certificates');

// Track what already exists to avoid duplicate _id errors
const existingIds = new Set(devices.find({}, {_id:1}).toArray().map(d => d._id));

let devIdx   = 200;  // start high to avoid collisions with existing seed
let inserted = 0;

for (let s = 0; s < SITES.length; s++) {
  const site = SITES[s];

  // ── BTS ──────────────────────────────────────────────────────────────────────
  const btsId  = `dev-bts-${site.code}-001`;
  const btsSn  = `BTS-A60-${String(s + 1).padStart(6, '0')}`;
  const btsIp  = `${site.ipPfx}.1.1`;
  const btsFw  = pick(FW_VERSIONS);
  const btsModel = pick(BTS_MODELS);

  if (!existingIds.has(btsId)) {
    devices.insertOne({
      _id: btsId, id: btsId, deviceType: 'BTS',
      serialNumber: btsSn, macAddress: mac(devIdx),
      ipAddress: btsIp, model: btsModel,
      firmwareVersion: btsFw, softwareVersion: 'NMS-Agent-2.1',
      status: 'ONLINE',
      uptimeSeconds: Math.floor(Math.random() * 2592000),
      latitude: site.lat + rnd(-0.015, 0.015),
      longitude: site.lon + rnd(-0.015, 0.015),
      channel: String(pick([36,40,44,100,104,149,153])),
      channelBandwidth: 80,
      txPower: 20 + Math.floor(Math.random() * 10),
      capacityPercentage: 30 + Math.floor(Math.random() * 60),
      tags: [
        { key: 'site',    value: site.code },
        { key: 'circle',  value: site.name.split(' ')[0] },
        { key: 'model',   value: btsModel },
        { key: 'network', value: site.net },
      ],
      organizationId: site.org, networkId: site.net,
      connectedCpeSerials: [],
      lastSeenAt: minsAgo(Math.floor(Math.random() * 15)),
      createdAt: daysAgo(120 + s * 7), updatedAt: minsAgo(Math.floor(Math.random() * 30)),
    });
    topo.replaceOne({ _id: `topo-${btsId}` }, {
      _id: `topo-${btsId}`, id: `topo-${btsId}`, deviceId: btsId, serialNumber: btsSn,
      ipAddress: btsIp, type: 'BTS', status: 'HEALTHY',
      latitude: site.lat, longitude: site.lon,
      parentDeviceId: null, childDeviceIds: [],
      cascadeHop: 0, linkHealth: 'HEALTHY', openAlarmCount: 0,
      networkId: site.net, organizationId: site.org,
      lastHealthUpdate: minsAgo(Math.floor(Math.random() * 15)),
    }, { upsert: true });
    inserted++;
  }
  devIdx++;

  // ── IDU (1 per site) ─────────────────────────────────────────────────────────
  const iduId = `dev-idu-${site.code}-001`;
  if (!existingIds.has(iduId)) {
    devices.insertOne({
      _id: iduId, id: iduId, deviceType: 'IDU',
      serialNumber: `IDU-A60-${String(s + 1).padStart(6, '0')}`, macAddress: mac(devIdx),
      ipAddress: `${site.ipPfx}.1.2`, model: pick(IDU_MODELS),
      firmwareVersion: btsFw, softwareVersion: 'NMS-Agent-2.0',
      status: Math.random() > 0.1 ? 'ONLINE' : 'OFFLINE',
      uptimeSeconds: Math.floor(Math.random() * 1296000),
      latitude: site.lat + rnd(-0.005, 0.005),
      longitude: site.lon + rnd(-0.005, 0.005),
      connectedBtsSerial: btsSn,
      tags: [{ key: 'site', value: site.code }, { key: 'circle', value: site.name.split(' ')[0] }],
      organizationId: site.org, networkId: site.net,
      lastSeenAt: minsAgo(Math.floor(Math.random() * 30)),
      createdAt: daysAgo(110 + s * 5), updatedAt: hoursAgo(Math.floor(Math.random() * 4)),
    });
    inserted++;
  }
  devIdx++;

  // ── CPEs (12-18 per site) ────────────────────────────────────────────────────
  const numCpe = 12 + Math.floor(Math.random() * 7);
  for (let c = 0; c < numCpe; c++) {
    const cpeId  = `dev-cpe-${site.code}-${String(c+1).padStart(3,'0')}`;
    const cpeSn  = `CPE-A61-${String(s * 20 + c + 1).padStart(6, '0')}`;
    if (existingIds.has(cpeId)) { devIdx++; continue; }

    const status = pick(STATUSES);
    const cust   = CUSTOMERS[devIdx % CUSTOMERS.length];
    const fw     = pick(FW_VERSIONS);
    const cpeModel = pick(CPE_MODELS);
    const cpeIp  = status === 'OFFLINE' ? null : ip(site.ipPfx, c + 10);

    devices.insertOne({
      _id: cpeId, id: cpeId, deviceType: 'CPE',
      serialNumber: cpeSn, macAddress: mac(devIdx),
      ipAddress: cpeIp, model: cpeModel,
      firmwareVersion: fw, softwareVersion: 'NMS-Agent-1.9',
      status, uptimeSeconds: status === 'ONLINE' ? Math.floor(Math.random() * 604800) : 0,
      latitude: site.lat + rnd(-0.04, 0.04),
      longitude: site.lon + rnd(-0.04, 0.04),
      connectedBtsSerial: btsSn,
      tags: [
        { key: 'customer', value: cust },
        { key: 'plan',     value: pick(['FUP-50','FUP-100','FUP-200','Unlimited-500']) },
        { key: 'site',     value: site.code },
        { key: 'circle',   value: site.name.split(' ')[0] },
      ],
      organizationId: site.org, networkId: site.net,
      lastSeenAt: status === 'OFFLINE' ? hoursAgo(2 + Math.floor(Math.random()*48)) : minsAgo(Math.floor(Math.random()*20)),
      createdAt: daysAgo(60 + Math.floor(Math.random() * 30)),
      updatedAt: hoursAgo(Math.floor(Math.random() * 12)),
    });
    inserted++;
    devIdx++;
  }
}

const total = devices.countDocuments();
print(`\n✅  Seed complete! Inserted ${inserted} new devices.`);
print(`📡  Total devices in ubrnms_inventory.devices: ${total}`);
