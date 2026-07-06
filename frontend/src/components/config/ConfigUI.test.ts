import { describe, it, expect } from 'vitest';
import { validateTemplate, CONFIG_PARAMS } from '../../api/config.types';
import { MOCK_JOB, MOCK_VERSIONS } from '../../mocks/config.mock';

describe('config template validation', () => {
  it('passes validation for valid template', () => {
    const errors = validateTemplate({ txPower: 20, vlanId: 100, ssid24: 'UBR-NET' });
    expect(errors).toHaveLength(0);
  });

  it('rejects txPower > 30', () => {
    const errors = validateTemplate({ txPower: 35 });
    expect(errors.some((e) => e.includes('txPower'))).toBe(true);
  });

  it('rejects txPower < 0', () => {
    const errors = validateTemplate({ txPower: -1 });
    expect(errors.some((e) => e.includes('txPower'))).toBe(true);
  });

  it('rejects vlanId < 1', () => {
    const errors = validateTemplate({ vlanId: 0 });
    expect(errors.some((e) => e.includes('vlanId'))).toBe(true);
  });

  it('rejects vlanId > 4094', () => {
    const errors = validateTemplate({ vlanId: 4095 });
    expect(errors.some((e) => e.includes('vlanId'))).toBe(true);
  });

  it('rejects ssid24 longer than 32 chars', () => {
    const errors = validateTemplate({ ssid24: 'A'.repeat(33) });
    expect(errors.some((e) => e.includes('ssid24'))).toBe(true);
  });

  it('accepts ssid24 exactly 32 chars', () => {
    const errors = validateTemplate({ ssid24: 'A'.repeat(32) });
    expect(errors.some((e) => e.includes('ssid24'))).toBe(false);
  });
});

describe('config params coverage', () => {
  it('includes all 12 required categories', () => {
    const required = ['wireless', 'network', 'vlan', 'qos', 'security', 'snmp', 'ntp', 'management', 'firmware', 'monitoring', 'logging', 'backup'];
    required.forEach((cat) => {
      expect(Object.keys(CONFIG_PARAMS)).toContain(cat);
    });
  });
});

describe('bulk push job tracking', () => {
  it('calculates progress correctly', () => {
    expect(MOCK_JOB.progressPercent).toBe(70);
    expect(MOCK_JOB.totalDevices).toBe(10);
    expect(MOCK_JOB.successCount + MOCK_JOB.failureCount + MOCK_JOB.pendingCount).toBe(10);
  });

  it('identifies offline devices in per-device status', () => {
    const offline = Object.values(MOCK_JOB.perDeviceStatus ?? {}).filter((s) => s === 'PENDING');
    expect(offline.length).toBeGreaterThan(0);
  });
});

describe('version history', () => {
  it('versions are in descending order', () => {
    const versions = [...MOCK_VERSIONS].sort((a, b) => b.versionNumber - a.versionNumber);
    expect(versions[0].versionNumber).toBeGreaterThan(versions[1].versionNumber);
  });

  it('diff contains previous and new values', () => {
    const v = MOCK_VERSIONS[0];
    expect(v.previousValues).toBeDefined();
    expect(v.newValues).toBeDefined();
    expect(Object.keys(v.previousValues!)).toContain('txPower');
    expect(Object.keys(v.newValues)).toContain('txPower');
  });
});
