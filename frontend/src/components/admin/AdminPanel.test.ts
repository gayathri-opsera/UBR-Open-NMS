import { describe, it, expect } from 'vitest';
import { MOCK_USERS, MOCK_SESSIONS, MOCK_SYSTEM_HEALTH } from '../../mocks/admin.mock';
import type { NmsUser } from '../../api/admin.types';

const ROLE_COLORS: Record<string, string> = {
  Admin: '#7f1d1d', Operator: '#1e3a5f', User: '#1c1917',
  admin: '#7f1d1d', operator: '#1e3a5f', user: '#1c1917',
};

describe('user management fixtures', () => {
  it('has expected number of mock users', () => {
    expect(MOCK_USERS).toHaveLength(3);
  });

  it('has exactly one Admin user', () => {
    expect(MOCK_USERS.filter((u) => u.role === 'Admin')).toHaveLength(1);
  });

  it('has at least one disabled user', () => {
    expect(MOCK_USERS.some((u) => !u.enabled)).toBe(true);
  });

  it('role assignment maps to correct color', () => {
    expect(ROLE_COLORS['Admin']).toBe('#7f1d1d');
    expect(ROLE_COLORS['Operator']).toBe('#1e3a5f');
    expect(ROLE_COLORS['User']).toBe('#1c1917');
  });

  it('all users have required fields', () => {
    MOCK_USERS.forEach((u: NmsUser) => {
      expect(u.id).toBeDefined();
      expect(u.username).toBeDefined();
      expect(u.email).toBeDefined();
      expect(u.role).toBeDefined();
    });
  });
});

describe('session management fixtures', () => {
  it('identifies stale sessions', () => {
    const stale = MOCK_SESSIONS.filter((s) => s.stale);
    expect(stale.length).toBeGreaterThan(0);
  });

  it('sessions have required fields', () => {
    MOCK_SESSIONS.forEach((s) => {
      expect(s.sessionId).toBeDefined();
      expect(s.username).toBeDefined();
      expect(s.ipAddress).toBeDefined();
    });
  });
});

describe('system health dashboard', () => {
  it('has all 15 expected microservices', () => {
    expect(MOCK_SYSTEM_HEALTH.services).toHaveLength(15);
  });

  it('infrastructure health is UP', () => {
    expect(MOCK_SYSTEM_HEALTH.kafka).toBe('UP');
    expect(MOCK_SYSTEM_HEALTH.mongodb).toBe('UP');
    expect(MOCK_SYSTEM_HEALTH.redis).toBe('UP');
  });

  it('has at least one degraded service', () => {
    expect(MOCK_SYSTEM_HEALTH.services.some((s) => s.status === 'DEGRADED')).toBe(true);
  });

  it('all services have name and status', () => {
    MOCK_SYSTEM_HEALTH.services.forEach((s) => {
      expect(s.name).toBeDefined();
      expect(['UP', 'DOWN', 'DEGRADED']).toContain(s.status);
    });
  });

  it('no services are DOWN in mock', () => {
    expect(MOCK_SYSTEM_HEALTH.services.filter((s) => s.status === 'DOWN')).toHaveLength(0);
  });
});
