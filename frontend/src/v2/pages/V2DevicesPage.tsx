/**
 * Inventory (Device Management) — NMS-IV-01 to IV-05
 *
 * Role-based CRUD:
 *  Admin    — Add, Edit, Delete devices
 *  Operator — View only (no Add/Edit/Delete buttons shown)
 *  Viewer   — View only
 */
import 'leaflet/dist/leaflet.css';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  fetchDevices, createDevice, updateDevice, deleteDevice, downloadDeviceExport,
} from '../../api/devices.api';
import type { Device, DeviceFilter, DeviceType, DeviceStatus } from '../../api/devices.types';
import { AdvancedTable, type ColumnDef } from '../components/common/AdvancedTable';
import { Badge } from '../components/common/Badge';
import { Button } from '../components/common/Button';
import { Input } from '../components/common/Input';
import { Select } from '../components/common/Select';
import { MetricCard } from '../components/common/MetricCard';
import { Modal } from '../components/common/Modal';
import { useToast } from '../components/common/Toast';
import { useAuth } from '../../contexts/AuthContext';
import { logger } from '../utils/logger';

// ── Geo helpers ───────────────────────────────────────────────────────────────
/**
 * Haversine great-circle distance in kilometres.
 * Used to enforce topology rules:
 *   - BTS ↔ CPE distance must be < 1 KM (NMS-IV requirement)
 *   - CPE and its linked IDU must share the same coordinates
 */
function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

// ── Constants ────────────────────────────────────────────────────────────────
// Model is strictly derived from device type — no other models allowed
const TYPE_MODEL_MAP: Record<string, string> = { BTS: 'A60', CPE: 'A61', IDU: 'IDU' };

const TYPE_OPTIONS = [
  { value: '', label: 'All types' },
  { value: 'BTS', label: 'BTS' },
  { value: 'CPE', label: 'CPE' },
  { value: 'IDU', label: 'IDU' },
];
const STATUS_OPTIONS = [
  { value: '', label: 'All statuses' },
  { value: 'ONLINE', label: 'Online' },
  { value: 'OFFLINE', label: 'Offline' },
  { value: 'PROVISIONING', label: 'Provisioning' },
  { value: 'UNKNOWN', label: 'Unknown' },
];

function statusVariant(s: DeviceStatus): 'online' | 'offline' | 'warning' | 'unknown' {
  return s === 'ONLINE' ? 'online' : s === 'OFFLINE' ? 'offline' : s === 'PROVISIONING' ? 'warning' : 'unknown';
}

const FIELD = {
  width: '100%', padding: '8px 10px', borderRadius: 6,
  border: '1px solid var(--vf-border-subtle)', background: 'var(--vf-surface)',
  color: 'var(--vf-text-primary)', fontSize: 13, boxSizing: 'border-box' as const,
};
const FL = ({ children }: { children: React.ReactNode }) => (
  <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--vf-text-muted)', marginBottom: 5 }}>{children}</div>
);

// ── Device Form (Add / Edit) ──────────────────────────────────────────────────
interface DeviceFormData {
  serialNumber: string; deviceType: DeviceType; status: DeviceStatus;
  ipAddress: string; macAddress: string; model: string; manufacturer: string;
  firmwareVersion: string; latitude: string; longitude: string;
}

const BLANK_FORM: DeviceFormData = {
  serialNumber: '', deviceType: 'BTS', status: 'PROVISIONING',
  ipAddress: '', macAddress: '', model: 'A60', manufacturer: 'Senao',
  firmwareVersion: '', latitude: '', longitude: '',
};

function DeviceFormModal({
  open, onClose, initial, onSave, allDevices = [],
}: {
  open: boolean;
  onClose: () => void;
  initial?: Device | null;
  onSave: (data: DeviceFormData) => Promise<void>;
  /** Full device list — used to enforce topology distance rules. */
  allDevices?: Device[];
}) {
  const [form, setForm]           = useState<DeviceFormData>(BLANK_FORM);
  const [saving, setSaving]       = useState(false);
  // IDU: which CPE to copy coordinates from
  const [linkedCpeId, setLinkedCpeId] = useState('');
  const { addToast } = useToast();

  useEffect(() => {
    if (open) {
      setLinkedCpeId('');
      setForm(initial ? {
        serialNumber: initial.serialNumber ?? '',
        deviceType:   initial.deviceType ?? 'BTS',
        status:       initial.status ?? 'PROVISIONING',
        ipAddress:    initial.ipAddress ?? '',
        macAddress:   initial.macAddress ?? '',
        model:        initial.model ?? 'A60',
        manufacturer: initial.manufacturer ?? 'Senao',
        firmwareVersion: initial.firmwareVersion ?? '',
        latitude:     String(initial.latitude ?? ''),
        longitude:    String(initial.longitude ?? ''),
      } : { ...BLANK_FORM });
    }
  }, [open, initial]);

  const set = (k: keyof DeviceFormData) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const val = e.target.value;
    setForm((f) => {
      const updated = { ...f, [k]: val };
      // Auto-derive model from device type — BTS→A60, CPE→A61, IDU→IDU
      if (k === 'deviceType') {
        updated.model = TYPE_MODEL_MAP[val] ?? val;
        setLinkedCpeId(''); // reset CPE link when type changes
      }
      return updated;
    });
  };

  // ── Geo rule helpers ────────────────────────────────────────────────────────
  const lat = form.latitude  ? parseFloat(form.latitude)  : undefined;
  const lng = form.longitude ? parseFloat(form.longitude) : undefined;
  const hasCoords = lat != null && lng != null && !isNaN(lat) && !isNaN(lng);

  const deviceCoords = (d: Device): [number, number] | null => {
    // Supports both {latitude, longitude} and GeoJSON {location.coordinates:[lng,lat]}
    const raw = d as unknown as Record<string, unknown>;
    const la = (raw.latitude as number | undefined) ?? d.location?.coordinates?.[1];
    const lo = (raw.longitude as number | undefined) ?? d.location?.coordinates?.[0];
    return (la != null && lo != null) ? [la, lo] : null;
  };

  /** Rule 1: CPE must be within 1KM of at least one BTS. */
  const btsProximityInfo = useMemo(() => {
    if (form.deviceType !== 'CPE' || !hasCoords) return null;
    const btsDevices = allDevices.filter((d) => d.deviceType === 'BTS');
    if (btsDevices.length === 0) return { nearestKm: Infinity, nearestSerial: null };
    let nearestKm = Infinity;
    let nearestSerial: string | null = null;
    for (const bts of btsDevices) {
      const c = deviceCoords(bts);
      if (!c) continue;
      const km = haversineKm(lat!, lng!, c[0], c[1]);
      if (km < nearestKm) { nearestKm = km; nearestSerial = bts.serialNumber; }
    }
    return { nearestKm, nearestSerial };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.deviceType, lat, lng, allDevices]);

  const btsTooFar = btsProximityInfo != null && btsProximityInfo.nearestKm > 1;

  /** Rule 2: IDU must share coordinates with its linked CPE. */
  const cpeList = useMemo(
    () => allDevices.filter((d) => d.deviceType === 'CPE'),
    [allDevices],
  );

  const cpeCoordsMatch = useMemo(() => {
    if (form.deviceType !== 'IDU' || !linkedCpeId || !hasCoords) return null;
    const cpe = cpeList.find((d) => d.id === linkedCpeId || d.serialNumber === linkedCpeId);
    if (!cpe) return null;
    const c = deviceCoords(cpe);
    if (!c) return null;
    const km = haversineKm(lat!, lng!, c[0], c[1]);
    return { km, cpeSerial: cpe.serialNumber };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.deviceType, linkedCpeId, lat, lng, cpeList]);

  const iduCoordsMismatch = cpeCoordsMatch != null && cpeCoordsMatch.km > 0.01; // >10 m = mismatch

  /** Copy CPE coordinates to IDU form fields. */
  const handleCopyCpeCoords = (cpeId: string) => {
    setLinkedCpeId(cpeId);
    const cpe = cpeList.find((d) => d.id === cpeId || d.serialNumber === cpeId);
    if (!cpe) return;
    const c = deviceCoords(cpe);
    if (c) setForm((f) => ({ ...f, latitude: c[0].toFixed(6), longitude: c[1].toFixed(6) }));
  };

  // ── Save with rule enforcement ──────────────────────────────────────────────
  const handleSave = async () => {
    if (!form.serialNumber.trim()) { addToast('Serial number is required', 'warning'); return; }
    if (!form.ipAddress.trim())    { addToast('IP address is required', 'warning'); return; }

    // Block CPE save if coordinates are >1KM from every BTS
    if (btsTooFar) {
      addToast(
        `CPE must be within 1 KM of a BTS. Nearest BTS is ${btsProximityInfo!.nearestKm.toFixed(2)} km away.`,
        'error',
      );
      return;
    }

    // Block IDU save if coordinates diverge from linked CPE
    if (iduCoordsMismatch) {
      addToast(
        `IDU coordinates must match its CPE (${cpeCoordsMatch!.cpeSerial}). Current offset: ${(cpeCoordsMatch!.km * 1000).toFixed(0)} m.`,
        'error',
      );
      return;
    }

    setSaving(true);
    try { await onSave(form); onClose(); }
    catch { /* parent shows toast */ }
    finally { setSaving(false); }
  };

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <Modal open={open} onClose={onClose} title={initial ? 'Edit Device' : 'Add Device'} size="lg">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>

        {/* Topology rule info banner */}
        <div style={{
          background: 'var(--vf-surface-raised, rgba(255,255,255,0.04))',
          border: '1px solid var(--vf-border-subtle)',
          borderRadius: 6, padding: '8px 12px', fontSize: 12,
          color: 'var(--vf-text-secondary)',
        }}>
          <strong style={{ color: 'var(--vf-text-primary)' }}>Topology rules:</strong>
          {' '}BTS → CPE distance &lt; 1 KM &nbsp;·&nbsp; CPE and IDU must share the same coordinates
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div>
            <FL>Device Type *</FL>
            <select value={form.deviceType} onChange={set('deviceType')} style={FIELD}>
              <option value="BTS">BTS — Model A60</option>
              <option value="CPE">CPE — Model A61</option>
              <option value="IDU">IDU — Model IDU</option>
            </select>
          </div>
          <div>
            <FL>Model (auto)</FL>
            <input
              readOnly value={form.model}
              style={{ ...FIELD, background: 'var(--vf-surface-raised)', color: 'var(--vf-text-muted)', cursor: 'not-allowed' }}
            />
          </div>
          <div>
            <FL>Serial Number *</FL>
            <input
              value={form.serialNumber} onChange={set('serialNumber')}
              placeholder={
                form.deviceType === 'BTS' ? 'BTS-A60-000001' :
                form.deviceType === 'CPE' ? 'CPE-A61-000001' : 'IDU-000001'
              }
              style={FIELD}
            />
          </div>
          <div>
            <FL>IP Address *</FL>
            <input value={form.ipAddress} onChange={set('ipAddress')} placeholder="10.10.1.1" style={FIELD} />
          </div>
          <div>
            <FL>MAC Address</FL>
            <input value={form.macAddress} onChange={set('macAddress')} placeholder="AA:BB:CC:DD:EE:FF" style={FIELD} />
          </div>
          <div>
            <FL>Manufacturer</FL>
            <input value={form.manufacturer} onChange={set('manufacturer')} placeholder="Senao" style={FIELD} />
          </div>
          <div>
            <FL>Firmware Version</FL>
            <input value={form.firmwareVersion} onChange={set('firmwareVersion')} placeholder="v3.5.0" style={FIELD} />
          </div>
          <div>
            <FL>Initial Status</FL>
            <select value={form.status} onChange={set('status')} style={FIELD}>
              <option value="PROVISIONING">PROVISIONING</option>
              <option value="ONLINE">ONLINE</option>
              <option value="OFFLINE">OFFLINE</option>
              <option value="UNKNOWN">UNKNOWN</option>
            </select>
          </div>

          {/* IDU: link to CPE for coordinate copy */}
          {form.deviceType === 'IDU' && (
            <div style={{ gridColumn: '1 / -1' }}>
              <FL>Link to CPE (copies coordinates automatically)</FL>
              <select
                value={linkedCpeId}
                onChange={(e) => handleCopyCpeCoords(e.target.value)}
                style={FIELD}
              >
                <option value="">— Select CPE to sync coordinates —</option>
                {cpeList.map((cpe) => {
                  const c = deviceCoords(cpe);
                  return (
                    <option key={cpe.id} value={cpe.id}>
                      {cpe.serialNumber}{c ? ` (${c[0].toFixed(4)}, ${c[1].toFixed(4)})` : ''}
                    </option>
                  );
                })}
              </select>
              {linkedCpeId && !iduCoordsMismatch && hasCoords && (
                <div style={{ marginTop: 5, fontSize: 11, color: '#22c55e' }}>
                  Coordinates match linked CPE
                </div>
              )}
            </div>
          )}

          <div>
            <FL>Latitude (GPS)</FL>
            <input type="number" value={form.latitude} onChange={set('latitude')} placeholder="28.6139" style={FIELD} />
          </div>
          <div>
            <FL>Longitude (GPS)</FL>
            <input type="number" value={form.longitude} onChange={set('longitude')} placeholder="77.2090" style={FIELD} />
          </div>
        </div>

        {/* Rule 1 — CPE proximity warning */}
        {form.deviceType === 'CPE' && hasCoords && btsProximityInfo && (
          <div style={{
            display: 'flex', alignItems: 'flex-start', gap: 8,
            background: btsTooFar ? 'rgba(239,68,68,0.08)' : 'rgba(34,197,94,0.08)',
            border: `1px solid ${btsTooFar ? '#ef4444' : '#22c55e'}`,
            borderRadius: 6, padding: '8px 12px', fontSize: 12,
          }}>
            <span style={{ fontSize: 16, lineHeight: 1 }}>{btsTooFar ? '✗' : '✓'}</span>
            <div>
              {btsProximityInfo.nearestSerial
                ? <>
                    Nearest BTS: <strong style={{ fontFamily: 'monospace' }}>{btsProximityInfo.nearestSerial}</strong>
                    {' — '}<strong style={{ color: btsTooFar ? '#ef4444' : '#22c55e' }}>
                      {btsProximityInfo.nearestKm < 1
                        ? `${(btsProximityInfo.nearestKm * 1000).toFixed(0)} m away`
                        : `${btsProximityInfo.nearestKm.toFixed(2)} km away`}
                    </strong>
                    {btsTooFar && <span style={{ color: '#ef4444' }}> — must be &lt; 1 KM</span>}
                  </>
                : <span style={{ color: '#f59e0b' }}>No BTS devices with coordinates found in inventory</span>
              }
            </div>
          </div>
        )}

        {/* Rule 2 — IDU coordinate mismatch warning */}
        {form.deviceType === 'IDU' && linkedCpeId && iduCoordsMismatch && cpeCoordsMatch && (
          <div style={{
            display: 'flex', alignItems: 'flex-start', gap: 8,
            background: 'rgba(239,68,68,0.08)', border: '1px solid #ef4444',
            borderRadius: 6, padding: '8px 12px', fontSize: 12,
          }}>
            <span style={{ fontSize: 16, lineHeight: 1 }}>✗</span>
            <div>
              IDU coordinates differ from CPE <strong style={{ fontFamily: 'monospace' }}>{cpeCoordsMatch.cpeSerial}</strong>
              {' by '}
              <strong style={{ color: '#ef4444' }}>
                {cpeCoordsMatch.km < 1
                  ? `${(cpeCoordsMatch.km * 1000).toFixed(0)} m`
                  : `${cpeCoordsMatch.km.toFixed(2)} km`}
              </strong>
              . CPE and IDU must share the same coordinates.
            </div>
          </div>
        )}

        {/* Map picker */}
        <GpsMapPicker
          lat={lat}
          lng={lng}
          onPick={(pickLat, pickLng) => setForm((f) => ({ ...f, latitude: pickLat.toFixed(6), longitude: pickLng.toFixed(6) }))}
        />

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', paddingTop: 4 }}>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={saving} onClick={handleSave}>
            {initial ? 'Save Changes' : 'Add Device'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ── GPS Map Picker ─────────────────────────────────────────────────────────────
/**
 * Inline Leaflet map that lets the user click to pick GPS coordinates.
 * Uses a simple <iframe> to OpenStreetMap so no extra Leaflet setup is needed;
 * we layer a transparent overlay to capture click coordinates via the
 * projection formula instead of relying on Leaflet events.
 * We use a real Leaflet map created imperatively so we get accurate clicks.
 */
function GpsMapPicker({ lat, lng, onPick }: {
  lat?: number;
  lng?: number;
  onPick(lat: number, lng: number): void;
}) {
  const [expanded, setExpanded] = useState(false);
  const mapRef = useRef<HTMLDivElement>(null);
  // Store the Leaflet map and marker instances across renders
  const mapInstanceRef = useRef<{ map: import('leaflet').Map; marker: import('leaflet').Marker | null } | null>(null);

  // Initialise Leaflet imperatively when the panel opens
  useEffect(() => {
    if (!expanded || !mapRef.current) return;

    // Dynamically import Leaflet so the bundle isn't bloated for users who never open this
    import('leaflet').then((mod) => {
      // Leaflet is CJS — the module IS the namespace, but Vite may wrap it
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const Lf = ((mod as any).default ?? mod) as typeof import('leaflet');
      if (!mapRef.current) return;

      // Clean up any previous map on the same element
      if (mapInstanceRef.current) {
        mapInstanceRef.current.map.remove();
        mapInstanceRef.current = null;
      }

      const centre: [number, number] = lat != null && lng != null ? [lat, lng] : [20.5937, 78.9629]; // India centre fallback
      const map = Lf.map(mapRef.current, { center: centre, zoom: lat != null ? 12 : 5, zoomControl: true });
      Lf.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap',
      }).addTo(map);

      const icon = Lf.divIcon({
        className: '',
        html: '<div style="width:14px;height:14px;background:#7c3aed;border:2px solid #fff;border-radius:50%;box-shadow:0 0 6px rgba(124,58,237,0.8)"></div>',
        iconAnchor: [7, 7],
      });

      let marker: import('leaflet').Marker | null = null;
      if (lat != null && lng != null) {
        marker = Lf.marker([lat, lng], { icon }).addTo(map);
      }

      map.on('click', (e: import('leaflet').LeafletMouseEvent) => {
        const { lat: clickLat, lng: clickLng } = e.latlng;
        if (marker) {
          marker.setLatLng([clickLat, clickLng]);
        } else {
          marker = Lf.marker([clickLat, clickLng], { icon }).addTo(map);
        }
        mapInstanceRef.current!.marker = marker;
        onPick(clickLat, clickLng);
      });

      mapInstanceRef.current = { map, marker };
    });

    return () => {
      if (mapInstanceRef.current) {
        mapInstanceRef.current.map.remove();
        mapInstanceRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded]);

  // Move marker when lat/lng inputs change
  useEffect(() => {
    if (!mapInstanceRef.current || lat == null || lng == null) return;
    const { map, marker } = mapInstanceRef.current;
    if (marker) {
      marker.setLatLng([lat, lng]);
    }
    map.setView([lat, lng], map.getZoom());
  }, [lat, lng]);

  return (
    <div>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        style={{
          display: 'flex', alignItems: 'center', gap: 6,
          background: 'none', border: '1px dashed var(--vf-border-default)',
          borderRadius: 6, padding: '7px 14px', cursor: 'pointer',
          color: 'var(--vf-accent)', fontSize: 13, width: '100%',
        }}>
        📍 {expanded ? 'Hide map picker' : 'Pick location from map'}
        {lat != null && lng != null && !expanded && (
          <span style={{ color: 'var(--vf-text-muted)', fontFamily: 'monospace', fontSize: 12 }}>
            ({lat.toFixed(4)}, {lng.toFixed(4)})
          </span>
        )}
      </button>
      {expanded && (
        <div style={{ marginTop: 8, borderRadius: 8, overflow: 'hidden', border: '1px solid var(--vf-border-subtle)', height: 280, position: 'relative' }}>
          <div style={{ position: 'absolute', top: 6, left: 8, zIndex: 1000, background: 'rgba(0,0,0,0.65)', color: '#fff', fontSize: 11, padding: '3px 8px', borderRadius: 4, pointerEvents: 'none' }}>
            Click map to set location
          </div>
          <div ref={mapRef} style={{ width: '100%', height: '100%' }} />
        </div>
      )}
    </div>
  );
}


// ── Delete Confirmation ───────────────────────────────────────────────────────
function DeleteConfirmModal({ device, onClose, onDelete }: { device: Device | null; onClose: () => void; onDelete: () => Promise<void> }) {
  const [deleting, setDeleting] = useState(false);
  if (!device) return null;
  return (
    <Modal open={!!device} onClose={onClose} title="Delete Device">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <p style={{ fontSize: 13, color: 'var(--vf-text-secondary)', margin: 0 }}>
          Remove <strong style={{ fontFamily: 'var(--vf-font-mono)' }}>{device.serialNumber}</strong> from inventory? This action cannot be undone.
        </p>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="danger" loading={deleting} onClick={async () => { setDeleting(true); await onDelete(); setDeleting(false); }}>
            Delete
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────
export default function V2DevicesPage() {
  const navigate    = useNavigate();
  const [searchParams] = useSearchParams();
  const { addToast } = useToast();
  const { user }    = useAuth();
  const isAdmin     = user?.role === 'Admin';

  const [devices, setDevices]       = useState<Device[]>([]);
  const [loading, setLoading]       = useState(true);
  const [filter, setFilter]         = useState<DeviceFilter>(() => {
    const init: DeviceFilter = {};
    const status     = searchParams.get('status') as DeviceStatus | null;
    const deviceType = searchParams.get('deviceType') as DeviceType | null;
    const firmware   = searchParams.get('firmware');
    if (status) init.status = status;
    if (deviceType) init.deviceType = deviceType;
    if (firmware) init.firmware = firmware;
    return init;
  });
  const [search, setSearch]         = useState(searchParams.get('search') ?? '');
  const [showGpsSearch, setShowGpsSearch] = useState(false);
  const [gpsLat, setGpsLat]         = useState('');
  const [gpsLng, setGpsLng]         = useState('');
  const [gpsRadius, setGpsRadius]   = useState('1');

  // CRUD state
  const [showAddModal, setShowAddModal]   = useState(false);
  const [editDevice, setEditDevice]       = useState<Device | null>(null);
  const [deleteDevice_, setDeleteDevice_] = useState<Device | null>(null);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const data = await fetchDevices(filter);
      setDevices(data);
    } catch (e) {
      logger.error('Failed to fetch devices', e);
      addToast('Failed to load inventory', 'error');
    } finally { setLoading(false); }
  }, [filter, addToast]);

  useEffect(() => { load(); }, [load]);

  // ── CRUD handlers ─────────────────────────────────────────────────────────
  const handleAdd = async (form: DeviceFormData) => {
    try {
      const created = await createDevice({
        serialNumber:    form.serialNumber,
        deviceType:      form.deviceType,
        status:          form.status,
        ipAddress:       form.ipAddress,
        macAddress:      form.macAddress || undefined,
        model:           form.model,
        manufacturer:    form.manufacturer,
        firmwareVersion: form.firmwareVersion || undefined,
        latitude:        form.latitude ? parseFloat(form.latitude) : undefined,
        longitude:       form.longitude ? parseFloat(form.longitude) : undefined,
      } as Omit<Device, 'id'>);
      setDevices((prev) => [created, ...prev]);
      addToast(`Device ${created.serialNumber} added`, 'success');
    } catch (e) {
      logger.error('Create device failed', e);
      addToast('Failed to add device', 'error');
      throw e;
    }
  };

  const handleEdit = async (form: DeviceFormData) => {
    if (!editDevice) return;
    try {
      const updated = await updateDevice(editDevice.id, {
        serialNumber:    form.serialNumber,
        deviceType:      form.deviceType,
        status:          form.status,
        ipAddress:       form.ipAddress,
        macAddress:      form.macAddress || undefined,
        model:           form.model,
        manufacturer:    form.manufacturer,
        firmwareVersion: form.firmwareVersion || undefined,
        latitude:        form.latitude ? parseFloat(form.latitude) : undefined,
        longitude:       form.longitude ? parseFloat(form.longitude) : undefined,
      });
      setDevices((prev) => prev.map((d) => d.id === editDevice.id ? updated : d));
      addToast(`Device ${updated.serialNumber} updated`, 'success');
    } catch (e) {
      logger.error('Update device failed', e);
      addToast('Failed to update device', 'error');
      throw e;
    }
  };

  const handleDelete = async () => {
    if (!deleteDevice_) return;
    try {
      await deleteDevice(deleteDevice_.id);
      setDevices((prev) => prev.filter((d) => d.id !== deleteDevice_.id));
      addToast(`Device ${deleteDevice_.serialNumber} removed`, 'success');
      setDeleteDevice_(null);
    } catch (e) {
      logger.error('Delete device failed', e);
      addToast('Failed to delete device', 'error');
    }
  };

  // ── Table columns ─────────────────────────────────────────────────────────
  const columns: ColumnDef<Device>[] = [
    {
      key: 'serialNumber', header: 'Serial', sortable: true,
      render: (d) => (
        <span style={{ fontFamily: 'var(--vf-font-mono)', fontSize: 12, color: 'var(--vf-accent)', cursor: 'pointer' }}
          onClick={(e) => { e.stopPropagation(); navigate(`/v2/devices/${d.id}`); }}>
          {d.serialNumber}
        </span>
      ),
    },
    { key: 'deviceType', header: 'Type', sortable: true, render: (d) => <Badge variant="default">{d.deviceType}</Badge>, width: 80 },
    {
      key: 'status', header: 'Status', sortable: true,
      render: (d) => <Badge variant={statusVariant(d.status)} dot>{d.status}</Badge>, width: 120,
    },
    { key: 'ipAddress', header: 'IP', sortable: true, render: (d) => <span style={{ fontFamily: 'var(--vf-font-mono)', fontSize: 12 }}>{d.ipAddress}</span> },
    { key: 'manufacturer', header: 'Manufacturer', sortable: true },
    { key: 'model', header: 'Model', sortable: true },
    { key: 'firmwareVersion', header: 'Firmware', sortable: true },
    {
      key: 'location', header: 'GPS',
      render: (d) => d.location?.coordinates?.[1] != null
        ? <span style={{ fontSize: 12, color: 'var(--vf-text-secondary)' }}>{d.location.coordinates[1].toFixed(4)}, {d.location.coordinates[0].toFixed(4)}</span>
        : <span style={{ color: 'var(--vf-text-dim)' }}>—</span>,
    },
    {
      key: 'pendingCommandCount', header: 'Pending', sortable: true,
      render: (d) => d.pendingCommandCount
        ? <Badge variant="warning">⏳ {d.pendingCommandCount}</Badge>
        : <span style={{ color: 'var(--vf-text-dim)' }}>—</span>,
      width: 80,
    },
    {
      key: 'tags', header: 'Tags',
      render: (d) => (
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {(d.tags ?? []).slice(0, 3).map((t) => (
            <Badge key={`${t.key}:${t.value}`} variant="default">{t.key}:{t.value}</Badge>
          ))}
          {(d.tags?.length ?? 0) > 3 && <Badge variant="default">+{(d.tags?.length ?? 0) - 3}</Badge>}
        </div>
      ),
    },
    // Actions column — Admin only
    ...(isAdmin ? [{
      key: '_actions' as keyof Device,
      header: 'Actions',
      width: 120,
      render: (d: Device) => (
        <div style={{ display: 'flex', gap: 6 }} onClick={(e) => e.stopPropagation()}>
          <button
            onClick={() => setEditDevice(d)}
            style={{ background: 'var(--vf-elevated)', border: 'var(--vf-card-border)', color: 'var(--vf-text-secondary)', padding: '3px 10px', borderRadius: 5, cursor: 'pointer', fontSize: 11, fontWeight: 600 }}>
            Edit
          </button>
          <button
            onClick={() => setDeleteDevice_(d)}
            style={{ background: 'none', border: '1px solid var(--vf-danger)', color: 'var(--vf-danger)', padding: '3px 10px', borderRadius: 5, cursor: 'pointer', fontSize: 11, fontWeight: 600 }}>
            Delete
          </button>
        </div>
      ),
    }] : []),
  ];

  const online  = devices.filter((d) => d.status === 'ONLINE').length;
  const offline = devices.filter((d) => d.status === 'OFFLINE').length;
  const btsCount = devices.filter((d) => d.deviceType === 'BTS').length;
  const cpeCount = devices.filter((d) => d.deviceType === 'CPE').length;

  const handleExport = async (fmt: 'csv' | 'xls') => {
    try {
      try { await downloadDeviceExport(filter, fmt); }
      catch {
        if (fmt === 'csv') {
          const header = 'Serial,Type,Model,Status,IP,MAC,Firmware,Latitude,Longitude\n';
          const rows = devices.map((d) =>
            `${d.serialNumber},${d.deviceType},${d.model},${d.status},${d.ipAddress},${d.macAddress ?? ''},${d.firmwareVersion ?? ''},${d.latitude ?? ''},${d.longitude ?? ''}`
          ).join('\n');
          const blob = new Blob([header + rows], { type: 'text/csv' });
          const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'inventory.csv'; a.click();
        }
      }
      addToast(`Inventory exported as ${fmt.toUpperCase()}`, 'success');
    } catch { addToast('Export failed', 'error'); }
  };

  const handleGpsSearch = () => {
    const lat = parseFloat(gpsLat); const lng = parseFloat(gpsLng); const r = parseFloat(gpsRadius);
    if (isNaN(lat) || isNaN(lng)) { addToast('Enter valid lat/lng coordinates', 'error'); return; }
    const R = 6371;
    const inRadius = devices.filter((d) => {
      if (!d.latitude || !d.longitude) return false;
      const dLat = ((d.latitude - lat) * Math.PI) / 180;
      const dLng = ((d.longitude - lng) * Math.PI) / 180;
      const a = Math.sin(dLat / 2) ** 2 + Math.cos((lat * Math.PI) / 180) * Math.cos((d.latitude * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
      return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) <= r;
    });
    setSearch(''); setFilter({});
    setDevices(inRadius);
    addToast(`${inRadius.length} devices within ${r} km`, 'success');
    setShowGpsSearch(false);
  };

  const tableData = filter.firmware ? devices.filter((d) => d.firmwareVersion === filter.firmware) : devices;

  return (
    <div className="vf-page">
      <div className="vf-page-header">
        <div>
          <h1 className="vf-page-title">Inventory</h1>
          {!isAdmin && (
            <span style={{ fontSize: 11, color: 'var(--vf-text-muted)', marginTop: 2, display: 'block' }}>
              View only — contact an Admin to add or modify devices
            </span>
          )}
        </div>
        <div className="vf-page-actions">
          {isAdmin && (
            <Button variant="primary" size="sm" onClick={() => setShowAddModal(true)}>
              + Add Device
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={() => setShowGpsSearch(true)}>📍 GPS Search</Button>
          <Button variant="ghost" size="sm" onClick={() => handleExport('csv')}>CSV</Button>
          <Button variant="ghost" size="sm" onClick={() => handleExport('xls')}>XLS</Button>
          <Button variant="ghost" size="sm" onClick={load}>Refresh</Button>
        </div>
      </div>

      {/* Role badge */}
      {isAdmin && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
          <span style={{ background: 'var(--vf-success-bg)', border: '1px solid var(--vf-success)', color: 'var(--vf-success)', fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 4 }}>
            ADMIN — Full CRUD enabled
          </span>
        </div>
      )}

      {/* Summary */}
      <div className="vf-kpi-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))' }}>
        <MetricCard label="Total"   value={devices.length} loading={loading} />
        <MetricCard label="Online"  value={online}         variant="success" loading={loading} />
        <MetricCard label="Offline" value={offline}        variant={offline > 0 ? 'danger' : 'default'} loading={loading} />
        <MetricCard label="BTS"     value={btsCount}       loading={loading} />
        <MetricCard label="CPE"     value={cpeCount}       loading={loading} />
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <Input placeholder="Search by serial, IP, model…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ width: 280 }} />
        <Select options={TYPE_OPTIONS} value={filter.deviceType ?? ''} onChange={(e) => setFilter((f) => ({ ...f, deviceType: (e.target.value as DeviceType) || undefined }))} style={{ width: 140 }} />
        <Select options={STATUS_OPTIONS} value={filter.status ?? ''} onChange={(e) => setFilter((f) => ({ ...f, status: (e.target.value as DeviceStatus) || undefined }))} style={{ width: 160 }} />
        <Button variant="ghost" size="sm" onClick={() => { setFilter({}); setSearch(''); }}>Clear</Button>
      </div>

      {/* Drilldown banner */}
      {(filter.status || filter.deviceType || filter.firmware) && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 14px', background: 'var(--vf-accent-subtle)', border: '1px solid var(--vf-accent)', borderRadius: 8, fontSize: 12 }}>
          <span style={{ color: 'var(--vf-accent)', fontWeight: 700 }}>Drilldown filter active:</span>
          {filter.status     && <span style={{ background: 'var(--vf-elevated)', padding: '2px 8px', borderRadius: 4 }}>Status: {filter.status}</span>}
          {filter.deviceType && <span style={{ background: 'var(--vf-elevated)', padding: '2px 8px', borderRadius: 4 }}>Type: {filter.deviceType}</span>}
          {filter.firmware   && <span style={{ background: 'var(--vf-elevated)', padding: '2px 8px', borderRadius: 4 }}>Firmware: {filter.firmware}</span>}
          <button onClick={() => setFilter({})} style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--vf-accent)', fontSize: 12, fontWeight: 600 }}>✕ Clear</button>
        </div>
      )}

      {/* Table */}
      <AdvancedTable
        columns={columns}
        data={tableData}
        rowKey={(d) => d.id}
        onRowClick={(d) => navigate(`/v2/devices/${d.id}`)}
        loading={loading}
        globalFilter={search}
        filterFields={['serialNumber', 'ipAddress', 'manufacturer', 'model', 'deviceType', 'status']}
        emptyMessage="No devices found — try adjusting filters"
        maxHeight="calc(100vh - 420px)"
      />

      {/* GPS Search Modal */}
      <Modal open={showGpsSearch} onClose={() => setShowGpsSearch(false)} title="GPS Location Search">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <p style={{ fontSize: 13, color: 'var(--vf-text-muted)', margin: 0 }}>Find all devices within a radius (NMS-IV-04).</p>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div>
              <FL>Latitude</FL>
              <input value={gpsLat} onChange={(e) => setGpsLat(e.target.value)} placeholder="28.4595" type="number" style={FIELD} />
            </div>
            <div>
              <FL>Longitude</FL>
              <input value={gpsLng} onChange={(e) => setGpsLng(e.target.value)} placeholder="77.0266" type="number" style={FIELD} />
            </div>
          </div>
          <div>
            <FL>Radius (km)</FL>
            <input value={gpsRadius} onChange={(e) => setGpsRadius(e.target.value)} type="number" min="0.1" max="100" step="0.5" style={{ ...FIELD, width: 120 }} />
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <Button variant="primary" onClick={handleGpsSearch}>Search</Button>
            <Button variant="ghost" onClick={() => { setShowGpsSearch(false); load(); }}>Reset</Button>
          </div>
        </div>
      </Modal>

      {/* Add Device Modal */}
      <DeviceFormModal
        open={showAddModal}
        onClose={() => setShowAddModal(false)}
        onSave={handleAdd}
        allDevices={devices}
      />

      {/* Edit Device Modal */}
      <DeviceFormModal
        open={!!editDevice}
        onClose={() => setEditDevice(null)}
        initial={editDevice}
        onSave={handleEdit}
        allDevices={devices}
      />

      {/* Delete Confirmation */}
      <DeleteConfirmModal
        device={deleteDevice_}
        onClose={() => setDeleteDevice_(null)}
        onDelete={handleDelete}
      />
    </div>
  );
}
