import React, { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { Device, DeviceFilter, DeviceType, DeviceStatus } from '../api/devices.types';
import { buildExportUrl, fetchDevices, searchByGps, updateDeviceTags } from '../api/devices.api';
import { DeviceTable } from '../components/devices/DeviceTable';

const PAGE_SIZE = 50;

export default function DevicesPage(): React.ReactElement {
  const [searchParams] = useSearchParams();
  const initStatus = searchParams.get('status') as DeviceStatus | null;
  const initType = searchParams.get('type') as DeviceType | null;

  const [devices, setDevices] = useState<Device[]>([]);
  const [filter, setFilter] = useState<DeviceFilter>({
    ...(initStatus ? { status: initStatus } : {}),
    ...(initType ? { deviceType: initType } : {}),
  });
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Device | null>(null);
  const [gpsSearch, setGpsSearch] = useState({ lat: '', lng: '', radius: '1' });
  const [gpsResults, setGpsResults] = useState<Device[] | null>(null);
  const [tagInput, setTagInput] = useState('');

  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setLoading(true);
    const timeout = setTimeout(() => setLoading(false), 30_000);
    fetchDevices(filter)
      .then(setDevices)
      .finally(() => { clearTimeout(timeout); setLoading(false); });
    return () => clearTimeout(timeout);
  }, [filter]);

  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => {
      setFilter((f) => ({ ...f, search: val || undefined }));
      setPage(0);
    }, 300);
  };

  const handleGpsSearch = async () => {
    const lat = parseFloat(gpsSearch.lat);
    const lng = parseFloat(gpsSearch.lng);
    const radius = parseFloat(gpsSearch.radius);
    if (isNaN(lat) || isNaN(lng)) return;
    const results = await searchByGps({ latitude: lat, longitude: lng, radiusKm: radius });
    setGpsResults(results);
  };

  const handleAddTag = async (tag: string) => {
    if (!selected || !tag.trim()) return;
    const [k, ...rest] = tag.trim().split(':');
    const newTag = rest.length ? { key: k, value: rest.join(':') } : { key: 'tag', value: k };
    const tags = [...(selected.tags ?? []), newTag];
    const updated = await updateDeviceTags(selected.id, tags);
    setSelected(updated);
    setTagInput('');
    setDevices((prev) => prev.map((d) => d.id === updated.id ? updated : d));
  };

  const handleRemoveTag = async (tag: { key: string; value: string }) => {
    if (!selected) return;
    const tags = (selected.tags ?? []).filter((t) => !(t.key === tag.key && t.value === tag.value));
    const updated = await updateDeviceTags(selected.id, tags);
    setSelected(updated);
    setDevices((prev) => prev.map((d) => d.id === updated.id ? updated : d));
  };

  const displayDevices = gpsResults ?? devices;
  const paginated = displayDevices.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const totalPages = Math.ceil(displayDevices.length / PAGE_SIZE);

  const label: React.CSSProperties = { color: '#94a3b8', fontSize: 12, display: 'block', marginBottom: 4 };
  const input: React.CSSProperties = {
    background: '#0f172a', border: '1px solid #1e3a5f', borderRadius: 4,
    color: '#e2e8f0', padding: '6px 10px', fontSize: 13, width: '100%', boxSizing: 'border-box',
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h2 style={{ color: '#e2e8f0', margin: 0 }}>
          Devices
          <span style={{ color: '#64748b', fontWeight: 400, fontSize: 16, marginLeft: 12 }}>
            ({displayDevices.length})
          </span>
        </h2>
        <div style={{ display: 'flex', gap: 8 }}>
          <a href={buildExportUrl(filter, 'csv')} style={{ background: 'none', border: '1px solid #374151', color: '#94a3b8', padding: '6px 14px', borderRadius: 4, textDecoration: 'none', fontSize: 13 }}>Export CSV</a>
          <a href={buildExportUrl(filter, 'xls')} style={{ background: 'none', border: '1px solid #374151', color: '#94a3b8', padding: '6px 14px', borderRadius: 4, textDecoration: 'none', fontSize: 13 }}>Export XLS</a>
        </div>
      </div>

      {/* Search + Filter row */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap' as const }} role="search" aria-label="Filter devices">
        <label htmlFor="device-search" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', left: -9999 }}>Search devices</label>
        <input
          id="device-search"
          style={{ ...input, flex: '1 1 240px', maxWidth: 320 }}
          placeholder="Search IP, MAC, serial…"
          onChange={handleSearchChange}
          aria-label="Search by IP, MAC address, or serial number"
        />
        <label htmlFor="device-type-filter" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', left: -9999 }}>Device type</label>
        <select
          id="device-type-filter"
          style={{ ...input, flex: '0 0 140px' }}
          value={filter.deviceType ?? ''}
          onChange={(e) => setFilter((f) => ({ ...f, deviceType: (e.target.value as DeviceType) || undefined }))}
          aria-label="Filter by device type"
        >
          <option value="">All types</option>
          <option value="BTS">BTS</option>
          <option value="CPE">CPE</option>
          <option value="IDU">IDU</option>
        </select>
        <label htmlFor="device-status-filter" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', left: -9999 }}>Device status</label>
        <select
          id="device-status-filter"
          style={{ ...input, flex: '0 0 140px' }}
          value={filter.status ?? ''}
          onChange={(e) => setFilter((f) => ({ ...f, status: (e.target.value as DeviceStatus) || undefined }))}
          aria-label="Filter by device status"
        >
          <option value="">All statuses</option>
          <option value="ONLINE">Online</option>
          <option value="OFFLINE">Offline</option>
          <option value="PROVISIONING">Provisioning</option>
        </select>
      </div>

      {/* GPS search */}
      <div style={{ background: '#0d1b2a', border: '1px solid #1e293b', borderRadius: 8, padding: 16, marginBottom: 16 }}>
        <div style={{ color: '#94a3b8', fontSize: 12, fontWeight: 600, marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.05em' }}>GPS Search</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' as const, alignItems: 'flex-end' }}>
          <div>
            <label style={label}>Latitude</label>
            <input style={{ ...input, width: 120 }} value={gpsSearch.lat} onChange={(e) => setGpsSearch((g) => ({ ...g, lat: e.target.value }))} placeholder="23.8103" />
          </div>
          <div>
            <label style={label}>Longitude</label>
            <input style={{ ...input, width: 120 }} value={gpsSearch.lng} onChange={(e) => setGpsSearch((g) => ({ ...g, lng: e.target.value }))} placeholder="90.4125" />
          </div>
          <div>
            <label style={label}>Radius (km)</label>
            <input style={{ ...input, width: 80 }} value={gpsSearch.radius} onChange={(e) => setGpsSearch((g) => ({ ...g, radius: e.target.value }))} />
          </div>
          <button
            onClick={handleGpsSearch}
            style={{ background: '#1e3a5f', border: 'none', color: '#60a5fa', padding: '7px 16px', borderRadius: 4, cursor: 'pointer', fontSize: 13 }}
          >
            Search
          </button>
          {gpsResults && (
            <button
              onClick={() => setGpsResults(null)}
              style={{ background: 'none', border: '1px solid #374151', color: '#9ca3af', padding: '7px 12px', borderRadius: 4, cursor: 'pointer', fontSize: 13 }}
            >
              Clear GPS
            </button>
          )}
        </div>
        {gpsResults && (
          <div style={{ color: '#60a5fa', fontSize: 13, marginTop: 8 }}>{gpsResults.length} devices found within {gpsSearch.radius} km</div>
        )}
      </div>

      <DeviceTable devices={paginated} onSelect={setSelected} loading={loading} />

      {/* Pagination */}
      {totalPages > 1 && (
        <div style={{ display: 'flex', gap: 8, marginTop: 12, justifyContent: 'center' }}>
          <button disabled={page === 0} onClick={() => setPage((p) => p - 1)} style={{ background: 'none', border: '1px solid #374151', color: '#94a3b8', padding: '4px 12px', borderRadius: 4, cursor: 'pointer' }}>‹ Prev</button>
          <span style={{ color: '#64748b', fontSize: 13, padding: '4px 8px' }}>{page + 1} / {totalPages}</span>
          <button disabled={page + 1 >= totalPages} onClick={() => setPage((p) => p + 1)} style={{ background: 'none', border: '1px solid #374151', color: '#94a3b8', padding: '4px 12px', borderRadius: 4, cursor: 'pointer' }}>Next ›</button>
        </div>
      )}

      {/* Device Detail Panel (slide-in) */}
      {selected && (
        <div style={{
          position: 'fixed', top: 0, right: 0, bottom: 0, width: 480,
          background: '#0d1b2a', borderLeft: '1px solid #1e293b', padding: 24,
          overflowY: 'auto', zIndex: 100,
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 20 }}>
            <h3 style={{ color: '#e2e8f0', margin: 0 }}>{selected.deviceType} — {selected.serialNumber}</h3>
            <div style={{ display: 'flex', gap: 6 }}>
              <a href={`/devices/${selected.id}`} style={{ background: '#1e3a5f', border: 'none', color: '#60a5fa', padding: '4px 12px', borderRadius: 4, textDecoration: 'none', fontSize: 12, cursor: 'pointer' }}>
                Full Detail →
              </a>
              <button onClick={() => setSelected(null)} style={{ background: 'none', border: 'none', color: '#64748b', cursor: 'pointer', fontSize: 18 }}>✕</button>
            </div>
          </div>

          <Section title="Device Info">
            <Field label="Device ID" value={selected.deviceId} />
            <Field label="IP" value={selected.ipAddress} />
            <Field label="MAC" value={selected.macAddress} />
            <Field label="Manufacturer" value={selected.manufacturer} />
            <Field label="Model" value={selected.model} />
            <Field label="Firmware" value={selected.firmwareVersion} />
            <Field label="Status" value={selected.status} />
            <Field label="Network" value={selected.networkId ?? '—'} />
            {selected.location && <Field label="GPS" value={`${selected.location.coordinates[1].toFixed(6)}, ${selected.location.coordinates[0].toFixed(6)}`} />}
          </Section>

          {selected.birthCertificate && (
            <Section title="Birth Certificate (read-only)">
              {Object.entries(selected.birthCertificate).map(([k, v]) => (
                <Field key={k} label={k} value={String(v)} />
              ))}
            </Section>
          )}

          <Section title="Tags">
            <div style={{ display: 'flex', flexWrap: 'wrap' as const, gap: 6, marginBottom: 10 }}>
              {(selected.tags ?? []).map((tag) => (
                <span key={`${tag.key}:${tag.value}`} style={{ background: '#1e3a5f', color: '#60a5fa', padding: '3px 10px', borderRadius: 12, fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}>
                  {tag.key}:{tag.value}
                  <button onClick={() => handleRemoveTag(tag)} style={{ background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer', fontSize: 12, padding: 0 }}>×</button>
                </span>
              ))}
              {(selected.tags ?? []).length === 0 && <span style={{ color: '#475569', fontSize: 13 }}>No tags</span>}
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <input
                style={{ ...input, flex: 1 }}
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleAddTag(tagInput); }}
                placeholder="Add tag (Enter)"
              />
              <button onClick={() => handleAddTag(tagInput)} style={{ background: '#1e3a5f', border: 'none', color: '#60a5fa', padding: '0 14px', borderRadius: 4, cursor: 'pointer' }}>+</button>
            </div>
          </Section>

          {(selected.pendingCommandCount ?? 0) > 0 && (
            <Section title={`Pending Commands (${selected.pendingCommandCount})`}>
              <div style={{ color: '#fcd34d', fontSize: 13 }}>{selected.pendingCommandCount} commands awaiting delivery</div>
            </Section>
          )}
        </div>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }): React.ReactElement {
  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ color: '#60a5fa', fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>{title}</div>
      {children}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', borderBottom: '1px solid #0f172a' }}>
      <span style={{ color: '#64748b', fontSize: 12, flex: '0 0 140px' }}>{label}</span>
      <span style={{ color: '#cbd5e1', fontSize: 13, fontFamily: 'monospace', textAlign: 'right' }}>{value}</span>
    </div>
  );
}
