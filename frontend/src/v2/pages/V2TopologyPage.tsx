import { useCallback, useEffect, useRef, useState } from 'react';
import * as d3 from 'd3';
import { useNavigate } from 'react-router-dom';
import L from 'leaflet';
import {
  MapContainer, TileLayer, Marker, Tooltip as LeafletTooltip, Circle, Polyline,
} from 'react-leaflet';
import { useMap } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import {
  fetchTopology,
  fetchDeviceConnections,
  fetchDeviceLinkHealth,
  fetchDeviceEvents,
  searchTopology,
} from '../../api/topology.api';
import type {
  TopologyGraph, TopologyNode, TopologyEdge, NodeHealth,
  LinkHealth, DeviceEvent,
} from '../../api/topology.types';
import { Badge } from '../components/common/Badge';
import { Button } from '../components/common/Button';
import { Select } from '../components/common/Select';
import { LoadingState, EmptyState } from '../components/common/States';
import { useToast } from '../components/common/Toast';
import { logger } from '../utils/logger';

// ── India city fallbacks ──────────────────────────────────────────────────────
const INDIA_CITIES: [number, number][] = [
  [28.6139, 77.2090], [19.0760, 72.8777], [13.0827, 80.2707],
  [12.9716, 77.5946], [17.3850, 78.4867], [22.5726, 88.3639],
  [23.0225, 72.5714], [18.5204, 73.8567], [26.9124, 75.7873],
  [30.7333, 76.7794],
];
function fallbackLatLng(idx: number): [number, number] {
  const base = INDIA_CITIES[idx % INDIA_CITIES.length];
  return [base[0] + (idx % 3) * 0.06, base[1] + (idx % 5) * 0.06];
}

// ── Colour maps ───────────────────────────────────────────────────────────────
const HEALTH_COLOR: Record<NodeHealth, string> = {
  HEALTHY: '#22c55e', DEGRADED: '#f59e0b', FAULTY: '#ef4444', UNKNOWN: '#6b7280',
};
const LQ_COLOR: Record<string, string> = {
  GOOD: '#22c55e', FAIR: '#f59e0b', POOR: '#ef4444', DOWN: '#dc2626',
};
const SEV_COLOR: Record<string, string> = {
  CRITICAL: '#ef4444', MAJOR: '#f97316', MINOR: '#f59e0b', WARNING: '#3b82f6', INFO: '#6b7280',
};

type View = 'map' | 'graph' | 'list';
type HealthFilter = '' | NodeHealth;
type TypeMode = 'ALL' | 'BTS' | 'CPE' | 'IDU';

const TYPE_MODE_BG: Record<TypeMode, string> = {
  ALL: 'linear-gradient(135deg, #1e3a5f 0%, #1967D2 100%)',
  BTS: 'linear-gradient(135deg, #14532d 0%, #0f9d58 100%)',
  CPE: 'linear-gradient(135deg, #78350f 0%, #f4b400 100%)',
  IDU: 'linear-gradient(135deg, #3b0764 0%, #a142f4 100%)',
};
type PanelTab = 'info' | 'connected' | 'history';
type EventRange = '24h' | '3d' | '7d';
const EVENT_RANGE_MS: Record<EventRange, number> = {
  '24h': 86_400_000, '3d': 3 * 86_400_000, '7d': 7 * 86_400_000,
};
const healthVariant: Record<NodeHealth, 'success' | 'warning' | 'danger' | 'unknown'> = {
  HEALTHY: 'success', DEGRADED: 'warning', FAULTY: 'danger', UNKNOWN: 'unknown',
};

// ── Clean solid-dot map markers (no glow) ─────────────────────────────────────
const DOT_COL: Record<string, string> = { BTS: '#3b82f6', CPE: '#22c55e', IDU: '#f59e0b' };
const DOT_R:   Record<string, number> = { BTS: 8,         CPE: 6,         IDU: 5         };

function makeDeviceIcon(node: TopologyNode, highlighted = false): L.DivIcon {
  const type = node.deviceType;
  const base = DOT_COL[type] ?? '#94a3b8';
  const col  = node.health === 'FAULTY'   ? '#ef4444'
             : node.health === 'DEGRADED' ? '#f97316'
             : base;

  const r   = DOT_R[type] ?? 6;
  const dia = r * 2;
  const label = node.deviceName ?? node.serialNumber?.slice(-6) ?? type;

  const html = `
    <div style="display:flex;flex-direction:column;align-items:center;pointer-events:none;gap:3px">
      <div style="
        width:${dia}px;height:${dia}px;border-radius:50%;
        background:${col};
        border:${highlighted ? `3px solid #fff` : `2px solid rgba(255,255,255,0.4)`};
        box-shadow:0 1px 3px rgba(0,0,0,0.5);
        flex-shrink:0;
      "></div>
      <div style="
        background:rgba(15,20,35,0.82);
        color:#f1f5f9;
        padding:1px 5px;
        border-radius:4px;
        font-size:10px;
        font-weight:600;
        white-space:nowrap;
        font-family:ui-monospace,monospace;
        line-height:1.5;
        border-left:2px solid ${col};
      ">${label}</div>
    </div>`;

  const W = 88;
  return L.divIcon({
    html,
    className: '',
    iconSize:   [W, dia + 20],
    iconAnchor: [W / 2, r + 1],
    tooltipAnchor: [0, -(r + 4)],
  });
}

// ── Fly-to when GPS search center changes ─────────────────────────────────────
function MapFlyTo({ center, zoom }: { center: [number, number]; zoom: number }) {
  const map = useMap();
  const prev = useRef<[number, number] | null>(null);
  useEffect(() => {
    if (center[0] !== prev.current?.[0] || center[1] !== prev.current?.[1]) {
      map.flyTo(center, zoom, { duration: 1.2 });
      prev.current = center;
    }
  }, [center, zoom, map]);
  return null;
}

// ── Viewport-height hook ──────────────────────────────────────────────────────
function useMapHeight() {
  const [h, setH] = useState(() => Math.max(520, window.innerHeight - 390));
  useEffect(() => {
    const up = () => setH(Math.max(520, window.innerHeight - 390));
    window.addEventListener('resize', up);
    return () => window.removeEventListener('resize', up);
  }, []);
  return h;
}

// ── Hover tooltip with ALL required NMS-TP-06 fields ─────────────────────────
function DeviceTooltip({ node, hideClickHint }: { node: TopologyNode; hideClickHint?: boolean }) {
  const hc = HEALTH_COLOR[node.health];
  const statusLabel = node.health === 'HEALTHY' ? 'Online'
                    : node.health === 'DEGRADED' ? 'Degraded'
                    : node.health === 'FAULTY'   ? 'Offline'
                    : 'Unknown';

  const row = (label: string, val: string | number | null | undefined) =>
    val != null && val !== '' ? (
      <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '0 16px', padding: '5px 0', borderBottom: '1px solid #e2e8f0' }}>
        <span style={{ color: '#374151', fontSize: 12, fontWeight: 500 }}>{label}</span>
        <span style={{ fontWeight: 700, color: '#111827', fontSize: 12, textAlign: 'right', fontFamily: 'ui-monospace,monospace' }}>{val}</span>
      </div>
    ) : null;

  return (
    <div style={{
      fontFamily: 'system-ui,sans-serif',
      minWidth: 260,
      maxWidth: 320,
      maxHeight: 'min(420px, 65vh)',
      overflowY: 'auto',
      background: '#ffffff',
      color: '#111827',
    }}>
      {/* Status header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, paddingBottom: 8, borderBottom: '2px solid #e2e8f0' }}>
        <span style={{ width: 11, height: 11, borderRadius: '50%', background: hc, flexShrink: 0 }} />
        <span style={{ color: hc, fontWeight: 800, fontSize: 14 }}>{statusLabel}</span>
      </div>

      {/* All device fields */}
      {row('Device Name',         node.deviceName)}
      {row('Serial Number',       node.serialNumber)}
      {row('IP Address',          node.ipAddress)}
      {row('Operating Channel',   node.operatingChannel)}
      {row('RSSI',                node.rssi   != null ? `${node.rssi} dBm`   : null)}
      {row('A1 RSSI',             node.a1Rssi != null ? `${node.a1Rssi} dBm` : null)}
      {row('A2 RSSI',             node.a2Rssi != null ? `${node.a2Rssi} dBm` : null)}
      {row('SNR',                 node.snr    != null ? `${node.snr} dB`     : null)}
      {row('Firmware Version',    node.firmwareVersion)}
      {row('Client Speed/Duplex', node.ethernetSpeed && node.duplex
            ? `${node.ethernetSpeed} / ${node.duplex}` : null)}
      {row('Uptime',              node.uptime)}

      {!hideClickHint && (
        <div style={{ marginTop: 8, paddingTop: 6, borderTop: '1px solid #e2e8f0', fontSize: 11, color: '#2563eb', textAlign: 'center', fontWeight: 600 }}>
          Click to open detail panel →
        </div>
      )}
    </div>
  );
}

// ── Side detail panel ─────────────────────────────────────────────────────────
function DevicePanel({ node, onClose, onNavigate, height }: {
  node: TopologyNode;
  onClose: () => void;
  onNavigate: (id: string) => void;
  height: number;
}) {
  const [tab, setTab]             = useState<PanelTab>('info');
  const [linkHealth, setLinkHealth] = useState<LinkHealth | null>(null);
  const [events, setEvents]       = useState<DeviceEvent[]>([]);
  const [connected, setConnected] = useState<TopologyNode[]>([]);
  const [evtRange, setEvtRange]   = useState<EventRange>('24h');
  const [loadConn, setLoadConn]   = useState(false);
  const [loadHist, setLoadHist]   = useState(false);
  const deviceId = node.deviceId || node.id;

  useEffect(() => {
    if (tab !== 'connected') return;
    setLoadConn(true);
    fetchDeviceConnections(deviceId)
      .then(setConnected).catch(() => setConnected([]))
      .finally(() => setLoadConn(false));
  }, [tab, deviceId]);

  useEffect(() => {
    if (tab !== 'history') return;
    setLoadHist(true);
    const from = new Date(Date.now() - EVENT_RANGE_MS[evtRange]).toISOString();
    Promise.all([fetchDeviceLinkHealth(deviceId), fetchDeviceEvents(deviceId, from)])
      .then(([lh, evts]) => { setLinkHealth(lh); setEvents(evts); })
      .catch(() => {}).finally(() => setLoadHist(false));
  }, [tab, deviceId, evtRange]);

  const hColor   = HEALTH_COLOR[node.health];
  const typeColor = node.deviceType === 'BTS' ? '#3b82f6' : node.deviceType === 'CPE' ? '#22c55e' : '#f59e0b';

  const row = (label: string, value: React.ReactNode) => (
    <div key={label} style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0', borderBottom: '1px solid var(--vf-border-subtle)', fontSize: 12 }}>
      <span style={{ color: 'var(--vf-text-muted)' }}>{label}</span>
      <span style={{ color: 'var(--vf-text-primary)', fontFamily: 'var(--vf-font-mono)', textAlign: 'right' }}>{value ?? '—'}</span>
    </div>
  );

  const tabStyle = (t: PanelTab): React.CSSProperties => ({
    flex: 1, padding: '10px 0', fontSize: 12,
    fontWeight: tab === t ? 700 : 500,
    color: tab === t ? 'var(--vf-accent)' : 'var(--vf-text-muted)',
    background: 'none', border: 'none',
    borderBottom: tab === t ? '2px solid var(--vf-accent)' : '2px solid transparent',
    cursor: 'pointer',
  });

  return (
    <div style={{ width: 370, height, borderLeft: '1px solid var(--vf-border-subtle)', background: 'var(--vf-surface)', display: 'flex', flexDirection: 'column', overflow: 'hidden', flexShrink: 0 }}>
      {/* Header */}
      <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--vf-border-subtle)', background: 'var(--vf-surface-raised)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ background: typeColor, color: '#fff', borderRadius: 4, padding: '2px 8px', fontSize: 11, fontWeight: 700 }}>{node.deviceType}</span>
            <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--vf-text-primary)', fontFamily: 'var(--vf-font-mono)' }}>
              {node.deviceName ?? node.serialNumber}
            </span>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--vf-text-muted)', fontSize: 20 }}>×</button>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: hColor }} />
          <Badge variant={healthVariant[node.health]}>{node.health}</Badge>
          <span style={{ color: 'var(--vf-text-muted)', fontSize: 11 }}>{node.ipAddress}</span>
        </div>
        <Button variant="primary" size="sm" style={{ width: '100%' }} onClick={() => onNavigate(deviceId)}>
          View Device Details →
        </Button>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', borderBottom: '1px solid var(--vf-border-subtle)' }}>
        {(['info', 'connected', 'history'] as PanelTab[]).map((t) => (
          <button key={t} style={tabStyle(t)} onClick={() => setTab(t)}>
            {t === 'info' ? '📋 Overview' : t === 'connected' ? `🔗 Connected` : '📊 History'}
          </button>
        ))}
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '12px 14px' }}>

        {/* Overview (all NMS-TP-06 fields) */}
        {tab === 'info' && (
          <>
            <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'var(--vf-text-muted)', marginBottom: 6 }}>RF</div>
            {row('Operating Channel', node.operatingChannel)}
            {row('RSSI',    node.rssi   != null ? `${node.rssi} dBm`   : null)}
            {row('A1 RSSI', node.a1Rssi != null ? `${node.a1Rssi} dBm` : null)}
            {row('A2 RSSI', node.a2Rssi != null ? `${node.a2Rssi} dBm` : null)}
            {row('SNR',     node.snr    != null ? `${node.snr} dB`     : null)}
            <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'var(--vf-text-muted)', marginTop: 12, marginBottom: 6 }}>Ethernet</div>
            {row('Client Speed/Duplex', node.ethernetSpeed && node.duplex ? `${node.ethernetSpeed} / ${node.duplex}` : null)}
            <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'var(--vf-text-muted)', marginTop: 12, marginBottom: 6 }}>System</div>
            {row('Device Name',     node.deviceName)}
            {row('Serial Number',   node.serialNumber)}
            {row('IP Address',      node.ipAddress)}
            {row('MAC Address',     node.macAddress)}
            {row('Firmware',        node.firmwareVersion)}
            {row('Uptime',          node.uptime)}
            {row('Cascade Hop',     node.cascadeHop)}
            {row('GPS', node.location ? `${node.location.lat.toFixed(4)}, ${node.location.lng.toFixed(4)}` : 'No GPS')}
          </>
        )}

        {/* Connected devices (NMS-TP-05) */}
        {tab === 'connected' && (
          <>
            <div style={{ fontSize: 11, color: 'var(--vf-text-muted)', marginBottom: 10 }}>
              {node.deviceType === 'BTS' ? 'CPEs connected to this BTS'
                : node.deviceType === 'CPE' ? 'Parent BTS and linked IDUs'
                : 'Parent CPE for this IDU'}
            </div>
            {loadConn ? <LoadingState label="Loading…" size="sm" /> : connected.length === 0 ? (
              <EmptyState title="No connected devices" description="No neighbours found." />
            ) : connected.map((c) => {
              const tc = c.deviceType === 'BTS' ? '#3b82f6' : c.deviceType === 'CPE' ? '#22c55e' : '#f59e0b';
              const hc = HEALTH_COLOR[c.health];
              return (
                <div key={c.id}
                  onClick={() => onNavigate(c.serialNumber || c.deviceId || c.id)}
                  style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', marginBottom: 6, background: 'var(--vf-surface-raised)', borderRadius: 8, cursor: 'pointer', border: '1px solid var(--vf-border-subtle)' }}
                >
                  <span style={{ width: 30, height: 30, borderRadius: 6, background: tc, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 700, color: '#fff', flexShrink: 0 }}>{c.deviceType}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontFamily: 'var(--vf-font-mono)', fontSize: 11, color: 'var(--vf-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.deviceName ?? c.serialNumber}</div>
                    <div style={{ fontSize: 11, color: 'var(--vf-text-muted)' }}>{c.ipAddress}</div>
                  </div>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: hc, flexShrink: 0 }} />
                </div>
              );
            })}
          </>
        )}

        {/* Link health + Event history (NMS-TP-08) */}
        {tab === 'history' && (
          <>
            {loadHist ? <LoadingState label="Loading…" size="sm" /> : (
              <>
                {linkHealth && (
                  <div style={{ background: 'var(--vf-surface-raised)', borderRadius: 8, padding: '10px 12px', marginBottom: 14, border: `1px solid ${LQ_COLOR[linkHealth.linkQuality]}44` }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                      <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', color: 'var(--vf-text-muted)' }}>Link Health</span>
                      <span style={{ background: LQ_COLOR[linkHealth.linkQuality], color: '#fff', borderRadius: 4, padding: '2px 8px', fontSize: 11, fontWeight: 700 }}>{linkHealth.linkQuality}</span>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 12px', fontSize: 12 }}>
                      {([
                        ['RSSI',       linkHealth.rssi != null         ? `${linkHealth.rssi} dBm` : '—'],
                        ['SNR',        linkHealth.snr != null          ? `${linkHealth.snr} dB` : '—'],
                        ['A1 RSSI',    linkHealth.a1Rssi != null       ? `${linkHealth.a1Rssi} dBm` : '—'],
                        ['A2 RSSI',    linkHealth.a2Rssi != null       ? `${linkHealth.a2Rssi} dBm` : '—'],
                        ['Throughput', linkHealth.throughputMbps != null ? `${linkHealth.throughputMbps} Mbps` : '—'],
                        ['Pkt Loss',   linkHealth.packetLossPct != null ? `${linkHealth.packetLossPct.toFixed(1)}%` : '—'],
                        ['Latency',    linkHealth.latencyMs != null    ? `${linkHealth.latencyMs} ms` : '—'],
                      ] as [string, string][]).map(([l, v]) => (
                        <div key={l}>
                          <div style={{ color: 'var(--vf-text-muted)', fontSize: 10 }}>{l}</div>
                          <div style={{ color: 'var(--vf-text-primary)', fontFamily: 'var(--vf-font-mono)' }}>{v}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                  <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', color: 'var(--vf-text-muted)' }}>Event History</span>
                  <div style={{ display: 'flex', gap: 3 }}>
                    {(['24h', '3d', '7d'] as EventRange[]).map((r) => (
                      <button key={r} onClick={() => setEvtRange(r)} style={{ padding: '2px 7px', fontSize: 10, borderRadius: 4, cursor: 'pointer', background: evtRange === r ? 'var(--vf-accent)' : 'var(--vf-surface-raised)', color: evtRange === r ? '#fff' : 'var(--vf-text-muted)', border: '1px solid var(--vf-border-subtle)' }}>{r}</button>
                    ))}
                  </div>
                </div>

                {events.length === 0 ? <EmptyState title="No events" description="None in selected range." /> : events.map((ev) => (
                  <div key={ev.id} style={{ display: 'flex', gap: 8, marginBottom: 7, padding: '6px 9px', background: 'var(--vf-surface-raised)', borderRadius: 6, borderLeft: `3px solid ${SEV_COLOR[ev.severity] ?? '#6b7280'}` }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--vf-text-primary)' }}>{ev.description}</div>
                      <div style={{ display: 'flex', gap: 8, marginTop: 2 }}>
                        <span style={{ fontSize: 10, color: SEV_COLOR[ev.severity] }}>{ev.severity}</span>
                        <span style={{ fontSize: 10, color: 'var(--vf-text-dim)' }}>{ev.eventType}</span>
                        {ev.acknowledged && <span style={{ fontSize: 10, color: '#22c55e' }}>✓ ack</span>}
                      </div>
                    </div>
                    <div style={{ fontSize: 10, color: 'var(--vf-text-dim)', flexShrink: 0, textAlign: 'right' }}>
                      {new Date(ev.timestamp).toLocaleString('en-IN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                    </div>
                  </div>
                ))}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ── GPS search bar with slider (NMS-TP-02) ────────────────────────────────────
interface GpsResult { lat: number; lng: number; radiusKm: number; nodes: TopologyNode[] }

// ── City quick-picks so users can search real inventory locations instantly ──
const CITY_PRESETS = [
  { label: 'Delhi',     lat: 28.6139, lng: 77.2090 },
  { label: 'Mumbai',    lat: 19.0760, lng: 72.8777 },
  { label: 'Chennai',   lat: 13.0827, lng: 80.2707 },
  { label: 'Bengaluru', lat: 12.9716, lng: 77.5946 },
  { label: 'Hyderabad', lat: 17.3850, lng: 78.4867 },
  { label: 'Kolkata',   lat: 22.5726, lng: 88.3639 },
  { label: 'Ahmedabad', lat: 23.0225, lng: 72.5714 },
  { label: 'Pune',      lat: 18.5204, lng: 73.8567 },
  { label: 'Jaipur',    lat: 26.9124, lng: 75.7873 },
  { label: 'Lucknow',   lat: 26.8467, lng: 80.9462 },
  { label: 'Chandigarh',lat: 30.7333, lng: 76.7794 },
  { label: 'Guwahati',  lat: 26.1445, lng: 91.7362 },
];

function GpsSearchBar({ onResult, onClear, active, resultCount }: {
  onResult: (r: GpsResult) => void;
  onClear: () => void;
  active: boolean;
  resultCount?: number;
}) {
  const [lat, setLat]       = useState('');
  const [lng, setLng]       = useState('');
  const [radius, setRadius] = useState(25);
  const [loading, setLoading] = useState(false);
  const { addToast } = useToast();

  const inp: React.CSSProperties = {
    padding: '5px 9px', fontSize: 12, width: 100,
    background: 'var(--vf-input-bg)', border: '1px solid var(--vf-border-default)',
    borderRadius: 6, color: 'var(--vf-text-primary)', outline: 'none',
  };

  const applyPreset = (p: typeof CITY_PRESETS[0]) => {
    setLat(String(p.lat));
    setLng(String(p.lng));
  };

  const run = async () => {
    const latN = parseFloat(lat), lngN = parseFloat(lng);
    if (isNaN(latN) || isNaN(lngN)) {
      addToast('Enter valid Latitude and Longitude, or pick a city shortcut', 'warning');
      return;
    }
    if (latN < 6 || latN > 38 || lngN < 67 || lngN > 98) {
      addToast('Coordinates must be within India (lat 6–38, lng 67–98)', 'warning');
      return;
    }
    setLoading(true);
    try {
      const nodes = await searchTopology({ lat: latN, lng: lngN, radiusKm: radius });
      onResult({ lat: latN, lng: lngN, radiusKm: radius, nodes });
      if (nodes.length === 0) addToast(`No devices within ${radius} km of (${latN.toFixed(4)}, ${lngN.toFixed(4)})`, 'info');
      else addToast(`Found ${nodes.length} device${nodes.length !== 1 ? 's' : ''} within ${radius} km`, 'success');
    } catch { addToast('GPS search failed — check network', 'error'); }
    finally { setLoading(false); }
  };

  return (
    <div style={{
      background: active ? 'rgba(59,130,246,0.06)' : 'var(--vf-surface-raised)',
      border: `1px solid ${active ? 'rgba(59,130,246,0.4)' : 'var(--vf-border-subtle)'}`,
      borderRadius: 10, padding: '10px 14px',
    }}>
      {/* Row 1: label + city shortcuts */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--vf-text-muted)', whiteSpace: 'nowrap' }}>📍 GPS Radius Search</span>
        <span style={{ fontSize: 11, color: 'var(--vf-text-muted)' }}>— Quick pick:</span>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {CITY_PRESETS.map((p) => (
            <button key={p.label} onClick={() => applyPreset(p)}
              style={{
                padding: '2px 8px', fontSize: 11, borderRadius: 20, cursor: 'pointer',
                background: lat === String(p.lat) ? 'var(--vf-accent)' : 'var(--vf-surface)',
                color: lat === String(p.lat) ? '#fff' : 'var(--vf-text-secondary)',
                border: `1px solid ${lat === String(p.lat) ? 'var(--vf-accent)' : 'var(--vf-border-subtle)'}`,
                fontWeight: lat === String(p.lat) ? 700 : 400,
                transition: 'all 0.15s',
              }}>
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {/* Row 2: coordinate inputs + radius + search */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <input placeholder="Latitude  (e.g. 28.6139)" value={lat} onChange={(e) => setLat(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && run()} style={{ ...inp, width: 165 }} />
        <input placeholder="Longitude (e.g. 77.2090)" value={lng} onChange={(e) => setLng(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && run()} style={{ ...inp, width: 175 }} />

        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--vf-text-secondary)', whiteSpace: 'nowrap' }}>
          Radius:
          <input type="range" min={1} max={200} step={1} value={radius}
            onChange={(e) => setRadius(parseFloat(e.target.value))}
            style={{ width: 120, accentColor: 'var(--vf-accent)' }} />
          <span style={{ fontFamily: 'var(--vf-font-mono)', fontWeight: 700, color: 'var(--vf-accent)', minWidth: 46 }}>
            {radius} km
          </span>
        </label>

        <Button variant="primary" size="sm" onClick={run} disabled={loading || !lat || !lng}>
          {loading ? '…' : 'Search'}
        </Button>

        {active && (
          <>
            <Button variant="ghost" size="sm" onClick={() => { onClear(); setLat(''); setLng(''); }}>Clear</Button>
            <span style={{ fontSize: 12, fontWeight: 600, color: '#22c55e', whiteSpace: 'nowrap' }}>
              ✓ {resultCount ?? 0} device{resultCount !== 1 ? 's' : ''} in radius
            </span>
          </>
        )}
      </div>
    </div>
  );
}

// ── Map view ──────────────────────────────────────────────────────────────────
function IndiaMapView({ nodes, edges, onNodeClick, gpsResult, mapHeight }: {
  nodes: TopologyNode[];
  edges: TopologyEdge[];
  onNodeClick: (n: TopologyNode) => void;
  gpsResult?: GpsResult;
  mapHeight: number;
}) {
  const [tileError, setTileError] = useState(false);
  const matchIds = gpsResult ? new Set(gpsResult.nodes.map((n) => n.id)) : null;

  const enriched = nodes.map((n, i) => ({
    node: n,
    lat: n.location?.lat ?? fallbackLatLng(i)[0],
    lng: n.location?.lng ?? fallbackLatLng(i)[1],
    hasGps: !!n.location,
    match: matchIds ? matchIds.has(n.id) : undefined,
    icon: makeDeviceIcon(n, matchIds ? matchIds.has(n.id) : false),
  }));

  return (
    <div style={{ position: 'relative', height: mapHeight }}>
      {tileError && (
        <div style={{ position: 'absolute', top: 8, left: '50%', transform: 'translateX(-50%)', zIndex: 1100, background: 'rgba(245,158,11,0.95)', color: '#000', padding: '5px 14px', borderRadius: 8, fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap' }}>
          ⚠ Map tiles unavailable — markers still visible
        </div>
      )}
      <MapContainer
        center={[22.5937, 78.9629]}
        zoom={5}
        scrollWheelZoom
        style={{ width: '100%', height: '100%' }}
      >
        <TileLayer
          url="https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png"
          attribution='&copy; OSM &copy; CARTO'
          subdomains="abcd"
          maxZoom={19}
          eventHandlers={{ tileerror: () => setTileError(true) }}
        />

        {/* GPS radius circle (NMS-TP-02) */}
        {gpsResult && (
          <>
            <MapFlyTo center={[gpsResult.lat, gpsResult.lng]} zoom={12} />
            <Circle
              center={[gpsResult.lat, gpsResult.lng]}
              radius={gpsResult.radiusKm * 1000}
              pathOptions={{ color: '#3b82f6', fillColor: '#3b82f6', fillOpacity: 0.07, weight: 2, dashArray: '6 4' }}
            />
          </>
        )}

        {/* BTS→CPE and CPE→IDU connection lines (NMS-TP-05) */}
        {edges.filter((e) => e.linkType !== 'BACKBONE').map((e) => {
          const src = enriched.find((x) => x.node.id === e.sourceDeviceId || x.node.deviceId === e.sourceDeviceId);
          const tgt = enriched.find((x) => x.node.id === e.targetDeviceId || x.node.deviceId === e.targetDeviceId);
          if (!src || !tgt) return null;

          const isWired = e.linkType === 'WIRED'; // IDU→CPE (Ethernet + PoE)

          const color = isWired
            ? '#94a3b8'               // steel-gray for wired Ethernet regardless of quality
            : e.linkQuality === 'GOOD'  ? '#22c55e'
            : e.linkQuality === 'FAIR'  ? '#f59e0b'
            : e.linkQuality === 'POOR'  ? '#ef4444'
            : e.linkQuality === 'DOWN'  ? '#6b7280'
            : '#334155';

          // WIRELESS (CPE→BTS): dashed to represent radio link; WIRED (IDU→CPE): solid
          const dash = isWired
            ? undefined
            : e.linkQuality === 'FAIR'  ? '8 5'
            : e.linkQuality === 'POOR'  ? '4 4'
            : e.linkQuality === 'DOWN'  ? '2 5'
            : '10 4';  // GOOD wireless = long dashes

          return (
            <Polyline
              key={e.id}
              positions={[[src.lat, src.lng], [tgt.lat, tgt.lng]]}
              pathOptions={{ color, weight: isWired ? 1 : 2, opacity: isWired ? 0.5 : 0.7, dashArray: dash }}
            />
          );
        })}

        {/* Device markers — glowing dots matching graph view */}
        {enriched.map(({ node, lat, lng, icon }) => (
          <Marker
            key={node.id}
            position={[lat, lng]}
            icon={icon}
            zIndexOffset={node.deviceType === 'BTS' ? 100 : node.deviceType === 'CPE' ? 50 : 0}
            eventHandlers={{ click: () => onNodeClick(node) }}
          >
            <LeafletTooltip direction="auto" offset={[0, -10]} sticky={false}>
              <DeviceTooltip node={node} />
            </LeafletTooltip>
          </Marker>
        ))}
      </MapContainer>

      {/* Legend */}
      <div style={{
        position: 'absolute', bottom: 20, left: 10, zIndex: 1000,
        background: 'rgba(6,14,27,0.9)', border: '1px solid rgba(77,158,255,0.2)',
        borderRadius: 8, padding: '10px 13px', backdropFilter: 'blur(6px)', pointerEvents: 'none',
      }}>
        <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em', color: '#64748b', marginBottom: 6 }}>Connection</div>
        {[['Good', '#22c55e', '——'], ['Fair', '#f59e0b', '- -'], ['Down', '#ef4444', '···']].map(([l, c, s]) => (
          <div key={l} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, marginBottom: 3 }}>
            <span style={{ color: c, fontFamily: 'monospace', fontWeight: 700, fontSize: 12 }}>{s}</span>
            <span style={{ color: '#cbd5e1' }}>{l}</span>
          </div>
        ))}
        <div style={{ borderTop: '1px solid rgba(77,158,255,0.15)', marginTop: 6, paddingTop: 6, fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em', color: '#64748b', marginBottom: 5 }}>Health</div>
        {Object.entries(HEALTH_COLOR).map(([h, c]) => (
          <div key={h} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, marginBottom: 2 }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', border: `2px solid ${c}`, display: 'inline-block' }} />
            <span style={{ color: '#cbd5e1' }}>{h}</span>
          </div>
        ))}
      </div>

      {/* Node counts */}
      <div style={{ position: 'absolute', top: 8, right: 8, zIndex: 1000, background: 'rgba(6,14,27,0.88)', border: '1px solid rgba(77,158,255,0.15)', borderRadius: 6, padding: '5px 11px', fontSize: 11, color: '#94a3b8', backdropFilter: 'blur(4px)', pointerEvents: 'none', lineHeight: 1.8 }}>
        <div>{nodes.length} nodes · {edges.length} links</div>
        <div style={{ display: 'flex', gap: 10 }}>
          <span style={{ color: '#3b82f6' }}>▲ {nodes.filter((n) => n.deviceType === 'BTS').length} BTS</span>
          <span style={{ color: '#22c55e' }}>⬡ {nodes.filter((n) => n.deviceType === 'CPE').length} CPE</span>
          <span style={{ color: '#f59e0b' }}>■ {nodes.filter((n) => n.deviceType === 'IDU').length} IDU</span>
        </div>
        {gpsResult && <div style={{ color: '#facc15', marginTop: 2 }}>📍 {gpsResult.nodes.length} in radius</div>}
      </div>
    </div>
  );
}

// ── Hierarchical graph view (NMS-TP-03, NMS-TP-08, NMS-TP-09) ─────────────────
// ── Cosmograph-style force-directed canvas graph ──────────────────────────────
function TopologyGraphView({ nodes, edges, onNodeClick, mapHeight }: {
  nodes: TopologyNode[];
  edges: TopologyEdge[];
  onNodeClick: (n: TopologyNode) => void;
  mapHeight: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // All mutable render state lives here — no React re-renders for canvas updates
  const stateRef = useRef({
    hoveredId: null as string | null,
    selectedId: null as string | null,
    transform: { k: 1, x: 0, y: 0 },
    simNodes: [] as any[],
    simEdges: [] as any[],
    draw: () => {},
  });
  // Trigger React re-render only for tooltip card
  const [tooltipNode, setTooltipNode] = useState<TopologyNode | null>(null);

  const NODE_R: Record<string, number> = { BTS: 13, CPE: 6, IDU: 4 };
  const NODE_COL: Record<string, string> = { BTS: '#3b82f6', CPE: '#22c55e', IDU: '#f59e0b' };
  const getR   = (t: string) => NODE_R[t]   ?? 6;
  const getCol = (t: string) => NODE_COL[t] ?? '#64748b';

  // WIRED (IDU→CPE, Ethernet+PoE): muted steel; WIRELESS (CPE→BTS): quality-coded green/amber/red
  const edgeBaseCol = (lq?: string, lt?: string) =>
    lt === 'WIRED' ? 'rgba(148,163,184,0.25)'  // steel-gray, dimmer for wired
    : lq === 'GOOD'  ? 'rgba(34,197,94,0.3)'
    : lq === 'FAIR'  ? 'rgba(245,158,11,0.3)'
    : lq === 'POOR'  ? 'rgba(239,68,68,0.3)'
    : 'rgba(100,116,139,0.18)';

  const edgeHLCol = (lq?: string, lt?: string) =>
    lt === 'WIRED' ? '#94a3b8'   // steel-gray highlight for wired
    : lq === 'GOOD'  ? '#22c55e'
    : lq === 'FAIR'  ? '#f59e0b'
    : lq === 'POOR'  ? '#ef4444'
    : '#64748b';

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || nodes.length === 0) return;

    const W = canvas.offsetWidth  || 1200;
    const H = canvas.offsetHeight || mapHeight;
    canvas.width  = W * window.devicePixelRatio;
    canvas.height = H * window.devicePixelRatio;
    canvas.style.width  = `${W}px`;
    canvas.style.height = `${H}px`;

    const state = stateRef.current;
    state.transform = { k: 1, x: 0, y: 0 };

    // ── Build simulation data ────────────────────────────────────────────────
    const simNodes: any[] = nodes.map((n) => ({
      id: n.id, type: n.deviceType,
      name: n.deviceName ?? n.serialNumber?.slice(-6) ?? n.id,
      health: n.health, lq: (n as any).linkQuality ?? 'GOOD', _node: n,
      x: W / 2 + (Math.random() - 0.5) * 400,
      y: H / 2 + (Math.random() - 0.5) * 300,
    }));
    const nodeMap = new Map<string, any>(simNodes.map((n) => [n.id, n]));
    const simEdges: any[] = edges
      .filter((e) => nodeMap.has(e.sourceDeviceId) && nodeMap.has(e.targetDeviceId))
      .map((e) => ({
        source: nodeMap.get(e.sourceDeviceId)!,
        target: nodeMap.get(e.targetDeviceId)!,
        lq: e.linkQuality,
        lt: e.linkType, // 'WIRELESS' | 'WIRED' | 'BACKBONE'
      }));

    state.simNodes = simNodes;
    state.simEdges = simEdges;

    // ── D3 force simulation ─────────────────────────────────────────────────
    // forceY tiers enforce the BTS→CPE→IDU top-down hierarchy from the architecture diagram
    const tierY = (type: string) =>
      type === 'BTS' ? H * 0.18 : type === 'CPE' ? H * 0.50 : H * 0.82;

    const sim = d3.forceSimulation(simNodes)
      .force('link', d3.forceLink<any, any>(simEdges).id((d) => d.id).distance(60).strength(0.5))
      .force('charge', d3.forceManyBody().strength(-160))
      .force('center', d3.forceCenter(W / 2, H / 2).strength(0.02))
      .force('collide', d3.forceCollide<any>().radius((d) => getR(d.type) + 9))
      // Hierarchy tiers: BTS top, CPE middle, IDU bottom — mirrors the architecture diagram
      .force('y', d3.forceY<any>((d) => tierY(d.type)).strength(0.35))
      // Spread nodes horizontally within their tier
      .force('x', d3.forceX<any>(W / 2).strength(0.04))
      .alphaDecay(0.006)
      .velocityDecay(0.40);

    // ── Canvas draw ─────────────────────────────────────────────────────────
    function draw() {
      const ctx = canvas!.getContext('2d');
      if (!ctx) return;
      const dpr = window.devicePixelRatio;
      const { hoveredId, selectedId, transform: { k, x, y } } = state;

      ctx.save();
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, W, H);

      // Dark base + subtle dot grid
      ctx.fillStyle = '#0a0f1a';
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = 'rgba(255,255,255,0.025)';
      const gs = 40 * k;
      const ox = ((x % gs) + gs) % gs, oy = ((y % gs) + gs) % gs;
      for (let gx = ox - gs; gx < W + gs; gx += gs)
        for (let gy = oy - gs; gy < H + gs; gy += gs) {
          ctx.beginPath(); ctx.arc(gx, gy, 0.8, 0, Math.PI * 2); ctx.fill();
        }

      ctx.translate(x, y);
      ctx.scale(k, k);

      // Determine connected set for highlight
      const activeId = selectedId ?? hoveredId;
      const connected = new Set<string>();
      if (activeId) {
        connected.add(activeId);
        state.simEdges.forEach((e: any) => {
          if (e.source.id === activeId) { connected.add(e.source.id); connected.add(e.target.id); }
          if (e.target.id === activeId) { connected.add(e.source.id); connected.add(e.target.id); }
        });
      }
      const hl = connected.size > 0;

      // ── Edges ──────────────────────────────────────────────────────────────
      // WIRELESS (CPE→BTS): solid colored line; WIRED (IDU→CPE): short dashes, steel-gray
      state.simEdges.forEach((e: any) => {
        const isConn  = !hl || (connected.has(e.source.id) && connected.has(e.target.id));
        const isWired = e.lt === 'WIRED';
        ctx.beginPath();
        ctx.moveTo(e.source.x, e.source.y);
        ctx.lineTo(e.target.x, e.target.y);
        // Wired = short dashes (Ethernet segment), Wireless = solid
        ctx.setLineDash(isWired ? [4, 4] : []);
        if (isConn && hl) {
          const c = edgeHLCol(e.lq, e.lt);
          ctx.strokeStyle = c; ctx.lineWidth = isWired ? 1 : 2;
          ctx.shadowColor = c; ctx.shadowBlur = isWired ? 4 : 12;
          ctx.globalAlpha = 1;
        } else if (!hl) {
          ctx.strokeStyle = edgeBaseCol(e.lq, e.lt);
          ctx.lineWidth = isWired ? 0.8 : 1;
          ctx.shadowColor = edgeHLCol(e.lq, e.lt);
          ctx.shadowBlur = isWired ? 2 : 4;
          ctx.globalAlpha = 1;
        } else {
          ctx.strokeStyle = 'rgba(255,255,255,0.04)';
          ctx.lineWidth = 0.5; ctx.shadowBlur = 0; ctx.globalAlpha = 1;
          ctx.setLineDash([]);
        }
        ctx.stroke();
        ctx.shadowBlur = 0; ctx.setLineDash([]);
      });

      // ── Nodes ──────────────────────────────────────────────────────────────
      state.simNodes.forEach((n: any) => {
        const r       = getR(n.type);
        const rawCol  = n.health === 'FAULTY' ? '#ef4444'
                      : n.health === 'DEGRADED' ? '#f59e0b'
                      : getCol(n.type);
        const isActive = n.id === activeId;
        const isConn   = !hl || connected.has(n.id);
        ctx.globalAlpha = !hl ? 1 : isConn ? 1 : 0.1;

        // Outer glow ring
        if (isActive || (isConn && hl)) {
          ctx.beginPath(); ctx.arc(n.x, n.y, r + (isActive ? 7 : 4), 0, Math.PI * 2);
          ctx.strokeStyle = rawCol + '55'; ctx.lineWidth = isActive ? 3 : 2;
          ctx.shadowColor = rawCol; ctx.shadowBlur = isActive ? 30 : 16;
          ctx.stroke(); ctx.shadowBlur = 0;
        }

        // Main circle with glow
        ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
        ctx.fillStyle = rawCol;
        ctx.shadowColor = rawCol;
        ctx.shadowBlur = isActive ? 28 : hl && isConn ? 16 : 8;
        ctx.fill(); ctx.shadowBlur = 0;

        // Bright core dot
        ctx.beginPath(); ctx.arc(n.x, n.y, r * 0.4, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255,255,255,${isActive ? 0.7 : 0.35})`;
        ctx.fill();

        // Label — always for BTS, only on active for CPE/IDU
        if (n.type === 'BTS' || isActive) {
          const fs = Math.max(9, 10 / k);
          ctx.font = `${isActive ? 700 : 500} ${fs}px system-ui,sans-serif`;
          ctx.textAlign = 'center'; ctx.textBaseline = 'top';
          const tw = ctx.measureText(n.name).width;
          ctx.fillStyle = 'rgba(10,15,26,0.7)';
          ctx.fillRect(n.x - tw / 2 - 3, n.y + r + 3, tw + 6, fs + 4);
          ctx.fillStyle = isActive ? '#fff' : 'rgba(255,255,255,0.88)';
          ctx.fillText(n.name, n.x, n.y + r + 5);
          ctx.textBaseline = 'alphabetic';
        }

        ctx.globalAlpha = 1;
      });

      ctx.restore();
    }

    state.draw = draw;
    sim.on('tick', draw);

    // ── D3 Zoom / Pan ────────────────────────────────────────────────────────
    const zoom = d3.zoom<HTMLCanvasElement, unknown>()
      .scaleExtent([0.08, 12])
      .filter((ev: any) => {
        if (ev.type === 'wheel') return true;
        // Don't pan when clicking a node — let drag handle it
        const { sx, sy } = screenToSim(ev.offsetX ?? 0, ev.offsetY ?? 0);
        return !findNearest(sx, sy);
      })
      .on('zoom', (event) => {
        const t = event.transform;
        state.transform = { k: t.k, x: t.x, y: t.y };
        draw();
      });
    d3.select(canvas).call(zoom);

    // ── Helpers ──────────────────────────────────────────────────────────────
    function screenToSim(cx: number, cy: number) {
      const { k, x, y } = state.transform;
      return { sx: (cx - x) / k, sy: (cy - y) / k };
    }
    function findNearest(sx: number, sy: number) {
      let best: any = null, bd = Infinity;
      state.simNodes.forEach((n: any) => {
        const d = Math.hypot((n.x ?? 0) - sx, (n.y ?? 0) - sy);
        const threshold = (getR(n.type) + 8) / state.transform.k;
        if (d < bd && d < threshold) { best = n; bd = d; }
      });
      return best;
    }

    // ── Mouse interactions ───────────────────────────────────────────────────
    let dragNode: any = null, dragStartX = 0, dragStartY = 0, didDrag = false;

    const onMM = (ev: MouseEvent) => {
      if (dragNode) {
        if (!didDrag && Math.hypot(ev.offsetX - dragStartX, ev.offsetY - dragStartY) > 4) didDrag = true;
        if (didDrag) {
          const { sx, sy } = screenToSim(ev.offsetX, ev.offsetY);
          dragNode.fx = sx; dragNode.fy = sy;
          sim.alpha(0.15).restart();
          return;
        }
      }
      const { sx, sy } = screenToSim(ev.offsetX, ev.offsetY);
      const n = findNearest(sx, sy);
      const id = n?.id ?? null;
      if (id !== state.hoveredId) {
        state.hoveredId = id;
        canvas!.style.cursor = id ? 'pointer' : 'default';
        setTooltipNode(id ? n._node : null);
        draw();
      }
    };

    const onMD = (ev: MouseEvent) => {
      const { sx, sy } = screenToSim(ev.offsetX, ev.offsetY);
      const n = findNearest(sx, sy);
      if (n) { dragNode = n; dragStartX = ev.offsetX; dragStartY = ev.offsetY; didDrag = false; n.fx = n.x; n.fy = n.y; }
    };

    const onMU = () => {
      if (dragNode) {
        if (!didDrag) {
          const newSel = state.selectedId === dragNode.id ? null : dragNode.id;
          state.selectedId = newSel;
          setTooltipNode(newSel ? dragNode._node : null);
          onNodeClick(dragNode._node);
          draw();
        }
        dragNode.fx = null; dragNode.fy = null;
        sim.alphaTarget(0);
      }
      dragNode = null; didDrag = false;
    };

    canvas.addEventListener('mousemove', onMM);
    canvas.addEventListener('mousedown', onMD);
    canvas.addEventListener('mouseup',   onMU);

    return () => {
      sim.stop();
      canvas.removeEventListener('mousemove', onMM);
      canvas.removeEventListener('mousedown', onMD);
      canvas.removeEventListener('mouseup',   onMU);
      d3.select(canvas).on('.zoom', null);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes.length, edges.length, mapHeight]);

  return (
    <div style={{ position: 'relative', height: mapHeight, background: '#0a0f1a', overflow: 'hidden' }}>
      <canvas ref={canvasRef} style={{ display: 'block', width: '100%', height: '100%' }} />

      {/* Tooltip / detail card */}
      {tooltipNode && (
        <div style={{
          position: 'absolute', top: 12, right: 12, zIndex: 20,
          background: 'rgba(10,15,26,0.95)', backdropFilter: 'blur(12px)',
          border: `1px solid ${HEALTH_COLOR[tooltipNode.health]}55`,
          borderRadius: 12, padding: '14px 16px', minWidth: 240,
          boxShadow: `0 0 30px ${HEALTH_COLOR[tooltipNode.health]}22`,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{ width: 10, height: 10, borderRadius: '50%', background: HEALTH_COLOR[tooltipNode.health], boxShadow: `0 0 8px ${HEALTH_COLOR[tooltipNode.health]}` }} />
              <span style={{ fontWeight: 700, fontSize: 13, color: '#fff' }}>
                {tooltipNode.deviceName ?? tooltipNode.serialNumber}
              </span>
            </div>
            <button onClick={() => { setTooltipNode(null); stateRef.current.selectedId = null; stateRef.current.draw(); }}
              style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.4)', cursor: 'pointer', fontSize: 16 }}>×</button>
          </div>
          <DeviceTooltip node={tooltipNode} hideClickHint />
          <button onClick={() => onNodeClick(tooltipNode)}
            style={{ marginTop: 10, width: '100%', padding: '7px 0', fontSize: 12, fontWeight: 700,
              background: 'linear-gradient(135deg,#3b82f6,#2563eb)', color: '#fff',
              border: 'none', borderRadius: 8, cursor: 'pointer',
              boxShadow: '0 0 12px rgba(59,130,246,0.5)' }}>
            View Device Details →
          </button>
        </div>
      )}

      {/* Legend */}
      <div style={{
        position: 'absolute', bottom: 16, left: 16, zIndex: 10,
        background: 'rgba(10,15,26,0.9)', backdropFilter: 'blur(10px)',
        border: '1px solid rgba(255,255,255,0.07)', borderRadius: 12, padding: '12px 16px',
      }}>
        <div style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'rgba(255,255,255,0.35)', marginBottom: 8 }}>Node Type</div>
        {([['BTS', '#3b82f6', 13], ['CPE', '#22c55e', 6], ['IDU', '#f59e0b', 4]] as const).map(([t, c, r]) => (
          <div key={t} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
            <div style={{ width: r * 2, height: r * 2, borderRadius: '50%', background: c, boxShadow: `0 0 8px ${c}`, flexShrink: 0 }} />
            <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.65)' }}>{t}</span>
          </div>
        ))}
        <div style={{ borderTop: '1px solid rgba(255,255,255,0.08)', marginTop: 8, paddingTop: 8 }}>
          <div style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'rgba(255,255,255,0.35)', marginBottom: 6 }}>Link Type</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <svg width="20" height="6"><line x1="0" y1="3" x2="20" y2="3" stroke="#22c55e" strokeWidth="2" strokeDasharray="0" /></svg>
            <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.5)' }}>Wireless (CPE→BTS)</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <svg width="20" height="6"><line x1="0" y1="3" x2="20" y2="3" stroke="#94a3b8" strokeWidth="1.5" strokeDasharray="4,3" /></svg>
            <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.5)' }}>Wired/PoE (IDU→CPE)</span>
          </div>
          <div style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'rgba(255,255,255,0.35)', marginBottom: 6 }}>Link Quality</div>
          {([['#22c55e', 'GOOD'], ['#f59e0b', 'FAIR'], ['#ef4444', 'POOR']] as const).map(([c, l]) => (
            <div key={l} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <div style={{ width: 18, height: 2, background: c, borderRadius: 1, boxShadow: `0 0 4px ${c}`, opacity: 0.85 }} />
              <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.5)' }}>{l}</span>
            </div>
          ))}
        </div>
        <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.25)', marginTop: 6, textAlign: 'center' }}>
          Scroll · zoom &nbsp;|&nbsp; Drag · pan &amp; move
        </div>
      </div>

      {/* Stats badge */}
      <div style={{
        position: 'absolute', top: 12, left: 12, zIndex: 10,
        background: 'rgba(10,15,26,0.9)', backdropFilter: 'blur(10px)',
        border: '1px solid rgba(255,255,255,0.07)', borderRadius: 8,
        padding: '6px 14px', display: 'flex', gap: 14,
      }}>
        {([['BTS', '#3b82f6'], ['CPE', '#22c55e'], ['IDU', '#f59e0b']] as const).map(([t, c]) => (
          <span key={t} style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)' }}>
            <span style={{ color: c, fontWeight: 700, marginRight: 3 }}>
              {nodes.filter((n) => n.deviceType === t).length}
            </span>{t}
          </span>
        ))}
        <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.3)' }}>· {edges.length} links</span>
      </div>
    </div>
  );

}

// ── Topology KPI tile (mirrors Dashboard KpiTile, clickable for drilldown) ────
function TopoKpiTile({ icon, label, value, total, color, onClick }: {
  icon: string; label: string; value: number; total?: number;
  color: string; onClick?: () => void;
}) {
  const pct = total && total > 0 ? ` (${Math.round((value / total) * 100)}%)` : '';
  return (
    <button
      onClick={onClick}
      disabled={!onClick}
      style={{
        textAlign: 'left', width: '100%',
        cursor: onClick ? 'pointer' : 'default',
        background: 'var(--vf-surface)',
        border: 'var(--vf-card-border)',
        borderRadius: 12, padding: '14px 16px',
        position: 'relative', overflow: 'hidden',
        transition: 'transform 0.15s, box-shadow 0.15s',
        boxShadow: 'var(--vf-shadow-low)',
        opacity: 1,
      }}
      onMouseEnter={onClick ? (e) => { const b = e.currentTarget as HTMLButtonElement; b.style.transform = 'translateY(-2px)'; b.style.boxShadow = '0 6px 20px rgba(0,0,0,0.15)'; } : undefined}
      onMouseLeave={onClick ? (e) => { const b = e.currentTarget as HTMLButtonElement; b.style.transform = ''; b.style.boxShadow = 'var(--vf-shadow-low)'; } : undefined}
    >
      {/* colored top accent bar */}
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 3, background: `linear-gradient(90deg, ${color}, ${color}55)`, borderRadius: '12px 12px 0 0' }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 10 }}>
        <span aria-hidden="true" style={{ fontSize: 13 }}>{icon}</span>
        <span style={{ color: 'var(--vf-text-muted)', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em' }}>{label}</span>
      </div>
      <div style={{ color, fontSize: 30, fontWeight: 800, fontFamily: 'var(--vf-font-mono)', lineHeight: 1, letterSpacing: '-0.02em' }}>
        {value.toLocaleString()}
        {pct && <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--vf-text-muted)', marginLeft: 6 }}>{pct}</span>}
      </div>
    </button>
  );
}

// ── List view ──────────────────────────────────────────────────────────────────
function TopologyListView({ nodes, onNodeClick, mapHeight }: {
  nodes: TopologyNode[];
  onNodeClick: (n: TopologyNode) => void;
  mapHeight: number;
}) {
  return (
    <div style={{ height: mapHeight, overflowY: 'auto', overflowX: 'auto', border: '1px solid rgba(77,158,255,0.1)', borderRadius: 10 }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--vf-font-sans)', fontSize: 13 }}>
        <thead style={{ position: 'sticky', top: 0, zIndex: 1 }}>
          <tr style={{ background: 'var(--vf-surface)' }}>
            {['Name', 'Serial', 'Type', 'Health', 'IP', 'RSSI', 'A1/A2', 'SNR', 'FW', 'Uptime', 'GPS'].map((h) => (
              <th key={h} style={{ padding: '10px 12px', textAlign: 'left', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--vf-text-muted)', borderBottom: '1px solid var(--vf-border-subtle)', whiteSpace: 'nowrap' }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {nodes.map((n) => (
            <tr key={n.id} style={{ borderBottom: '1px solid var(--vf-border-subtle)', cursor: 'pointer' }} onClick={() => onNodeClick(n)}>
              <td style={{ padding: '8px 12px', fontWeight: 600, color: 'var(--vf-text-primary)' }}>{n.deviceName ?? '—'}</td>
              <td style={{ padding: '8px 12px', fontFamily: 'var(--vf-font-mono)', fontSize: 11, color: 'var(--vf-accent)' }}>{n.serialNumber}</td>
              <td style={{ padding: '8px 12px' }}><Badge variant="default">{n.deviceType}</Badge></td>
              <td style={{ padding: '8px 12px' }}><Badge variant={healthVariant[n.health]} dot>{n.health}</Badge></td>
              <td style={{ padding: '8px 12px', fontFamily: 'var(--vf-font-mono)', fontSize: 11 }}>{n.ipAddress}</td>
              <td style={{ padding: '8px 12px', color: 'var(--vf-text-secondary)' }}>{n.rssi != null ? `${n.rssi} dBm` : '—'}</td>
              <td style={{ padding: '8px 12px', color: 'var(--vf-text-secondary)', fontFamily: 'var(--vf-font-mono)', fontSize: 11 }}>
                {n.a1Rssi != null ? `${n.a1Rssi} / ${n.a2Rssi} dBm` : '—'}
              </td>
              <td style={{ padding: '8px 12px', color: 'var(--vf-text-secondary)' }}>{n.snr != null ? `${n.snr} dB` : '—'}</td>
              <td style={{ padding: '8px 12px', fontFamily: 'var(--vf-font-mono)', fontSize: 11, color: 'var(--vf-text-muted)' }}>{n.firmwareVersion ?? '—'}</td>
              <td style={{ padding: '8px 12px', color: 'var(--vf-text-muted)', fontSize: 11 }}>{n.uptime ?? '—'}</td>
              <td style={{ padding: '8px 12px' }}>
                {n.location
                  ? <Badge variant="success" dot>{n.location.lat.toFixed(3)}, {n.location.lng.toFixed(3)}</Badge>
                  : <Badge variant="default">No GPS</Badge>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────────
export default function V2TopologyPage() {
  const navigate = useNavigate();
  const { addToast } = useToast();
  const mapHeight = useMapHeight();

  const [graph, setGraph]               = useState<TopologyGraph | null>(null);
  const [loading, setLoading]           = useState(true);
  const [refreshKey, setRefreshKey]     = useState(0);
  const [view, setView]                 = useState<View>('map');
  const [healthFilter, setHealthFilter] = useState<HealthFilter>('');
  const [typeMode,  setTypeMode]        = useState<TypeMode>('ALL');
  const [search, setSearch]             = useState('');

  // typeFilter is always derived from typeMode (ALL → '')
  const typeFilter = typeMode === 'ALL' ? '' : typeMode;
  const [selectedNode, setSelectedNode] = useState<TopologyNode | null>(null);
  const [gpsResult, setGpsResult]       = useState<GpsResult | undefined>(undefined);

  const [isBustCache, setIsBustCache] = useState(false);

  const handleRefresh = useCallback(() => {
    setLoading(true);
    setGraph(null);
    setIsBustCache(true);
    setRefreshKey((k) => k + 1);
  }, []);

  useEffect(() => {
    fetchTopology(undefined, isBustCache)
      .then((g) => { setGraph(g); setIsBustCache(false); addToast(`Topology refreshed — ${g.nodes?.length ?? 0} devices`, 'success'); })
      .catch((e) => { logger.error('Topology fetch failed', e); addToast('Failed to load topology data', 'error'); })
      .finally(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addToast, refreshKey]);

  const nodes = graph?.nodes ?? [];
  const edges = graph?.edges ?? [];

  const filteredNodes = nodes.filter((n) => {
    if (healthFilter && n.health !== healthFilter) return false;
    if (typeFilter   && n.deviceType !== typeFilter) return false;
    if (search) {
      const q = search.toLowerCase();
      if (![n.serialNumber, n.ipAddress, n.deviceName, n.macAddress].some((v) => (v ?? '').toLowerCase().includes(q))) return false;
    }
    return true;
  });

  const healthy  = nodes.filter((n) => n.health === 'HEALTHY').length;
  const degraded = nodes.filter((n) => n.health === 'DEGRADED').length;
  const faulty   = nodes.filter((n) => n.health === 'FAULTY').length;
  const withGps  = nodes.filter((n) => !!n.location).length;

  // Mode-specific breakdowns (mirrors Dashboard KPIs)
  const btsNodes = nodes.filter((n) => n.deviceType === 'BTS');
  const cpeNodes = nodes.filter((n) => n.deviceType === 'CPE');
  const iduNodes = nodes.filter((n) => n.deviceType === 'IDU');
  const btsOnline  = btsNodes.filter((n) => n.health === 'HEALTHY').length;
  const btsFaulty  = btsNodes.filter((n) => n.health === 'FAULTY' || n.health === 'DEGRADED').length;
  const cpeOnline  = cpeNodes.filter((n) => n.health === 'HEALTHY').length;
  const cpeOffline = cpeNodes.filter((n) => n.health === 'FAULTY').length;
  const iduOnline  = iduNodes.filter((n) => n.health === 'HEALTHY').length;
  const avgCpesPerBts = btsNodes.length > 0 ? Math.round(cpeNodes.length / btsNodes.length) : 0;

  const handleNodeClick  = useCallback((n: TopologyNode) => { setSelectedNode(n); }, []);
  // Navigate to device detail. The topology stub now returns real inventory IDs, so we
  // prefer deviceId. Serial number is kept as a fallback for robustness.
  const handleNavigate = useCallback((deviceIdOrSerial: string) => {
    const node = nodes.find(
      (n) => n.id === deviceIdOrSerial || n.deviceId === deviceIdOrSerial || n.serialNumber === deviceIdOrSerial,
    );
    // Prefer real inventory ID; fall back to serial (device detail also matches by serial)
    const navId = node?.deviceId || node?.serialNumber || deviceIdOrSerial;
    navigate(`/v2/devices/${navId}`, { state: { from: 'topology' } });
  }, [navigate, nodes]);

  const contentHeight = mapHeight;

  return (
    <div className="vf-page">
      <div className="vf-page-header">
        <h1 className="vf-page-title">Topology</h1>
        <div className="vf-page-actions">
          {(['map', 'graph', 'list'] as View[]).map((v) => (
            <Button key={v} variant={view === v ? 'primary' : 'ghost'} size="sm" onClick={() => { setView(v); setSelectedNode(null); }}>
              {v === 'map' ? '🗺 Map' : v === 'graph' ? '⬡ Graph' : '☰ List'}
            </Button>
          ))}
          <Button variant="ghost" size="sm" onClick={handleRefresh} loading={loading} title="Refresh topology data from inventory">
            ↻ Refresh
          </Button>
        </div>
      </div>

      {/* ── Device-type mode chips ─────────────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        {(['ALL', 'BTS', 'CPE', 'IDU'] as TypeMode[]).map((m) => (
          <button key={m} onClick={() => setTypeMode(m)}
            style={{
              padding: '6px 18px', borderRadius: 20, cursor: 'pointer',
              fontSize: 12, fontWeight: 700, letterSpacing: '0.04em',
              background: typeMode === m ? TYPE_MODE_BG[m] : 'var(--vf-elevated)',
              color: typeMode === m ? '#fff' : 'var(--vf-text-secondary)',
              boxShadow: typeMode === m ? '0 2px 10px rgba(0,0,0,0.18)' : 'none',
              border: typeMode === m ? '1px solid transparent' : '1px solid var(--vf-border-subtle)',
              transition: 'all 0.15s',
            }}>
            {m}
          </button>
        ))}
        <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--vf-text-muted)' }}>
          {typeMode === 'ALL' ? 'All Devices' : `${typeMode} View`}
          <span style={{ marginLeft: 8, background: 'var(--vf-accent-subtle)', border: '1px solid var(--vf-accent)', color: 'var(--vf-accent)', padding: '2px 10px', borderRadius: 12, fontSize: 12, fontWeight: 700, fontFamily: 'monospace' }}>
            {filteredNodes.length} / {nodes.length}
          </span>
        </span>
      </div>

      {/* ── KPI tiles — mode-aware (mirrors Dashboard) ────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 10 }}>
        {typeMode === 'ALL' && (<>
          <TopoKpiTile icon="🌐" label="Total Nodes"  value={nodes.length}  color="#94a3b8" onClick={() => { setTypeMode('ALL'); setHealthFilter(''); }} />
          <TopoKpiTile icon="🔗" label="Links"        value={edges.length}  color="#60a5fa" />
          <TopoKpiTile icon="✅" label="Healthy"      value={healthy}       color="#22c55e" onClick={() => { setTypeMode('ALL'); setHealthFilter('HEALTHY'); }} />
          <TopoKpiTile icon="⚠️" label="Degraded"    value={degraded}      color={degraded > 0 ? '#f59e0b' : '#22c55e'} onClick={() => { setTypeMode('ALL'); setHealthFilter('DEGRADED'); }} />
          <TopoKpiTile icon="⛔" label="Faulty"       value={faulty}        color={faulty > 0 ? '#ef4444' : '#22c55e'}   onClick={() => { setTypeMode('ALL'); setHealthFilter('FAULTY'); }} />
          <TopoKpiTile icon="📍" label="GPS Located"  value={withGps}       color={withGps < nodes.length ? '#f59e0b' : '#22c55e'} total={nodes.length} />
        </>)}
        {typeMode === 'BTS' && (<>
          <TopoKpiTile icon="🗼" label="BTS Total"    value={btsNodes.length}  color="#60a5fa" onClick={() => setHealthFilter('')} />
          <TopoKpiTile icon="🟢" label="BTS Online"   value={btsOnline}        color="#22c55e" total={btsNodes.length} onClick={() => setHealthFilter('HEALTHY')} />
          <TopoKpiTile icon="⚠"  label="BTS Faulty"  value={btsFaulty}        color={btsFaulty > 0 ? '#ef4444' : '#22c55e'} onClick={() => setHealthFilter('FAULTY')} />
          <TopoKpiTile icon="📡" label="Avg CPEs/BTS" value={avgCpesPerBts}   color="#a78bfa" />
          <TopoKpiTile icon="🔗" label="Links"        value={edges.length}    color="#60a5fa" />
          <TopoKpiTile icon="📍" label="GPS Located"  value={btsNodes.filter((n) => !!n.location).length} color="#22c55e" total={btsNodes.length} />
        </>)}
        {typeMode === 'CPE' && (<>
          <TopoKpiTile icon="📡" label="CPE Total"   value={cpeNodes.length}  color="#a78bfa" onClick={() => setHealthFilter('')} />
          <TopoKpiTile icon="🟢" label="CPE Online"  value={cpeOnline}        color="#22c55e" total={cpeNodes.length} onClick={() => setHealthFilter('HEALTHY')} />
          <TopoKpiTile icon="🔴" label="CPE Offline" value={cpeOffline}       color={cpeOffline > 0 ? '#ef4444' : '#22c55e'} onClick={() => setHealthFilter('FAULTY')} />
          <TopoKpiTile icon="🔌" label="IDU Total"   value={iduNodes.length}  color="#22d3ee" onClick={() => setTypeMode('IDU')} />
          <TopoKpiTile icon="🔗" label="Links"       value={edges.length}     color="#60a5fa" />
          <TopoKpiTile icon="📡" label="Avg CPEs/BTS" value={avgCpesPerBts}  color="#f59e0b" />
        </>)}
        {typeMode === 'IDU' && (<>
          <TopoKpiTile icon="🔌" label="IDU Total"   value={iduNodes.length}  color="#22d3ee" onClick={() => setHealthFilter('')} />
          <TopoKpiTile icon="🟢" label="IDU Online"  value={iduOnline}        color="#22c55e" total={iduNodes.length} onClick={() => setHealthFilter('HEALTHY')} />
          <TopoKpiTile icon="⛔" label="IDU Faulty"  value={iduNodes.filter((n) => n.health === 'FAULTY').length} color="#ef4444" onClick={() => setHealthFilter('FAULTY')} />
          <TopoKpiTile icon="🗼" label="BTS Total"   value={btsNodes.length}  color="#60a5fa" onClick={() => setTypeMode('BTS')} />
          <TopoKpiTile icon="📡" label="CPE Total"   value={cpeNodes.length}  color="#a78bfa" onClick={() => setTypeMode('CPE')} />
          <TopoKpiTile icon="📍" label="GPS Located"  value={withGps}         color="#22c55e" total={nodes.length} />
        </>)}
      </div>

      {/* GPS radius search — map only (NMS-TP-02) */}
      {view === 'map' && (
        <GpsSearchBar
          active={!!gpsResult}
          onResult={setGpsResult}
          onClear={() => setGpsResult(undefined)}
          resultCount={gpsResult?.nodes.length}
        />
      )}

      {/* Text / health filters */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ position: 'relative' }}>
          <span style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', color: 'var(--vf-text-muted)', fontSize: 13 }}>🔍</span>
          <input
            placeholder="IP, Serial Number, MAC"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ padding: '6px 10px 6px 28px', fontSize: 13, background: 'var(--vf-input-bg)', border: '1px solid var(--vf-border-default)', borderRadius: 8, color: 'var(--vf-text-primary)', width: 220 }}
          />
          {search && (
            <button onClick={() => setSearch('')} style={{ position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--vf-text-muted)' }}>×</button>
          )}
        </div>
        <Select
          options={[{ value: '' as HealthFilter, label: 'All health' }, { value: 'HEALTHY' as HealthFilter, label: 'Healthy' }, { value: 'DEGRADED' as HealthFilter, label: 'Degraded' }, { value: 'FAULTY' as HealthFilter, label: 'Faulty' }, { value: 'UNKNOWN' as HealthFilter, label: 'Unknown' }]}
          value={healthFilter}
          onChange={(e) => setHealthFilter(e.target.value as HealthFilter)}
          style={{ width: 140 }}
        />
        <Button variant="ghost" size="sm" onClick={() => { setHealthFilter(''); setTypeMode('ALL'); setSearch(''); }}>Clear</Button>
      </div>

      {/* Main area */}
      {loading ? (
        <LoadingState label="Loading topology…" />
      ) : !graph || nodes.length === 0 ? (
        <EmptyState title="No topology data" description="No network topology has been discovered yet." />
      ) : (
        <div style={{ display: 'flex', height: contentHeight, borderRadius: 12, overflow: 'hidden', border: '1px solid var(--vf-border-subtle)' }}>
          {/* Visualization */}
          <div style={{ flex: 1, minWidth: 0, height: contentHeight }}>
            {view === 'map' ? (
              <IndiaMapView
                nodes={filteredNodes}
                edges={edges}
                onNodeClick={handleNodeClick}
                gpsResult={gpsResult}
                mapHeight={contentHeight}
              />
            ) : view === 'graph' ? (
              <TopologyGraphView
                nodes={filteredNodes}
                edges={edges}
                onNodeClick={handleNodeClick}
                mapHeight={contentHeight}
              />
            ) : (
              <TopologyListView
                nodes={filteredNodes}
                onNodeClick={handleNodeClick}
                mapHeight={contentHeight}
              />
            )}
          </div>

          {/* Side panel (NMS-TP-05, NMS-TP-08) */}
          {selectedNode && (
            <DevicePanel
              node={selectedNode}
              onClose={() => setSelectedNode(null)}
              onNavigate={handleNavigate}
              height={contentHeight}
            />
          )}
        </div>
      )}
    </div>
  );
}
