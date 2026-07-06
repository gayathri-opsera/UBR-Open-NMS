'use strict';

// ── sse.service tests ──────────────────────────────────────────────
const { formatSseEvent, addClient, removeClient, broadcast, clientCount } =
  require('../../src/services/sse.service');

describe('SSE Service', () => {
  test('formatSseEvent returns correctly structured data frame', () => {
    const alarm = {
      alarmId: 'a1', alarmName: 'LINK_DOWN', severity: 'CRITICAL',
      deviceId: 'bts-001', deviceType: 'BTS', raisedAt: '2026-01-01T00:00:00Z', state: 'ACTIVE',
    };
    const frame = formatSseEvent(alarm);
    expect(frame).toMatch(/^data: /);
    expect(frame).toMatch(/LINK_DOWN/);
    const parsed = JSON.parse(frame.replace('data: ', '').trim());
    expect(parsed.alarmId).toBe('a1');
    expect(parsed.severity).toBe('CRITICAL');
    expect(parsed.state).toBe('ACTIVE');
  });

  test('addClient / removeClient / clientCount work correctly', () => {
    const mockRes = { write: jest.fn() };
    addClient('c1', mockRes, 'user1');
    expect(clientCount()).toBeGreaterThanOrEqual(1);
    removeClient('c1');
  });

  test('broadcast writes SSE frame to all clients', () => {
    const writes = [];
    const fakeRes = { write: (d) => writes.push(d) };
    addClient('c2', fakeRes, null);

    const alarm = { alarmId: 'a2', alarmName: 'TEST', severity: 'MAJOR',
                    deviceId: 'd1', deviceType: 'CPE', state: 'ACTIVE', _consumedAt: Date.now() };
    broadcast(alarm);
    expect(writes.length).toBe(1);
    expect(writes[0]).toContain('a2');
    removeClient('c2');
  });
});

// ── email.service tests ────────────────────────────────────────────
const { renderEmailBody } = require('../../src/services/email.service');

describe('Email Service', () => {
  test('renderEmailBody includes alarm details', () => {
    const alarm = { alarmId: 'e1', alarmName: 'CPU_HIGH', severity: 'MAJOR',
                    deviceId: 'bts-002', deviceType: 'BTS', state: 'ACTIVE', description: 'cpu=95' };
    const body = renderEmailBody(alarm);
    expect(body).toContain('MAJOR');
    expect(body).toContain('bts-002');
    expect(body).toContain('cpu=95');
  });
});

// ── sms.service tests ──────────────────────────────────────────────
const { buildSmsPayload } = require('../../src/services/sms.service');

describe('SMS Service', () => {
  test('buildSmsPayload includes phone numbers and message', () => {
    const alarm = { alarmId: 's1', alarmName: 'POWER_FAULT', severity: 'CRITICAL',
                    deviceId: 'bts-003', state: 'ACTIVE' };
    const payload = buildSmsPayload(alarm, ['+1234567890']);
    expect(payload.to).toEqual(['+1234567890']);
    expect(payload.message).toContain('CRITICAL');
    expect(payload.message).toContain('bts-003');
  });
});

// ── preference.service tests ───────────────────────────────────────
const { setPreferences, getPreferences, shouldNotify } =
  require('../../src/services/preference.service');

describe('Preference Service', () => {
  test('shouldNotify returns true for CRITICAL above WARNING threshold', () => {
    setPreferences('u1', { minSeverity: 'WARNING' });
    expect(shouldNotify('u1', 'CRITICAL')).toBe(true);
  });

  test('shouldNotify returns false for INFO below MAJOR threshold', () => {
    setPreferences('u2', { minSeverity: 'MAJOR' });
    expect(shouldNotify('u2', 'INFO')).toBe(false);
  });

  test('getPreferences returns stored preferences', () => {
    setPreferences('u3', { email: false, sms: true, minSeverity: 'CRITICAL' });
    const prefs = getPreferences('u3');
    expect(prefs.email).toBe(false);
    expect(prefs.sms).toBe(true);
  });

  test('getPreferences returns defaults for unknown user', () => {
    const prefs = getPreferences('unknown-user-xyz');
    expect(prefs.minSeverity).toBe('WARNING');
  });
});
