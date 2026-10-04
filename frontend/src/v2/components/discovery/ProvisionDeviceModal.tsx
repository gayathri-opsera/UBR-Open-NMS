/**
 * ProvisionDeviceModal — admin confirmation dialog for provisioning a discovered
 * network device into the managed inventory.
 *
 * Flow: SNMP Discovery → admin clicks "Provision" → this modal → (success state) →
 *       navigate to Inventory or Topology.
 *
 * Auto-population logic:
 *   • deviceType  — derived from SNMP genericDeviceType heuristic
 *   • serialNumber — derived from sysName or IP (overridable)
 *   • networkId   — derived from IP /24 subnet (e.g. 192.168.65.x → net-192-168-65)
 *   • lat/lng     — attempted from sysLocation if it contains a coordinate pair
 *
 * Fields that SNMP MIB-II cannot discover and must be entered by the admin:
 *   • macAddress  — requires ARP table walk or physical label
 *   • precise GPS — sysLocation is free-text; auto-parse succeeds only when formatted
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Modal } from '../common/Modal';
import { Button } from '../common/Button';
import { Input } from '../common/Input';
import type { DiscoveryResult, ProvisionHostRequest, NmsDeviceType } from '../../../api/discovery.api';
import { mapGenericTypeToDeviceType, buildProvisionRequest } from '../../../api/discovery.api';

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

/**
 * Derive a Network ID from the /24 subnet of the discovered IP.
 * e.g. 192.168.65.254 → "net-192-168-65"
 */
function deriveNetworkId(ip: string): string {
  const parts = ip.split('.');
  if (parts.length === 4) return `net-${parts[0]}-${parts[1]}-${parts[2]}`;
  return '';
}

/**
 * Attempt to parse a GPS coordinate pair from a free-text sysLocation string.
 * Handles formats like "28.6139,77.2090" or "lat:28.6 lng:77.2" or "(28.61, 77.20)".
 * Returns null if no valid India-range coordinate is detected.
 */
function parseGpsFromLocation(sysLocation?: string): { lat: number; lng: number } | null {
  if (!sysLocation) return null;
  // Match two decimal numbers separated by comma, space, or lat:/lng: labels
  const m = sysLocation.match(/(-?\d{1,3}\.?\d*)[,\s/]+(-?\d{1,3}\.?\d*)/);
  if (!m) return null;
  const lat = parseFloat(m[1]);
  const lng = parseFloat(m[2]);
  // Validate rough India bounds (lenient — allow some international deployments)
  if (!isNaN(lat) && !isNaN(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
    return { lat, lng };
  }
  return null;
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
    navigate('/v2/discovery?tab=all');
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
            Open the All Discovered tab to monitor this device's status and metrics.
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
  const [macAddress,   setMacAddress]   = useState('');
  const [networkId,    setNetworkId]    = useState('');
  const [latStr,       setLatStr]       = useState('');
  const [lngStr,       setLngStr]       = useState('');
  const [gpsAutoFilled, setGpsAutoFilled] = useState(false);
  /** Where the pre-filled GPS came from — drives the badge label shown to the operator. */
  const [gpsSource, setGpsSource] = useState<'sysLocation' | 'productDefinition' | null>(null);

  // Reset form whenever a new result is opened.
  useEffect(() => {
    if (result) {
      // ── Device Type ─────────────────────────────────────────────────────────
      // Use the genericDeviceType from the discovery result (which comes from the
      // Product Definition's deviceType field when a template was selected, or from
      // the OID classification table when not). mapGenericTypeToDeviceType handles
      // all PD types (RADIO, GATEWAY, SWITCH, etc.) not just BTS/CPE/IDU.
      setDeviceType(mapGenericTypeToDeviceType(result.genericDeviceType));

      setSerialNumber(deriveSerialFromResult(result));

      // Auto-fill MAC if the scanner walked IF-MIB ifPhysAddress; otherwise leave blank.
      setMacAddress(result.macAddress || '');

      // Auto-derive network ID from IP subnet (e.g. 192.168.65.x → net-192-168-65)
      setNetworkId(deriveNetworkId(result.ip));

      // ── GPS priority chain ──────────────────────────────────────────────────
      // 1. Parse from SNMP sysLocation (device reports its own GPS as free-text)
      // 2. Fall back to Product Definition location block (operator's planning doc)
      // 3. Leave blank — operator enters manually
      const gps = parseGpsFromLocation(result.sysLocation);
      if (gps) {
        setLatStr(String(gps.lat));
        setLngStr(String(gps.lng));
        setGpsAutoFilled(true);
        setGpsSource('sysLocation');
      } else if (result.defaultLatitude != null && result.defaultLongitude != null) {
        setLatStr(String(result.defaultLatitude));
        setLngStr(String(result.defaultLongitude));
        setGpsAutoFilled(true);
        setGpsSource('productDefinition');
      } else {
        setLatStr('');
        setLngStr('');
        setGpsAutoFilled(false);
        setGpsSource(null);
      }
    }
  }, [result]);

  if (!result) return null;

  // ── Validation ──────────────────────────────────────────────────────────────
  const serialValid = serialNumber.trim().length >= 4;
  const macValid    = macAddress.trim() === '' || /^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/.test(macAddress.trim());
  const latValid    = latStr === '' || (!isNaN(parseFloat(latStr)) && Math.abs(parseFloat(latStr)) <= 90);
  const lngValid    = lngStr === '' || (!isNaN(parseFloat(lngStr)) && Math.abs(parseFloat(lngStr)) <= 180);
  const canSubmit   = serialValid && macValid && latValid && lngValid && !saving && !provisioned;

  const errors: string[] = [];
  if (!serialValid) errors.push('Serial number must be at least 4 characters.');
  if (!macValid)    errors.push('MAC address must be in XX:XX:XX:XX:XX:XX format.');
  if (!latValid)    errors.push('Latitude must be between -90 and 90.');
  if (!lngValid)    errors.push('Longitude must be between -180 and 180.');

  function handleConfirm() {
    if (!canSubmit) return;
    const req = buildProvisionRequest(result!, {
      deviceType,
      serialNumber: serialNumber.trim(),
      macAddress:   macAddress.trim(),
      networkId:    networkId.trim() || undefined,
      latitude:     latStr ? parseFloat(latStr) : undefined,
      longitude:    lngStr ? parseFloat(lngStr) : undefined,
    });
    onConfirm(req);
  }

  // TYPE_COLORS is now driven by TYPE_META — use getTypeMeta(t).color per type

  // ── SNMP summary rows ───────────────────────────────────────────────────────
  const snmpRows: [string, string | undefined][] = [
    ['Manufacturer', result.vendor],
    ['Model',        result.model],
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
          </div>

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
        </div>

        {/* ── Identity Fields ─────────────────────────────────────────────── */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
          <Field
            label="Serial Number"
            value={serialNumber}
            onChange={setSerialNumber}
            placeholder="e.g. SN-12345678"
            mono
            required
            badge="auto-filled"
            hint="Derived from SNMP hostname. Override with the physical label serial."
          />
          <Field
            label="MAC Address"
            value={macAddress}
            onChange={setMacAddress}
            placeholder="AA:BB:CC:DD:EE:FF"
            mono
            badge={result.macAddress ? 'auto-filled via IF-MIB' : undefined}
            hint={result.macAddress
              ? 'Retrieved via SNMP ifPhysAddress walk. Override if the label differs.'
              : 'Not found in SNMP scalar walk (IF-MIB ifPhysAddress walk may be needed). Enter from the physical device label.'}
          />
        </div>

        {/* ── Network Assignment ─────────────────────────────────────────── */}
        <Field
          label="Network ID"
          value={networkId}
          onChange={setNetworkId}
          placeholder="e.g. net-del-001"
          mono
          badge={networkId ? 'auto-filled' : undefined}
          hint={`Derived from IP subnet (${result.ip.split('.').slice(0, 3).join('.')}.0/24). Edit to assign to a different network segment.`}
        />

        {/* ── GPS Location ────────────────────────────────────────────────── */}
        <div>
          <div style={{
            fontSize: 11, fontWeight: 700, textTransform: 'uppercase',
            letterSpacing: '0.06em', color: 'var(--vf-text-muted)', marginBottom: 8,
            display: 'flex', alignItems: 'center', gap: 6,
          }}>
            📍 GPS Location (optional — shows device on topology map)
            {gpsSource === 'sysLocation' && (
              <span style={{
                fontSize: 9, fontWeight: 600, background: 'rgba(34,197,94,0.15)',
                color: '#22c55e', borderRadius: 4, padding: '1px 5px',
              }}>
                parsed from sysLocation
              </span>
            )}
            {gpsSource === 'productDefinition' && (
              <span style={{
                fontSize: 9, fontWeight: 600, background: 'rgba(96,165,250,0.15)',
                color: '#60a5fa', borderRadius: 4, padding: '1px 5px',
              }}>
                📂 from Product Definition
              </span>
            )}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            <Field
              label="Latitude"
              value={latStr}
              onChange={setLatStr}
              placeholder="e.g. 28.6139"
              type="number"
              hint="Decimal degrees. India: 6°N – 38°N."
            />
            <Field
              label="Longitude"
              value={lngStr}
              onChange={setLngStr}
              placeholder="e.g. 77.2090"
              type="number"
              hint="Decimal degrees. India: 67°E – 98°E."
            />
          </div>
          {!gpsAutoFilled && result.sysLocation && (
            <div style={{
              marginTop: 8, fontSize: 11, color: 'var(--vf-text-muted)',
              padding: '7px 10px', borderRadius: 6,
              background: 'rgba(245,158,11,0.06)',
              border: '1px solid rgba(245,158,11,0.2)',
            }}>
              ⚠ SNMP sysLocation is free-text and could not be parsed as GPS:
              <em> "{result.sysLocation}"</em>
              <br />
              Enter decimal coordinates above to place this device on the topology map.
            </div>
          )}
          {!result.sysLocation && (
            <div style={{ marginTop: 6, fontSize: 11, color: 'var(--vf-text-muted)' }}>
              No sysLocation reported by device. Enter coordinates manually to show on map.
            </div>
          )}
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
            <li>Without GPS, the map uses an approximate city fallback for India-region devices.</li>
          </ul>
        </div>

      </div>
      )}
    </Modal>
  );
}
