'use strict';

const express = require('express');
const router  = express.Router();

// ── Inventory service URL (internal Docker network or override) ─────────────
const INVENTORY_URL = process.env.INVENTORY_SERVICE_URL || 'http://nms-inventory:8082';

// ── Short in-memory cache so we don't hammer inventory on every request ──────
let _devCache  = null;
let _cacheAt   = 0;
const CACHE_TTL = 30_000; // 30 s

// ── Helpers ───────────────────────────────────────────────────────────────────
function toHealth(s) {
  if (!s) return 'UNKNOWN';
  const u = String(s).toUpperCase();
  if (['ONLINE', 'HEALTHY', 'ACTIVE', 'UP', 'RUNNING'].includes(u)) return 'HEALTHY';
  if (['DEGRADED', 'WARNING', 'WARN'].includes(u))                   return 'DEGRADED';
  if (['OFFLINE', 'DOWN', 'FAULTY', 'ERROR', 'UNREACHABLE'].includes(u)) return 'FAULTY';
  return 'UNKNOWN';
}

function toLinkQuality(health) {
  if (health === 'HEALTHY')  return 'GOOD';
  if (health === 'DEGRADED') return 'FAIR';
  if (health === 'FAULTY')   return 'POOR';
  return 'DOWN';
}

function fmtUptime(sec) {
  if (!sec) return 'N/A';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${d}d ${h}h ${m}m`;
}

// ── Fetch real devices from inventory (no auth needed on internal network) ───
async function getInventoryDevices(bustCache = false) {
  const now = Date.now();
  if (!bustCache && _devCache && now - _cacheAt < CACHE_TTL) return _devCache;

  const resp = await fetch(`${INVENTORY_URL}/api/v1/devices?limit=500`);
  if (!resp.ok) throw new Error(`Inventory HTTP ${resp.status}`);

  const body = await resp.json();
  const list = Array.isArray(body) ? body : (body.devices ?? body.data ?? body.items ?? []);

  _devCache = list;
  _cacheAt  = now;
  return list;
}

// ── Map an inventory device to a topology node ────────────────────────────────
// parentNode is passed in a second pass (after buildEdges sets parentDeviceId)
// so CPE/IDU can inherit coordinates from their BTS when their own GPS is missing.
function toNode(d, idx, parentNode) {
  const type   = d.deviceType || d.type || 'CPE';
  const health = toHealth(d.status || d.health);
  const id     = d.id || d._id || d.deviceId || `dev-${idx}`;
  const rssi   = d.rssi ?? (type !== 'IDU' ? -60 - (idx % 20) : null);
  const snr    = d.snr  ?? (type !== 'IDU' ? 25  - (idx % 10) : null);

  // Fix any GPS coordinate that is outside India (0,0 or wrong continent)
  let lat = d.latitude, lng = d.longitude;
  if (!isInsideIndia(lat, lng)) {
    const fb = fallbackCoord(d, parentNode, idx);
    lat = fb.lat;
    lng = fb.lng;
  }

  return {
    id,
    deviceId:        id,
    deviceName:      d.name || d.deviceName
                     || (d.serialNumber ? `${type} ${d.serialNumber.slice(-3)}` : `${type} ${101 + idx}`),
    serialNumber:    d.serialNumber || `${type}-${String(100000 + idx).padStart(6, '0')}`,
    _connectedBtsSerial: d.connectedBtsSerial || null,
    type,
    status:          health,
    ipAddress:       d.ipAddress  || '0.0.0.0',
    macAddress:      d.macAddress || '00:00:00:00:00:00',
    latitude:        lat,
    longitude:       lng,
    operatingChannel: d.channel ? `${d.channel} (${d.channelBandwidth || 80} MHz)` : null,
    rssi,
    a1Rssi:          d.a1Rssi ?? (rssi != null ? rssi - 3 : null),
    a2Rssi:          d.a2Rssi ?? (rssi != null ? rssi - 5 : null),
    snr,
    ethernetSpeed:   d.ethernetSpeed || (type === 'BTS' ? '1000 Mbps' : '100 Mbps'),
    duplex:          d.duplex || 'Full',
    firmwareVersion: d.firmwareVersion || 'v2.3.1',
    uptime:          fmtUptime(d.uptimeSeconds || d.uptime),
    cascadeHop:      type === 'BTS' ? 1 : type === 'CPE' ? 2 : 3,
    pendingCommandCount: 0,
    networkId:       d.networkId || d.organizationId || `net-${(idx % 3) + 1}`,
    parentDeviceId:  null,          // filled in during buildEdges()
    linkQuality:     toLinkQuality(health),
    connectedCpeSerials:  d.connectedCpeSerials  || [],
    connectedIduSerials:  d.connectedIduSerials  || [],
    // inter-city backbone links (BTS↔BTS)
    _cascadedBtsSerials:  d.cascadedBtsSerials   || [],
  };
}

// ── Wire BTS→CPE and BTS→IDU; fix child GPS to sit near their parent BTS ─────
function buildEdges(nodes) {
  // Index BTS by serialNumber and by id for O(1) look-ups
  const btsBySerial = {};
  const nodesById   = {};
  nodes.forEach((n) => {
    nodesById[n.id] = n;
    if (n.type === 'BTS') btsBySerial[n.serialNumber] = n;
  });

  // Assign parentDeviceId on CPE and IDU via connectedBtsSerial
  nodes.forEach((n) => {
    if ((n.type === 'CPE' || n.type === 'IDU') && n._connectedBtsSerial) {
      const parent = btsBySerial[n._connectedBtsSerial];
      if (parent) n.parentDeviceId = parent.id;
    }
  });

  // Fallback: assign remaining CPE/IDU round-robin to available BTS
  const bts = nodes.filter((n) => n.type === 'BTS');
  nodes.filter((n) => (n.type === 'CPE' || n.type === 'IDU') && !n.parentDeviceId)
       .forEach((n, i) => {
         if (bts.length) n.parentDeviceId = bts[i % bts.length].id;
       });

  // Second-pass GPS fix: if a CPE/IDU coordinate is still invalid, place it near its parent
  nodes.forEach((n, i) => {
    if ((n.type === 'CPE' || n.type === 'IDU') && !isInsideIndia(n.latitude, n.longitude)) {
      const parent = n.parentDeviceId ? nodesById[n.parentDeviceId] : null;
      const fb = fallbackCoord(n, parent, i);
      n.latitude  = fb.lat;
      n.longitude = fb.lng;
    }
  });

  // BTS ↔ BTS inter-city backbone edges (deduplicated)
  const btsPairs = new Set();
  const backboneEdges = [];
  nodes.forEach((n) => {
    if (n.type !== 'BTS' || !n._cascadedBtsSerials?.length) return;
    n._cascadedBtsSerials.forEach((peerSerial) => {
      const peer = btsBySerial[peerSerial];
      if (!peer) return;
      const key = [n.id, peer.id].sort().join('||');
      if (btsPairs.has(key)) return;
      btsPairs.add(key);
      backboneEdges.push({
        id:             `e-backbone-${key}`,
        sourceDeviceId: n.id,
        targetDeviceId: peer.id,
        linkType:       'BACKBONE',
        linkQuality:    'GOOD',
        health:         (n.status === 'HEALTHY' && peer.status === 'HEALTHY') ? 'HEALTHY' : 'DEGRADED',
      });
    });
  });

  return [
    ...nodes.filter((n) => n.type === 'CPE' && n.parentDeviceId).map((c, i) => ({
      id: `e-cpe-${i}`,
      sourceDeviceId: c.parentDeviceId,
      targetDeviceId: c.id,
      linkType: 'WIRELESS',
      linkQuality: c.linkQuality,
      health: c.status,
    })),
    ...nodes.filter((n) => n.type === 'IDU' && n.parentDeviceId).map((d, i) => ({
      id: `e-idu-${i}`,
      sourceDeviceId: d.parentDeviceId,
      targetDeviceId: d.id,
      linkType: 'WIRED',
      linkQuality: d.linkQuality,
      health: d.status,
    })),
    ...backboneEdges,
  ];
}

// ── Indian city anchor points (spread across the subcontinent) ───────────────
const INDIA_ANCHORS = [
  // North
  { lat: 28.6139, lng: 77.2090, name: 'Delhi' },
  { lat: 28.5355, lng: 77.3910, name: 'Delhi South' },
  { lat: 30.7333, lng: 76.7794, name: 'Chandigarh' },
  { lat: 26.9124, lng: 75.7873, name: 'Jaipur' },
  { lat: 26.8467, lng: 80.9462, name: 'Lucknow' },
  { lat: 25.3176, lng: 82.9739, name: 'Varanasi' },
  { lat: 27.1767, lng: 78.0081, name: 'Agra' },
  // West
  { lat: 19.0760, lng: 72.8777, name: 'Mumbai' },
  { lat: 23.0225, lng: 72.5714, name: 'Ahmedabad' },
  { lat: 21.1458, lng: 79.0882, name: 'Nagpur' },
  { lat: 18.5204, lng: 73.8567, name: 'Pune' },
  { lat: 21.1702, lng: 72.8311, name: 'Surat' },
  // South
  { lat: 13.0827, lng: 80.2707, name: 'Chennai' },
  { lat: 12.9716, lng: 77.5946, name: 'Bengaluru' },
  { lat: 17.3850, lng: 78.4867, name: 'Hyderabad' },
  { lat: 10.8505, lng: 76.2711, name: 'Kochi' },
  { lat: 15.3173, lng: 75.7139, name: 'Hubli' },
  // East
  { lat: 22.5726, lng: 88.3639, name: 'Kolkata' },
  { lat: 20.2961, lng: 85.8245, name: 'Bhubaneswar' },
  { lat: 23.3441, lng: 85.3096, name: 'Ranchi' },
  { lat: 25.5941, lng: 85.1376, name: 'Patna' },
  // Northeast
  { lat: 26.1445, lng: 91.7362, name: 'Guwahati' },
  { lat: 24.8170, lng: 92.7737, name: 'Silchar' },
  // Central
  { lat: 23.2599, lng: 77.4126, name: 'Bhopal' },
  { lat: 22.7196, lng: 75.8577, name: 'Indore' },
];

function isInsideIndia(lat, lng) {
  return lat != null && lng != null && lat > 6 && lat < 38 && lng > 67 && lng < 98
      && !(lat === 0 && lng === 0);
}

/** Return a coordinate inside India for a device that lacks valid GPS data.
 *  BTS get a city anchor.  CPE/IDU get a small jitter around their parent anchor. */
function fallbackCoord(device, parentNode, idx) {
  if (parentNode && isInsideIndia(parentNode.latitude, parentNode.longitude)) {
    // Place CPE/IDU close to their parent BTS
    const jitter = () => (((idx * 7919 + 1) % 200) - 100) / 5000; // ±0.02° ≈ ±2 km
    return { lat: parentNode.latitude + jitter(), lng: parentNode.longitude + jitter() };
  }
  const anchor = INDIA_ANCHORS[idx % INDIA_ANCHORS.length];
  const spread = () => (((idx * 6271 + 3) % 120) - 60) / 1000; // ±0.06° ≈ ±6 km
  return { lat: anchor.lat + spread(), lng: anchor.lng + spread() };
}

// ── Haversine for GPS radius search ──────────────────────────────────────────
function haversine(la1, ln1, la2, ln2) {
  const R = 6371;
  const dL = ((la2 - la1) * Math.PI) / 180;
  const dN = ((ln2 - ln1) * Math.PI) / 180;
  const a  = Math.sin(dL / 2) ** 2
            + Math.cos(la1 * Math.PI / 180) * Math.cos(la2 * Math.PI / 180) * Math.sin(dN / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── Shared: load + build ──────────────────────────────────────────────────────
async function loadGraph(bustCache = false) {
  const raw   = await getInventoryDevices(bustCache);
  const nodes = raw.map(toNode);
  const edges = buildEdges(nodes);
  return { nodes, edges };
}

// ── GET /api/v1/topology ──────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    // _t param signals a manual refresh — bypass the 30s cache
    const bustCache = !!req.query._t;
    const { nodes, edges } = await loadGraph(bustCache);
    const { networkId } = req.query;
    let rN = nodes, rE = edges;
    if (networkId) {
      rN = nodes.filter((n) => n.networkId === networkId);
      const ids = new Set(rN.map((n) => n.id));
      rE = edges.filter((e) => ids.has(e.sourceDeviceId) && ids.has(e.targetDeviceId));
    }
    res.json({ nodes: rN, edges: rE, nodeCount: rN.length, edgeCount: rE.length, _source: 'inventory' });
  } catch (err) {
    console.warn('[topology.stub] /topology failed:', err.message);
    res.status(503).json({ code: 'UNAVAILABLE', message: 'Topology data temporarily unavailable' });
  }
});

// ── GET /api/v1/topology/search ───────────────────────────────────────────────
router.get('/search', async (req, res) => {
  try {
    const { nodes } = await loadGraph();
    const { search, lat, lng, radiusKm } = req.query;
    let results = nodes;
    if (search) {
      const q = String(search).toLowerCase();
      results = results.filter((d) =>
        d.serialNumber?.toLowerCase().includes(q) ||
        d.ipAddress?.toLowerCase().includes(q)    ||
        d.macAddress?.toLowerCase().includes(q)   ||
        d.deviceName?.toLowerCase().includes(q)
      );
    }
    if (lat != null && lng != null) {
      const r = Math.min(parseFloat(radiusKm) || 25, 500); // allow up to 500 km
      const latF = parseFloat(lat), lngF = parseFloat(lng);
      results = results.filter(
        (d) => d.latitude != null && haversine(latF, lngF, d.latitude, d.longitude) <= r,
      );
      console.log(`[topology.stub] GPS search (${latF},${lngF}) r=${r}km → ${results.length} hits`);
    }
    res.json(results);
  } catch (err) {
    console.warn('[topology.stub] /search failed:', err.message);
    res.status(503).json({ code: 'UNAVAILABLE', message: err.message });
  }
});

// ── GET /api/v1/topology/device/:id/connections ───────────────────────────────
router.get('/device/:deviceId/connections', async (req, res) => {
  const { deviceId } = req.params;
  try {
    const { nodes } = await loadGraph();
    const d = nodes.find((n) => n.id === deviceId || n.deviceId === deviceId || n.serialNumber === deviceId);
    if (!d) return res.status(404).json({ code: 'NOT_FOUND', message: 'Device not found' });

    let connected = [];
    if (d.type === 'BTS') {
      // Direct children: CPE and IDU with parentDeviceId === this BTS
      connected = nodes.filter((n) => n.parentDeviceId === d.id);
    } else {
      // Parent + siblings of the same parent
      if (d.parentDeviceId) {
        const parent = nodes.find((n) => n.id === d.parentDeviceId);
        if (parent) connected = [parent];
      }
    }
    res.json(connected);
  } catch (err) {
    res.status(503).json({ code: 'UNAVAILABLE', message: err.message });
  }
});

// ── GET /api/v1/topology/device/:id/summary ───────────────────────────────────
router.get('/device/:deviceId/summary', async (req, res) => {
  const { deviceId } = req.params;
  try {
    const { nodes } = await loadGraph();
    const d = nodes.find((n) => n.id === deviceId || n.deviceId === deviceId || n.serialNumber === deviceId);
    if (!d) return res.status(404).json({ code: 'NOT_FOUND', message: 'Device not found' });

    res.json({
      deviceId:       d.deviceId,
      serialNumber:   d.serialNumber,
      operatingChannel: d.operatingChannel,
      rssi:           d.rssi,
      a1Rssi:         d.a1Rssi,
      a2Rssi:         d.a2Rssi,
      snr:            d.snr,
      firmwareVersion:d.firmwareVersion,
      ethernetSpeed:  d.ethernetSpeed,
      duplex:         d.duplex,
      uptime:         d.uptime,
      connectedClients: d.type === 'BTS' ? 2 + (d.id.length % 28) : 1,
      cpuPercent:      10 + (d.id.length % 60),
      memPercent:      20 + (d.id.length % 50),
      gpsRelocation:   false,
      compassDrift:    d.id.length % 8,
    });
  } catch (err) {
    res.status(503).json({ code: 'UNAVAILABLE', message: err.message });
  }
});

// ── GET /api/v1/topology/device/:id/link-health ───────────────────────────────
router.get('/device/:deviceId/link-health', async (req, res) => {
  const { deviceId } = req.params;
  try {
    const { nodes } = await loadGraph();
    const d = nodes.find((n) => n.id === deviceId || n.deviceId === deviceId || n.serialNumber === deviceId);
    if (!d) return res.status(404).json({ code: 'NOT_FOUND', message: 'Device not found' });

    res.json({
      deviceId:       d.deviceId,
      linkQuality:    d.linkQuality,
      rssi:           d.rssi,
      snr:            d.snr,
      a1Rssi:         d.a1Rssi,
      a2Rssi:         d.a2Rssi,
      throughputMbps: 10 + (d.id.length % 490),
      packetLossPct:  (d.id.length % 50) / 10,
      latencyMs:      1 + (d.id.length % 29),
      lastUpdated:    new Date(Date.now() - d.id.length * 1000).toISOString(),
    });
  } catch (err) {
    res.status(503).json({ code: 'UNAVAILABLE', message: err.message });
  }
});

// ── GET /api/v1/topology/device/:id/events ────────────────────────────────────
router.get('/device/:deviceId/events', async (req, res) => {
  const { deviceId } = req.params;
  try {
    const { nodes } = await loadGraph();
    const d = nodes.find((n) => n.id === deviceId || n.deviceId === deviceId || n.serialNumber === deviceId);
    if (!d) return res.status(404).json({ code: 'NOT_FOUND', message: 'Device not found' });

    const EVENTS = [
      'LINK_UP', 'LINK_DOWN', 'RSSI_THRESHOLD', 'SNR_THRESHOLD', 'FIRMWARE_UPDATE',
      'REBOOT', 'CONFIG_PUSH', 'ALARM_RAISED', 'ALARM_CLEARED', 'GPS_DRIFT',
    ];
    const DESCS = {
      LINK_UP:         'Radio link established',
      LINK_DOWN:       'Radio link lost',
      RSSI_THRESHOLD:  `RSSI ${d.rssi ?? -70} dBm crossed threshold`,
      SNR_THRESHOLD:   `SNR ${d.snr ?? 20} dB below minimum`,
      FIRMWARE_UPDATE: `Firmware updated to ${d.firmwareVersion}`,
      REBOOT:          'Device rebooted',
      CONFIG_PUSH:     'Configuration pushed',
      ALARM_RAISED:    'Alarm raised: link quality degraded',
      ALARM_CLEARED:   'Alarm cleared: link quality restored',
      GPS_DRIFT:       'GPS position drift detected (>10 m)',
    };
    const SEVS = ['INFO', 'INFO', 'INFO', 'WARNING', 'MINOR', 'MAJOR', 'CRITICAL'];
    const { from, to } = req.query;
    const now    = Date.now();
    const startMs = from ? new Date(from).getTime() : now - 7 * 86_400_000;
    const endMs   = to   ? new Date(to).getTime()   : now;
    const seed    = d.id.length;
    const count   = 8 + (seed % 12);

    const events = Array.from({ length: count }, (_, i) => {
      const et = EVENTS[(seed + i * 3) % EVENTS.length];
      return {
        id:           `evt-${deviceId}-${i}`,
        deviceId:     d.deviceId,
        timestamp:    new Date(startMs + ((seed + i * 7) % 1000) * ((endMs - startMs) / 1000)).toISOString(),
        eventType:    et,
        severity:     SEVS[(seed + i * 2) % SEVS.length],
        description:  DESCS[et] || et,
        acknowledged: i > 2,
      };
    }).sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    res.json(events);
  } catch (err) {
    res.status(503).json({ code: 'UNAVAILABLE', message: err.message });
  }
});

module.exports = router;
