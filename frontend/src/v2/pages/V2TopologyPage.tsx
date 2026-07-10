import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { MapContainer, TileLayer, CircleMarker, Tooltip as LeafletTooltip } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import { fetchTopology } from '../../api/topology.api';
import type { TopologyGraph, TopologyNode, NodeHealth } from '../../api/topology.types';
import { Badge } from '../components/common/Badge';
import { Button } from '../components/common/Button';
import { Select } from '../components/common/Select';
import { MetricCard } from '../components/common/MetricCard';
import { LoadingState, EmptyState } from '../components/common/States';
import { useToast } from '../components/common/Toast';
import { logger } from '../utils/logger';

// ── India bounding-box fallback positions ─────────────────────────────────────
// When a node has no GPS coords we distribute it across Indian cities so the
// map still shows something meaningful.
const INDIA_CITIES: [number, number][] = [
  [28.6139, 77.2090],  // Delhi
  [19.0760, 72.8777],  // Mumbai
  [13.0827, 80.2707],  // Chennai
  [12.9716, 77.5946],  // Bangalore
  [17.3850, 78.4867],  // Hyderabad
  [22.5726, 88.3639],  // Kolkata
  [23.0225, 72.5714],  // Ahmedabad
  [18.5204, 73.8567],  // Pune
  [26.9124, 75.7873],  // Jaipur
  [30.7333, 76.7794],  // Chandigarh
  [21.1458, 79.0882],  // Nagpur
  [25.5941, 85.1376],  // Patna
  [26.8467, 80.9462],  // Lucknow
  [22.7196, 75.8577],  // Indore
  [11.0168, 76.9558],  // Coimbatore
  [15.3173, 75.7139],  // Hubli
  [16.5062, 80.6480],  // Vijayawada
  [9.9312,  76.2673],  // Kochi
  [29.0588, 76.0856],  // Rohtak
  [24.8607, 67.0011],  // Karachi-border
];

function fallbackLatLng(idx: number): [number, number] {
  const base = INDIA_CITIES[idx % INDIA_CITIES.length];
  // small jitter so collocated nodes don't stack exactly
  return [base[0] + (idx % 3) * 0.08, base[1] + (idx % 5) * 0.08];
}

// ── Health colour palette ──────────────────────────────────────────────────────
const HEALTH_COLOR: Record<NodeHealth, string> = {
  HEALTHY: '#22c55e',
  DEGRADED: '#f59e0b',
  FAULTY:   '#ef4444',
  UNKNOWN:  '#6b7280',
};

type View = 'map' | 'graph' | 'list';
type HealthFilter = '' | NodeHealth;

const HEALTH_OPTIONS = [
  { value: '' as HealthFilter, label: 'All health' },
  { value: 'HEALTHY'  as HealthFilter, label: 'Healthy' },
  { value: 'DEGRADED' as HealthFilter, label: 'Degraded' },
  { value: 'FAULTY'   as HealthFilter, label: 'Faulty' },
  { value: 'UNKNOWN'  as HealthFilter, label: 'Unknown' },
];

const healthVariant: Record<NodeHealth, 'success' | 'warning' | 'danger' | 'unknown'> = {
  HEALTHY: 'success', DEGRADED: 'warning', FAULTY: 'danger', UNKNOWN: 'unknown',
};

// ── Device-type visual encoding ────────────────────────────────────────────────
const DEVICE_TYPE_COLOR: Record<string, string> = {
  BTS: '#3b82f6',   // blue  — base stations are prominent
  CPE: '#22c55e',   // green — customer premise equipment
  IDU: '#f59e0b',   // amber — indoor units
};
const DEVICE_TYPE_RADIUS: Record<string, number> = { BTS: 14, CPE: 9, IDU: 7 };

// ── India map view ─────────────────────────────────────────────────────────────
function IndiaMapView({ nodes, edges, onNodeClick }: {
  nodes: TopologyNode[];
  edges: TopologyGraph['edges'];
  onNodeClick: (n: TopologyNode) => void;
}) {
  const [tileError, setTileError] = useState(false);

  const enriched = nodes.map((n, i) => ({
    node: n,
    lat: n.location?.lat ?? fallbackLatLng(i)[0],
    lng: n.location?.lng ?? fallbackLatLng(i)[1],
    hasGps: !!n.location,
  }));

  const btsCount = nodes.filter((n) => n.deviceType === 'BTS').length;
  const cpeCount = nodes.filter((n) => n.deviceType === 'CPE').length;
  const iduCount = nodes.filter((n) => n.deviceType === 'IDU').length;

  return (
    <div style={{ position: 'relative', border: '1px solid rgba(77,158,255,0.1)', borderRadius: 12, overflow: 'hidden', height: 580 }}>
      {tileError && (
        <div style={{
          position: 'absolute', top: 10, left: '50%', transform: 'translateX(-50%)',
          zIndex: 1100, background: 'rgba(245,158,11,0.95)', color: '#000',
          padding: '6px 16px', borderRadius: 8, fontSize: 12, fontWeight: 600,
          whiteSpace: 'nowrap', boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
        }}>
          ⚠ Map tiles unavailable — device markers still shown
        </div>
      )}
      <MapContainer
        center={[22.5937, 78.9629]}
        zoom={5}
        scrollWheelZoom
        style={{ width: '100%', height: '100%' }}
      >
        {/* CartoDB Voyager — colorful, globally reliable */}
        <TileLayer
          url="https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png"
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/">CARTO</a>'
          subdomains="abcd"
          maxZoom={19}
          eventHandlers={{ tileerror: () => setTileError(true) }}
        />

        {enriched.map(({ node, lat, lng, hasGps }) => {
          const typeColor   = DEVICE_TYPE_COLOR[node.deviceType] ?? '#6b7280';
          const healthColor = HEALTH_COLOR[node.health];
          const radius      = DEVICE_TYPE_RADIUS[node.deviceType] ?? 9;
          return (
            <CircleMarker
              key={node.id}
              center={[lat, lng]}
              radius={radius}
              pathOptions={{
                // outer ring uses health color; fill uses device-type color
                color:       healthColor,
                fillColor:   typeColor,
                fillOpacity: 0.85,
                weight: node.health === 'FAULTY' ? 3 : 2,
                dashArray:   hasGps ? undefined : '4 2',
              }}
              eventHandlers={{ click: () => onNodeClick(node) }}
            >
              <LeafletTooltip>
                <div style={{ fontFamily: 'monospace', fontSize: 12, lineHeight: 1.7, minWidth: 180 }}>
                  <div style={{ fontWeight: 700, marginBottom: 4 }}>
                    <span style={{ background: typeColor, color: '#fff', borderRadius: 4, padding: '1px 5px', fontSize: 11, marginRight: 5 }}>{node.deviceType}</span>
                    {node.serialNumber}
                  </div>
                  {!hasGps && <div style={{ color: '#f59e0b', fontSize: 11, marginBottom: 4 }}>⚠ Estimated position (no GPS)</div>}
                  <div>IP: {node.ipAddress}</div>
                  {node.operatingChannel && <div>Channel: {node.operatingChannel}</div>}
                  {node.rssi  != null && <div>RSSI: <strong>{node.rssi} dBm</strong></div>}
                  {node.snr   != null && <div>SNR: <strong>{node.snr} dB</strong></div>}
                  {node.uptime && <div>Uptime: {node.uptime}</div>}
                  {node.firmwareVersion && <div>FW: {node.firmwareVersion}</div>}
                  <div style={{ marginTop: 4, display: 'flex', alignItems: 'center', gap: 5 }}>
                    <span style={{ width: 8, height: 8, borderRadius: '50%', background: healthColor, display: 'inline-block' }} />
                    <span>{node.health}</span>
                    {node.pendingCommandCount != null && node.pendingCommandCount > 0 && (
                      <span style={{ marginLeft: 6, color: '#f59e0b' }}>⚡ {node.pendingCommandCount} pending cmds</span>
                    )}
                  </div>
                  <div style={{ marginTop: 6, color: '#60a5fa', fontSize: 11 }}>🔗 Click to open device detail</div>
                </div>
              </LeafletTooltip>
            </CircleMarker>
          );
        })}
      </MapContainer>

      {/* Device-type + health legend — floats bottom-left */}
      <div style={{
        position: 'absolute', bottom: 24, left: 12, zIndex: 1000,
        background: 'rgba(6,14,27,0.92)', border: '1px solid rgba(77,158,255,0.2)',
        borderRadius: 8, padding: '10px 14px',
        display: 'flex', flexDirection: 'column', gap: 5,
        backdropFilter: 'blur(8px)', pointerEvents: 'none',
      }}>
        <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em', color: '#64748b', marginBottom: 3 }}>Device Type</div>
        {[['BTS', '#3b82f6', '●'], ['CPE', '#22c55e', '●'], ['IDU', '#f59e0b', '●']].map(([t, c, s]) => (
          <div key={t} style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 11 }}>
            <span style={{ color: c, fontSize: 14 }}>{s}</span>
            <span style={{ color: '#cbd5e1' }}>{t}</span>
          </div>
        ))}
        <div style={{ borderTop: '1px solid rgba(77,158,255,0.12)', marginTop: 4, paddingTop: 6, fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em', color: '#64748b', marginBottom: 3 }}>Health (ring)</div>
        {Object.entries(HEALTH_COLOR).map(([h, c]) => (
          <div key={h} style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 11 }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', border: `2px solid ${c}`, display: 'inline-block', flexShrink: 0 }} />
            <span style={{ color: '#cbd5e1' }}>{h}</span>
          </div>
        ))}
        <div style={{ borderTop: '1px solid rgba(77,158,255,0.12)', marginTop: 2, paddingTop: 5, display: 'flex', alignItems: 'center', gap: 7, fontSize: 11, color: '#94a3b8' }}>
          <span style={{ width: 10, height: 0, borderBottom: '2px dashed #6b7280', display: 'inline-block', flexShrink: 0 }} />
          Est. position
        </div>
      </div>

      {/* Node/link count + device-type breakdown — top-right overlay */}
      <div style={{
        position: 'absolute', top: 10, right: 10, zIndex: 1000,
        background: 'rgba(6,14,27,0.92)', border: '1px solid rgba(77,158,255,0.15)',
        borderRadius: 6, padding: '6px 12px', fontSize: 11, color: '#94a3b8',
        backdropFilter: 'blur(4px)', pointerEvents: 'none', lineHeight: 1.8,
      }}>
        <div>{nodes.length} nodes · {edges.length} links</div>
        <div style={{ display: 'flex', gap: 10, marginTop: 2 }}>
          <span style={{ color: '#3b82f6' }}>● {btsCount} BTS</span>
          <span style={{ color: '#22c55e' }}>● {cpeCount} CPE</span>
          {iduCount > 0 && <span style={{ color: '#f59e0b' }}>● {iduCount} IDU</span>}
        </div>
      </div>
    </div>
  );
}

// ── Force-directed graph view ──────────────────────────────────────────────────
interface NodePos { id: string; x: number; y: number; vx: number; vy: number; }

function TopologyGraphView({ nodes, edges, onNodeClick }: {
  nodes: TopologyNode[];
  edges: TopologyGraph['edges'];
  onNodeClick: (n: TopologyNode) => void;
}) {
  const W = 900, H = 500;
  const [positions, setPositions] = useState<Map<string, NodePos>>(() => {
    const m = new Map<string, NodePos>();
    nodes.forEach((n, i) => {
      const angle = (i / nodes.length) * 2 * Math.PI;
      m.set(n.id, { id: n.id, x: W / 2 + Math.cos(angle) * 200, y: H / 2 + Math.sin(angle) * 150, vx: 0, vy: 0 });
    });
    return m;
  });

  useEffect(() => {
    const pos = new Map<string, NodePos>();
    nodes.forEach((n, i) => {
      const angle = (i / nodes.length) * 2 * Math.PI;
      const r = Math.min(W, H) * 0.35;
      pos.set(n.id, { id: n.id, x: W / 2 + Math.cos(angle) * r, y: H / 2 + Math.sin(angle) * r * 0.8, vx: 0, vy: 0 });
    });
    nodes.filter((n) => n.deviceType === 'BTS').forEach((n, i, arr) => {
      const angle = (i / (arr.length || 1)) * 2 * Math.PI;
      const p = pos.get(n.id)!;
      p.x = W / 2 + Math.cos(angle) * 80;
      p.y = H / 2 + Math.sin(angle) * 60;
    });
    setPositions(pos);
  }, [nodes]);

  const healthColor: Record<NodeHealth, string> = {
    HEALTHY: 'var(--vf-success)', DEGRADED: 'var(--vf-warning)',
    FAULTY: 'var(--vf-danger)', UNKNOWN: 'var(--vf-text-dim)',
  };

  return (
    <div style={{ border: '1px solid rgba(77,158,255,0.1)', borderRadius: 12, overflow: 'hidden', background: 'var(--vf-surface)' }}>
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ display: 'block' }}>
        {edges.map((e) => {
          const src = positions.get(e.sourceDeviceId);
          const tgt = positions.get(e.targetDeviceId);
          if (!src || !tgt) return null;
          return <line key={e.id} x1={src.x} y1={src.y} x2={tgt.x} y2={tgt.y} stroke="var(--vf-border-default)" strokeWidth="1.5" strokeOpacity="0.6" />;
        })}
        {nodes.map((n) => {
          const p = positions.get(n.id);
          if (!p) return null;
          const color = healthColor[n.health];
          const r = n.deviceType === 'BTS' ? 16 : 10;
          return (
            <g key={n.id} style={{ cursor: 'pointer' }} onClick={() => onNodeClick(n)}>
              <circle cx={p.x} cy={p.y} r={r + 4} fill={color} opacity="0.15" />
              <circle cx={p.x} cy={p.y} r={r} fill="var(--vf-surface)" stroke={color} strokeWidth="2" />
              <text x={p.x} y={p.y} textAnchor="middle" dominantBaseline="central"
                fontSize={n.deviceType === 'BTS' ? 10 : 8} fill={color}
                fontFamily="var(--vf-font-sans)" fontWeight="700">{n.deviceType}</text>
              <text x={p.x} y={p.y + r + 10} textAnchor="middle"
                fontSize="9" fill="var(--vf-text-muted)" fontFamily="var(--vf-font-sans)">
                {n.serialNumber?.slice(0, 8)}
              </text>
            </g>
          );
        })}
      </svg>
      <div style={{ padding: '6px 12px', borderTop: '1px solid var(--vf-border-subtle)', fontSize: 11, color: 'var(--vf-text-muted)', display: 'flex', gap: 16 }}>
        <span>{nodes.length} nodes · {edges.length} links</span>
        {([['HEALTHY','var(--vf-success)'],['DEGRADED','var(--vf-warning)'],['FAULTY','var(--vf-danger)'],['UNKNOWN','var(--vf-text-dim)']] as [string,string][]).map(([h, c]) => (
          <span key={h} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: c, display: 'inline-block' }} />
            {h}
          </span>
        ))}
      </div>
    </div>
  );
}

// ── List view ──────────────────────────────────────────────────────────────────
function TopologyListView({ nodes, onNodeClick }: { nodes: TopologyNode[]; onNodeClick: (n: TopologyNode) => void }) {
  return (
    <div style={{ overflowX: 'auto', border: '1px solid rgba(77,158,255,0.1)', borderRadius: 10 }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--vf-font-sans)', fontSize: 13 }}>
        <thead>
          <tr style={{ background: 'var(--vf-surface)' }}>
            {['Serial', 'Type', 'Health', 'IP', 'RSSI', 'SNR', 'Hop', 'Firmware', 'GPS'].map((h) => (
              <th key={h} style={{ padding: '10px 12px', textAlign: 'left', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--vf-text-muted)', borderBottom: '1px solid var(--vf-border-subtle)', whiteSpace: 'nowrap' }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {nodes.map((n) => (
            <tr key={n.id} style={{ borderBottom: '1px solid var(--vf-border-subtle)', cursor: 'pointer' }} onClick={() => onNodeClick(n)}>
              <td style={{ padding: '9px 12px', fontFamily: 'var(--vf-font-mono)', fontSize: 12, color: 'var(--vf-accent)' }}>{n.serialNumber}</td>
              <td style={{ padding: '9px 12px' }}><Badge variant="default">{n.deviceType}</Badge></td>
              <td style={{ padding: '9px 12px' }}><Badge variant={healthVariant[n.health]} dot>{n.health}</Badge></td>
              <td style={{ padding: '9px 12px', fontFamily: 'var(--vf-font-mono)', fontSize: 12 }}>{n.ipAddress}</td>
              <td style={{ padding: '9px 12px', color: 'var(--vf-text-secondary)' }}>{n.rssi != null ? `${n.rssi} dBm` : '—'}</td>
              <td style={{ padding: '9px 12px', color: 'var(--vf-text-secondary)' }}>{n.snr  != null ? `${n.snr} dB`  : '—'}</td>
              <td style={{ padding: '9px 12px', color: 'var(--vf-text-muted)' }}>{n.cascadeHop ?? '—'}</td>
              <td style={{ padding: '9px 12px', fontFamily: 'var(--vf-font-mono)', fontSize: 11, color: 'var(--vf-text-muted)' }}>{n.firmwareVersion ?? '—'}</td>
              <td style={{ padding: '9px 12px' }}>
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
  const [graph, setGraph]             = useState<TopologyGraph | null>(null);
  const [loading, setLoading]         = useState(true);
  const [view, setView]               = useState<View>('map');   // India map is the default
  const [healthFilter, setHealthFilter] = useState<HealthFilter>('');
  const [typeFilter, setTypeFilter]   = useState('');
  const [search, setSearch]           = useState('');
  useEffect(() => {
    fetchTopology()
      .then(setGraph)
      .catch((e) => { logger.error('Topology fetch failed', e); addToast('Failed to load topology', 'error'); })
      .finally(() => setLoading(false));
  }, [addToast]);

  const nodes = graph?.nodes ?? [];
  const edges = graph?.edges ?? [];

  const filteredNodes = nodes.filter((n) => {
    if (healthFilter && n.health !== healthFilter)   return false;
    if (typeFilter   && n.deviceType !== typeFilter) return false;
    if (search) {
      const q = search.toLowerCase();
      if (![n.serialNumber, n.ipAddress, n.deviceType].some((v) => (v ?? '').toLowerCase().includes(q))) return false;
    }
    return true;
  });

  const healthy  = nodes.filter((n) => n.health === 'HEALTHY').length;
  const degraded = nodes.filter((n) => n.health === 'DEGRADED').length;
  const faulty   = nodes.filter((n) => n.health === 'FAULTY').length;
  const withGps  = nodes.filter((n) => !!n.location).length;

  return (
    <div className="vf-page">
      <div className="vf-page-header">
        <h1 className="vf-page-title">Topology</h1>
        <div className="vf-page-actions">
          {/* View toggle */}
          {(['map', 'graph', 'list'] as View[]).map((v) => (
            <Button key={v} variant={view === v ? 'primary' : 'ghost'} size="sm" onClick={() => setView(v)}>
              {v === 'map' ? '🗺 Map' : v === 'graph' ? '⬡ Graph' : '☰ List'}
            </Button>
          ))}
        </div>
      </div>

      {/* KPIs */}
      <div className="vf-kpi-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))' }}>
        <MetricCard label="Total Nodes" value={nodes.length}   loading={loading} />
        <MetricCard label="Links"       value={edges.length}   loading={loading} />
        <MetricCard label="Healthy"     value={healthy}        variant="success"                              loading={loading} />
        <MetricCard label="Degraded"    value={degraded}       variant={degraded > 0 ? 'warning' : 'default'} loading={loading} />
        <MetricCard label="Faulty"      value={faulty}         variant={faulty   > 0 ? 'danger'  : 'default'} loading={loading} />
        <MetricCard label="GPS Located" value={withGps}        variant={withGps < nodes.length ? 'warning' : 'success'} loading={loading} />
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <input
          placeholder="Search nodes…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ padding: '6px 10px', fontSize: 13, background: 'var(--vf-input-bg)', border: '1px solid rgba(77,158,255,0.12)', borderRadius: 8, color: 'var(--vf-text-primary)', width: 200 }}
        />
        <Select options={HEALTH_OPTIONS} value={healthFilter} onChange={(e) => setHealthFilter(e.target.value as HealthFilter)} style={{ width: 140 }} />
        <Select
          options={[{ value: '', label: 'All types' }, { value: 'BTS', label: 'BTS' }, { value: 'CPE', label: 'CPE' }, { value: 'IDU', label: 'IDU' }]}
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
          style={{ width: 130 }}
        />
        <Button variant="ghost" size="sm" onClick={() => { setHealthFilter(''); setTypeFilter(''); setSearch(''); }}>Clear</Button>
        {filteredNodes.length !== nodes.length && (
          <span style={{ fontSize: 12, color: 'var(--vf-text-muted)' }}>Showing {filteredNodes.length} of {nodes.length}</span>
        )}
      </div>

      {/* Content */}
      {loading ? (
        <LoadingState label="Loading topology…" />
      ) : !graph || nodes.length === 0 ? (
        <EmptyState title="No topology data" description="No network topology has been discovered yet." />
      ) : view === 'map' ? (
        <IndiaMapView
          nodes={filteredNodes}
          edges={edges}
          onNodeClick={(n) => navigate(`/v2/devices/${n.deviceId || n.id}`, { state: { from: 'topology' } })}
        />
      ) : view === 'graph' ? (
        <TopologyGraphView nodes={filteredNodes} edges={edges} onNodeClick={(n) => navigate(`/v2/devices/${n.deviceId || n.id}`, { state: { from: 'topology' } })} />
      ) : (
        <TopologyListView nodes={filteredNodes} onNodeClick={(n) => navigate(`/v2/devices/${n.deviceId || n.id}`, { state: { from: 'topology' } })} />
      )}
    </div>
  );
}
