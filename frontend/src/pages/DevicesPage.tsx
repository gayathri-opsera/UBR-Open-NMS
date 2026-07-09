import React, { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { Device, DeviceFilter, DeviceType, DeviceStatus } from '../api/devices.types';
import { downloadDeviceExport, createDevice, deleteDevice, fetchDevices, searchByGps, updateDeviceTags } from '../api/devices.api';
import { DeviceTable } from '../components/devices/DeviceTable';

const EMPTY_FORM = {
  deviceId: '', deviceType: 'CPE' as DeviceType, serialNumber: '', macAddress: '',
  ipAddress: '', manufacturer: 'Senao', model: '', firmwareVersion: '',
  status: 'PROVISIONING' as DeviceStatus, networkId: '', organizationId: '',
};

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

  // Add device modal state
  const [showAddModal, setShowAddModal] = useState(false);
  const [addForm, setAddForm] = useState({ ...EMPTY_FORM });
  const [addError, setAddError] = useState<string | null>(null);
  const [addLoading, setAddLoading] = useState(false);

  // Delete state
  const [deleteConfirm, setDeleteConfirm] = useState<Device | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);

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

  const handleCreate = async () => {
    if (!addForm.deviceId.trim() || !addForm.serialNumber.trim() || !addForm.ipAddress.trim()) {
      setAddError('Device ID, Serial Number, and IP Address are required.');
      return;
    }
    setAddLoading(true);
    setAddError(null);
    try {
      const created = await createDevice(addForm as Omit<Device, 'id'>);
      setDevices((prev) => [created, ...prev]);
      setShowAddModal(false);
      setAddForm({ ...EMPTY_FORM });
    } catch {
      setAddError('Failed to create device. Check that Device ID and Serial Number are unique.');
    } finally {
      setAddLoading(false);
    }
  };

  const handleDelete = async (device: Device) => {
    setDeleteLoading(true);
    try {
      await deleteDevice(device.id);
      setDevices((prev) => prev.filter((d) => d.id !== device.id));
      setSelected(null);
      setDeleteConfirm(null);
    } catch {
      /* ignore */
    } finally {
      setDeleteLoading(false);
    }
  };

  const displayDevices = gpsResults ?? devices;
  const paginated = displayDevices.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const totalPages = Math.ceil(displayDevices.length / PAGE_SIZE);

  const label: React.CSSProperties = { color: 'var(--text-secondary)', fontSize: 12, display: 'block', marginBottom: 4 };
  const input: React.CSSProperties = {
    background: 'var(--bg-input)', border: '1px solid var(--border-default)', borderRadius: 4,
    color: 'var(--text-primary)', padding: '6px 10px', fontSize: 13, width: '100%', boxSizing: 'border-box',
  };
  const btnPrimary: React.CSSProperties = {
    background: 'var(--accent)', border: 'none', color: '#fff',
    padding: '7px 18px', borderRadius: 4, cursor: 'pointer', fontSize: 13, fontWeight: 600,
  };
  const btnDanger: React.CSSProperties = {
    background: '#ef4444', border: 'none', color: '#fff',
    padding: '6px 14px', borderRadius: 4, cursor: 'pointer', fontSize: 13, fontWeight: 600,
  };
  const btnGhost: React.CSSProperties = {
    background: 'none', border: '1px solid var(--border-strong)', color: 'var(--text-secondary)',
    padding: '6px 14px', borderRadius: 4, cursor: 'pointer', fontSize: 13,
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h2 style={{ color: 'var(--text-primary)', margin: 0 }}>
          Devices
          <span style={{ color: 'var(--text-muted)', fontWeight: 400, fontSize: 16, marginLeft: 12 }}>
            ({displayDevices.length})
          </span>
        </h2>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => downloadDeviceExport(filter, 'csv')} style={btnGhost}>Export CSV</button>
          <button onClick={() => downloadDeviceExport(filter, 'xls')} style={btnGhost}>Export XLS</button>
          <button onClick={() => { setAddForm({ ...EMPTY_FORM }); setAddError(null); setShowAddModal(true); }} style={btnPrimary}>
            + Add Device
          </button>
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
      <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 8, padding: 16, marginBottom: 16 }}>
        <div style={{ color: 'var(--text-secondary)', fontSize: 12, fontWeight: 600, marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.05em' }}>GPS Search</div>
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
          <button onClick={handleGpsSearch} style={{ background: 'var(--accent-bg)', border: 'none', color: 'var(--accent)', padding: '7px 16px', borderRadius: 4, cursor: 'pointer', fontSize: 13 }}>
            Search
          </button>
          {gpsResults && (
            <button onClick={() => setGpsResults(null)} style={btnGhost}>Clear GPS</button>
          )}
        </div>
        {gpsResults && (
          <div style={{ color: 'var(--accent)', fontSize: 13, marginTop: 8 }}>{gpsResults.length} devices found within {gpsSearch.radius} km</div>
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
          background: 'var(--bg-surface)', borderLeft: '1px solid var(--border-subtle)', padding: 24,
          overflowY: 'auto', zIndex: 100,
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 20 }}>
            <h3 style={{ color: 'var(--text-primary)', margin: 0 }}>{selected.deviceType} — {selected.serialNumber}</h3>
            <div style={{ display: 'flex', gap: 6 }}>
              <a href={`/devices/${selected.id}`} style={{ background: 'var(--accent-bg)', border: 'none', color: 'var(--accent)', padding: '4px 12px', borderRadius: 4, textDecoration: 'none', fontSize: 12 }}>
                Full Detail →
              </a>
              <button onClick={() => setDeleteConfirm(selected)} style={{ background: 'none', border: '1px solid #ef4444', color: '#ef4444', padding: '4px 10px', borderRadius: 4, cursor: 'pointer', fontSize: 12 }}>
                Delete
              </button>
              <button onClick={() => setSelected(null)} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 18 }}>✕</button>
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
                <span key={`${tag.key}:${tag.value}`} style={{ background: 'var(--accent-bg)', color: 'var(--accent)', padding: '3px 10px', borderRadius: 12, fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}>
                  {tag.key}:{tag.value}
                  <button onClick={() => handleRemoveTag(tag)} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 12, padding: 0 }}>×</button>
                </span>
              ))}
              {(selected.tags ?? []).length === 0 && <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>No tags</span>}
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <input
                style={{ ...input, flex: 1 }}
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleAddTag(tagInput); }}
                placeholder="circle:delhi or tag:value"
              />
              <button onClick={() => handleAddTag(tagInput)} style={{ background: 'var(--accent-bg)', border: 'none', color: 'var(--accent)', padding: '0 14px', borderRadius: 4, cursor: 'pointer' }}>+</button>
            </div>
          </Section>

          {(selected.pendingCommandCount ?? 0) > 0 && (
            <Section title={`Pending Commands (${selected.pendingCommandCount})`}>
              <div style={{ color: '#fcd34d', fontSize: 13 }}>{selected.pendingCommandCount} commands awaiting delivery</div>
            </Section>
          )}
        </div>
      )}

      {/* ── Add Device Modal ─────────────────────────────────────────── */}
      {showAddModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 10, padding: 28, width: 560, maxHeight: '90vh', overflowY: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 20 }}>
              <h3 style={{ color: 'var(--text-primary)', margin: 0, fontSize: 18 }}>Add New Device</h3>
              <button onClick={() => setShowAddModal(false)} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 20 }}>✕</button>
            </div>

            {addError && (
              <div style={{ background: '#7f1d1d', border: '1px solid #ef4444', borderRadius: 6, padding: '10px 14px', color: '#fca5a5', fontSize: 13, marginBottom: 16 }}>
                {addError}
              </div>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
              <div>
                <label style={label}>Device ID <span style={{ color: '#ef4444' }}>*</span></label>
                <input style={input} value={addForm.deviceId} onChange={(e) => setAddForm((f) => ({ ...f, deviceId: e.target.value }))} placeholder="dev-cpe-xxx-001" />
              </div>
              <div>
                <label style={label}>Device Type <span style={{ color: '#ef4444' }}>*</span></label>
                <select style={input} value={addForm.deviceType} onChange={(e) => setAddForm((f) => ({ ...f, deviceType: e.target.value as DeviceType }))}>
                  <option value="CPE">CPE</option>
                  <option value="BTS">BTS</option>
                  <option value="IDU">IDU</option>
                </select>
              </div>
              <div>
                <label style={label}>Serial Number <span style={{ color: '#ef4444' }}>*</span></label>
                <input style={input} value={addForm.serialNumber} onChange={(e) => setAddForm((f) => ({ ...f, serialNumber: e.target.value }))} placeholder="SN-XXXXXX" />
              </div>
              <div>
                <label style={label}>IP Address <span style={{ color: '#ef4444' }}>*</span></label>
                <input style={input} value={addForm.ipAddress} onChange={(e) => setAddForm((f) => ({ ...f, ipAddress: e.target.value }))} placeholder="192.168.1.100" />
              </div>
              <div>
                <label style={label}>MAC Address</label>
                <input style={input} value={addForm.macAddress} onChange={(e) => setAddForm((f) => ({ ...f, macAddress: e.target.value }))} placeholder="AA:BB:CC:DD:EE:FF" />
              </div>
              <div>
                <label style={label}>Status</label>
                <select style={input} value={addForm.status} onChange={(e) => setAddForm((f) => ({ ...f, status: e.target.value as DeviceStatus }))}>
                  <option value="PROVISIONING">Provisioning</option>
                  <option value="ONLINE">Online</option>
                  <option value="OFFLINE">Offline</option>
                </select>
              </div>
              <div>
                <label style={label}>Manufacturer</label>
                <input style={input} value={addForm.manufacturer} onChange={(e) => setAddForm((f) => ({ ...f, manufacturer: e.target.value }))} placeholder="Senao" />
              </div>
              <div>
                <label style={label}>Model</label>
                <input style={input} value={addForm.model} onChange={(e) => setAddForm((f) => ({ ...f, model: e.target.value }))} placeholder="ENS620EXT" />
              </div>
              <div>
                <label style={label}>Firmware Version</label>
                <input style={input} value={addForm.firmwareVersion} onChange={(e) => setAddForm((f) => ({ ...f, firmwareVersion: e.target.value }))} placeholder="2.1.4" />
              </div>
              <div>
                <label style={label}>Network ID</label>
                <input style={input} value={addForm.networkId} onChange={(e) => setAddForm((f) => ({ ...f, networkId: e.target.value }))} placeholder="net-delhi-north-001" />
              </div>
              <div style={{ gridColumn: '1 / -1' }}>
                <label style={label}>Organization ID</label>
                <input style={input} value={addForm.organizationId} onChange={(e) => setAddForm((f) => ({ ...f, organizationId: e.target.value }))} placeholder="org-airtel-delhi-001" />
              </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 24 }}>
              <button onClick={() => setShowAddModal(false)} style={btnGhost}>Cancel</button>
              <button onClick={handleCreate} disabled={addLoading} style={{ ...btnPrimary, opacity: addLoading ? 0.6 : 1 }}>
                {addLoading ? 'Creating…' : 'Create Device'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Delete Confirmation Dialog ───────────────────────────────── */}
      {deleteConfirm && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: 'var(--bg-surface)', border: '1px solid #ef4444', borderRadius: 10, padding: 28, width: 400 }}>
            <h3 style={{ color: '#ef4444', margin: '0 0 12px' }}>Delete Device</h3>
            <p style={{ color: 'var(--text-secondary)', fontSize: 14, margin: '0 0 8px' }}>
              Are you sure you want to permanently delete:
            </p>
            <p style={{ color: 'var(--text-primary)', fontFamily: 'monospace', fontSize: 14, margin: '0 0 20px', background: 'var(--bg-base)', padding: '8px 12px', borderRadius: 4 }}>
              {deleteConfirm.deviceId} — {deleteConfirm.serialNumber}
            </p>
            <p style={{ color: '#94a3b8', fontSize: 12, margin: '0 0 20px' }}>
              This action cannot be undone. All KPI history and config for this device will also be lost.
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
              <button onClick={() => setDeleteConfirm(null)} style={btnGhost}>Cancel</button>
              <button onClick={() => handleDelete(deleteConfirm)} disabled={deleteLoading} style={{ ...btnDanger, opacity: deleteLoading ? 0.6 : 1 }}>
                {deleteLoading ? 'Deleting…' : 'Yes, Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }): React.ReactElement {
  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ color: 'var(--accent)', fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>{title}</div>
      {children}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', borderBottom: '1px solid var(--border-subtle)' }}>
      <span style={{ color: 'var(--text-muted)', fontSize: 12, flex: '0 0 140px' }}>{label}</span>
      <span style={{ color: 'var(--text-secondary)', fontSize: 13, fontFamily: 'monospace', textAlign: 'right' }}>{value}</span>
    </div>
  );
}
