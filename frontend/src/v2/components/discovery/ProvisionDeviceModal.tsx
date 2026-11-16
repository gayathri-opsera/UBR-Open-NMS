/**
 * ProvisionDeviceModal — admin confirmation dialog for provisioning a discovered
 * network device into the managed inventory.
 *
 * Flow: SNMP Discovery → admin clicks "Provision" → this modal → (success state) →
 *       navigate to Inventory or Topology.
 *
 * Auto-population logic:
 *   • deviceType  — device-reported role (vendor role OID); admin picks only when not reported
 *   • serialNumber — the serial number the device itself reports (vendor serial OID). Only when
 *                    the device reports none is a hostname/IP-derived value offered, and editable.
 *   • lat/lng     — the GPS position the device publishes (vendor GPS OIDs or a coordinate pair
 *                    in sysLocation).
 *
 * When the device publishes no GPS position the admin sets it here — on the map or by typing
 * coordinates. A position the device publishes later (live poll) always replaces that one.
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Modal } from '../common/Modal';
import { Button } from '../common/Button';
import { Input } from '../common/Input';
import { GpsMapPicker } from '../common/GpsMapPicker';
import type { DiscoveryResult, ProvisionHostRequest, NmsDeviceType } from '../../../api/discovery.api';
import { mapGenericTypeToDeviceType, buildProvisionRequest } from '../../../api/discovery.api';
import { listModels, listRolesForModel } from '../../../api/deviceTypeCombinations.api';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ProvisionDeviceModalProps {
  /** The discovery result to provision. Null when modal is closed. */
  result: DiscoveryResult | null;
  open: boolean;
  /** Called when the user dismisses or finishes with the modal. */
  onClose: () => void;
  /**
   * Called when the admin confirms provisioning.
   * The parent is responsible for calling the API and showing the result.
   */
  onConfirm: (req: ProvisionHostRequest) => void;
  /** True while the parent is processing the API call. */
  saving?: boolean;
  /**
   * Set to true by the parent after a successful provision API call.
   * Switches the modal into the success state with navigation buttons.
   */
  provisioned?: boolean;
  /** The device ID returned by the inventory after provisioning — used for deep-links. */
  provisionedDeviceId?: string;
  /** Serial number after provisioning (for display). */
  provisionedSerialNumber?: string;
}

// Re-export for internal use
type DeviceType = NmsDeviceType;

/** Emoji and color for every supported device type. Unknown types get a fallback. */
const TYPE_META: Record<string, { emoji: string; color: string; label: string; desc: string }> = {
  BTS:      { emoji: '📡', color: '#3b82f6', label: 'BTS',      desc: 'Base Transceiver Station — provides wireless coverage to CPEs.' },
  CPE:      { emoji: '🏠', color: '#22c55e', label: 'CPE',      desc: 'Customer Premises Equipment — receives signal from a BTS.' },
  IDU:      { emoji: '🔌', color: '#f59e0b', label: 'IDU',      desc: 'Indoor Unit — wired Ethernet/PoE bridge attached to a CPE.' },
  RADIO:    { emoji: '📻', color: '#8b5cf6', label: 'RADIO',    desc: 'Wireless Radio / Backhaul — point-to-point or sector radio.' },
  SWITCH:   { emoji: '🔄', color: '#06b6d4', label: 'SWITCH',   desc: 'Network Switch — L2/L3 switching device.' },
  ROUTER:   { emoji: '🌐', color: '#0ea5e9', label: 'ROUTER',   desc: 'Router — routes traffic between network segments.' },
  GATEWAY:  { emoji: '🚪', color: '#64748b', label: 'GATEWAY',  desc: 'Gateway — edge device bridging two network domains.' },
  FIREWALL: { emoji: '🔥', color: '#ef4444', label: 'FIREWALL', desc: 'Firewall — security appliance controlling traffic flow.' },
  AP:       { emoji: '📶', color: '#10b981', label: 'AP',       desc: 'Access Point — wireless LAN access point (Wi-Fi).' },
  OLT:      { emoji: '💡', color: '#f97316', label: 'OLT',      desc: 'Optical Line Terminal — PON headend device.' },
  ONU:      { emoji: '📦', color: '#a855f7', label: 'ONU',      desc: 'Optical Network Unit — subscriber-side PON device.' },
  SERVER:   { emoji: '🖥️', color: '#6366f1', label: 'SERVER',   desc: 'Server — network management host or application server.' },
  UNKNOWN:  { emoji: '❓', color: '#94a3b8', label: 'UNKNOWN',  desc: 'Unclassified device — update after discovery.' },
};

/** Returns meta for any type, generating a sensible fallback for custom types. */
function getTypeMeta(type: string) {
  return TYPE_META[type.toUpperCase()] ?? {
    emoji: '🔧', color: '#64748b',
    label: type.toUpperCase(),
    desc: `Custom device type: ${type}`,
  };
}

/**
 * Ordered list of "common" types shown as quick-select buttons.
 * The detected type is always prepended so it appears first.
 */
const COMMON_TYPES: DeviceType[] = [
  'BTS','CPE','IDU','RADIO','SWITCH','ROUTER','GATEWAY','FIREWALL','AP','OLT','ONU',
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function deriveSerialFromResult(r: DiscoveryResult): string {
  if (r.sysName && r.sysName.trim() && r.sysName.trim() !== 'N/A') {
    const safe = r.sysName.trim().replace(/[^a-zA-Z0-9-_]/g, '-').slice(0, 28);
    if (safe.length >= 4) return `SN-${safe}`;
  }
  return `SNMP-${r.ip.replace(/\./g, '-')}`;
}

// ── Field component ───────────────────────────────────────────────────────────

function Field({
  label, value, onChange, placeholder, mono, required, readOnly, type, hint, badge,
}: {
  label: string;
  value: string;
  onChange?: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
  required?: boolean;
  readOnly?: boolean;
  type?: string;
  hint?: string;
  badge?: string; // small inline badge next to label, e.g. "auto-filled"
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <label style={{
        fontSize: 11, fontWeight: 700, textTransform: 'uppercase',
        letterSpacing: '0.06em', color: 'var(--vf-text-muted)',
        display: 'flex', alignItems: 'center', gap: 6,
      }}>
        {label}
        {required && <span style={{ color: 'var(--vf-danger)' }}>*</span>}
        {badge && (
          <span style={{
            fontSize: 9, fontWeight: 600, background: 'rgba(34,197,94,0.15)',
            color: '#22c55e', borderRadius: 4, padding: '1px 5px', textTransform: 'none',
          }}>
            {badge}
          </span>
        )}
      </label>
      {readOnly ? (
        <div style={{
          padding: '7px 10px', borderRadius: 6,
          border: '1px solid var(--vf-border-subtle)',
          background: 'var(--vf-surface-raised)',
          fontFamily: mono ? 'var(--vf-font-mono)' : undefined,
          fontSize: 13, color: 'var(--vf-text-secondary)',
        }}>
          {value || '—'}
        </div>
      ) : (
        <Input
          type={type}
          value={value}
          onChange={(e) => onChange?.(e.target.value)}
          placeholder={placeholder}
          style={{ fontFamily: mono ? 'var(--vf-font-mono)' : undefined, fontSize: 13 }}
        />
      )}
      {hint && (
        <span style={{ fontSize: 11, color: 'var(--vf-text-muted)', lineHeight: 1.4 }}>{hint}</span>
      )}
    </div>
  );
}

// ── Success State ─────────────────────────────────────────────────────────────

function SuccessView({
  ip,
  serialNumber,
  deviceId,
  deviceType,
  onClose,
}: {
  ip: string;
  serialNumber: string;
  deviceId: string;
  deviceType: DeviceType;
  onClose: () => void;
}) {
  const navigate = useNavigate();

  function goInventory() {
    onClose();
    // The device that was just provisioned: open its own page (Node View). Fall back to the
    // discovered-devices list only when the id is not known.
    navigate(deviceId ? `/v2/devices/${encodeURIComponent(deviceId)}` : '/v2/discovery?tab=all');
  }

  function goTopology() {
    onClose();
    // Pass the IP as a highlight hint so topology auto-selects and centers this device.
    navigate(`/v2/topology?highlight=${encodeURIComponent(ip)}`);
  }

  const meta = getTypeMeta(deviceType);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20, alignItems: 'center', padding: '8px 0' }}>

      {/* Big success icon */}
      <div style={{
        width: 72, height: 72, borderRadius: '50%',
        background: 'rgba(34,197,94,0.12)',
        border: '2px solid rgba(34,197,94,0.3)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 32,
      }}>
        ✅
      </div>

      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--vf-text-primary)', marginBottom: 6 }}>
          Device Provisioned Successfully
        </div>
        <div style={{ fontSize: 12, color: 'var(--vf-text-muted)', lineHeight: 1.6 }}>
          {meta.emoji} <strong>{serialNumber}</strong> ({ip}) has been added to inventory
          with status <span style={{ color: '#22c55e', fontWeight: 600 }}>ONLINE</span>.
        </div>
        {deviceId && (
          <div style={{
            marginTop: 8, fontSize: 11, fontFamily: 'var(--vf-font-mono)',
            color: 'var(--vf-text-muted)',
          }}>
            Device ID: {deviceId}
          </div>
        )}
      </div>

      {/* Navigation cards */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, width: '100%' }}>
        <button
          onClick={goInventory}
          style={{
            padding: '16px 12px', borderRadius: 10, cursor: 'pointer', textAlign: 'left',
            background: 'rgba(59,130,246,0.07)',
            border: '1.5px solid rgba(59,130,246,0.25)',
            transition: 'all 0.15s',
          }}
          onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(59,130,246,0.14)')}
          onMouseLeave={(e) => (e.currentTarget.style.background = 'rgba(59,130,246,0.07)')}
        >
          <div style={{ fontSize: 22, marginBottom: 6 }}>📋</div>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#60a5fa', marginBottom: 3 }}>
            View in Inventory
          </div>
          <div style={{ fontSize: 11, color: 'var(--vf-text-muted)', lineHeight: 1.4 }}>
            Open this device's Node View to see its live parameters, status and metrics.
          </div>
        </button>

        <button
          onClick={goTopology}
          style={{
            padding: '16px 12px', borderRadius: 10, cursor: 'pointer', textAlign: 'left',
            background: 'rgba(34,197,94,0.07)',
            border: '1.5px solid rgba(34,197,94,0.25)',
            transition: 'all 0.15s',
          }}
          onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(34,197,94,0.14)')}
          onMouseLeave={(e) => (e.currentTarget.style.background = 'rgba(34,197,94,0.07)')}
        >
          <div style={{ fontSize: 22, marginBottom: 6 }}>🗺</div>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#22c55e', marginBottom: 3 }}>
            View on Topology Map
          </div>
          <div style={{ fontSize: 11, color: 'var(--vf-text-muted)', lineHeight: 1.4 }}>
            See the device placed on the network map. Refresh topology if GPS was provided.
          </div>
        </button>
      </div>

      <Button variant="ghost" size="sm" onClick={onClose} style={{ marginTop: 4 }}>
        Back to Discovery Results
      </Button>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function ProvisionDeviceModal({
  result,
  open,
  onClose,
  onConfirm,
  saving = false,
  provisioned = false,
  provisionedDeviceId = '',
  provisionedSerialNumber = '',
}: ProvisionDeviceModalProps) {
  // ── Form state ──────────────────────────────────────────────────────────────
  const [deviceType,   setDeviceType]   = useState<DeviceType>('UNKNOWN');
  const [serialNumber, setSerialNumber] = useState('');
  /** True when the serial was read from the device (then it is shown read-only). */
  const [serialFromDevice, setSerialFromDevice] = useState(false);
  const [latStr,       setLatStr]       = useState('');
  const [lngStr,       setLngStr]       = useState('');
  /** Where the GPS in the form came from ('' = none yet): a device OID source, 'sysLocation',
   *  or 'manual' once the admin typed or picked it. Drives the badge shown to the operator. */
  const [gpsSource, setGpsSource] = useState('');

  // ── DT-04: Model + Role two-step picker ─────────────────────────────────────
  const [comboModels,       setComboModels]       = useState<string[]>([]);
  const [selectedModel,     setSelectedModel]     = useState<string>('');
  const [modelRoles,        setModelRoles]        = useState<{ role: string; description: string }[]>([]);
  const [comboLoading,      setComboLoading]      = useState(false);
  const [showComboPicker,   setShowComboPicker]   = useState(false);

  // Load available models once
  useEffect(() => {
    listModels().then(setComboModels).catch(() => setComboModels([]));
  }, []);

  // Load roles when model is selected
  const handleModelSelect = useCallback(async (model: string) => {
    setSelectedModel(model);
    setComboLoading(true);
    try {
      const roles = await listRolesForModel(model);
      setModelRoles(roles);
    } catch {
      setModelRoles([]);
    } finally {
      setComboLoading(false);
    }
  }, []);

  // Apply selected role
  const handleRoleSelect = useCallback((role: string) => {
    setDeviceType(role as DeviceType);
    setShowComboPicker(false);
  }, []);

  // Reset form whenever a new result is opened.
  useEffect(() => {
    if (result) {
      // ── Device Type ─────────────────────────────────────────────────────────
      // The role the device reports over SNMP (vendor role OID) wins. Otherwise
      // use the genericDeviceType from the discovery result (which comes from the
      // Product Definition's deviceType field when a template was selected, or from
      // the OID classification table when not). mapGenericTypeToDeviceType handles
      // all PD types (RADIO, GATEWAY, SWITCH, etc.) not just BTS/CPE/IDU.
      setDeviceType(result.deviceRole ?? mapGenericTypeToDeviceType(result.genericDeviceType));

      // The serial number the device itself reports is its identity. Only a device that reports
      // none gets a derived value, which the admin may replace with the label on the unit.
      const reportedSerial = (result.reportedSerialNumber || '').trim();
      setSerialNumber(reportedSerial || deriveSerialFromResult(result));
      setSerialFromDevice(!!reportedSerial);

      // ── GPS ─────────────────────────────────────────────────────────────────
      // 1. Device-published GPS (vendor GPS OIDs, or a coordinate pair in sysLocation — both read
      //    by the gateway during discovery and returned as latitude/longitude)
      // 2. Otherwise blank — the admin picks the location on the map or enters coordinates.
      //    (Whatever is entered here is replaced by the device's own GPS once it publishes one.)
      if (result.latitude != null && result.longitude != null) {
        setLatStr(String(result.latitude));
        setLngStr(String(result.longitude));
        setGpsSource(result.locationSource || 'device');
      } else {
        setLatStr('');
        setLngStr('');
        setGpsSource('');
      }
    }
  }, [result]);

  if (!result) return null;

  // ── Validation ──────────────────────────────────────────────────────────────
  const serialValid = serialNumber.trim().length >= 4;
  const latValid    = latStr === '' || (!isNaN(parseFloat(latStr)) && Math.abs(parseFloat(latStr)) <= 90);
  const lngValid    = lngStr === '' || (!isNaN(parseFloat(lngStr)) && Math.abs(parseFloat(lngStr)) <= 180);
  const canSubmit   = serialValid && latValid && lngValid && !saving && !provisioned;

  const errors: string[] = [];
  if (!serialValid) errors.push('Serial number must be at least 4 characters.');
  if (!latValid)    errors.push('Latitude must be between -90 and 90.');
  if (!lngValid)    errors.push('Longitude must be between -180 and 180.');

  function handleConfirm() {
    if (!canSubmit) return;
    const req = buildProvisionRequest(result!, {
      deviceType,
      serialNumber: serialNumber.trim(),
      latitude:     latStr ? parseFloat(latStr) : undefined,
      longitude:    lngStr ? parseFloat(lngStr) : undefined,
    });
    onConfirm(req);
  }

  // TYPE_COLORS is now driven by TYPE_META — use getTypeMeta(t).color per type

  const roleReported = !!result.deviceRole;
  const gpsAutoFilled = gpsSource !== '';

  // ── SNMP summary rows ───────────────────────────────────────────────────────
  const snmpRows: [string, string | undefined][] = [
    ['Manufacturer', result.vendor],
    ['Model',        result.model],
    ['Device Role',  result.deviceRole],
    ['Coordinates',  result.latitude != null && result.longitude != null
      ? `${result.latitude}, ${result.longitude}` : undefined],
    ['Hostname',     result.sysName],
    ['Location',     result.sysLocation],
    ['sysObjectID',  result.sysObjectID],
    ['ICMP',         result.icmpStatus],
    ['SNMP',         result.snmpStatus],
  ];

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={provisioned ? `✅ Device Provisioned` : `Provision Device — ${result.ip}`}
      footer={
        provisioned ? null : (
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', width: '100%' }}>
            <Button variant="ghost" size="sm" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={handleConfirm}
              disabled={!canSubmit}
            >
              {saving ? '⏳ Provisioning…' : '🔧 Provision Device'}
            </Button>
          </div>
        )
      }
    >
      {/* ── Success state ─────────────────────────────────────────────────── */}
      {provisioned ? (
        <SuccessView
          ip={result.ip}
          serialNumber={provisionedSerialNumber || serialNumber}
          deviceId={provisionedDeviceId}
          deviceType={deviceType}
          onClose={onClose}
        />
      ) : (

      /* ── Form state ────────────────────────────────────────────────────── */
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>

        {/* ── SNMP Discovery Summary ──────────────────────────────────────── */}
        <div style={{
          background: 'var(--vf-surface-raised)',
          border: '1px solid var(--vf-border-subtle)',
          borderRadius: 8,
          padding: '12px 14px',
        }}>
          <div style={{
            fontSize: 10, fontWeight: 700, textTransform: 'uppercase',
            letterSpacing: '0.07em', color: 'var(--vf-text-muted)', marginBottom: 8,
          }}>
            Discovered Device Info
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px 16px' }}>
            <div>
              <span style={{ fontSize: 11, color: 'var(--vf-text-muted)' }}>IP Address</span>
              <div style={{ fontFamily: 'var(--vf-font-mono)', fontWeight: 700, fontSize: 13, color: '#60a5fa' }}>
                {result.ip}
              </div>
            </div>
            {snmpRows.map(([label, val]) =>
              val ? (
                <div key={label}>
                  <span style={{ fontSize: 11, color: 'var(--vf-text-muted)' }}>{label}</span>
                  <div style={{
                    fontSize: 12, color: 'var(--vf-text-primary)',
                    fontFamily: label === 'sysObjectID' ? 'var(--vf-font-mono)' : undefined,
                  }}>
                    {val}
                  </div>
                </div>
              ) : null,
            )}
          </div>
        </div>

        {/* ── Device Type Selector ────────────────────────────────────────── */}
        <div>
          <div style={{
            fontSize: 11, fontWeight: 700, textTransform: 'uppercase',
            letterSpacing: '0.06em', color: 'var(--vf-text-muted)', marginBottom: 8,
            display: 'flex', alignItems: 'center', gap: 6,
          }}>
            Device Type <span style={{ color: 'var(--vf-danger)' }}>*</span>
            {result.genericDeviceType && (
              <span style={{
                fontSize: 9, fontWeight: 600, textTransform: 'none',
                background: 'rgba(96,165,250,0.12)', color: '#93c5fd',
                borderRadius: 4, padding: '1px 6px', letterSpacing: 0,
              }}>
                auto-detected: {result.genericDeviceType}
              </span>
            )}
            {roleReported && (
              <span style={{
                fontSize: 9, fontWeight: 600, textTransform: 'none',
                background: 'rgba(34,197,94,0.15)', color: '#22c55e',
                borderRadius: 4, padding: '1px 6px', letterSpacing: 0,
              }}>
                reported by device
              </span>
            )}
          </div>

          {/* ── DT-04: Model → Role two-step picker (shown when combinations exist) ── */}
          {comboModels.length > 0 && (
            <div style={{ marginBottom: 10 }}>
              {!showComboPicker ? (
                <button
                  onClick={() => { setShowComboPicker(true); if (!selectedModel && comboModels.length > 0) handleModelSelect(comboModels[0]); }}
                  style={{ fontSize: 11, color: 'var(--vf-accent)', background: 'rgba(96,165,250,0.08)', border: '1px solid rgba(96,165,250,0.3)', borderRadius: 6, padding: '4px 12px', cursor: 'pointer', fontWeight: 600 }}
                >
                  🔧 Pick from Model + Role combinations
                </button>
              ) : (
                <div style={{ background: 'var(--vf-surface-raised)', border: '1px solid var(--vf-border-default)', borderRadius: 8, padding: 12 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                    <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--vf-text-primary)' }}>Select Model → Role</span>
                    <button onClick={() => setShowComboPicker(false)} style={{ background: 'none', border: 'none', color: 'var(--vf-text-muted)', cursor: 'pointer', fontSize: 14 }}>✕</button>
                  </div>
                  {/* Step 1: Model */}
                  <div style={{ marginBottom: 10 }}>
                    <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--vf-text-muted)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Model</div>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {comboModels.map((m) => (
                        <button key={m} onClick={() => handleModelSelect(m)}
                          style={{ padding: '4px 12px', fontSize: 11, fontWeight: 600, borderRadius: 6, cursor: 'pointer',
                            background: selectedModel === m ? 'var(--vf-accent)' : 'var(--vf-surface)',
                            color:      selectedModel === m ? '#fff' : 'var(--vf-text-secondary)',
                            border:     selectedModel === m ? '1px solid var(--vf-accent)' : '1px solid var(--vf-border-default)' }}>
                          {m}
                        </button>
                      ))}
                    </div>
                  </div>
                  {/* Step 2: Role (filtered by model) */}
                  {selectedModel && (
                    <div>
                      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--vf-text-muted)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                        Role for {selectedModel}
                      </div>
                      {comboLoading ? (
                        <div style={{ fontSize: 12, color: 'var(--vf-text-muted)' }}>Loading roles…</div>
                      ) : modelRoles.length === 0 ? (
                        <div style={{ fontSize: 12, color: '#f59e0b' }}>No roles defined for this model yet.</div>
                      ) : (
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                          {modelRoles.map((r) => {
                            const meta = getTypeMeta(r.role);
                            return (
                              <button key={r.role} onClick={() => handleRoleSelect(r.role)}
                                title={r.description}
                                style={{ padding: '6px 14px', fontSize: 12, fontWeight: 700, borderRadius: 6, cursor: 'pointer',
                                  background: deviceType === r.role ? meta.color : 'var(--vf-surface)',
                                  color:      deviceType === r.role ? '#fff' : meta.color,
                                  border:     `1px solid ${meta.color}` }}>
                                {meta.emoji} {r.role}
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Dynamic type grid — all common types + detected type always visible */}
          {(() => {
            const detectedType = result.genericDeviceType?.toUpperCase() as DeviceType | undefined;
            // Build list: detected type first (if not already in COMMON_TYPES), then the rest
            const typeList: DeviceType[] = detectedType && !COMMON_TYPES.includes(detectedType)
              ? [detectedType, ...COMMON_TYPES]
              : COMMON_TYPES;
            return (
              <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(80px, 1fr))',
                gap: 6, marginBottom: 8,
              }}>
                {typeList.map((t) => {
                  const m = getTypeMeta(t);
                  const selected = deviceType === t;
                  return (
                    <button
                      key={t}
                      onClick={() => setDeviceType(t)}
                      title={m.desc}
                      style={{
                        padding: '8px 4px', borderRadius: 8, cursor: 'pointer',
                        fontSize: 11, fontWeight: 700, textAlign: 'center',
                        background: selected ? m.color : 'var(--vf-surface-raised)',
                        color: selected ? '#fff' : 'var(--vf-text-secondary)',
                        border: `2px solid ${selected ? m.color : 'var(--vf-border-subtle)'}`,
                        transition: 'all 0.15s',
                        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3,
                      }}
                    >
                      <span style={{ fontSize: 16 }}>{m.emoji}</span>
                      <span>{m.label}</span>
                    </button>
                  );
                })}
              </div>
            );
          })()}

          {/* Description of selected type */}
          {deviceType && deviceType !== 'UNKNOWN' && (
            <div style={{ fontSize: 11, color: 'var(--vf-text-muted)', marginBottom: 4 }}>
              {getTypeMeta(deviceType).emoji} {getTypeMeta(deviceType).desc}
            </div>
          )}
          <div style={{ marginTop: 4, fontSize: 11, color: roleReported ? 'var(--vf-text-muted)' : '#f59e0b' }}>
            {roleReported
              ? `Role detected via ${result.deviceRoleSource || 'SNMP'}.`
              : '⚠ The device did not report its role over SNMP — confirm the type before provisioning.'}
          </div>
        </div>

        {/* ── Serial number ───────────────────────────────────────────────── */}
        <Field
          label="Serial Number"
          value={serialNumber}
          onChange={setSerialNumber}
          placeholder="e.g. SN-12345678"
          mono
          required
          readOnly={serialFromDevice}
          badge={serialFromDevice ? 'reported by device' : undefined}
          hint={serialFromDevice
            ? 'Read from the device itself.'
            : 'The device did not report a serial number. Enter the serial from the label on the unit.'}
        />

        {/* ── GPS Location ────────────────────────────────────────────────── */}
        <div>
          <div style={{
            fontSize: 11, fontWeight: 700, textTransform: 'uppercase',
            letterSpacing: '0.06em', color: 'var(--vf-text-muted)', marginBottom: 8,
            display: 'flex', alignItems: 'center', gap: 6,
          }}>
            📍 GPS Location
            {gpsSource !== '' && gpsSource !== 'manual' && (
              <span style={{
                fontSize: 9, fontWeight: 600, background: 'rgba(34,197,94,0.15)',
                color: '#22c55e', borderRadius: 4, padding: '1px 5px',
              }}>
                {gpsSource === 'sysLocation' ? 'published by device (sysLocation)' : 'published by device'}
              </span>
            )}
            {gpsSource === 'manual' && (
              <span style={{
                fontSize: 9, fontWeight: 600, background: 'rgba(96,165,250,0.15)',
                color: '#60a5fa', borderRadius: 4, padding: '1px 5px',
              }}>
                set by you
              </span>
            )}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            <Field
              label="Latitude"
              value={latStr}
              onChange={(v) => { setLatStr(v); setGpsSource('manual'); }}
              placeholder="e.g. 28.6139"
              type="number"
              hint="Decimal degrees."
            />
            <Field
              label="Longitude"
              value={lngStr}
              onChange={(v) => { setLngStr(v); setGpsSource('manual'); }}
              placeholder="e.g. 77.2090"
              type="number"
              hint="Decimal degrees."
            />
          </div>
          <div style={{ marginTop: 10 }}>
            <GpsMapPicker
              lat={latStr !== '' && latValid ? parseFloat(latStr) : undefined}
              lng={lngStr !== '' && lngValid ? parseFloat(lngStr) : undefined}
              onPick={(la, lo) => { setLatStr(la.toFixed(6)); setLngStr(lo.toFixed(6)); setGpsSource('manual'); }}
            />
          </div>
          <div style={{
            marginTop: 8, fontSize: 11, color: 'var(--vf-text-muted)', padding: '7px 10px', borderRadius: 6,
            background: gpsAutoFilled && gpsSource !== 'manual' ? 'rgba(34,197,94,0.06)' : 'rgba(245,158,11,0.06)',
            border: `1px solid ${gpsAutoFilled && gpsSource !== 'manual' ? 'rgba(34,197,94,0.2)' : 'rgba(245,158,11,0.2)'}`,
          }}>
            {gpsAutoFilled && gpsSource !== 'manual'
              ? 'The device publishes its own position, and it is used as is.'
              : 'This device does not publish a GPS position. Pick the location on the map or enter the coordinates. As soon as the device publishes its own position, that replaces what you set here.'}
          </div>
        </div>

        {/* ── Validation errors ────────────────────────────────────────────── */}
        {errors.length > 0 && (
          <div style={{
            padding: '10px 14px', borderRadius: 8,
            background: 'var(--vf-danger-subtle)',
            border: '1px solid var(--vf-danger)',
            fontSize: 12, color: 'var(--vf-danger)',
          }}>
            {errors.map((e) => <div key={e}>⚠ {e}</div>)}
          </div>
        )}

        {/* ── What happens next ────────────────────────────────────────────── */}
        <div style={{
          padding: '10px 14px', borderRadius: 8,
          background: 'rgba(34,197,94,0.06)',
          border: '1px solid rgba(34,197,94,0.2)',
          fontSize: 12, color: 'var(--vf-text-secondary)', lineHeight: 1.6,
        }}>
          <strong style={{ color: '#22c55e' }}>What happens when you provision:</strong>
          <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
            <li>Device is created in the inventory with status <strong>ONLINE</strong>.</li>
            <li>Appears in <strong>Inventory</strong> immediately — you can navigate there from the next screen.</li>
            <li>If GPS coordinates are supplied, the device is placed on the <strong>Topology Map</strong>.</li>
            <li>Without GPS, the map shows the device at an approximate position, marked as approximate.</li>
          </ul>
        </div>

      </div>
      )}
    </Modal>
  );
}
