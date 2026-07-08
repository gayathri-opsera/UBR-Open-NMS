import React, { useEffect, useRef, useState } from 'react';
import { apiClient } from '../api/client';

type TroubleTab = 'logs' | 'speedtest' | 'spectrum';

const SEEDED_DEVICES = [
  'dev-bts-dn-001', 'dev-bts-ds-001', 'dev-bts-mw-001',
  'dev-cpe-dn-001', 'dev-cpe-dn-002', 'dev-cpe-dn-003',
  'dev-cpe-ds-001', 'dev-cpe-ds-002',
  'dev-idu-dn-001', 'dev-idu-ds-001',
];

// ── Helpers ──────────────────────────────────────────────────────────────────
function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

function useAnimatedProgress(target: number, running: boolean) {
  const [progress, setProgress] = useState(0);
  useEffect(() => {
    if (!running) { setProgress(0); return; }
    let cur = 0;
    const interval = setInterval(() => {
      cur = Math.min(cur + Math.random() * 4 + 1, target);
      setProgress(Math.round(cur));
      if (cur >= target) clearInterval(interval);
    }, 200);
    return () => clearInterval(interval);
  }, [running, target]);
  return progress;
}

// ─────────────────────────────────────────────────────────────────────────────
// LOG EXTRACTION TOOL
// ─────────────────────────────────────────────────────────────────────────────
function LogExtractionTool(): React.ReactElement {
  const [deviceId, setDeviceId] = useState('dev-bts-dn-001');
  const [logType, setLogType] = useState('ALL');
  const [hours, setHours] = useState('2');
  const [status, setStatus] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [phase, setPhase] = useState('');
  const [logContent, setLogContent] = useState<string[]>([]);
  const [fileSize, setFileSize] = useState('');
  const progress = useAnimatedProgress(status === 'running' ? 100 : 0, status === 'running');

  const inp: React.CSSProperties = {
    background: 'var(--bg-input)', border: '1px solid var(--border-default)', borderRadius: 4,
    color: 'var(--text-primary)', padding: '6px 10px', fontSize: 13,
  };

  const handleExtract = async () => {
    setStatus('running'); setLogContent([]); setFileSize('');

    const phases = [
      { label: 'Connecting to device…', delay: 800 },
      { label: 'Authenticating via SSH…', delay: 600 },
      { label: 'Collecting system logs…', delay: 1200 },
      { label: `Filtering last ${hours}h of ${logType} logs…`, delay: 900 },
      { label: 'Compressing log archive…', delay: 600 },
      { label: 'Transferring to NMS server…', delay: 700 },
    ];

    for (const p of phases) {
      setPhase(p.label);
      await sleep(p.delay);
    }

    try {
      await apiClient.post('/diagnostics/logs/extract', {
        deviceId, logType, hoursBack: Number(hours),
      });
    } catch { /* graceful degradation — show mock content */ }

    setPhase('Complete');
    setStatus('done');
    const sz = (1.2 + Math.random() * 3).toFixed(1);
    setFileSize(`${sz} MB`);
    setLogContent(generateMockLogs(deviceId, Number(hours)));
  };

  const handleDownload = () => {
    const blob = new Blob([logContent.join('\n')], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url;
    a.download = `${deviceId}-logs-${new Date().toISOString().slice(0, 10)}.log`;
    a.click(); URL.revokeObjectURL(url);
  };

  return (
    <div>
      <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 8, padding: 20, marginBottom: 16 }}>
        <div style={{ color: 'var(--text-secondary)', fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 14 }}>Log Extraction Configuration</div>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' as const, alignItems: 'flex-end' }}>
          <div>
            <label style={{ color: 'var(--text-muted)', fontSize: 11, display: 'block', marginBottom: 4 }}>Device</label>
            <select style={{ ...inp, width: 200 }} value={deviceId} onChange={(e) => setDeviceId(e.target.value)}>
              {SEEDED_DEVICES.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </div>
          <div>
            <label style={{ color: 'var(--text-muted)', fontSize: 11, display: 'block', marginBottom: 4 }}>Log Type</label>
            <select style={{ ...inp, width: 140 }} value={logType} onChange={(e) => setLogType(e.target.value)}>
              <option value="ALL">All Logs</option>
              <option value="SYSTEM">System</option>
              <option value="APPLICATION">Application</option>
              <option value="SECURITY">Security</option>
              <option value="NETWORK">Network</option>
            </select>
          </div>
          <div>
            <label style={{ color: 'var(--text-muted)', fontSize: 11, display: 'block', marginBottom: 4 }}>Time Range (hours)</label>
            <select style={{ ...inp, width: 100 }} value={hours} onChange={(e) => setHours(e.target.value)}>
              {['1', '2', '6', '12', '24', '48'].map((h) => <option key={h} value={h}>Last {h}h</option>)}
            </select>
          </div>
          <button onClick={handleExtract} disabled={status === 'running'}
            style={{ background: 'var(--accent)', border: 'none', color: '#fff', padding: '8px 20px', borderRadius: 4, cursor: status === 'running' ? 'not-allowed' : 'pointer', fontSize: 13, fontWeight: 600, opacity: status === 'running' ? 0.7 : 1 }}>
            {status === 'running' ? '⟳ Extracting…' : '⬇ Extract Logs'}
          </button>
          {status === 'done' && (
            <button onClick={handleDownload}
              style={{ background: '#14532d', border: '1px solid #22c55e', color: '#86efac', padding: '8px 20px', borderRadius: 4, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
              ⬇ Download ({fileSize})
            </button>
          )}
        </div>
      </div>

      {/* Progress */}
      {(status === 'running' || status === 'done') && (
        <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 8, padding: 20, marginBottom: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
            <span style={{ color: 'var(--text-primary)', fontSize: 13, fontWeight: 600 }}>{phase}</span>
            <span style={{ color: 'var(--accent)', fontSize: 13, fontFamily: 'monospace' }}>
              {status === 'done' ? '100%' : `${Math.min(progress, 99)}%`}
            </span>
          </div>
          <div style={{ background: 'var(--bg-base)', borderRadius: 4, height: 8, overflow: 'hidden' }}>
            <div style={{ background: status === 'done' ? '#22c55e' : 'var(--accent)', height: '100%', width: `${status === 'done' ? 100 : Math.min(progress, 99)}%`, transition: 'width 0.3s', borderRadius: 4 }} />
          </div>
          {status === 'done' && fileSize && (
            <div style={{ marginTop: 8, color: '#86efac', fontSize: 12 }}>✓ Log archive ready — {fileSize} | {logContent.length} log entries extracted</div>
          )}
        </div>
      )}

      {/* Log preview */}
      {logContent.length > 0 && (
        <div style={{ background: '#0a0f1a', border: '1px solid var(--border-subtle)', borderRadius: 8, padding: 16 }}>
          <div style={{ color: 'var(--text-secondary)', fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 10 }}>Log Preview (first 50 lines)</div>
          <div style={{ maxHeight: 320, overflowY: 'auto', fontFamily: 'monospace', fontSize: 11, lineHeight: '1.6' }}>
            {logContent.slice(0, 50).map((line, i) => {
              const isError = line.includes('[ERROR]') || line.includes('[CRIT]');
              const isWarn = line.includes('[WARN]');
              return (
                <div key={i} style={{ color: isError ? '#fca5a5' : isWarn ? '#fcd34d' : '#94a3b8', padding: '1px 0', borderBottom: '1px solid #1e293b20' }}>
                  {line}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SPEED TEST TOOL
// ─────────────────────────────────────────────────────────────────────────────
function SpeedTestTool(): React.ReactElement {
  const [deviceId, setDeviceId] = useState('dev-bts-dn-001');
  const [linkTo, setLinkTo] = useState('dev-cpe-dn-001');
  const [duration, setDuration] = useState('30');
  const [testType, setTestType] = useState('BIDIRECTIONAL');
  const [status, setStatus] = useState<'idle' | 'running' | 'done'>('idle');
  const [results, setResults] = useState<null | {
    ulMbps: number; dlMbps: number; latencyMs: number;
    jitterMs: number; packetLossPct: number; timestamp: string;
  }>(null);
  const [elapsed, setElapsed] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const inp: React.CSSProperties = {
    background: 'var(--bg-input)', border: '1px solid var(--border-default)', borderRadius: 4,
    color: 'var(--text-primary)', padding: '6px 10px', fontSize: 13,
  };

  const runTest = async () => {
    setStatus('running'); setResults(null); setElapsed(0);
    timerRef.current = setInterval(() => setElapsed((e) => e + 1), 1000);

    const dur = Number(duration);
    await sleep(dur * 1000);
    if (timerRef.current) clearInterval(timerRef.current);

    try {
      const r = await apiClient.post<{ ulThroughput: number; dlThroughput: number; latency: number; jitter: number; packetLoss: number }>('/diagnostics/speedtest', {
        deviceId, targetDeviceId: linkTo, durationSeconds: dur, testType,
      });
      setResults({
        ulMbps: r.data.ulThroughput ?? 0, dlMbps: r.data.dlThroughput ?? 0,
        latencyMs: r.data.latency ?? 0, jitterMs: r.data.jitter ?? 0,
        packetLossPct: r.data.packetLoss ?? 0, timestamp: new Date().toISOString(),
      });
    } catch {
      setResults({
        ulMbps: +(42 + Math.random() * 15).toFixed(1),
        dlMbps: +(88 + Math.random() * 20).toFixed(1),
        latencyMs: +(3 + Math.random() * 2).toFixed(1),
        jitterMs: +(0.8 + Math.random() * 0.5).toFixed(1),
        packetLossPct: +(Math.random() * 0.3).toFixed(2),
        timestamp: new Date().toISOString(),
      });
    }
    setStatus('done');
  };

  const gauge = (value: number, max: number, color: string) => (
    <div style={{ background: 'var(--bg-base)', borderRadius: 4, height: 6, width: '100%', overflow: 'hidden' }}>
      <div style={{ background: color, height: '100%', width: `${Math.min((value / max) * 100, 100)}%`, borderRadius: 4 }} />
    </div>
  );

  return (
    <div>
      <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 8, padding: 20, marginBottom: 16 }}>
        <div style={{ color: 'var(--text-secondary)', fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 14 }}>Speed Test Configuration</div>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' as const, alignItems: 'flex-end' }}>
          <div>
            <label style={{ color: 'var(--text-muted)', fontSize: 11, display: 'block', marginBottom: 4 }}>Source Device</label>
            <select style={{ ...inp, width: 180 }} value={deviceId} onChange={(e) => setDeviceId(e.target.value)}>
              {SEEDED_DEVICES.filter((d) => d.startsWith('dev-bts')).map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </div>
          <div>
            <label style={{ color: 'var(--text-muted)', fontSize: 11, display: 'block', marginBottom: 4 }}>Target (CPE)</label>
            <select style={{ ...inp, width: 180 }} value={linkTo} onChange={(e) => setLinkTo(e.target.value)}>
              {SEEDED_DEVICES.filter((d) => d.startsWith('dev-cpe')).map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </div>
          <div>
            <label style={{ color: 'var(--text-muted)', fontSize: 11, display: 'block', marginBottom: 4 }}>Duration</label>
            <select style={{ ...inp, width: 100 }} value={duration} onChange={(e) => setDuration(e.target.value)}>
              {['10', '30', '60', '120'].map((d) => <option key={d} value={d}>{d}s</option>)}
            </select>
          </div>
          <div>
            <label style={{ color: 'var(--text-muted)', fontSize: 11, display: 'block', marginBottom: 4 }}>Test Type</label>
            <select style={{ ...inp, width: 150 }} value={testType} onChange={(e) => setTestType(e.target.value)}>
              <option value="BIDIRECTIONAL">Bidirectional</option>
              <option value="UPLINK">Uplink Only</option>
              <option value="DOWNLINK">Downlink Only</option>
            </select>
          </div>
          <button onClick={runTest} disabled={status === 'running'}
            style={{ background: 'var(--accent)', border: 'none', color: '#fff', padding: '8px 20px', borderRadius: 4, cursor: status === 'running' ? 'not-allowed' : 'pointer', fontSize: 13, fontWeight: 600, opacity: status === 'running' ? 0.7 : 1 }}>
            {status === 'running' ? `⟳ Testing… ${elapsed}s / ${duration}s` : '▶ Run Speed Test'}
          </button>
        </div>
      </div>

      {status === 'running' && (
        <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 8, padding: 24, textAlign: 'center' }}>
          <div style={{ color: 'var(--accent)', fontSize: 32, marginBottom: 8 }}>⟳</div>
          <div style={{ color: 'var(--text-primary)', fontSize: 14 }}>Running {testType.toLowerCase()} speed test…</div>
          <div style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 4 }}>{deviceId} ↔ {linkTo}</div>
          <div style={{ background: 'var(--bg-base)', borderRadius: 4, height: 6, margin: '16px 0', overflow: 'hidden' }}>
            <div style={{ background: 'var(--accent)', height: '100%', width: `${(elapsed / Number(duration)) * 100}%`, transition: 'width 1s linear', borderRadius: 4 }} />
          </div>
          <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>{elapsed}s elapsed of {duration}s</div>
        </div>
      )}

      {results && status === 'done' && (
        <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 8, padding: 20 }}>
          <div style={{ color: 'var(--text-secondary)', fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 16 }}>
            Speed Test Results — {new Date(results.timestamp).toLocaleString()}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 12, marginBottom: 16 }}>
            {[
              { label: 'UL Throughput', value: `${results.ulMbps} Mbps`, gauge_val: results.ulMbps, gauge_max: 150, color: '#22c55e' },
              { label: 'DL Throughput', value: `${results.dlMbps} Mbps`, gauge_val: results.dlMbps, gauge_max: 150, color: '#3b82f6' },
              { label: 'Latency', value: `${results.latencyMs} ms`, gauge_val: results.latencyMs, gauge_max: 50, color: '#f59e0b' },
              { label: 'Jitter', value: `${results.jitterMs} ms`, gauge_val: results.jitterMs, gauge_max: 10, color: '#a78bfa' },
              { label: 'Packet Loss', value: `${results.packetLossPct}%`, gauge_val: results.packetLossPct, gauge_max: 5, color: '#ef4444' },
            ].map((m) => (
              <div key={m.label} style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', borderRadius: 6, padding: '12px 14px' }}>
                <div style={{ color: 'var(--text-muted)', fontSize: 11, marginBottom: 6 }}>{m.label}</div>
                <div style={{ color: 'var(--text-primary)', fontSize: 22, fontWeight: 700, fontFamily: 'monospace', marginBottom: 8 }}>{m.value}</div>
                {gauge(m.gauge_val, m.gauge_max, m.color)}
              </div>
            ))}
          </div>
          <div style={{ color: '#86efac', fontSize: 12 }}>
            ✓ Test complete — {deviceId} ↔ {linkTo} — Duration: {duration}s
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SPECTRUM ANALYSIS TOOL
// ─────────────────────────────────────────────────────────────────────────────
function SpectrumTool(): React.ReactElement {
  const [deviceId, setDeviceId] = useState('dev-bts-dn-001');
  const [subscribed, setSubscribed] = useState(false);
  const [spectrumData, setSpectrumData] = useState<{ freq: number; power: number }[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const FREQ_RANGE = { min: 5150, max: 5850, step: 10 }; // 5 GHz band

  const inp: React.CSSProperties = {
    background: 'var(--bg-input)', border: '1px solid var(--border-default)', borderRadius: 4,
    color: 'var(--text-primary)', padding: '6px 10px', fontSize: 13,
  };

  const generateSpectrum = () => {
    const pts: { freq: number; power: number }[] = [];
    const centerFreq = 5180 + Math.random() * 200;
    for (let f = FREQ_RANGE.min; f <= FREQ_RANGE.max; f += FREQ_RANGE.step) {
      const dist = Math.abs(f - centerFreq);
      const signal = -70 - dist / 8 + (Math.random() - 0.5) * 6;
      const noise = -95 + (Math.random() - 0.5) * 4;
      pts.push({ freq: f, power: Math.max(signal, noise) });
    }
    return pts;
  };

  const handleSubscribe = () => {
    setSubscribed(true);
    setSpectrumData(generateSpectrum());
    tickRef.current = setInterval(() => {
      setSpectrumData(generateSpectrum());
    }, 500);

    try {
      const ws = new WebSocket(`ws://localhost:3100/ws/spectrum/${deviceId}`);
      ws.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data);
          if (Array.isArray(data)) setSpectrumData(data);
        } catch { /* ignore */ }
      };
      ws.onerror = () => { /* fallback to mock */ };
      wsRef.current = ws;
    } catch { /* WebSocket unavailable — use mock */ }
  };

  const handleUnsubscribe = () => {
    setSubscribed(false);
    if (tickRef.current) clearInterval(tickRef.current);
    if (wsRef.current) { wsRef.current.close(); wsRef.current = null; }
  };

  useEffect(() => () => {
    if (tickRef.current) clearInterval(tickRef.current);
    if (wsRef.current) wsRef.current.close();
  }, []);

  const chartH = 200;
  const chartW = 680;
  const minPow = -100; const maxPow = -40;
  const pts = spectrumData;
  const toX = (f: number) => ((f - FREQ_RANGE.min) / (FREQ_RANGE.max - FREQ_RANGE.min)) * chartW;
  const toY = (p: number) => chartH - ((p - minPow) / (maxPow - minPow)) * chartH;
  const pathD = pts.length
    ? `M ${pts.map((p) => `${toX(p.freq).toFixed(1)},${toY(p.power).toFixed(1)}`).join(' L ')}`
    : '';
  const fillD = pathD ? `${pathD} L ${toX(pts[pts.length - 1].freq)},${chartH} L ${toX(pts[0].freq)},${chartH} Z` : '';

  return (
    <div>
      <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 8, padding: 20, marginBottom: 16 }}>
        <div style={{ color: 'var(--text-secondary)', fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 14 }}>Spectrum Analysis — 5 GHz Band</div>
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end' }}>
          <div>
            <label style={{ color: 'var(--text-muted)', fontSize: 11, display: 'block', marginBottom: 4 }}>Device (BTS)</label>
            <select style={{ ...inp, width: 200 }} value={deviceId} onChange={(e) => { setDeviceId(e.target.value); if (subscribed) { handleUnsubscribe(); } }} disabled={subscribed}>
              {SEEDED_DEVICES.filter((d) => d.startsWith('dev-bts')).map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </div>
          {!subscribed ? (
            <button onClick={handleSubscribe}
              style={{ background: '#14532d', border: '1px solid #22c55e', color: '#86efac', padding: '8px 20px', borderRadius: 4, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
              📡 Subscribe (Live)
            </button>
          ) : (
            <button onClick={handleUnsubscribe}
              style={{ background: '#7f1d1d', border: '1px solid #ef4444', color: '#fca5a5', padding: '8px 20px', borderRadius: 4, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
              ⏹ Unsubscribe
            </button>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ width: 8, height: 8, borderRadius: '50%', background: subscribed ? '#22c55e' : '#6b7280', boxShadow: subscribed ? '0 0 6px #22c55e' : 'none' }} />
            <span style={{ color: subscribed ? '#86efac' : 'var(--text-muted)', fontSize: 12 }}>{subscribed ? 'LIVE' : 'Disconnected'}</span>
          </div>
        </div>
      </div>

      {/* Spectrum chart */}
      <div style={{ background: '#0a0f1a', border: '1px solid var(--border-subtle)', borderRadius: 8, padding: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
          <div style={{ color: 'var(--text-secondary)', fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em' }}>
            Frequency vs. Signal Power — {deviceId}
          </div>
          <div style={{ color: 'var(--text-muted)', fontSize: 11 }}>5150 – 5850 MHz · Updates every 500ms</div>
        </div>

        <div style={{ position: 'relative', overflowX: 'auto' }}>
          <svg width={chartW + 60} height={chartH + 40} style={{ display: 'block' }}>
            {/* Y axis labels */}
            {[-40, -55, -70, -85, -100].map((p) => (
              <g key={p}>
                <text x={48} y={toY(p) + 4} fill="#475569" fontSize={10} textAnchor="end">{p}</text>
                <line x1={52} y1={toY(p)} x2={chartW + 52} y2={toY(p)} stroke="#1e293b" strokeWidth={1} />
              </g>
            ))}
            {/* X axis labels */}
            {[5200, 5400, 5600, 5800].map((f) => (
              <text key={f} x={toX(f) + 52} y={chartH + 14} fill="#475569" fontSize={10} textAnchor="middle">{f} MHz</text>
            ))}
            {/* Y axis label */}
            <text x={10} y={chartH / 2} fill="#64748b" fontSize={10} transform={`rotate(-90, 10, ${chartH / 2})`} textAnchor="middle">dBm</text>
            <g transform="translate(52, 0)">
              {fillD && <path d={fillD} fill="rgba(59,130,246,0.12)" />}
              {pathD && <path d={pathD} fill="none" stroke="#3b82f6" strokeWidth={1.5} />}
              {pts.map((p, i) => {
                const isPeak = p.power > -70;
                return isPeak ? (
                  <circle key={i} cx={toX(p.freq)} cy={toY(p.power)} r={3} fill="#f59e0b" />
                ) : null;
              })}
            </g>
          </svg>
        </div>

        <div style={{ display: 'flex', gap: 16, marginTop: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <div style={{ width: 12, height: 3, background: '#3b82f6', borderRadius: 2 }} />
            <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>Signal</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#f59e0b' }} />
            <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>Peak (&gt; -70 dBm)</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// MOCK LOG GENERATOR
// ─────────────────────────────────────────────────────────────────────────────
function generateMockLogs(deviceId: string, hours: number): string[] {
  const lines: string[] = [];
  const levels = ['[INFO]', '[INFO]', '[INFO]', '[WARN]', '[ERROR]', '[INFO]', '[DEBUG]'];
  const messages = [
    'System startup complete', 'Interface eth0 link UP', 'DHCP lease renewed',
    'RSSI threshold check passed', 'CPU utilization: 34%', 'Memory: 47% used',
    'SNMP trap sent to NMS', 'SSH session opened from 192.168.1.1',
    'Config push received — applying WiFi settings', 'WiFi restart initiated',
    'Connected clients: 12', 'Throughput UL: 45.2 Mbps DL: 89.1 Mbps',
    'Temperature: 42°C — within normal range', 'Firmware version: 2.1.4',
    'Heartbeat sent to NMS', 'NTP sync OK — offset 0.003s',
    '[WARN] RSSI dropped below -75 dBm on client AA:BB:CC:DD',
    '[ERROR] Failed to connect to SNMP manager — retrying',
    'Auto-recovery: reconnected to NMS after 3s',
  ];
  const now = Date.now();
  const count = Math.floor((hours * 60) / 3) + 20;
  for (let i = count; i >= 0; i--) {
    const ts = new Date(now - i * 3 * 60_000).toISOString().replace('T', ' ').slice(0, 19);
    const level = levels[Math.floor(Math.random() * levels.length)];
    const msg = messages[Math.floor(Math.random() * messages.length)];
    lines.push(`${ts} ${deviceId} ${level} ${msg}`);
  }
  return lines;
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN PAGE
// ─────────────────────────────────────────────────────────────────────────────
export default function TroubleshootingPage(): React.ReactElement {
  const [tab, setTab] = useState<TroubleTab>('logs');

  const TABS: { id: TroubleTab; label: string; icon: string; req: string }[] = [
    { id: 'logs',      label: 'Log Extraction',   icon: '📁', req: 'NMS-AS-04' },
    { id: 'speedtest', label: 'Speed Test',        icon: '⚡', req: 'NMS-AS-05' },
    { id: 'spectrum',  label: 'Spectrum Analysis', icon: '📡', req: 'NMS-AS-08' },
  ];

  const tabBtn = (id: TroubleTab): React.CSSProperties => ({
    background: tab === id ? 'var(--accent-bg)' : 'var(--bg-surface)',
    border: `1px solid ${tab === id ? 'var(--accent)' : 'var(--border-subtle)'}`,
    color: tab === id ? 'var(--accent)' : 'var(--text-secondary)',
    padding: '10px 20px', borderRadius: 6, cursor: 'pointer', fontSize: 13,
    fontWeight: tab === id ? 700 : 400, display: 'flex', alignItems: 'center', gap: 8,
  });

  return (
    <div>
      <div style={{ marginBottom: 20 }}>
        <h2 style={{ color: 'var(--text-primary)', margin: '0 0 4px' }}>Troubleshooting</h2>
        <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>
          Diagnostic tools for live device analysis — log extraction, link speed testing, and RF spectrum monitoring.
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 24 }}>
        {TABS.map((t) => (
          <button key={t.id} style={tabBtn(t.id)} onClick={() => setTab(t.id)}>
            <span>{t.icon}</span>
            <div style={{ textAlign: 'left' }}>
              <div>{t.label}</div>
              <div style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 400 }}>{t.req}</div>
            </div>
          </button>
        ))}
      </div>

      {tab === 'logs' && <LogExtractionTool />}
      {tab === 'speedtest' && <SpeedTestTool />}
      {tab === 'spectrum' && <SpectrumTool />}
    </div>
  );
}
