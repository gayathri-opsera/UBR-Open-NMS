import React, { useState } from 'react';
import { pushDeviceParam } from '../../../api/config.api';
import { useAuth } from '../../../contexts/AuthContext';
import { Button } from '../common/Button';
import { Input } from '../common/Input';
import { Select } from '../common/Select';
import { Card } from '../common/Card';
import { useToast } from '../common/Toast';
import { logger } from '../../utils/logger';

// ── Types ─────────────────────────────────────────────────────────────────────

interface BandConfig {
  ssid: string;
  channel: string;
  encryption: string;
  key: string;
  // DDRS/ATPC
  ddrsStatus: string;
  spatialStream: string;
  maxRateSingle: string;
  maxRateDual: string;
  txPower: string;
  maxEirp: string;
  antennaGain: string;
  // DCS
  dcsScanInterval: string;
  dcsThreshold: string;
  dcsChannelList: string;
}

type WirelessSubTab = 'properties' | 'ddrs' | 'dcs';

const CHANNEL_OPTIONS_5 = [
  { value: 'auto', label: 'Auto' },
  { value: '36',   label: 'Ch 36 (5180 MHz)' },
  { value: '40',   label: 'Ch 40 (5200 MHz)' },
  { value: '44',   label: 'Ch 44 (5220 MHz)' },
  { value: '48',   label: 'Ch 48 (5240 MHz)' },
  { value: '52',   label: 'Ch 52 (5260 MHz)' },
  { value: '56',   label: 'Ch 56 (5280 MHz)' },
  { value: '100',  label: 'Ch 100 (5500 MHz)' },
  { value: '104',  label: 'Ch 104 (5520 MHz)' },
  { value: '149',  label: 'Ch 149 (5745 MHz)' },
  { value: '153',  label: 'Ch 153 (5765 MHz)' },
  { value: '157',  label: 'Ch 157 (5785 MHz)' },
  { value: '161',  label: 'Ch 161 (5805 MHz)' },
];

const CHANNEL_OPTIONS_24 = [
  { value: 'auto', label: 'Auto' },
  ...Array.from({ length: 13 }, (_, i) => ({ value: String(i + 1), label: `Ch ${i + 1} (${2412 + i * 5} MHz)` })),
];

const ENCRYPTION_OPTIONS = [
  { value: 'WPA2-AES',   label: 'WPA2-AES' },
  { value: 'WPA2-TKIP',  label: 'WPA2-TKIP' },
  { value: 'WPA2-Mixed', label: 'WPA2-Mixed' },
  { value: 'AES-256',    label: 'AES-256' },
  { value: 'Open',       label: 'Open (No Encryption)' },
];

const DDRS_OPTIONS    = [{ value: 'enabled', label: 'Enabled' }, { value: 'disabled', label: 'Disabled' }];
const STREAM_OPTIONS  = [{ value: 'auto', label: 'Auto' }, { value: 'single', label: 'Single' }, { value: 'dual', label: 'Dual' }];
const MCS_OPTIONS     = [
  { value: 'auto', label: 'Auto' },
  ...Array.from({ length: 10 }, (_, i) => ({ value: `MCS${i}`, label: `MCS${i}` })),
];

function defaultBand(): BandConfig {
  return {
    ssid: '',
    channel: 'auto',
    encryption: 'WPA2-AES',
    key: '',
    ddrsStatus: 'enabled',
    spatialStream: 'auto',
    maxRateSingle: 'auto',
    maxRateDual: 'auto',
    txPower: '20',
    maxEirp: '30',
    antennaGain: '5',
    dcsScanInterval: '60',
    dcsThreshold: '-75',
    dcsChannelList: '36,40,44,48',
  };
}

// ── Validation ────────────────────────────────────────────────────────────────

interface BandErrors {
  ssid?: string;
  key?: string;
  txPower?: string;
  maxEirp?: string;
}

function validateBand(band: BandConfig): BandErrors {
  const errs: BandErrors = {};
  if (!band.ssid) errs.ssid = 'SSID is required.';
  else if (band.ssid.length > 32) errs.ssid = 'SSID must be 1–32 characters.';
  if (band.encryption !== 'Open') {
    if (!band.key) errs.key = 'Key is required for encrypted networks.';
    else if (band.key.length < 8 || band.key.length > 63) errs.key = 'Key must be 8–63 characters.';
  }
  const tx = parseInt(band.txPower, 10);
  if (Number.isNaN(tx) || tx < 1 || tx > 26) errs.txPower = 'Tx Power must be 1–26 dBm.';
  const eirp = parseInt(band.maxEirp, 10);
  if (Number.isNaN(eirp) || eirp < 0 || eirp > 100) errs.maxEirp = 'Max EIRP must be 0–100 dBm.';
  return errs;
}

// ── Band Panel ────────────────────────────────────────────────────────────────

interface BandPanelProps {
  label: string;
  bandKey: '5g' | '2g';
  config: BandConfig;
  onChange: (cfg: BandConfig) => void;
  readOnly: boolean;
  subTab: WirelessSubTab;
  onPushRestart: () => void;
  pushing: boolean;
  errors: BandErrors;
}

function BandPanel({ label, bandKey, config, onChange, readOnly, subTab, onPushRestart, pushing, errors }: BandPanelProps) {
  const [showKey, setShowKey] = useState(false);
  const set = (field: keyof BandConfig) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    onChange({ ...config, [field]: e.target.value });

  const channelOpts = bandKey === '5g' ? CHANNEL_OPTIONS_5 : CHANNEL_OPTIONS_24;

  return (
    <Card title={`${label} Band`} style={{ marginBottom: 16 }}>
      {subTab === 'properties' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <Input
            label="SSID"
            value={config.ssid}
            onChange={set('ssid')}
            disabled={readOnly}
            maxLength={32}
            placeholder="Network name"
            error={errors.ssid}
          />
          <Select
            label="Configured Channel"
            options={channelOpts}
            value={config.channel}
            onChange={set('channel')}
            disabled={readOnly}
          />
          <Select
            label="Encryption"
            options={ENCRYPTION_OPTIONS}
            value={config.encryption}
            onChange={set('encryption')}
            disabled={readOnly}
          />
          <div style={{ position: 'relative' }}>
            <Input
              label="Key / Passphrase"
              type={showKey ? 'text' : 'password'}
              value={config.key}
              onChange={set('key')}
              disabled={readOnly || config.encryption === 'Open'}
              placeholder="8–63 characters"
              error={errors.key}
            />
            {!readOnly && config.encryption !== 'Open' && (
              <button
                type="button"
                onClick={() => setShowKey((v) => !v)}
                style={{ position: 'absolute', right: 10, top: 30, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--vf-text-muted)', fontSize: 12 }}
                aria-label={showKey ? 'Hide key' : 'Show key'}
              >
                {showKey ? '🙈 Hide' : '👁 Show'}
              </button>
            )}
          </div>
        </div>
      )}

      {subTab === 'ddrs' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <Select label="DDRS Status" options={DDRS_OPTIONS} value={config.ddrsStatus} onChange={set('ddrsStatus')} disabled={readOnly} />
          <Select label="Spatial Stream" options={STREAM_OPTIONS} value={config.spatialStream} onChange={set('spatialStream')} disabled={readOnly} />
          <Select label="Max Data Rate — Single Stream" options={MCS_OPTIONS} value={config.maxRateSingle} onChange={set('maxRateSingle')} disabled={readOnly} />
          <Select label="Max Data Rate — Dual Stream" options={MCS_OPTIONS} value={config.maxRateDual} onChange={set('maxRateDual')} disabled={readOnly} />
          <Input
            label="Transmit Power (1–26 dBm)"
            type="number"
            value={config.txPower}
            onChange={set('txPower')}
            disabled={readOnly}
            min={1}
            max={26}
            error={errors.txPower}
          />
          <Input
            label="Maximum EIRP (0–100 dBm)"
            type="number"
            value={config.maxEirp}
            onChange={set('maxEirp')}
            disabled={readOnly}
            min={0}
            max={100}
            error={errors.maxEirp}
          />
          <Input
            label="Connectorized Antenna Gain (dBi)"
            value={config.antennaGain}
            onChange={() => {/* read-only display */}}
            disabled
            hint="Hardware value — not editable"
          />
        </div>
      )}

      {subTab === 'dcs' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <Input
            label="Scan Interval (seconds)"
            type="number"
            value={config.dcsScanInterval}
            onChange={set('dcsScanInterval')}
            disabled={readOnly}
            min={30}
            max={3600}
            hint="How often DCS re-scans for better channels"
          />
          <Input
            label="DCS Threshold (dBm)"
            type="number"
            value={config.dcsThreshold}
            onChange={set('dcsThreshold')}
            disabled={readOnly}
            min={-100}
            max={-30}
            hint="Signal level that triggers channel change"
          />
          <Input
            label="Channel List"
            value={config.dcsChannelList}
            onChange={set('dcsChannelList')}
            disabled={readOnly}
            hint="Comma-separated list of eligible channels"
            style={{ gridColumn: '1 / -1' }}
          />
        </div>
      )}

      {!readOnly && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16, paddingTop: 12, borderTop: '1px solid var(--vf-border-subtle)' }}>
          <Button
            variant="ghost"
            size="sm"
            onClick={onPushRestart}
            disabled={pushing}
            loading={pushing}
          >
            Wireless Restart / Activate
          </Button>
        </div>
      )}
    </Card>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────

interface WirelessConfigTabProps {
  deviceId: string;
}

export function WirelessConfigTab({ deviceId }: WirelessConfigTabProps) {
  const { user } = useAuth();
  const { addToast } = useToast();
  const readOnly = !user || (user.role.toLowerCase() === 'user');

  const [subTab, setSubTab] = useState<WirelessSubTab>('properties');
  const [band5, setBand5] = useState<BandConfig>({ ...defaultBand(), ssid: 'NMS-5G', channel: '36', key: 'securepass5g' });
  const [band24, setBand24] = useState<BandConfig>({ ...defaultBand(), ssid: 'NMS-2.4G', channel: '6', key: 'securepass24' });
  const [errors5, setErrors5] = useState<BandErrors>({});
  const [errors24, setErrors24] = useState<BandErrors>({});
  const [applying, setApplying] = useState(false);
  const [restarting5, setRestarting5] = useState(false);
  const [restarting24, setRestarting24] = useState(false);

  async function handleApply() {
    const e5 = validateBand(band5);
    const e24 = validateBand(band24);
    setErrors5(e5);
    setErrors24(e24);
    if (Object.keys(e5).length || Object.keys(e24).length) return;

    setApplying(true);
    try {
      await pushDeviceParam(deviceId, {
        ssid5: band5.ssid,
        channel5: band5.channel,
        password5: band5.key,
        txPower5: parseInt(band5.txPower, 10),
        ssid24: band24.ssid,
        channel24: band24.channel,
        password24: band24.key,
        txPower24: parseInt(band24.txPower, 10),
      });
      addToast('Configuration applied successfully', 'success');
    } catch (err) {
      logger.error('Wireless config push failed', err, { context: 'WirelessConfigTab' });
      addToast('Failed to apply configuration. Please try again.', 'error');
    } finally {
      setApplying(false);
    }
  }

  async function handleRestart(band: '5g' | '2g') {
    const setter = band === '5g' ? setRestarting5 : setRestarting24;
    setter(true);
    try {
      await pushDeviceParam(deviceId, { wifiRestart: true, band });
      addToast(`${band === '5g' ? '5GHz' : '2.4GHz'} wireless restart initiated`, 'success');
    } catch (err) {
      logger.error('Wireless restart failed', err, { context: 'WirelessConfigTab' });
      addToast('Wireless restart command failed', 'error');
    } finally {
      setter(false);
    }
  }

  const SUB_TABS: { id: WirelessSubTab; label: string }[] = [
    { id: 'properties', label: 'Properties' },
    { id: 'ddrs',       label: 'DDRS / ATPC' },
    { id: 'dcs',        label: 'DCS' },
  ];

  return (
    <div style={{ paddingTop: 16 }}>
      {/* Sub-tab selector */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 20, borderBottom: '1px solid var(--vf-border-subtle)', paddingBottom: 0 }}>
        {SUB_TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setSubTab(t.id)}
            style={{
              padding: '8px 16px',
              background: 'none',
              border: 'none',
              borderBottom: subTab === t.id ? '2px solid var(--vf-accent)' : '2px solid transparent',
              color: subTab === t.id ? 'var(--vf-accent)' : 'var(--vf-text-secondary)',
              fontFamily: 'var(--vf-font-sans)',
              fontSize: 13,
              fontWeight: subTab === t.id ? 600 : 400,
              cursor: 'pointer',
              marginBottom: -1,
              whiteSpace: 'nowrap',
            }}
            aria-selected={subTab === t.id}
          >
            {t.label}
          </button>
        ))}
        {!readOnly && (
          <div style={{ marginLeft: 'auto', paddingBottom: 4 }}>
            <Button size="sm" onClick={handleApply} disabled={applying} loading={applying}>
              Apply
            </Button>
          </div>
        )}
      </div>

      {readOnly && (
        <div style={{
          padding: '8px 12px',
          marginBottom: 12,
          background: 'var(--vf-warning-subtle)',
          border: '1px solid var(--vf-warning)',
          borderRadius: 6,
          fontSize: 12,
          color: 'var(--vf-warning)',
        }}>
          Read-only mode — you do not have permission to modify wireless configuration.
        </div>
      )}

      <BandPanel
        label="5GHz"
        bandKey="5g"
        config={band5}
        onChange={setBand5}
        readOnly={readOnly}
        subTab={subTab}
        onPushRestart={() => handleRestart('5g')}
        pushing={restarting5}
        errors={errors5}
      />
      <BandPanel
        label="2.4GHz"
        bandKey="2g"
        config={band24}
        onChange={setBand24}
        readOnly={readOnly}
        subTab={subTab}
        onPushRestart={() => handleRestart('2g')}
        pushing={restarting24}
        errors={errors24}
      />
    </div>
  );
}
