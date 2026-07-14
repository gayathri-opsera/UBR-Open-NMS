/**
 * migrate-device-coords.js
 *
 * Fixes existing device coordinates to comply with topology rules:
 *   Rule 1: CPE must be within 1 KM of its associated BTS
 *   Rule 2: IDU must share exact coordinates with its co-located CPE
 *
 * Run via mongosh:
 *   docker exec -i nms-mongo mongosh ubrnms_inventory < scripts/migrate-device-coords.js
 *   docker exec -i nms-mongo mongosh ubr_nms          < scripts/migrate-device-coords.js
 */
'use strict';

// ── Haversine distance (km) ─────────────────────────────────────────────────
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

// Random small offset within CPE_MAX_OFFSET degrees (≈ 0.63 km diagonal max)
const CPE_MAX_OFFSET = 0.004;
function rnd(min, max) { return parseFloat((min + Math.random() * (max - min)).toFixed(6)); }

// ── Fetch all devices ────────────────────────────────────────────────────────
const col = db.getCollection('devices');
const allDevices = col.find({}).toArray();

// Index by serial for quick lookup
const bySerial = {};
allDevices.forEach((d) => { if (d.serialNumber) bySerial[d.serialNumber] = d; });

// ── Helper: device lat/lon ───────────────────────────────────────────────────
function coords(d) {
  const lat = d.latitude ?? d.location?.coordinates?.[1];
  const lon = d.longitude ?? d.location?.coordinates?.[0];
  return (lat != null && lon != null) ? { lat, lon } : null;
}

let cpeMoved = 0;
let iduMoved = 0;

// ── Rule 1: CPE must be ≤ 1 KM from BTS ─────────────────────────────────────
const cpeDevices = allDevices.filter((d) => d.deviceType === 'CPE');
cpeDevices.forEach((cpe) => {
  const btsSn = cpe.connectedBtsSerial;
  if (!btsSn) return;
  const bts = bySerial[btsSn];
  if (!bts) return;
  const btsCoords = coords(bts);
  if (!btsCoords) return;
  const cpeCoords = coords(cpe);
  if (!cpeCoords) {
    // No coords at all — place near BTS
    const newLat = btsCoords.lat + rnd(-CPE_MAX_OFFSET, CPE_MAX_OFFSET);
    const newLon = btsCoords.lon + rnd(-CPE_MAX_OFFSET, CPE_MAX_OFFSET);
    col.updateOne({ _id: cpe._id }, { $set: { latitude: newLat, longitude: newLon } });
    bySerial[cpe.serialNumber].latitude  = newLat;
    bySerial[cpe.serialNumber].longitude = newLon;
    cpeMoved++;
    return;
  }
  const distKm = haversineKm(cpeCoords.lat, cpeCoords.lon, btsCoords.lat, btsCoords.lon);
  if (distKm > 1.0) {
    // Move CPE to within 1 km of BTS
    const newLat = btsCoords.lat + rnd(-CPE_MAX_OFFSET, CPE_MAX_OFFSET);
    const newLon = btsCoords.lon + rnd(-CPE_MAX_OFFSET, CPE_MAX_OFFSET);
    col.updateOne({ _id: cpe._id }, { $set: { latitude: newLat, longitude: newLon } });
    // Update in-memory cache so IDU fix below sees updated value
    bySerial[cpe.serialNumber].latitude  = newLat;
    bySerial[cpe.serialNumber].longitude = newLon;
    cpeMoved++;
  }
});

// ── Rule 2: IDU must share coords with co-located CPE ───────────────────────
const iduDevices = allDevices.filter((d) => d.deviceType === 'IDU');
iduDevices.forEach((idu) => {
  // Prefer explicit linkedCpeSerial; fallback to first CPE sharing same BTS
  let cpe = null;
  if (idu.linkedCpeSerial) {
    cpe = bySerial[idu.linkedCpeSerial];
  }
  if (!cpe && idu.connectedBtsSerial) {
    cpe = cpeDevices.find((c) => c.connectedBtsSerial === idu.connectedBtsSerial);
  }
  if (!cpe) return;

  const cpeCoords = coords(cpe);
  if (!cpeCoords) return;

  const iduCoords = coords(idu);
  const mismatch = !iduCoords
    || haversineKm(iduCoords.lat, iduCoords.lon, cpeCoords.lat, cpeCoords.lon) > 0.01;

  if (mismatch) {
    col.updateOne(
      { _id: idu._id },
      { $set: {
          latitude:       cpeCoords.lat,
          longitude:      cpeCoords.lon,
          linkedCpeSerial: cpe.serialNumber,
      }},
    );
    iduMoved++;
  }
});

// ── Also fix topology_nodes if the collection exists ────────────────────────
const topoCol = db.getCollection('topology_nodes');
if (topoCol) {
  const topoNodes = topoCol.find({ type: { $in: ['CPE', 'IDU'] } }).toArray();
  let topoFixed = 0;
  topoNodes.forEach((node) => {
    const dev = allDevices.find((d) => d._id === node.deviceId || d.serialNumber === node.serialNumber);
    if (!dev) return;
    const devCoords = coords(dev);
    if (!devCoords) return;
    const nodeCoords = { lat: node.latitude, lon: node.longitude };
    if (!nodeCoords.lat || haversineKm(nodeCoords.lat, nodeCoords.lon, devCoords.lat, devCoords.lon) > 0.05) {
      topoCol.updateOne(
        { _id: node._id },
        { $set: { latitude: devCoords.lat, longitude: devCoords.lon } },
      );
      topoFixed++;
    }
  });
  print(`✓ topology_nodes synced: ${topoFixed} nodes updated`);
}

print(`\n✅  Coordinate migration complete!`);
print(`   CPE devices moved into 1 KM: ${cpeMoved}`);
print(`   IDU devices synced to CPE:   ${iduMoved}`);
print(`   Total devices in collection: ${col.countDocuments()}`);
