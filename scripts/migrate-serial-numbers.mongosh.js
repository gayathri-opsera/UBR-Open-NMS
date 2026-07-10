/**
 * Migrate device serial numbers to the new format:
 *   BTS → BTS-A60-######
 *   CPE → CPE-A61-######
 *   IDU → IDU-A60-######
 *
 * Run: docker exec nms-mongo mongosh ubrnms_inventory /tmp/migrate-serial-numbers.js
 */
'use strict';

const devices   = db.getCollection('devices');
const topo      = db.getCollection('topology_nodes');
const births    = db.getCollection('birth_certificates');

let btsIdx = 1, cpeIdx = 1, iduIdx = 1;

function pad6(n) { return String(n).padStart(6, '0'); }

let updated = 0;

devices.find({}).sort({ _id: 1 }).forEach((dev) => {
  let newSn;
  if (dev.deviceType === 'BTS') {
    newSn = `BTS-A60-${pad6(btsIdx++)}`;
  } else if (dev.deviceType === 'CPE') {
    newSn = `CPE-A61-${pad6(cpeIdx++)}`;
  } else if (dev.deviceType === 'IDU') {
    newSn = `IDU-A60-${pad6(iduIdx++)}`;
  } else {
    return; // skip unknown types
  }

  const oldSn = dev.serialNumber;
  devices.updateOne({ _id: dev._id }, { $set: { serialNumber: newSn } });

  // Keep topology_nodes in sync
  topo.updateMany({ serialNumber: oldSn }, { $set: { serialNumber: newSn } });
  topo.updateMany({ deviceId: dev._id }, { $set: { serialNumber: newSn } });

  // Keep birth_certificates in sync
  births.updateMany({ serialNumber: oldSn }, { $set: { serialNumber: newSn } });
  births.updateMany({ deviceId: dev._id }, { $set: { serialNumber: newSn } });

  // Update connectedBtsSerial references on CPE/IDU that point to this BTS
  if (dev.deviceType === 'BTS') {
    devices.updateMany({ connectedBtsSerial: oldSn }, { $set: { connectedBtsSerial: newSn } });
  }

  updated++;
});

print(`\u2713 Migrated ${updated} device serial numbers`);
print(`  BTS: ${btsIdx - 1} (BTS-A60-000001 ... BTS-A60-${pad6(btsIdx - 1)})`);
print(`  CPE: ${cpeIdx - 1} (CPE-A61-000001 ... CPE-A61-${pad6(cpeIdx - 1)})`);
print(`  IDU: ${iduIdx - 1} (IDU-A60-000001 ... IDU-A60-${pad6(iduIdx - 1)})`);
