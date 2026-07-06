import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { TopologyNode, TopologyGraph as TGraph } from '../api/topology.types';
import type { Alarm } from '../api/alarms.types';
import type { Device } from '../api/devices.types';
import { fetchTopology, searchTopology } from '../api/topology.api';
import { fetchAlarms } from '../api/alarms.api';
import { searchByGps } from '../api/devices.api';
import { TopologyGraph2D } from '../components/topology/TopologyGraph2D';
import { TopologyMapView } from '../components/topology/TopologyMapView';

type ViewMode = 'graph' | 'map';
type DetailTab = 'info' | 'history';

const SEV_ICON: Record<string, string> = { CRITICAL: '⛔', MAJOR: '🔴', MINOR: '🟠', WARNING: '🟡', CLEAR: '🟢', INDETERMINATE: '⚪' };
const SEV_COLOR: Record<string, string> = { CRITICAL: '#fca5a5', MAJOR: '#fb923c', MINOR: '#fde68a', WARNING: '#93c5fd', CLEAR: '#86efac' };

const DEVICE_ICON: Record<string, string> = { BTS: '🗼', CPE: '📡', IDU: '🔌' };

export default function TopologyPage(): React.ReactElement {
  const navigate = useNavigate();
  const [graph, setGraph] = useState<TGraph>({ nodes: [], edges: [], nodeCount: 0, edgeCount: 0 });
  const [view, setView] = useState<ViewMode>('graph');
  const [loading, setLoading] = useState(false);
  const [networkId, setNetworkId] = useState('net-1');
  const [hovered, setHovered] = useState<TopologyNode | null>(null);
  const [selected, setSelected] = useState<TopologyNode | null>(null);
  const [search, setSearch] = useState('');
  const [highlightedId, setHighlightedId] = useState<string | undefined>();
  const [mapError, setMapError] = useState(false);

  // GPS radius search state (NMS-TP-02)
  const [gpsMode, setGpsMode] = useState(false);
  const [gpsLat, setGpsLat] = useState('');
  const [gpsLng, setGpsLng] = useState('');
  const [gpsRadius, setGpsRadius] = useState('1');
  const [gpsDevices, setGpsDevices] = useState<Device[]>([]);
  const [gpsLoading, setGpsLoading] = useState(false);
  const [gpsError, setGpsError] = useState<string | null>(null);

  // Event history state
  const [detailTab, setDetailTab] = useState<DetailTab>('info');
  const [historyAlarms, setHistoryAlarms] = useState<Alarm[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyRange, setHistoryRange] = useState<'24h' | '3d' | '7d'>('24h');

  useEffect(() => {
    if (!networkId) return;
    setLoading(true);
    fetchTopology(networkId).then(setGraph).catch(() => {}).finally(() => setLoading(false));
  }, [networkId]);

  // Load event history when a device is selected and history tab is open
  useEffect(() => {
    if (!selected || detailTab !== 'history') return;
    setHistoryLoading(true);
    const msMap = { '24h': 86_400_000, '3d': 259_200_000, '7d': 604_800_000 };
    const from = new Date(Date.now() - msMap[historyRange]).toISOString();
    fetchAlarms({ from })
      .then((a) => setHistoryAlarms(a.filter((x) => x.deviceId === selected.deviceId)))
      .catch(() => setHistoryAlarms([]))
      .finally(() => setHistoryLoading(false));
  }, [selected, detailTab, historyRange]);

  const handleSearch = async () => {
    if (!search.trim()) { setHighlightedId(undefined); return; }
    const results = await searchTopology({ search }).catch(() => []);
    if (results.length > 0) setHighlightedId(results[0].id);
  };

  const handleGpsSearch = async () => {
    const lat = parseFloat(gpsLat);
    const lng = parseFloat(gpsLng);
    const radius = parseFloat(gpsRadius) || 1;
    if (isNaN(lat) || isNaN(lng)) { setGpsError('Enter valid latitude and longitude.'); return; }
    setGpsLoading(true); setGpsError(null);
    searchByGps({ latitude: lat, longitude: lng, radiusKm: radius })
      .then(setGpsDevices)
      .catch(() => setGpsError('GPS search failed.'))
      .finally(() => setGpsLoading(false));
  };

  const handleNodeClick = (node: TopologyNode) => {
    setSelected(node);
    setDetailTab('info');
  };

  const showDetail = !!selected;

  const btnStyle = (active: boolean): React.CSSProperties => ({
    background: active ? '#1e3a5f' : 'none',
    border: `1px solid ${active ? '#60a5fa' : '#374151'}`,
    color: active ? '#60a5fa' : '#64748b',
    padding: '6px 14px', borderRadius: 4, cursor: 'pointer', fontSize: 13,
  });

  const effectiveView: ViewMode = (view === 'map' && mapError) ? 'graph' : view;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 56px - 48px)' }}>
      {/* Toolbar */}
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' as const }} role="toolbar" aria-label="Topology controls">
        <h2 style={{ color: '#e2e8f0', margin: 0 }}>Topology</h2>

        <div style={{ display: 'flex', gap: 4 }} role="group" aria-label="View mode">
          <button style={btnStyle(effectiveView === 'graph')} onClick={() => setView('graph')} aria-pressed={effectiveView === 'graph'}>📊 Graph</button>
          <button style={btnStyle(effectiveView === 'map')} onClick={() => { setView('map'); setMapError(false); }} aria-pressed={effectiveView === 'map'}>
            🗺 Map {mapError && <span style={{ color: '#f87171', fontSize: 11 }}>⚠</span>}
          </button>
        </div>

        <label htmlFor="topology-network-id" style={{ position: 'absolute', left: -9999, width: 1, height: 1, overflow: 'hidden' }}>Network ID</label>
        <input id="topology-network-id" aria-label="Network ID"
          style={{ background: '#0f172a', border: '1px solid #1e3a5f', borderRadius: 4, color: '#e2e8f0', padding: '6px 10px', fontSize: 13, width: 180 }}
          value={networkId} onChange={(e) => setNetworkId(e.target.value)} placeholder="Network ID" />

        <div style={{ display: 'flex', gap: 4 }} role="search" aria-label="Search topology nodes">
          <label htmlFor="topology-search" style={{ position: 'absolute', left: -9999, width: 1, height: 1, overflow: 'hidden' }}>Search</label>
          <input id="topology-search" aria-label="Search devices in topology"
            style={{ background: '#0f172a', border: '1px solid #1e3a5f', borderRadius: 4, color: '#e2e8f0', padding: '6px 10px', fontSize: 13, width: 200 }}
            value={search} onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleSearch(); }} placeholder="Search IP, MAC, serial…" />
          <button onClick={handleSearch} style={{ ...btnStyle(false), background: '#1e3a5f', color: '#60a5fa' }} aria-label="Search">Search</button>
        </div>

        <span style={{ color: '#64748b', fontSize: 13 }} aria-live="polite">
          {loading ? 'Loading…' : graph.nodeCount === 0 ? 'No nodes' : `${graph.nodeCount} nodes · ${graph.edgeCount} links`}
        </span>
      </div>

      {mapError && view === 'map' && (
        <div role="alert" style={{ background: '#1e3a5f', border: '1px solid #2563eb', borderRadius: 6, padding: '8px 14px', marginBottom: 10, color: '#93c5fd', fontSize: 13 }}>
          🗺 Map unavailable — showing graph view.
        </div>
      )}

      {/* GPS Radius search (NMS-TP-02) */}
      <div style={{ background: '#0d1b2a', border: '1px solid #1e293b', borderRadius: 6, padding: '8px 14px', marginBottom: 10, display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <button onClick={() => setGpsMode((v) => !v)}
          style={{ background: gpsMode ? '#1e3a5f' : 'none', border: '1px solid #374151', color: gpsMode ? '#60a5fa' : '#64748b', padding: '4px 10px', borderRadius: 4, cursor: 'pointer', fontSize: 12 }}>
          📍 GPS Radius Search
        </button>
        {gpsMode && (
          <>
            <div>
              <label style={{ color: '#64748b', fontSize: 10, display: 'block', marginBottom: 2 }}>Latitude</label>
              <input value={gpsLat} onChange={(e) => setGpsLat(e.target.value)} placeholder="28.4595"
                style={{ background: '#0f172a', border: '1px solid #1e3a5f', borderRadius: 4, color: '#e2e8f0', padding: '4px 8px', fontSize: 12, width: 90 }} />
            </div>
            <div>
              <label style={{ color: '#64748b', fontSize: 10, display: 'block', marginBottom: 2 }}>Longitude</label>
              <input value={gpsLng} onChange={(e) => setGpsLng(e.target.value)} placeholder="77.0266"
                style={{ background: '#0f172a', border: '1px solid #1e3a5f', borderRadius: 4, color: '#e2e8f0', padding: '4px 8px', fontSize: 12, width: 90 }} />
            </div>
            <div>
              <label style={{ color: '#64748b', fontSize: 10, display: 'block', marginBottom: 2 }}>Radius (km)</label>
              <input value={gpsRadius} onChange={(e) => setGpsRadius(e.target.value)} placeholder="1"
                style={{ background: '#0f172a', border: '1px solid #1e3a5f', borderRadius: 4, color: '#e2e8f0', padding: '4px 8px', fontSize: 12, width: 60 }} />
            </div>
            <button onClick={handleGpsSearch} disabled={gpsLoading}
              style={{ background: '#1e3a5f', border: 'none', color: '#60a5fa', padding: '5px 12px', borderRadius: 4, cursor: gpsLoading ? 'not-allowed' : 'pointer', fontSize: 12 }}>
              {gpsLoading ? 'Searching…' : 'Search'}
            </button>
            {gpsDevices.length > 0 && (
              <button onClick={() => { setGpsDevices([]); setGpsMode(false); }}
                style={{ background: 'none', border: '1px solid #374151', color: '#9ca3af', padding: '4px 10px', borderRadius: 4, cursor: 'pointer', fontSize: 12 }}>
                Clear ×
              </button>
            )}
            {gpsError && <span style={{ color: '#f87171', fontSize: 12 }}>{gpsError}</span>}
            {gpsDevices.length > 0 && <span style={{ color: '#60a5fa', fontSize: 12 }}>{gpsDevices.length} devices within {gpsRadius} km</span>}
          </>
        )}
      </div>

      {/* GPS results list */}
      {gpsMode && gpsDevices.length > 0 && (
        <div style={{ background: '#0d1b2a', border: '1px solid #1e293b', borderRadius: 6, padding: 10, marginBottom: 10, maxHeight: 160, overflowY: 'auto' }}>
          <div style={{ color: '#64748b', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 6 }}>
            Devices within {gpsRadius} km
          </div>
          {gpsDevices.map((d) => (
            <div key={d.id} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '3px 0', borderBottom: '1px solid #0f172a', cursor: 'pointer' }}
              onClick={() => setHighlightedId(d.id)}>
              <span style={{ color: d.status === 'ONLINE' ? '#22c55e' : '#ef4444', fontSize: 10 }}>●</span>
              <span style={{ color: '#e2e8f0', fontSize: 12, fontFamily: 'monospace' }}>{d.serialNumber}</span>
              <span style={{ color: '#64748b', fontSize: 11 }}>{d.ipAddress}</span>
              <span style={{ color: '#475569', fontSize: 10 }}>{d.deviceType}</span>
            </div>
          ))}
        </div>
      )}

      <div style={{ flex: 1, display: 'flex', gap: 12, minHeight: 0 }}>
        {/* Main graph/map */}
        <div style={{ flex: 1, borderRadius: 8, overflow: 'hidden' }}>
          {loading && <LoadingBox msg="Loading topology…" />}
          {!loading && graph.nodeCount === 0 && <EmptyBox icon="🗺" title="No topology data" sub="Enter a Network ID above." />}
          {!loading && graph.nodeCount > 0 && effectiveView === 'graph' && (
            <TopologyGraph2D graph={graph} highlightedId={highlightedId} onNodeClick={handleNodeClick} onNodeHover={setHovered} />
          )}
          {!loading && graph.nodeCount > 0 && effectiveView === 'map' && (
            <TopologyMapView nodes={graph.nodes} highlightedId={highlightedId} onNodeClick={handleNodeClick} onError={() => setMapError(true)} />
          )}
        </div>

        {/* Detail / History panel */}
        {showDetail && selected && (
          <div style={{ width: 300, background: '#0d1b2a', border: '1px solid #1e293b', borderRadius: 8, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            {/* Panel header */}
            <div style={{ padding: '12px 16px', borderBottom: '1px solid #1e293b' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <strong style={{ color: '#60a5fa', fontSize: 13 }}>
                  <span aria-hidden="true">{DEVICE_ICON[selected.deviceType] ?? '📡'} </span>
                  {selected.deviceType} — {selected.deviceId}
                </strong>
                <div style={{ display: 'flex', gap: 4 }}>
                  <button onClick={() => navigate(`/devices/${selected.id}`)} style={{ background: 'none', border: 'none', color: '#60a5fa', cursor: 'pointer', fontSize: 11 }}>Detail →</button>
                  <button onClick={() => setSelected(null)} style={{ background: 'none', border: 'none', color: '#64748b', cursor: 'pointer', fontSize: 16 }}>✕</button>
                </div>
              </div>
              {/* Tab switcher */}
              <div style={{ display: 'flex', gap: 4 }}>
                {(['info', 'history'] as DetailTab[]).map((t) => (
                  <button key={t} onClick={() => setDetailTab(t)}
                    style={{ background: detailTab === t ? '#1e3a5f' : 'none', border: `1px solid ${detailTab === t ? '#60a5fa' : '#374151'}`, color: detailTab === t ? '#60a5fa' : '#64748b', padding: '3px 10px', borderRadius: 4, cursor: 'pointer', fontSize: 11, textTransform: 'capitalize' }}>
                    {t === 'history' ? '📋 Event History' : 'ℹ Info'}
                  </button>
                ))}
              </div>
            </div>

            {/* Info tab */}
            {detailTab === 'info' && (
              <div style={{ padding: '12px 16px', overflowY: 'auto', flex: 1, fontSize: 12 }}>
                <DetailRow label="Serial" value={selected.serialNumber} />
                <DetailRow label="IP Address" value={selected.ipAddress} />
                <DetailRow label="MAC Address" value={selected.macAddress} />
                {selected.operatingChannel && <DetailRow label="Channel" value={selected.operatingChannel} />}
                {selected.rssi !== undefined && <DetailRow label="RSSI" value={`${selected.rssi} dBm`} />}
                {selected.snr !== undefined && <DetailRow label="SNR" value={`${selected.snr} dB`} />}
                {selected.firmwareVersion && <DetailRow label="Firmware" value={selected.firmwareVersion} />}
                {selected.uptime && <DetailRow label="Uptime" value={selected.uptime} />}
                <DetailRow label="Health" value={selected.health} />
                {(selected.pendingCommandCount ?? 0) > 0 && (
                  <div style={{ marginTop: 8, background: '#78350f', border: '1px solid #f59e0b', borderRadius: 4, padding: '4px 8px', color: '#fcd34d', fontSize: 11 }}>
                    ⏳ {selected.pendingCommandCount} pending commands queued
                  </div>
                )}
              </div>
            )}

            {/* Event history tab */}
            {detailTab === 'history' && (
              <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
                {/* Range selector */}
                <div style={{ padding: '8px 16px', borderBottom: '1px solid #1e293b', display: 'flex', gap: 4, alignItems: 'center' }}>
                  <span style={{ color: '#64748b', fontSize: 11 }}>Range:</span>
                  {(['24h', '3d', '7d'] as const).map((r) => (
                    <button key={r} onClick={() => setHistoryRange(r)}
                      style={{ background: historyRange === r ? '#1e3a5f' : 'none', border: `1px solid ${historyRange === r ? '#60a5fa' : '#374151'}`, color: historyRange === r ? '#60a5fa' : '#64748b', padding: '2px 8px', borderRadius: 3, cursor: 'pointer', fontSize: 11 }}>
                      {r}
                    </button>
                  ))}
                  <span style={{ marginLeft: 'auto', color: '#475569', fontSize: 11 }}>{historyAlarms.length} events</span>
                </div>

                <div style={{ flex: 1, overflowY: 'auto', padding: '8px 0' }}>
                  {historyLoading && (
                    <div style={{ textAlign: 'center', padding: 24, color: '#60a5fa', fontSize: 12 }}>Loading history…</div>
                  )}
                  {!historyLoading && historyAlarms.length === 0 && (
                    <div style={{ textAlign: 'center', padding: 24 }}>
                      <div style={{ fontSize: 24, marginBottom: 8 }}>📋</div>
                      <div style={{ color: '#94a3b8', fontSize: 12 }}>No events in last {historyRange}</div>
                    </div>
                  )}
                  {!historyLoading && historyAlarms.map((a) => (
                    <div key={a.id} style={{ padding: '7px 16px', borderBottom: '1px solid #0f172a' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                        <span aria-hidden="true">{SEV_ICON[a.severity] ?? '⚪'}</span>
                        <span style={{ color: SEV_COLOR[a.severity] ?? '#94a3b8', fontSize: 11, fontWeight: 700 }}>{a.severity}</span>
                        <span style={{ color: a.state === 'ACTIVE' ? '#f87171' : a.state === 'ACKNOWLEDGED' ? '#fcd34d' : '#86efac', fontSize: 10, marginLeft: 'auto' }}>
                          {a.state}
                        </span>
                      </div>
                      <div style={{ color: '#cbd5e1', fontSize: 12 }}>{a.alarmName}</div>
                      <time style={{ color: '#475569', fontSize: 10 }} dateTime={a.timestamp}>
                        {new Date(a.timestamp).toLocaleString()}
                      </time>
                      {a.clearedAt && (
                        <div style={{ color: '#475569', fontSize: 10 }}>Cleared: {new Date(a.clearedAt).toLocaleString()}</div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Hover tooltip (when no selection) */}
        {!showDetail && hovered && (
          <div style={{ width: 240, background: '#0d1b2a', border: '1px solid #1e293b', borderRadius: 8, padding: 14, overflowY: 'auto', fontSize: 12 }}>
            <div style={{ color: '#60a5fa', fontWeight: 700, marginBottom: 10 }}>
              <span aria-hidden="true">{DEVICE_ICON[hovered.deviceType] ?? '📡'} </span>
              {hovered.deviceType} — {hovered.deviceId}
            </div>
            <DetailRow label="Serial" value={hovered.serialNumber} />
            <DetailRow label="IP" value={hovered.ipAddress} />
            {hovered.rssi !== undefined && <DetailRow label="RSSI" value={`${hovered.rssi} dBm`} />}
            {hovered.snr !== undefined && <DetailRow label="SNR" value={`${hovered.snr} dB`} />}
            <DetailRow label="Health" value={hovered.health} />
            <div style={{ color: '#475569', fontSize: 10, marginTop: 8 }}>Click to pin & view history</div>
          </div>
        )}
      </div>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0', borderBottom: '1px solid #0f172a' }}>
      <span style={{ color: '#64748b', fontSize: 11 }}>{label}</span>
      <span style={{ color: '#cbd5e1', fontSize: 12, fontFamily: 'monospace', textAlign: 'right', maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value}</span>
    </div>
  );
}

function LoadingBox({ msg }: { msg: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', background: '#0d1b2a', borderRadius: 8 }}>
      <div style={{ textAlign: 'center' }}>
        <div style={{ color: '#60a5fa', fontSize: 24, marginBottom: 10 }}>↻</div>
        <div style={{ color: '#94a3b8', fontSize: 13 }}>{msg}</div>
      </div>
    </div>
  );
}

function EmptyBox({ icon, title, sub }: { icon: string; title: string; sub: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', background: '#0d1b2a', borderRadius: 8 }}>
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: 40, marginBottom: 10 }}>{icon}</div>
        <div style={{ color: '#94a3b8', fontWeight: 600, marginBottom: 4 }}>{title}</div>
        <div style={{ color: '#475569', fontSize: 12 }}>{sub}</div>
      </div>
    </div>
  );
}
