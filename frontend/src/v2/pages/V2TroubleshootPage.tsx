/**
 * V2 Diagnostics & Troubleshooting — NMS-AS-04 / AS-05 / AS-06 / AS-08
 *
 * Tabs:
 *  1. Log Extraction  (NMS-AS-04) — extract filtered logs from a device
 *  2. Speed Test      (NMS-AS-05) — source→target link speed test
 *  3. Spectrum        (NMS-AS-08) — live 5 GHz spectrum waterfall
 *  4. Missing Data    (NMS-AS-06) — devices with missing KPI cycles
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  extractDeviceLogs, triggerSpeedTest, triggerSpectrumAnalysis, fetchMissingDataReport,
} from '../../api/diagnostics.api';
import type { LogEntry, SpeedTestResult, SpectrumResult, MissingDataEntry } from '../../api/diagnostics.api';
import { fetchDevices } from '../../api/devices.api';
import type { Device } from '../../api/devices.types';
import { Badge } from '../components/common/Badge';
import { Button } from '../components/common/Button';
import { Select } from '../components/common/Select';
import { MetricCard } from '../components/common/MetricCard';
import { LoadingState, EmptyState } from '../components/common/States';
import { useToast } from '../components/common/Toast';
import { logger } from '../utils/logger';

type DiagTab = 'logs' | 'speed' | 'spectrum' | 'missing';

const TABS: { id: DiagTab; label: string; sub: string }[] = [
  { id: 'logs',     label: 'Log Extraction',   sub: 'NMS-AS-04' },
  { id: 'speed',    label: 'Speed Test',        sub: 'NMS-AS-05' },
  { id: 'spectrum', label: 'Spectrum Analysis', sub: 'NMS-AS-08' },
  { id: 'missing',  label: 'Missing Data',      sub: 'NMS-AS-06' },
];

// ── Tab bar ───────────────────────────────────────────────────────────────────
function TabBtn({ tab, active, onClick }: { tab: typeof TABS[0]; active: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} style={{
      padding: '10px 18px', border: 'none',
      background: active ? 'var(--vf-accent)' : 'var(--vf-elevated)',
      borderRadius: 8, cursor: 'pointer', transition: 'all 0.15s',
      color: active ? '#fff' : 'var(--vf-text-secondary)',
      boxShadow: active ? '0 2px 8px rgba(79,70,229,0.3)' : 'none',
      display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 2,
    }}>
      <span style={{ fontSize: 13, fontWeight: active ? 700 : 500 }}>{tab.label}</span>
      <span style={{ fontSize: 10, opacity: 0.7 }}>{tab.sub}</span>
    </button>
  );
}

// ── Shared field label ────────────────────────────────────────────────────────
function FL({ children }: { children: React.ReactNode }) {
  return <label style={{ fontSize: 11, fontWeight: 700, color: 'var(--vf-text-muted)', display: 'block', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.06em' }}>{children}</label>;
}

const CTRL = { background: 'var(--vf-surface)', border: 'var(--vf-card-border)', borderRadius: 10, padding: '16px 20px', display: 'flex', gap: 14, alignItems: 'flex-end', flexWrap: 'wrap' as const, boxShadow: 'var(--vf-shadow-low)' };

// ── Shared device loader hook ─────────────────────────────────────────────────
function useDevices() {
  const [devices, setDevices] = useState<Device[]>([]);
  useEffect(() => { fetchDevices({}).then(setDevices).catch(() => {}); }, []);
  return devices;
}

function DeviceOpts(devices: Device[], placeholder = 'Select device…') {
  return [
    { value: '', label: placeholder },
    ...devices.map((d) => ({ value: d.id, label: `${d.serialNumber} — ${d.ipAddress} (${d.deviceType})` })),
  ];
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. Log Extraction (NMS-AS-04)
// ═══════════════════════════════════════════════════════════════════════════════
const LOG_LEVEL_OPTIONS = [
  { value: '', label: 'All Logs' }, { value: 'DEBUG', label: 'DEBUG' },
  { value: 'INFO', label: 'INFO' }, { value: 'WARN', label: 'WARN' }, { value: 'ERROR', label: 'ERROR' },
];
const TIME_RANGE_OPTIONS = [
  { value: '2', label: 'Last 2h' }, { value: '6', label: 'Last 6h' },
  { value: '12', label: 'Last 12h' }, { value: '24', label: 'Last 24h' },
];
const LEVEL_COLOR: Record<string, string> = { ERROR: '#f87171', WARN: '#fbbf24', INFO: '#60a5fa', DEBUG: 'var(--vf-text-muted)' };

function LogsTab() {
  const { addToast } = useToast();
  const devices = useDevices();
  const [deviceId, setDeviceId] = useState('');
  const [level, setLevel]       = useState('');
  const [lines, setLines]       = useState(200);
  const [timeRange, setTimeRange] = useState('2');
  const [logs, setLogs]         = useState<LogEntry[]>([]);
  const [loading, setLoading]   = useState(false);

  const run = async () => {
    if (!deviceId) { addToast('Select a device first', 'warning'); return; }
    setLoading(true);
    try {
      const result = await extractDeviceLogs({ deviceId, lines, level: (level || undefined) as 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | undefined });
      setLogs(result);
      addToast(`${result.length} log entries retrieved`, 'success');
    } catch (e) { logger.error('Log extraction failed', e); addToast('Failed to extract logs', 'error'); }
    finally { setLoading(false); }
  };

  const downloadLogs = () => {
    const text = logs.map((l) => `${l.timestamp} [${l.level}]${l.source ? ` [${l.source}]` : ''} ${l.message}`).join('\n');
    const blob = new Blob([text], { type: 'text/plain' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = `device-logs-${deviceId}.txt`; a.click();
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={CTRL}>
        <div>
          <FL>Device</FL>
          <Select options={DeviceOpts(devices)} value={deviceId} onChange={(e) => setDeviceId(e.target.value)} disabled={loading} style={{ minWidth: 280 }} />
        </div>
        <div>
          <FL>Log Type</FL>
          <Select options={LOG_LEVEL_OPTIONS} value={level} onChange={(e) => setLevel(e.target.value)} style={{ width: 140 }} disabled={loading} />
        </div>
        <div>
          <FL>Time Range (hours)</FL>
          <Select options={TIME_RANGE_OPTIONS} value={timeRange} onChange={(e) => setTimeRange(e.target.value)} style={{ width: 130 }} disabled={loading} />
        </div>
        <div>
          <FL>Lines</FL>
          <select value={lines} onChange={(e) => setLines(Number(e.target.value))} disabled={loading}
            style={{ background: 'var(--vf-input-bg)', border: 'var(--vf-card-border)', borderRadius: 7, color: 'var(--vf-text-primary)', padding: '7px 10px', fontSize: 13, width: 100 }}>
            {[100, 200, 500, 1000].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>
        <Button variant="primary" onClick={run} loading={loading} disabled={!deviceId}>Extract Logs</Button>
        {logs.length > 0 && <Button variant="ghost" size="sm" onClick={downloadLogs}>⬇ Download</Button>}
      </div>

      {loading ? <LoadingState label="Extracting logs…" /> : logs.length === 0 ? (
        <EmptyState title="No logs" description="Select a device and click Extract Logs." icon={<span>📋</span>} />
      ) : (
        <>
          <div style={{ display: 'flex', gap: 8, fontSize: 12, color: 'var(--vf-text-muted)' }}>
            <span>{logs.length} entries</span>
            {(['ERROR','WARN','INFO','DEBUG'] as const).map((lv) => {
              const n = logs.filter((l) => l.level === lv).length;
              return n > 0 ? <span key={lv} style={{ color: LEVEL_COLOR[lv] }}>{n} {lv}</span> : null;
            })}
          </div>
          <div style={{ background: '#050d17', border: '1px solid rgba(77,158,255,0.1)', borderRadius: 10, padding: '12px 16px', fontFamily: 'var(--vf-font-mono)', fontSize: 12, maxHeight: 500, overflowY: 'auto' }}>
            {logs.map((l, i) => (
              <div key={i} style={{ display: 'flex', gap: 10, padding: '2px 0', borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
                <span style={{ color: 'rgba(148,163,184,0.5)', whiteSpace: 'nowrap', flexShrink: 0, fontSize: 11 }}>{new Date(l.timestamp).toISOString().replace('T', ' ').slice(0, 19)}</span>
                <span style={{ color: LEVEL_COLOR[l.level] ?? 'var(--vf-text-muted)', fontWeight: 700, width: 46, flexShrink: 0 }}>{l.level}</span>
                {l.source && <span style={{ color: '#a78bfa', flexShrink: 0, fontSize: 11 }}>[{l.source}]</span>}
                <span style={{ color: '#e2e8f0' }}>{l.message}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// 2. Speed Test (NMS-AS-05)
// ═══════════════════════════════════════════════════════════════════════════════
const DURATION_OPTIONS = [
  { value: '30', label: '30s' }, { value: '60', label: '1m' },
  { value: '120', label: '2m' }, { value: '300', label: '5m' },
];
const TEST_TYPE_OPTIONS = [
  { value: 'BIDIRECTIONAL', label: 'Bidirectional' },
  { value: 'UPLOAD', label: 'Upload Only' },
  { value: 'DOWNLOAD', label: 'Download Only' },
];

function SpeedTab() {
  const { addToast } = useToast();
  const devices = useDevices();
  const [srcId, setSrcId]       = useState('');
  const [tgtId, setTgtId]       = useState('');
  const [duration, setDuration] = useState('30');
  const [testType, setTestType] = useState('BIDIRECTIONAL');
  const [result, setResult]     = useState<SpeedTestResult | null>(null);
  const [loading, setLoading]   = useState(false);

  const run = async () => {
    if (!srcId) { addToast('Select source device first', 'warning'); return; }
    setLoading(true); setResult(null);
    try {
      const r = await triggerSpeedTest(srcId);
      setResult(r);
      addToast('Speed test complete', r.status === 'SUCCESS' ? 'success' : 'warning');
    } catch (e) { logger.error('Speed test failed', e); addToast('Speed test failed', 'error'); }
    finally { setLoading(false); }
  };

  const cpeDevices = devices.filter((d) => d.deviceType === 'CPE');
  const btsDevices = devices.filter((d) => d.deviceType === 'BTS');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Config panel */}
      <div style={{ background: 'var(--vf-surface)', border: 'var(--vf-card-border)', borderRadius: 10, padding: '20px 24px', boxShadow: 'var(--vf-shadow-low)' }}>
        <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--vf-text-muted)', marginBottom: 14 }}>Speed Test Configuration</div>
        <div style={{ display: 'flex', gap: 14, alignItems: 'flex-end', flexWrap: 'wrap' as const }}>
          <div>
            <FL>Source Device</FL>
            <Select options={DeviceOpts(btsDevices.length ? btsDevices : devices, 'Source device…')} value={srcId} onChange={(e) => setSrcId(e.target.value)} disabled={loading} style={{ minWidth: 240 }} />
          </div>
          <div>
            <FL>Target (CPE)</FL>
            <Select options={DeviceOpts(cpeDevices.length ? cpeDevices : devices, 'Target device…')} value={tgtId} onChange={(e) => setTgtId(e.target.value)} disabled={loading} style={{ minWidth: 240 }} />
          </div>
          <div>
            <FL>Duration</FL>
            <Select options={DURATION_OPTIONS} value={duration} onChange={(e) => setDuration(e.target.value)} style={{ width: 100 }} disabled={loading} />
          </div>
          <div>
            <FL>Test Type</FL>
            <Select options={TEST_TYPE_OPTIONS} value={testType} onChange={(e) => setTestType(e.target.value)} style={{ width: 170 }} disabled={loading} />
          </div>
          <Button variant="primary" onClick={run} loading={loading} disabled={!srcId}>▶ Run Speed Test</Button>
        </div>
      </div>

      {loading && <LoadingState label={`Running ${testType.toLowerCase().replace('_',' ')} speed test… (~${duration}s)`} />}

      {result && (
        <>
          <div className="vf-kpi-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))' }}>
            {testType !== 'UPLOAD'   && <MetricCard label="Download"    value={`${result.downloadMbps} Mbps`} variant="success" />}
            {testType !== 'DOWNLOAD' && <MetricCard label="Upload"      value={`${result.uploadMbps} Mbps`}  variant="success" />}
            <MetricCard label="Latency"     value={`${result.latencyMs} ms`}    variant={result.latencyMs > 100 ? 'warning' : 'default'} />
            <MetricCard label="Packet Loss" value={`${result.packetLossPct}%`}  variant={result.packetLossPct > 1 ? 'danger' : 'default'} />
          </div>
          <div style={{ background: 'var(--vf-surface)', border: 'var(--vf-card-border)', borderRadius: 10, padding: '14px 20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 13, color: 'var(--vf-text-secondary)' }}>Tested at: {new Date(result.testedAt).toLocaleString()}</span>
            <Badge variant={result.status === 'SUCCESS' ? 'success' : 'danger'} dot>{result.status}</Badge>
          </div>
        </>
      )}

      {!loading && !result && (
        <EmptyState title="No results yet" description="Configure the test above and click Run Speed Test." icon={<span>⚡</span>} />
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// 3. Spectrum Analysis — Live (NMS-AS-08)
// ═══════════════════════════════════════════════════════════════════════════════
function SpectrumTab() {
  const { addToast } = useToast();
  const devices = useDevices();
  const [deviceId, setDeviceId] = useState('');
  const [result, setResult]     = useState<SpectrumResult | null>(null);
  const [loading, setLoading]   = useState(false);
  const [live, setLive]         = useState(false);
  const [connected, setConnected] = useState(false);
  const liveTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchOnce = useCallback(async () => {
    if (!deviceId) return;
    try {
      const r = await triggerSpectrumAnalysis(deviceId);
      setResult(r);
    } catch { /* silent in live mode */ }
  }, [deviceId]);

  const startLive = () => {
    if (!deviceId) { addToast('Select a device first', 'warning'); return; }
    setLive(true);
    setConnected(true);
    fetchOnce();
    liveTimer.current = setInterval(fetchOnce, 2000);
    addToast('Live spectrum stream started', 'success');
  };

  const stopLive = () => {
    if (liveTimer.current) { clearInterval(liveTimer.current); liveTimer.current = null; }
    setLive(false); setConnected(false);
    addToast('Live stream stopped', 'info');
  };

  const runOnce = async () => {
    if (!deviceId) { addToast('Select a device first', 'warning'); return; }
    setLoading(true); setResult(null);
    try {
      const r = await triggerSpectrumAnalysis(deviceId);
      setResult(r);
      addToast('Spectrum analysis complete', 'success');
    } catch (e) { logger.error('Spectrum analysis failed', e); addToast('Spectrum analysis failed', 'error'); }
    finally { setLoading(false); }
  };

  useEffect(() => () => { if (liveTimer.current) clearInterval(liveTimer.current); }, []);

  const maxPower = result ? Math.max(...result.buckets.map((b) => b.powerDbm)) : -40;
  const minPower = result ? Math.min(...result.buckets.map((b) => b.powerDbm)) : -100;
  const range    = maxPower - minPower || 1;
  const btsDevices = devices.filter((d) => d.deviceType === 'BTS');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ background: 'var(--vf-surface)', border: 'var(--vf-card-border)', borderRadius: 10, padding: '16px 20px', boxShadow: 'var(--vf-shadow-low)' }}>
        <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--vf-text-muted)', marginBottom: 14 }}>Spectrum Analysis — 5 GHz Band</div>
        <div style={{ display: 'flex', gap: 14, alignItems: 'flex-end', flexWrap: 'wrap' as const }}>
          <div>
            <FL>Device (BTS)</FL>
            <Select options={DeviceOpts(btsDevices.length ? btsDevices : devices, 'Select BTS device…')} value={deviceId} onChange={(e) => { setDeviceId(e.target.value); if (live) stopLive(); }} disabled={live} style={{ minWidth: 280 }} />
          </div>
          {/* Live subscribe */}
          {!live ? (
            <Button variant="primary" onClick={startLive} disabled={!deviceId}>
              <span style={{ marginRight: 6 }}>●</span> Subscribe (Live)
            </Button>
          ) : (
            <Button variant="danger" onClick={stopLive}>
              <span style={{ marginRight: 6 }}>■</span> Stop Live
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={runOnce} loading={loading} disabled={!deviceId || live}>Single Capture</Button>

          {/* Connection status */}
          <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: connected ? '#22c55e' : 'var(--vf-text-muted)' }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: connected ? '#22c55e' : '#475569', display: 'inline-block' }} />
            {connected ? 'Live · Updates every 2s' : 'Disconnected'}
          </span>
        </div>
      </div>

      {loading && !live && <LoadingState label="Capturing spectrum… 30–60s" />}

      {result && (
        <>
          <div style={{ background: '#050d17', border: '1px solid rgba(77,158,255,0.12)', borderRadius: 10, padding: '16px', overflow: 'hidden' }}>
            {/* Header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'rgba(148,163,184,0.6)', marginBottom: 10, fontFamily: 'var(--vf-font-mono)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              <span>Frequency vs. Signal Power — {deviceId.toUpperCase()}</span>
              <span>{result.buckets[0]?.frequencyMHz}–{result.buckets[result.buckets.length - 1]?.frequencyMHz} MHz{live ? ' · Updates every 2s' : ''}</span>
            </div>

            {/* Y-axis + bars */}
            <div style={{ display: 'flex', gap: 6 }}>
              {/* Y-axis labels */}
              <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between', fontSize: 10, color: 'rgba(148,163,184,0.5)', fontFamily: 'var(--vf-font-mono)', height: 160, marginRight: 4, flexShrink: 0 }}>
                <span>{maxPower.toFixed(0)}</span>
                <span>{((maxPower + minPower) / 2).toFixed(0)}</span>
                <span>{minPower.toFixed(0)}</span>
              </div>
              {/* Bars */}
              <div style={{ flex: 1, display: 'flex', alignItems: 'flex-end', gap: 1, height: 160, overflowX: 'auto' }}>
                {result.buckets.map((b) => {
                  const h = ((b.powerDbm - minPower) / range) * 100;
                  const util = b.channelUtilizationPct ?? 0;
                  const color = util > 80 ? '#ef4444' : util > 50 ? '#f59e0b' : '#22c55e';
                  return (
                    <div key={b.frequencyMHz} title={`${b.frequencyMHz} MHz\n${b.powerDbm} dBm\n${util}% util`}
                      style={{ flex: '0 0 8px', background: color, height: `${Math.max(3, h)}%`, borderRadius: '2px 2px 0 0', opacity: 0.85, transition: 'height 0.4s ease' }} />
                  );
                })}
              </div>
            </div>

            {/* X-axis */}
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6, fontSize: 10, color: 'rgba(148,163,184,0.5)', fontFamily: 'var(--vf-font-mono)', paddingLeft: 28 }}>
              <span>{result.buckets[0]?.frequencyMHz} MHz</span>
              <span style={{ color: 'rgba(148,163,184,0.4)' }}>Frequency →</span>
              <span>{result.buckets[result.buckets.length - 1]?.frequencyMHz} MHz</span>
            </div>

            {/* Legend */}
            <div style={{ display: 'flex', gap: 16, marginTop: 10, fontSize: 11, paddingLeft: 28 }}>
              {[['#22c55e','Signal'],['#f59e0b',`Peak (> ${(minPower + range * 0.5).toFixed(0)} dBm)`]].map(([c, l]) => (
                <span key={l} style={{ display: 'flex', alignItems: 'center', gap: 5, color: 'rgba(148,163,184,0.7)' }}>
                  <span style={{ width: 10, height: 3, background: c, borderRadius: 2, display: 'inline-block' }} />{l}
                </span>
              ))}
            </div>
          </div>

          {/* Bucket table */}
          <details style={{ border: 'var(--vf-card-border)', borderRadius: 10, overflow: 'hidden' }}>
            <summary style={{ padding: '10px 16px', cursor: 'pointer', background: 'var(--vf-surface)', fontSize: 12, fontWeight: 600, color: 'var(--vf-text-secondary)' }}>
              Frequency Table ({result.buckets.length} buckets)
            </summary>
            <div style={{ overflowX: 'auto', maxHeight: 300, overflowY: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ background: 'var(--vf-elevated)' }}>
                    {['Frequency (MHz)','Power (dBm)','Utilization'].map((h) => (
                      <th key={h} style={{ padding: '8px 12px', textAlign: 'left', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--vf-text-muted)', borderBottom: 'var(--vf-card-border)', whiteSpace: 'nowrap' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.buckets.map((b) => (
                    <tr key={b.frequencyMHz} style={{ borderBottom: 'var(--vf-card-border)' }}>
                      <td style={{ padding: '6px 12px', fontFamily: 'var(--vf-font-mono)', color: 'var(--vf-text-primary)' }}>{b.frequencyMHz}</td>
                      <td style={{ padding: '6px 12px', fontFamily: 'var(--vf-font-mono)', color: b.powerDbm === maxPower ? '#f87171' : 'var(--vf-text-secondary)' }}>{b.powerDbm}</td>
                      <td style={{ padding: '6px 12px' }}>
                        {b.channelUtilizationPct != null ? (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <div style={{ flex: 1, height: 4, background: 'var(--vf-elevated)', borderRadius: 2, maxWidth: 100 }}>
                              <div style={{ height: '100%', width: `${b.channelUtilizationPct}%`, background: b.channelUtilizationPct > 80 ? '#ef4444' : b.channelUtilizationPct > 50 ? '#fbbf24' : '#22c55e', borderRadius: 2 }} />
                            </div>
                            <span style={{ color: 'var(--vf-text-secondary)', minWidth: 36 }}>{b.channelUtilizationPct}%</span>
                          </div>
                        ) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      )}

      {!loading && !result && (
        <EmptyState title="No spectrum data" description="Select a BTS device, then click Subscribe (Live) or Single Capture." icon={<span>📡</span>} />
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// 4. Missing Data (NMS-AS-06)
// ═══════════════════════════════════════════════════════════════════════════════
function MissingDataTab() {
  const { addToast } = useToast();
  const [entries, setEntries]     = useState<MissingDataEntry[]>([]);
  const [loading, setLoading]     = useState(true);
  const [minMissed, setMinMissed] = useState(0);

  const load = useCallback(() => {
    setLoading(true);
    fetchMissingDataReport()
      .then(setEntries)
      .catch(() => addToast('Failed to load missing data report', 'error'))
      .finally(() => setLoading(false));
  }, [addToast]);

  useEffect(load, [load]);

  const filtered = entries.filter((e) => e.missedCycles >= minMissed);
  const critical = entries.filter((e) => e.missedCycles >= 10).length;

  const exportCsv = () => {
    const rows = ['Device ID,Serial Number,Last Reported,Missed Cycles',
      ...filtered.map((e) => `${e.deviceId},${e.serialNumber},${e.lastReportedAt ?? 'Never'},${e.missedCycles}`)];
    const blob = new Blob([rows.join('\n')], { type: 'text/csv' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'missing-data.csv'; a.click();
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="vf-kpi-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))' }}>
        <MetricCard label="Affected Devices" value={entries.length} loading={loading} />
        <MetricCard label="Critical (≥10)" value={critical} variant={critical > 0 ? 'danger' : 'default'} loading={loading} />
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' as const }}>
        <label style={{ fontSize: 12, color: 'var(--vf-text-muted)' }}>Min missed cycles:</label>
        <select value={minMissed} onChange={(e) => setMinMissed(Number(e.target.value))}
          style={{ background: 'var(--vf-input-bg)', border: 'var(--vf-card-border)', borderRadius: 7, color: 'var(--vf-text-primary)', padding: '5px 10px', fontSize: 13 }}>
          {[0,1,3,5,10].map((n) => <option key={n} value={n}>{n}+</option>)}
        </select>
        <div style={{ flex: 1 }} />
        <Button variant="ghost" size="sm" onClick={load}>↻ Refresh</Button>
        <Button variant="ghost" size="sm" onClick={exportCsv} disabled={filtered.length === 0}>⬇ Export CSV</Button>
      </div>

      {loading ? <LoadingState label="Loading missing data report…" /> : filtered.length === 0 ? (
        <EmptyState title="All devices reporting" description="No devices are missing KPI cycles within the selected threshold." icon={<span>✅</span>} />
      ) : (
        <div style={{ overflowX: 'auto', border: 'var(--vf-card-border)', borderRadius: 10, background: 'var(--vf-surface)', boxShadow: 'var(--vf-shadow-low)' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: 'var(--vf-elevated)' }}>
                {['Serial Number','Device ID','Last Reported','Missed Cycles','Severity'].map((h) => (
                  <th key={h} style={{ padding: '10px 14px', textAlign: 'left', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--vf-text-muted)', borderBottom: 'var(--vf-card-border)', whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.sort((a, b) => b.missedCycles - a.missedCycles).map((e) => (
                <tr key={e.deviceId} style={{ borderBottom: 'var(--vf-card-border)' }}>
                  <td style={{ padding: '9px 14px', fontFamily: 'var(--vf-font-mono)', fontSize: 12, color: 'var(--vf-accent)' }}>{e.serialNumber}</td>
                  <td style={{ padding: '9px 14px', fontFamily: 'var(--vf-font-mono)', fontSize: 11, color: 'var(--vf-text-muted)' }}>{e.deviceId}</td>
                  <td style={{ padding: '9px 14px', fontSize: 12, color: 'var(--vf-text-secondary)' }}>
                    {e.lastReportedAt ? new Date(e.lastReportedAt).toLocaleString() : <span style={{ color: '#f87171' }}>Never</span>}
                  </td>
                  <td style={{ padding: '9px 14px', fontWeight: 700, color: e.missedCycles >= 10 ? '#f87171' : e.missedCycles >= 5 ? '#fbbf24' : 'var(--vf-text-primary)' }}>
                    {e.missedCycles}
                  </td>
                  <td style={{ padding: '9px 14px' }}>
                    <Badge variant={e.missedCycles >= 10 ? 'danger' : e.missedCycles >= 5 ? 'warning' : 'default'}>
                      {e.missedCycles >= 10 ? 'Critical' : e.missedCycles >= 5 ? 'Warning' : 'Low'}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Main Page
// ═══════════════════════════════════════════════════════════════════════════════
export default function V2TroubleshootPage() {
  const [tab, setTab] = useState<DiagTab>('logs');

  return (
    <div className="vf-page">
      <div className="vf-page-header">
        <div>
          <h1 className="vf-page-title">Diagnostics & Troubleshooting</h1>
          <p style={{ fontSize: 12, color: 'var(--vf-text-muted)', margin: '2px 0 0' }}>
            Diagnostic tools for live device analysis — log extraction, link speed testing, and RF spectrum monitoring.
          </p>
        </div>
      </div>

      {/* Tab bar */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 24 }}>
        {TABS.map((t) => (
          <TabBtn key={t.id} tab={t} active={tab === t.id} onClick={() => setTab(t.id)} />
        ))}
      </div>

      {tab === 'logs'     && <LogsTab />}
      {tab === 'speed'    && <SpeedTab />}
      {tab === 'spectrum' && <SpectrumTab />}
      {tab === 'missing'  && <MissingDataTab />}
    </div>
  );
}
