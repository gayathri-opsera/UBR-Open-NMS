'use strict';

// Disable actual syslog client via config mock
jest.mock('../../src/config', () => ({
  syslog: { enabled: false, host: 'localhost', port: 514, transport: 'UDP', appName: 'test' },
  audit: { ttlDays: 365, maxExportRows: 10000 },
  port: 3007,
  kafka: { enabled: false },
}));

// Mock the syslog-client package so syslog.forwarder can be required
jest.mock('syslog-client', () => ({
  createClient: jest.fn(() => ({ log: jest.fn(), on: jest.fn() })),
  Transport: { Udp: 0, Tcp: 1 },
  Facility: { Security: 4 },
  Severity: { Informational: 6 },
}), { virtual: true });

const { forward } = require('../../src/services/syslog.forwarder');

describe('syslog forwarder', () => {
  it('does not throw when syslog is disabled', () => {
    expect(() => {
      forward({ actor: 'user1', action: 'LOGIN', resource: 'auth', result: 'SUCCESS', timestamp: new Date() });
    }).not.toThrow();
  });
});
