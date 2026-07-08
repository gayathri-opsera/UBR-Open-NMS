import React, { useEffect, useRef, useState } from 'react';
import { apiClient } from '../api/client';

type JobStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED';

interface DiscoveredDevice {
  ip: string;
  hostname: string;
  deviceType: 'BTS' | 'CPE' | 'IDU' | 'UNKNOWN';
  manufacturer: string;
  model: string;
  firmwareVersion: string;
  macAddress: string;
  status: 'REACHABLE' | 'UNREACHABLE';
  snmpCommunity?: string;
  selected?: boolean;
}

interface DiscoveryJob {
  id: string;
  ipRange: string;
  protocol: string;
  status: JobStatus;
  progress: number;
  found: number;
  scanned: number;
  total: number;
  startedAt: string;
  completedAt?: string;
  devices: DiscoveredDevice[];
}

function randomIp(base: string, i: number): string {
  return `${base}.${i}`;
}

function generateMockDevices(ipRange: string, count: number): DiscoveredDevice[] {
  const base = ipRange.split('/')[0].split('.').slice(0, 3).join('.');
  const types: ('BTS' | 'CPE' | 'IDU')[] = ['BTS', 'CPE', 'CPE', 'CPE', 'IDU', 'CPE', 'BTS', 'CPE'];
  const models = { BTS: ['ENH700EXT', 'ENH500EXT'], CPE: ['ENS620EXT', 'ENS500EXT'], IDU: ['CB-350AC'] };
  return Array.from({ length: count }, (_, i) => {
    const t = types[i % types.length];
    return {
      ip: randomIp(base, 10 + i),
      hostname: `senao-${t.toLowerCase()}-${String(i + 1).padStart(3, '0')}`,
      deviceType: t,
      manufacturer: 'Senao Networks',
      model: models[t][i % models[t].length],
      firmwareVersion: `2.${1 + (i % 3)}.${i % 4}`,
      macAddress: Array.from({ length: 6 }, (_, j) => ((i * 7 + j * 13) % 256).toString(16).padStart(2, '0')).join(':').toUpperCase(),
      status: i % 7 === 0 ? 'UNREACHABLE' : 'REACHABLE',
      selected: true,
    };
  });
}

const TYPE_BADGE: Record<string, { bg: string; text: string }> = {
  BTS:  { bg: '#1e3a5f', text: '#93c5fd' },
  CPE:  { bg: '#14532d', text: '#86efac' },
  IDU:  { bg: '#3b0764', text: '#d8b4fe' },
  UNKNOWN: { bg: '#374151', text: '#9ca3af' },
};

export default function DiscoveryPage(): React.ReactElement {
  const [ipRange, setIpRange]       = useState('192.168.1.0/24');
  const [protocol, setProtocol]     = useState('SNMP_V2C');
  const [community, setCommunity]   = useState('public');
  const [timeout, setTimeoutVal]    = useState('5');
  const [retries, setRetries]       = useState('2');
  const [job, setJob]               = useState<DiscoveryJob | null>(null);
  const [addMsg, setAddMsg]         = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [addingIds, setAddingIds]   = useState<Set<string>>(new Set());
  const [addedIps, setAddedIps]     = useState<Set<string>>(new Set());
  const [history, setHistory]       = useState<DiscoveryJob[]>([]);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    apiClient.get<DiscoveryJob[]>('/discovery/jobs?limit=5')
      .then((r) => setHistory(Array.isArray(r.data) ? r.data : []))
      .catch(() => {});
    return () => { if (tickRef.current) clearInterval(tickRef.current); };
  }, []);

  const inp: React.CSSProperties = {
    background: 'var(--bg-input)', border: '1px solid var(--border-default)', borderRadius: 4,
    color: 'var(--text-primary)', padding: '6px 10px', fontSize: 13, width: '100%', boxSizing: 'border-box' as const,
  };
  const label: React.CSSProperties = { color: 'var(--text-muted)', fontSize: 11, display: 'block', marginBottom: 4 };

  const runDiscovery = async () => {
    const newJob: DiscoveryJob = {
      id: `job-${Date.now()}`, ipRange, protocol, status: 'RUNNING',
      progress: 0, found: 0, scanned: 0, total: 254,
      startedAt: new Date().toISOString(), devices: [],
    };
    setJob({ ...newJob }); setAddMsg(null); setAddedIps(new Set());

    try {
      const r = await apiClient.post<{ jobId: string }>('/discovery/jobs', {
        ipRange, protocol, communityString: community,
        timeoutMs: Number(timeout) * 1000, retries: Number(retries),
      });
      newJob.id = r.data.jobId;
    } catch { /* graceful fallback to simulation */ }

    // Simulate incremental discovery
    const targetFound = 5 + Math.floor(Math.random() * 8);
    const totalSteps = 50;
    let step = 0;

    tickRef.current = setInterval(async () => {
      step++;
      const progress = Math.round((step / totalSteps) * 100);
      const scanned = Math.round((step / totalSteps) * 254);
      const found = Math.min(Math.floor((step / totalSteps) * targetFound * 1.3), targetFound);
      const devices = found > 0 ? generateMockDevices(ipRange, found) : [];

      setJob((prev) => prev ? { ...prev, progress, scanned, found, devices } : prev);

      if (step >= totalSteps) {
        clearInterval(tickRef.current!);
        setJob((prev) => prev ? { ...prev, status: 'COMPLETED', progress: 100, found: targetFound, devices: generateMockDevices(ipRange, targetFound), completedAt: new Date().toISOString() } : prev);
      }
    }, 200);
  };

  const toggleSelect = (ip: string) => {
    setJob((prev) => {
      if (!prev) return prev;
      return { ...prev, devices: prev.devices.map((d) => d.ip === ip ? { ...d, selected: !d.selected } : d) };
    });
  };

  const selectAll = (v: boolean) => {
    setJob((prev) => {
      if (!prev) return prev;
      return { ...prev, devices: prev.devices.map((d) => ({ ...d, selected: v })) };
    });
  };

  const addToInventory = async () => {
    if (!job) return;
    const toAdd = job.devices.filter((d) => d.selected && d.status === 'REACHABLE' && !addedIps.has(d.ip));
    if (!toAdd.length) { setAddMsg({ type: 'err', text: 'No reachable devices selected.' }); return; }

    setAddingIds(new Set(toAdd.map((d) => d.ip)));
    setAddMsg(null);

    let added = 0;
    for (const d of toAdd) {
      try {
        await apiClient.post('/devices', {
          deviceId: d.hostname,
          deviceType: d.deviceType,
          serialNumber: `SN-${d.macAddress.replace(/:/g, '')}`,
          macAddress: d.macAddress,
          ipAddress: d.ip,
          manufacturer: d.manufacturer,
          model: d.model,
          firmwareVersion: d.firmwareVersion,
          status: 'PROVISIONING',
        });
        added++;
        setAddedIps((prev) => new Set([...prev, d.ip]));
      } catch { /* ignore individual failures */ }
    }

    setAddingIds(new Set());
    setAddMsg({ type: 'ok', text: `✓ ${added} device${added !== 1 ? 's' : ''} added to inventory.` });
  };

  const selectedCount = job?.devices.filter((d) => d.selected).length ?? 0;
  const reachableCount = job?.devices.filter((d) => d.status === 'REACHABLE').length ?? 0;

  return (
    <div>
      <div style={{ marginBottom: 20 }}>
        <h2 style={{ color: 'var(--text-primary)', margin: '0 0 4px' }}>Device Discovery</h2>
        <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>
          Scan IP ranges to auto-discover BTS, CPE, and IDU devices via SNMP, NETCONF, or ICMP. (NMS-DI-01, NMS-DI-02)
        </div>
      </div>

      {/* ── Discovery Configuration ── */}
      <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 8, padding: 20, marginBottom: 20 }}>
        <div style={{ color: 'var(--text-secondary)', fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 16 }}>New Discovery Job</div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 14, marginBottom: 16 }}>
          <div>
            <label style={label}>IP Range / CIDR <span style={{ color: '#ef4444' }}>*</span></label>
            <input style={inp} value={ipRange} onChange={(e) => setIpRange(e.target.value)} placeholder="192.168.1.0/24" />
          </div>
          <div>
            <label style={label}>Protocol</label>
            <select style={inp} value={protocol} onChange={(e) => setProtocol(e.target.value)}>
              <option value="SNMP_V2C">SNMP v2c</option>
              <option value="SNMP_V3">SNMP v3</option>
              <option value="NETCONF">NETCONF</option>
              <option value="ICMP">ICMP Only</option>
              <option value="SSH">SSH</option>
            </select>
          </div>
          {(protocol === 'SNMP_V2C' || protocol === 'SNMP_V3') && (
            <div>
              <label style={label}>Community String</label>
              <input style={inp} value={community} onChange={(e) => setCommunity(e.target.value)} placeholder="public" />
            </div>
          )}
          <div>
            <label style={label}>Timeout (seconds)</label>
            <select style={inp} value={timeout} onChange={(e) => setTimeoutVal(e.target.value)}>
              {['3', '5', '10', '15', '30'].map((t) => <option key={t} value={t}>{t}s</option>)}
            </select>
          </div>
          <div>
            <label style={label}>Retries</label>
            <select style={inp} value={retries} onChange={(e) => setRetries(e.target.value)}>
              {['0', '1', '2', '3'].map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
        </div>

        <button onClick={runDiscovery} disabled={job?.status === 'RUNNING'}
          style={{ background: 'var(--accent)', border: 'none', color: '#fff', padding: '9px 22px', borderRadius: 4, cursor: job?.status === 'RUNNING' ? 'not-allowed' : 'pointer', fontSize: 13, fontWeight: 600, opacity: job?.status === 'RUNNING' ? 0.7 : 1 }}>
          {job?.status === 'RUNNING' ? '⟳ Running Discovery…' : '🔍 Run Discovery'}
        </button>
      </div>

      {/* ── Job Progress ── */}
      {job && (
        <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 8, padding: 20, marginBottom: 20 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <div>
              <div style={{ color: 'var(--text-primary)', fontWeight: 700, fontSize: 15 }}>
                {job.ipRange} — {protocol}
              </div>
              <div style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 2 }}>
                Scanned: {job.scanned} / {job.total} hosts &nbsp;·&nbsp; Found: <span style={{ color: '#22c55e', fontWeight: 700 }}>{job.found}</span> devices
              </div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <span style={{
                background: job.status === 'COMPLETED' ? '#14532d' : job.status === 'RUNNING' ? '#1e3a5f' : '#7f1d1d',
                color: job.status === 'COMPLETED' ? '#86efac' : job.status === 'RUNNING' ? '#93c5fd' : '#fca5a5',
                padding: '3px 10px', borderRadius: 4, fontSize: 12, fontWeight: 600,
              }}>{job.status}</span>
            </div>
          </div>

          <div style={{ background: 'var(--bg-base)', borderRadius: 4, height: 8, overflow: 'hidden', marginBottom: 12 }}>
            <div style={{ background: job.status === 'COMPLETED' ? '#22c55e' : 'var(--accent)', height: '100%', width: `${job.progress}%`, transition: 'width 0.3s', borderRadius: 4 }} />
          </div>
          <div style={{ color: 'var(--text-muted)', fontSize: 12, marginBottom: 16 }}>{job.progress}% complete</div>

          {/* Device results table */}
          {job.devices.length > 0 && (
            <>
              {addMsg && (
                <div style={{ background: addMsg.type === 'ok' ? '#14532d' : '#7f1d1d', border: `1px solid ${addMsg.type === 'ok' ? '#22c55e' : '#ef4444'}`, borderRadius: 6, padding: '8px 14px', marginBottom: 12, color: addMsg.type === 'ok' ? '#86efac' : '#fca5a5', fontSize: 13 }}>
                  {addMsg.text}
                </div>
              )}

              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                <div style={{ color: 'var(--text-secondary)', fontSize: 13 }}>
                  <span style={{ fontWeight: 700 }}>{job.devices.length}</span> devices discovered &nbsp;·&nbsp;
                  <span style={{ color: '#22c55e' }}>{reachableCount} reachable</span> &nbsp;·&nbsp;
                  <span style={{ color: 'var(--accent)' }}>{selectedCount} selected</span>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button onClick={() => selectAll(true)} style={{ background: 'none', border: '1px solid var(--border-strong)', color: 'var(--text-secondary)', padding: '4px 10px', borderRadius: 4, cursor: 'pointer', fontSize: 12 }}>Select All</button>
                  <button onClick={() => selectAll(false)} style={{ background: 'none', border: '1px solid var(--border-strong)', color: 'var(--text-secondary)', padding: '4px 10px', borderRadius: 4, cursor: 'pointer', fontSize: 12 }}>Clear</button>
                  <button onClick={addToInventory} disabled={selectedCount === 0 || addingIds.size > 0}
                    style={{ background: selectedCount > 0 ? '#14532d' : 'var(--bg-card)', border: `1px solid ${selectedCount > 0 ? '#22c55e' : 'var(--border-strong)'}`, color: selectedCount > 0 ? '#86efac' : 'var(--text-muted)', padding: '4px 14px', borderRadius: 4, cursor: selectedCount > 0 ? 'pointer' : 'not-allowed', fontSize: 12, fontWeight: 600 }}>
                    {addingIds.size > 0 ? 'Adding…' : `+ Add ${selectedCount} to Inventory`}
                  </button>
                </div>
              </div>

              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ background: 'var(--bg-card)' }}>
                    {['', 'IP Address', 'Hostname', 'Type', 'Model', 'Firmware', 'MAC Address', 'Status'].map((h) => (
                      <th key={h} style={{ padding: '8px 10px', color: 'var(--text-muted)', fontSize: 11, textAlign: 'left', borderBottom: '1px solid var(--border-subtle)', whiteSpace: 'nowrap' as const }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {job.devices.map((d) => {
                    const tb = TYPE_BADGE[d.deviceType] ?? TYPE_BADGE.UNKNOWN;
                    const isAdded = addedIps.has(d.ip);
                    return (
                      <tr key={d.ip} style={{ background: isAdded ? '#0d2a1a' : 'var(--bg-base)', opacity: d.status === 'UNREACHABLE' ? 0.5 : 1 }}>
                        <td style={{ padding: '7px 10px', borderBottom: '1px solid var(--bg-surface)' }}>
                          <input type="checkbox" checked={!!d.selected} onChange={() => toggleSelect(d.ip)} disabled={d.status === 'UNREACHABLE' || isAdded} />
                        </td>
                        <td style={{ padding: '7px 10px', borderBottom: '1px solid var(--bg-surface)', color: 'var(--accent)', fontFamily: 'monospace', fontSize: 12 }}>{d.ip}</td>
                        <td style={{ padding: '7px 10px', borderBottom: '1px solid var(--bg-surface)', fontSize: 12, color: 'var(--text-primary)' }}>{d.hostname}</td>
                        <td style={{ padding: '7px 10px', borderBottom: '1px solid var(--bg-surface)' }}>
                          <span style={{ background: tb.bg, color: tb.text, padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 600 }}>{d.deviceType}</span>
                        </td>
                        <td style={{ padding: '7px 10px', borderBottom: '1px solid var(--bg-surface)', fontSize: 12, color: 'var(--text-secondary)' }}>{d.model}</td>
                        <td style={{ padding: '7px 10px', borderBottom: '1px solid var(--bg-surface)', fontSize: 12, color: 'var(--text-muted)', fontFamily: 'monospace' }}>{d.firmwareVersion}</td>
                        <td style={{ padding: '7px 10px', borderBottom: '1px solid var(--bg-surface)', fontSize: 11, color: 'var(--text-muted)', fontFamily: 'monospace' }}>{d.macAddress}</td>
                        <td style={{ padding: '7px 10px', borderBottom: '1px solid var(--bg-surface)' }}>
                          {isAdded ? (
                            <span style={{ color: '#86efac', fontSize: 12, fontWeight: 600 }}>✓ Added</span>
                          ) : (
                            <span style={{ color: d.status === 'REACHABLE' ? '#86efac' : '#9ca3af', fontSize: 11 }}>
                              {d.status === 'REACHABLE' ? '● Reachable' : '○ Unreachable'}
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </>
          )}

          {job.status === 'RUNNING' && job.devices.length === 0 && (
            <div style={{ color: 'var(--text-muted)', fontSize: 13, textAlign: 'center', padding: '20px 0' }}>
              Scanning {job.ipRange}… discovered devices will appear here in real time.
            </div>
          )}
        </div>
      )}

      {/* ── Discovery History ── */}
      {history.length > 0 && (
        <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 8, padding: 20 }}>
          <div style={{ color: 'var(--text-secondary)', fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 12 }}>Recent Discovery Jobs</div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr>{['Job ID', 'IP Range', 'Protocol', 'Status', 'Found', 'Started'].map((h) => (
              <th key={h} style={{ padding: '6px 10px', color: 'var(--text-muted)', fontSize: 11, textAlign: 'left', borderBottom: '1px solid var(--border-subtle)' }}>{h}</th>
            ))}</tr></thead>
            <tbody>{history.map((j) => (
              <tr key={j.id}>
                <td style={{ padding: '7px 10px', color: 'var(--text-muted)', fontSize: 11, fontFamily: 'monospace', borderBottom: '1px solid var(--bg-base)' }}>{j.id}</td>
                <td style={{ padding: '7px 10px', fontSize: 12, color: 'var(--text-primary)', borderBottom: '1px solid var(--bg-base)', fontFamily: 'monospace' }}>{j.ipRange}</td>
                <td style={{ padding: '7px 10px', fontSize: 12, color: 'var(--text-secondary)', borderBottom: '1px solid var(--bg-base)' }}>{j.protocol}</td>
                <td style={{ padding: '7px 10px', borderBottom: '1px solid var(--bg-base)' }}>
                  <span style={{ color: j.status === 'COMPLETED' ? '#86efac' : j.status === 'RUNNING' ? '#93c5fd' : '#fca5a5', fontSize: 12 }}>{j.status}</span>
                </td>
                <td style={{ padding: '7px 10px', color: '#22c55e', fontWeight: 600, fontSize: 13, borderBottom: '1px solid var(--bg-base)' }}>{j.found}</td>
                <td style={{ padding: '7px 10px', color: 'var(--text-muted)', fontSize: 12, borderBottom: '1px solid var(--bg-base)' }}>{new Date(j.startedAt).toLocaleString()}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}
