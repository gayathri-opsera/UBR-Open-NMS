'use strict';
/**
 * K8s Seed Script — all collections into single ubr_nms database
 * Run from auth-service pod: node /tmp/seed-k8s.js
 */
const { MongoClient } = require('mongodb');
const bcrypt = require('bcrypt');

const MONGO_URL = process.env.MONGO_URI || 'mongodb://localhost:27017/ubr_nms';
const BASE_URL  = MONGO_URL.replace(/\/[^/]+$/, '');
const RESET     = process.argv.includes('--reset');
const ROUNDS    = 10;

function now()         { return new Date(); }
function daysAgo(n)    { return new Date(Date.now() - n * 86_400_000); }
function hoursAgo(n)   { return new Date(Date.now() - n * 3_600_000); }
function minsAgo(n)    { return new Date(Date.now() - n * 60_000); }

const IDS = {
  orgDelhi:'org-airtel-delhi-001', orgMumbai:'org-airtel-mumbai-001',
  circleDelhi:'circle-delhi-north-001', circleMumbai:'circle-mumbai-west-001',
  netDN:'net-delhi-north-001', netDS:'net-delhi-south-001', netMW:'net-mumbai-west-001',
  btsDN:'dev-bts-dn-001', btsDS:'dev-bts-ds-001', btsMW:'dev-bts-mw-001',
  cpeDN1:'dev-cpe-dn-001', cpeDN2:'dev-cpe-dn-002', cpeDN3:'dev-cpe-dn-003',
  cpeDS1:'dev-cpe-ds-001', cpeDS2:'dev-cpe-ds-002',
  cpeMW1:'dev-cpe-mw-001', cpeMW2:'dev-cpe-mw-002', cpeMW3:'dev-cpe-mw-003',
  iduDN:'dev-idu-dn-001', iduDS:'dev-idu-ds-001', iduMW:'dev-idu-mw-001',
  tmplBTS:'tmpl-bts-std-001', tmplCPE:'tmpl-cpe-home-001', tmplIDU:'tmpl-idu-p2p-001',
};

async function main() {
  console.log('\n🌱  UBR Open NMS — K8s Seed Script');
  console.log(`   MongoDB : ${BASE_URL}`);
  console.log(`   Mode    : ${RESET ? 'RESET + seed' : 'skip if exists'}\n`);

  const client = new MongoClient(BASE_URL);
  await client.connect();
  console.log('✓ Connected\n');

  const db = client.db('ubr_nms');

  // ── USERS ──────────────────────────────────────────────────────────────────
  const users = db.collection('users');
  if (RESET) await users.deleteMany({});
  if (await users.countDocuments() === 0) {
    const h = (pw) => bcrypt.hash(pw, ROUNDS);
    await users.insertMany([
      { username:'admin',        email:'admin@ubrnms.local',    passwordHash: await h('Admin@NMS2024!'),     role:'admin',    permissions:{ canManageUsers:true, canPushConfig:true, canAcknowledgeAlarms:true }, isActive:true, isLdapUser:false, failedAttempts:0, lockoutUntil:null, lastLogin:hoursAgo(1), passwordChangedAt:daysAgo(30), createdAt:daysAgo(90), updatedAt:hoursAgo(1) },
      { username:'operator',     email:'operator@ubrnms.local', passwordHash: await h('Operator@NMS2024!'),  role:'operator', permissions:{ canPushConfig:true, canAcknowledgeAlarms:true }, isActive:true, isLdapUser:false, failedAttempts:0, lockoutUntil:null, lastLogin:hoursAgo(3), passwordChangedAt:daysAgo(15), createdAt:daysAgo(60), updatedAt:hoursAgo(3) },
      { username:'viewer',       email:'viewer@ubrnms.local',   passwordHash: await h('Viewer@NMS2024!'),    role:'user',     permissions:{}, isActive:true, isLdapUser:false, failedAttempts:0, lockoutUntil:null, lastLogin:daysAgo(2), passwordChangedAt:daysAgo(7), createdAt:daysAgo(30), updatedAt:daysAgo(2) },
      { username:'noc_operator', email:'noc@ubrnms.local',      passwordHash: await h('NocOp@NMS2024!'),     role:'operator', permissions:{ canAcknowledgeAlarms:true }, isActive:true, isLdapUser:false, failedAttempts:0, lockoutUntil:null, lastLogin:minsAgo(30), passwordChangedAt:daysAgo(5), createdAt:daysAgo(45), updatedAt:minsAgo(30) },
    ]);
    console.log('✓ users: 4 inserted (admin / operator / viewer / noc_operator)');
  } else { console.log('↳ users: already exists — skipping'); }

  // ── ORGANIZATIONS ──────────────────────────────────────────────────────────
  const orgs = db.collection('organizations');
  if (RESET) await orgs.deleteMany({});
  if (await orgs.countDocuments() === 0) {
    await orgs.insertMany([
      { _id:IDS.orgDelhi,  id:IDS.orgDelhi,  name:'Airtel Delhi',  description:'Airtel telecom circle — Delhi & NCR', active:true, createdAt:daysAgo(180), updatedAt:daysAgo(10) },
      { _id:IDS.orgMumbai, id:IDS.orgMumbai, name:'Airtel Mumbai', description:'Airtel telecom circle — Mumbai Metropolitan', active:true, createdAt:daysAgo(180), updatedAt:daysAgo(5) },
    ]);
    console.log('✓ organizations: 2 inserted');
  }

  // ── HIERARCHY VIEWS ────────────────────────────────────────────────────────
  const hvs = db.collection('hierarchy_views');
  if (RESET) await hvs.deleteMany({});
  if (await hvs.countDocuments() === 0) {
    await hvs.insertMany([
      { _id:IDS.circleDelhi,  id:IDS.circleDelhi,  organizationId:IDS.orgDelhi,  name:'Delhi North Circle', type:'CIRCLE', active:true, createdAt:daysAgo(180), updatedAt:daysAgo(10) },
      { _id:IDS.circleMumbai, id:IDS.circleMumbai, organizationId:IDS.orgMumbai, name:'Mumbai West Circle',  type:'CIRCLE', active:true, createdAt:daysAgo(180), updatedAt:daysAgo(5)  },
    ]);
    console.log('✓ hierarchy_views: 2 inserted');
  }

  // ── NETWORKS ───────────────────────────────────────────────────────────────
  const nets = db.collection('networks');
  if (RESET) await nets.deleteMany({});
  if (await nets.countDocuments() === 0) {
    await nets.insertMany([
      { _id:IDS.netDN, id:IDS.netDN, organizationId:IDS.orgDelhi,  hierarchyId:IDS.circleDelhi,  name:'Delhi-North-NET', active:true, createdAt:daysAgo(150), updatedAt:daysAgo(5) },
      { _id:IDS.netDS, id:IDS.netDS, organizationId:IDS.orgDelhi,  hierarchyId:IDS.circleDelhi,  name:'Delhi-South-NET', active:true, createdAt:daysAgo(150), updatedAt:daysAgo(3) },
      { _id:IDS.netMW, id:IDS.netMW, organizationId:IDS.orgMumbai, hierarchyId:IDS.circleMumbai, name:'Mumbai-West-NET',  active:true, createdAt:daysAgo(140), updatedAt:daysAgo(2) },
    ]);
    console.log('✓ networks: 3 inserted');
  }

  // ── DEVICES ────────────────────────────────────────────────────────────────
  const devs = db.collection('devices');
  if (RESET) await devs.deleteMany({});
  if (await devs.countDocuments() === 0) {
    await devs.insertMany([
      { _id:IDS.btsDN,  id:IDS.btsDN,  deviceType:'BTS', serialNumber:'SN-BTS-DN-001', macAddress:'AA:BB:CC:DD:E1:01', ipAddress:'10.10.1.1',   model:'Senao ENH1750EXT',    firmwareVersion:'v3.4.1', status:'ONLINE',  uptimeSeconds:864000,   latitude:28.6139, longitude:77.2090, organizationId:IDS.orgDelhi,  networkId:IDS.netDN, connectedCpeSerials:['SN-CPE-DN-001','SN-CPE-DN-002','SN-CPE-DN-003'], tags:[{key:'site',value:'SITE-DELHI-NORTH-01'}], createdAt:daysAgo(120), updatedAt:minsAgo(5) },
      { _id:IDS.btsDS,  id:IDS.btsDS,  deviceType:'BTS', serialNumber:'SN-BTS-DS-001', macAddress:'AA:BB:CC:DD:E1:02', ipAddress:'10.10.2.1',   model:'Senao ENH1750EXT',    firmwareVersion:'v3.4.1', status:'ONLINE',  uptimeSeconds:432000,   latitude:28.5355, longitude:77.3910, organizationId:IDS.orgDelhi,  networkId:IDS.netDS, tags:[{key:'site',value:'SITE-DELHI-SOUTH-01'}], createdAt:daysAgo(115), updatedAt:minsAgo(15) },
      { _id:IDS.btsMW,  id:IDS.btsMW,  deviceType:'BTS', serialNumber:'SN-BTS-MW-001', macAddress:'AA:BB:CC:DD:E1:03', ipAddress:'10.30.1.1',   model:'Senao ENH1750EXT-AC', firmwareVersion:'v3.5.0', status:'ONLINE',  uptimeSeconds:1728000,  latitude:19.0760, longitude:72.8777, organizationId:IDS.orgMumbai, networkId:IDS.netMW, tags:[{key:'site',value:'SITE-MUMBAI-WEST-01'}], createdAt:daysAgo(110), updatedAt:minsAgo(2) },
      { _id:IDS.cpeDN1, id:IDS.cpeDN1, deviceType:'CPE', serialNumber:'SN-CPE-DN-001', macAddress:'BB:CC:DD:EE:FF:01', ipAddress:'10.10.1.101', model:'Senao EAP300',        firmwareVersion:'v2.3.0', status:'ONLINE',  uptimeSeconds:259200,   latitude:28.6210, longitude:77.2110, organizationId:IDS.orgDelhi,  networkId:IDS.netDN, connectedBtsSerial:'SN-BTS-DN-001', tags:[{key:'customer',value:'Rajesh Kumar'}], createdAt:daysAgo(90), updatedAt:hoursAgo(2) },
      { _id:IDS.cpeDN2, id:IDS.cpeDN2, deviceType:'CPE', serialNumber:'SN-CPE-DN-002', macAddress:'BB:CC:DD:EE:FF:02', ipAddress:'10.10.1.102', model:'Senao EAP300',        firmwareVersion:'v2.3.0', status:'ONLINE',  uptimeSeconds:172800,   latitude:28.6230, longitude:77.2080, organizationId:IDS.orgDelhi,  networkId:IDS.netDN, connectedBtsSerial:'SN-BTS-DN-001', tags:[{key:'customer',value:'Priya Sharma'}], createdAt:daysAgo(85), updatedAt:hoursAgo(4) },
      { _id:IDS.cpeDN3, id:IDS.cpeDN3, deviceType:'CPE', serialNumber:'SN-CPE-DN-003', macAddress:'BB:CC:DD:EE:FF:03', ipAddress:'10.10.1.103', model:'Senao EAP300',        firmwareVersion:'v2.1.0', status:'OFFLINE', uptimeSeconds:0,        latitude:28.6190, longitude:77.2140, organizationId:IDS.orgDelhi,  networkId:IDS.netDN, connectedBtsSerial:'SN-BTS-DN-001', tags:[{key:'customer',value:'Mohammed Ali'}], createdAt:daysAgo(80), updatedAt:hoursAgo(6) },
      { _id:IDS.cpeDS1, id:IDS.cpeDS1, deviceType:'CPE', serialNumber:'SN-CPE-DS-001', macAddress:'BB:CC:DD:EE:FF:04', ipAddress:'10.10.2.101', model:'Senao EAP300-AC',     firmwareVersion:'v2.3.0', status:'ONLINE',  uptimeSeconds:518400,   latitude:28.5400, longitude:77.3950, organizationId:IDS.orgDelhi,  networkId:IDS.netDS, connectedBtsSerial:'SN-BTS-DS-001', tags:[{key:'customer',value:'Sunita Patel'}], createdAt:daysAgo(75), updatedAt:hoursAgo(1) },
      { _id:IDS.cpeDS2, id:IDS.cpeDS2, deviceType:'CPE', serialNumber:'SN-CPE-DS-002', macAddress:'BB:CC:DD:EE:FF:05', ipAddress:'10.10.2.102', model:'Senao EAP300',        firmwareVersion:'v2.3.0', status:'PROVISIONING', uptimeSeconds:0, latitude:28.5380, longitude:77.3920, organizationId:IDS.orgDelhi,  networkId:IDS.netDS, tags:[{key:'customer',value:'Vijay Singh'}], createdAt:daysAgo(1), updatedAt:minsAgo(45) },
      { _id:IDS.cpeMW1, id:IDS.cpeMW1, deviceType:'CPE', serialNumber:'SN-CPE-MW-001', macAddress:'BB:CC:DD:EE:FF:06', ipAddress:'10.30.1.101', model:'Senao EAP300-AC',     firmwareVersion:'v2.3.0', status:'ONLINE',  uptimeSeconds:691200,   latitude:19.0810, longitude:72.8820, organizationId:IDS.orgMumbai, networkId:IDS.netMW, connectedBtsSerial:'SN-BTS-MW-001', tags:[{key:'customer',value:'Amit Desai'}], createdAt:daysAgo(70), updatedAt:hoursAgo(1) },
      { _id:IDS.cpeMW2, id:IDS.cpeMW2, deviceType:'CPE', serialNumber:'SN-CPE-MW-002', macAddress:'BB:CC:DD:EE:FF:07', ipAddress:'10.30.1.102', model:'Senao EAP300-AC',     firmwareVersion:'v2.3.0', status:'ONLINE',  uptimeSeconds:345600,   latitude:19.0740, longitude:72.8750, organizationId:IDS.orgMumbai, networkId:IDS.netMW, connectedBtsSerial:'SN-BTS-MW-001', tags:[{key:'customer',value:'Nandini Joshi'}], createdAt:daysAgo(65), updatedAt:hoursAgo(3) },
      { _id:IDS.cpeMW3, id:IDS.cpeMW3, deviceType:'CPE', serialNumber:'SN-CPE-MW-003', macAddress:'BB:CC:DD:EE:FF:08', ipAddress:'10.30.1.103', model:'Senao EAP300',        firmwareVersion:'v2.2.0', status:'ONLINE',  uptimeSeconds:129600,   latitude:19.0790, longitude:72.8800, organizationId:IDS.orgMumbai, networkId:IDS.netMW, connectedBtsSerial:'SN-BTS-MW-001', tags:[{key:'customer',value:'Rohan Mehta'}], createdAt:daysAgo(60), updatedAt:hoursAgo(5) },
      { _id:IDS.iduDN,  id:IDS.iduDN,  deviceType:'IDU', serialNumber:'SN-IDU-DN-001', macAddress:'CC:DD:EE:FF:00:01', ipAddress:'10.10.1.200', model:'Senao IDU-5000',      firmwareVersion:'v1.9.2', status:'ONLINE',  uptimeSeconds:1209600,  latitude:28.6139, longitude:77.2095, organizationId:IDS.orgDelhi,  networkId:IDS.netDN, connectedBtsSerial:'SN-BTS-DN-001', tags:[{key:'link-type',value:'backhaul'}], createdAt:daysAgo(100), updatedAt:minsAgo(10) },
      { _id:IDS.iduDS,  id:IDS.iduDS,  deviceType:'IDU', serialNumber:'SN-IDU-DS-001', macAddress:'CC:DD:EE:FF:00:02', ipAddress:'10.10.2.200', model:'Senao IDU-5000',      firmwareVersion:'v1.8.5', status:'OFFLINE', uptimeSeconds:0,        latitude:28.5355, longitude:77.3915, organizationId:IDS.orgDelhi,  networkId:IDS.netDS, tags:[{key:'issue',value:'device-unreachable'}], createdAt:daysAgo(95), updatedAt:hoursAgo(8) },
      { _id:IDS.iduMW,  id:IDS.iduMW,  deviceType:'IDU', serialNumber:'SN-IDU-MW-001', macAddress:'CC:DD:EE:FF:00:03', ipAddress:'10.30.1.200', model:'Senao IDU-5000-AC',   firmwareVersion:'v1.9.2', status:'ONLINE',  uptimeSeconds:2592000,  latitude:19.0760, longitude:72.8785, organizationId:IDS.orgMumbai, networkId:IDS.netMW, connectedBtsSerial:'SN-BTS-MW-001', tags:[{key:'link-type',value:'backhaul'}], createdAt:daysAgo(90), updatedAt:minsAgo(3) },
    ]);
    console.log('✓ devices: 14 inserted (3 BTS, 8 CPE, 3 IDU)');
  }

  // ── ALARMS ─────────────────────────────────────────────────────────────────
  const alarms = db.collection('alarms');
  if (RESET) await alarms.deleteMany({});
  if (await alarms.countDocuments() === 0) {
    await alarms.insertMany([
      { id:'alm-crit-link-dn-001',    alarmId:'AL-CRIT-0001', deviceId:IDS.btsDN,  deviceType:'BTS', alarmType:'LINK_DOWN',           alarmName:'Ethernet Backhaul Link Down',  severity:'CRITICAL', state:'ACTIVE',       description:'Primary Ethernet backhaul link failure on eth0.',                  metricValue:0,    threshold:0,    isRootCause:true,  correlatedChildCount:3, dedupCount:1, acknowledgedBy:null, acknowledgedAt:null, networkId:IDS.netDN, organizationId:IDS.orgDelhi, source:'NETCOOL',  raisedAt:hoursAgo(2), clearedAt:null, updatedAt:hoursAgo(2) },
      { id:'alm-crit-dev-unreach-001', alarmId:'AL-CRIT-0002', deviceId:IDS.iduDS,  deviceType:'IDU', alarmType:'DEVICE_UNREACHABLE',  alarmName:'Device Unreachable',           severity:'CRITICAL', state:'ACTIVE',       description:'ICMP ping timeout — IDU-DS-001 not responded for 20+ minutes.', metricValue:0,    threshold:0,    isRootCause:true,  correlatedChildCount:0, dedupCount:4, acknowledgedBy:null, acknowledgedAt:null, networkId:IDS.netDS, organizationId:IDS.orgDelhi, source:'NMS-POLL', raisedAt:hoursAgo(8), clearedAt:null, updatedAt:hoursAgo(3) },
      { id:'alm-maj-cpu-dn-001',       alarmId:'AL-MAJOR-0001',deviceId:IDS.cpeDN3, deviceType:'CPE', alarmType:'HIGH_CPU_UTILIZATION',alarmName:'CPU Utilization Critical',      severity:'MAJOR',    state:'ACTIVE',       description:'CPU utilization sustained above 90% for 10+ minutes.',           metricValue:93.5, threshold:85.0, isRootCause:false, correlatedChildCount:0, dedupCount:2, acknowledgedBy:null, acknowledgedAt:null, networkId:IDS.netDN, organizationId:IDS.orgDelhi, source:'NMS-KPI',  raisedAt:hoursAgo(5), clearedAt:null, updatedAt:hoursAgo(5) },
      { id:'alm-maj-sig-deg-001',      alarmId:'AL-MAJOR-0002',deviceId:IDS.btsDS,  deviceType:'BTS', alarmType:'SIGNAL_DEGRADED',     alarmName:'RF Signal Level Degraded',     severity:'MAJOR',    state:'ACTIVE',       description:'Average RSSI degraded below -78 dBm. Potential antenna issue.',  metricValue:-80.3,threshold:-78.0,isRootCause:true,  correlatedChildCount:2, dedupCount:1, acknowledgedBy:null, acknowledgedAt:null, networkId:IDS.netDS, organizationId:IDS.orgDelhi, source:'NMS-KPI',  raisedAt:hoursAgo(3), clearedAt:null, updatedAt:hoursAgo(3) },
      { id:'alm-min-low-sig-001',      alarmId:'AL-MINOR-0001',deviceId:IDS.cpeDN2, deviceType:'CPE', alarmType:'LOW_SIGNAL_STRENGTH', alarmName:'Low Signal Strength',          severity:'MINOR',    state:'ACTIVE',       description:'RSSI dropped to -76 dBm, below -75 dBm minor threshold.',        metricValue:-76.2,threshold:-75.0,isRootCause:false, correlatedChildCount:0, dedupCount:1, acknowledgedBy:null, acknowledgedAt:null, networkId:IDS.netDN, organizationId:IDS.orgDelhi, source:'NMS-KPI',  raisedAt:hoursAgo(4), clearedAt:null, updatedAt:hoursAgo(4) },
      { id:'alm-warn-mem-001',         alarmId:'AL-WARN-0001', deviceId:IDS.cpeDS1, deviceType:'CPE', alarmType:'HIGH_MEMORY_USAGE',   alarmName:'High Memory Usage',            severity:'WARNING',  state:'ACTIVE',       description:'Memory usage at 82%, approaching 85% warning threshold.',        metricValue:82.1, threshold:80.0, isRootCause:false, correlatedChildCount:0, dedupCount:1, acknowledgedBy:null, acknowledgedAt:null, networkId:IDS.netDS, organizationId:IDS.orgDelhi, source:'NMS-KPI',  raisedAt:hoursAgo(1), clearedAt:null, updatedAt:hoursAgo(1) },
      { id:'alm-ack-temp-001',         alarmId:'AL-ACK-0001',  deviceId:IDS.btsMW,  deviceType:'BTS', alarmType:'TEMPERATURE_HIGH',    alarmName:'Device Temperature High',      severity:'MAJOR',    state:'ACKNOWLEDGED', description:'BTS temperature reached 68°C, above 65°C threshold.',           metricValue:68.2, threshold:65.0, isRootCause:true,  correlatedChildCount:0, dedupCount:3, acknowledgedBy:'operator', acknowledgedAt:hoursAgo(1), networkId:IDS.netMW, organizationId:IDS.orgMumbai, source:'NMS-KPI', raisedAt:hoursAgo(6), clearedAt:null, updatedAt:hoursAgo(1) },
      { id:'alm-clr-pwr-001',          alarmId:'AL-CLR-0001',  deviceId:IDS.iduDN,  deviceType:'IDU', alarmType:'POWER_FLUCTUATION',   alarmName:'Power Supply Fluctuation',     severity:'MAJOR',    state:'CLEARED',      description:'Intermittent power supply issue. UPS log shows 3 micro-outages.',metricValue:0,    threshold:0,    isRootCause:false, correlatedChildCount:0, dedupCount:2, acknowledgedBy:'admin',    acknowledgedAt:hoursAgo(12), networkId:IDS.netDN, organizationId:IDS.orgDelhi,  source:'SYSLOG',   raisedAt:daysAgo(1), clearedAt:hoursAgo(10), updatedAt:hoursAgo(10) },
    ]);
    console.log('✓ alarms: 8 inserted (2 CRITICAL, 2 MAJOR, 1 MINOR, 1 WARNING, 1 ACK, 1 CLEARED)');
  }

  // ── ALARM THRESHOLDS ───────────────────────────────────────────────────────
  const thresholds = db.collection('alarm_thresholds');
  if (RESET) await thresholds.deleteMany({});
  if (await thresholds.countDocuments() === 0) {
    await thresholds.insertMany([
      { deviceType:'CPE', parameter:'rssiDbm',              raiseThreshold:-75.0, clearThreshold:-70.0, severity:'MINOR',    alarmType:'LOW_SIGNAL_STRENGTH',      enabled:true },
      { deviceType:'CPE', parameter:'rssiDbm',              raiseThreshold:-85.0, clearThreshold:-80.0, severity:'CRITICAL', alarmType:'CRITICAL_SIGNAL',          enabled:true },
      { deviceType:'BTS', parameter:'channelUtilizationPct',raiseThreshold:90.0,  clearThreshold:80.0,  severity:'MAJOR',    alarmType:'HIGH_CHANNEL_UTILIZATION', enabled:true },
      { deviceType:'BTS', parameter:'temperature',          raiseThreshold:65.0,  clearThreshold:60.0,  severity:'MAJOR',    alarmType:'TEMPERATURE_HIGH',         enabled:true },
      { deviceType:null,  parameter:'cpuPct',               raiseThreshold:85.0,  clearThreshold:75.0,  severity:'MAJOR',    alarmType:'HIGH_CPU_UTILIZATION',     enabled:true },
      { deviceType:null,  parameter:'memoryPct',            raiseThreshold:80.0,  clearThreshold:70.0,  severity:'WARNING',  alarmType:'HIGH_MEMORY_USAGE',        enabled:true },
    ]);
    console.log('✓ alarm_thresholds: 6 inserted');
  }

  // ── CONFIG TEMPLATES ───────────────────────────────────────────────────────
  const templates = db.collection('config_templates');
  if (RESET) await templates.deleteMany({});
  if (await templates.countDocuments() === 0) {
    await templates.insertMany([
      { _id:IDS.tmplBTS, id:IDS.tmplBTS, name:'BTS-Standard-5GHz', description:'Standard 5 GHz for all Senao BTS units', deviceType:'BTS', isDefault:true, channel5:36, txPower5:20, channelBandwidth:80, firmwareVersion:'v3.4.1', qosProfile:'BEST_EFFORT', vlanId:100, createdBy:'admin', createdAt:daysAgo(90), updatedAt:daysAgo(15) },
      { _id:IDS.tmplCPE, id:IDS.tmplCPE, name:'CPE-Home-Basic',    description:'Default home subscriber CPE profile',     deviceType:'CPE', isDefault:true, channel5:36, txPower5:20, firmwareVersion:'v2.3.0', qosProfile:'BEST_EFFORT', createdBy:'admin', createdAt:daysAgo(90), updatedAt:daysAgo(10) },
      { _id:IDS.tmplIDU, id:IDS.tmplIDU, name:'IDU-P2P-Backhaul',  description:'Point-to-point backhaul IDU template',    deviceType:'IDU', isDefault:true, channel5:160, channelBandwidth:40, firmwareVersion:'v1.9.2', qosProfile:'REALTIME', createdBy:'admin', createdAt:daysAgo(80), updatedAt:daysAgo(20) },
    ]);
    console.log('✓ config_templates: 3 inserted');
  }

  // ── TOPOLOGY NODES ─────────────────────────────────────────────────────────
  const topoNodes = db.collection('topology_nodes');
  if (RESET) await topoNodes.deleteMany({});
  if (await topoNodes.countDocuments() === 0) {
    await topoNodes.insertMany([
      { id:`topo-${IDS.btsDN}`,  deviceId:IDS.btsDN,  serialNumber:'SN-BTS-DN-001', ipAddress:'10.10.1.1',   type:'BTS', status:'HEALTHY',  latitude:28.6139, longitude:77.2090, parentDeviceId:null,     childDeviceIds:[IDS.cpeDN1,IDS.cpeDN2,IDS.cpeDN3,IDS.iduDN], cascadeHop:0, linkHealth:'HEALTHY',  openAlarmCount:1, networkId:IDS.netDN, organizationId:IDS.orgDelhi,  lastHealthUpdate:minsAgo(5) },
      { id:`topo-${IDS.btsDS}`,  deviceId:IDS.btsDS,  serialNumber:'SN-BTS-DS-001', ipAddress:'10.10.2.1',   type:'BTS', status:'DEGRADED', latitude:28.5355, longitude:77.3910, parentDeviceId:null,     childDeviceIds:[IDS.cpeDS1,IDS.cpeDS2], cascadeHop:0, linkHealth:'DEGRADED', openAlarmCount:1, networkId:IDS.netDS, organizationId:IDS.orgDelhi,  lastHealthUpdate:minsAgo(15) },
      { id:`topo-${IDS.btsMW}`,  deviceId:IDS.btsMW,  serialNumber:'SN-BTS-MW-001', ipAddress:'10.30.1.1',   type:'BTS', status:'HEALTHY',  latitude:19.0760, longitude:72.8777, parentDeviceId:null,     childDeviceIds:[IDS.cpeMW1,IDS.cpeMW2,IDS.cpeMW3,IDS.iduMW], cascadeHop:0, linkHealth:'HEALTHY',  openAlarmCount:1, networkId:IDS.netMW, organizationId:IDS.orgMumbai, lastHealthUpdate:minsAgo(2) },
      { id:`topo-${IDS.cpeDN1}`, deviceId:IDS.cpeDN1, serialNumber:'SN-CPE-DN-001', ipAddress:'10.10.1.101', type:'CPE', status:'HEALTHY',  latitude:28.6210, longitude:77.2110, parentDeviceId:IDS.btsDN, childDeviceIds:[], cascadeHop:1, linkHealth:'HEALTHY',  openAlarmCount:0, networkId:IDS.netDN, organizationId:IDS.orgDelhi,  lastHealthUpdate:hoursAgo(2) },
      { id:`topo-${IDS.cpeDN2}`, deviceId:IDS.cpeDN2, serialNumber:'SN-CPE-DN-002', ipAddress:'10.10.1.102', type:'CPE', status:'DEGRADED', latitude:28.6230, longitude:77.2080, parentDeviceId:IDS.btsDN, childDeviceIds:[], cascadeHop:1, linkHealth:'DEGRADED', openAlarmCount:1, networkId:IDS.netDN, organizationId:IDS.orgDelhi,  lastHealthUpdate:hoursAgo(4) },
      { id:`topo-${IDS.cpeDN3}`, deviceId:IDS.cpeDN3, serialNumber:'SN-CPE-DN-003', ipAddress:'10.10.1.103', type:'CPE', status:'FAULTY',   latitude:28.6190, longitude:77.2140, parentDeviceId:IDS.btsDN, childDeviceIds:[], cascadeHop:1, linkHealth:'FAULTY',   openAlarmCount:1, networkId:IDS.netDN, organizationId:IDS.orgDelhi,  lastHealthUpdate:hoursAgo(6) },
      { id:`topo-${IDS.cpeDS1}`, deviceId:IDS.cpeDS1, serialNumber:'SN-CPE-DS-001', ipAddress:'10.10.2.101', type:'CPE', status:'HEALTHY',  latitude:28.5400, longitude:77.3950, parentDeviceId:IDS.btsDS, childDeviceIds:[], cascadeHop:1, linkHealth:'DEGRADED', openAlarmCount:1, networkId:IDS.netDS, organizationId:IDS.orgDelhi,  lastHealthUpdate:hoursAgo(1) },
      { id:`topo-${IDS.cpeMW1}`, deviceId:IDS.cpeMW1, serialNumber:'SN-CPE-MW-001', ipAddress:'10.30.1.101', type:'CPE', status:'HEALTHY',  latitude:19.0810, longitude:72.8820, parentDeviceId:IDS.btsMW, childDeviceIds:[], cascadeHop:1, linkHealth:'HEALTHY',  openAlarmCount:0, networkId:IDS.netMW, organizationId:IDS.orgMumbai, lastHealthUpdate:hoursAgo(1) },
      { id:`topo-${IDS.cpeMW2}`, deviceId:IDS.cpeMW2, serialNumber:'SN-CPE-MW-002', ipAddress:'10.30.1.102', type:'CPE', status:'HEALTHY',  latitude:19.0740, longitude:72.8750, parentDeviceId:IDS.btsMW, childDeviceIds:[], cascadeHop:1, linkHealth:'HEALTHY',  openAlarmCount:0, networkId:IDS.netMW, organizationId:IDS.orgMumbai, lastHealthUpdate:hoursAgo(3) },
      { id:`topo-${IDS.iduDN}`,  deviceId:IDS.iduDN,  serialNumber:'SN-IDU-DN-001', ipAddress:'10.10.1.200', type:'IDU', status:'HEALTHY',  latitude:28.6139, longitude:77.2095, parentDeviceId:IDS.btsDN, childDeviceIds:[], cascadeHop:1, linkHealth:'HEALTHY',  openAlarmCount:0, networkId:IDS.netDN, organizationId:IDS.orgDelhi,  lastHealthUpdate:minsAgo(10) },
      { id:`topo-${IDS.iduDS}`,  deviceId:IDS.iduDS,  serialNumber:'SN-IDU-DS-001', ipAddress:null,          type:'IDU', status:'FAULTY',   latitude:28.5355, longitude:77.3915, parentDeviceId:null,     childDeviceIds:[], cascadeHop:0, linkHealth:'FAULTY',   openAlarmCount:1, networkId:IDS.netDS, organizationId:IDS.orgDelhi,  lastHealthUpdate:hoursAgo(8) },
      { id:`topo-${IDS.iduMW}`,  deviceId:IDS.iduMW,  serialNumber:'SN-IDU-MW-001', ipAddress:'10.30.1.200', type:'IDU', status:'HEALTHY',  latitude:19.0760, longitude:72.8785, parentDeviceId:IDS.btsMW, childDeviceIds:[], cascadeHop:1, linkHealth:'HEALTHY',  openAlarmCount:0, networkId:IDS.netMW, organizationId:IDS.orgMumbai, lastHealthUpdate:minsAgo(3) },
    ]);
    console.log('✓ topology_nodes: 12 inserted');
  }

  await client.close();

  console.log('\n' + '═'.repeat(56));
  console.log('✅  Seed complete!');
  console.log('');
  console.log('  Role      │ Username     │ Password');
  console.log('  ──────────┼──────────────┼──────────────────');
  console.log('  Admin     │ admin        │ Admin@NMS2024!');
  console.log('  Operator  │ operator     │ Operator@NMS2024!');
  console.log('  NOC Ops   │ noc_operator │ NocOp@NMS2024!');
  console.log('  Viewer    │ viewer       │ Viewer@NMS2024!');
  console.log('═'.repeat(56) + '\n');
}

main().catch(err => { console.error('❌ Seed failed:', err.message); process.exit(1); });
