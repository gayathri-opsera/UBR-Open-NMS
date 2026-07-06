import { describe, it, expect } from 'vitest';
import { MOCK_TOPOLOGY } from '../../mocks/topology.mock';
import type { NodeType, NodeHealth } from '../../api/topology.types';

// ── Pure logic tests (no DOM / D3 / Leaflet required) ────────────────────────

describe('topology node helpers', () => {
  const HEALTH_COLOR: Record<NodeHealth, string> = {
    HEALTHY: '#22c55e',
    DEGRADED: '#f59e0b',
    FAULTY: '#ef4444',
    UNKNOWN: '#6b7280',
  };

  const NODE_ICON: Record<NodeType, string> = { BTS: '🗼', CPE: '📡', IDU: '📦' };

  it('mock topology has expected node count', () => {
    expect(MOCK_TOPOLOGY.nodes).toHaveLength(5);
    expect(MOCK_TOPOLOGY.edges).toHaveLength(4);
  });

  it('each node type maps to correct icon', () => {
    expect(NODE_ICON['BTS']).toBe('🗼');
    expect(NODE_ICON['CPE']).toBe('📡');
    expect(NODE_ICON['IDU']).toBe('📦');
  });

  it('health maps to correct color', () => {
    expect(HEALTH_COLOR['HEALTHY']).toBe('#22c55e');
    expect(HEALTH_COLOR['FAULTY']).toBe('#ef4444');
    expect(HEALTH_COLOR['DEGRADED']).toBe('#f59e0b');
    expect(HEALTH_COLOR['UNKNOWN']).toBe('#6b7280');
  });

  it('faulty node is correctly identified', () => {
    const faulty = MOCK_TOPOLOGY.nodes.filter((n) => n.health === 'FAULTY');
    expect(faulty).toHaveLength(1);
    expect(faulty[0].deviceType).toBe('IDU');
  });

  it('nodes with pending commands are identified correctly', () => {
    const pending = MOCK_TOPOLOGY.nodes.filter((n) => (n.pendingCommandCount ?? 0) > 0);
    expect(pending.length).toBeGreaterThan(0);
    expect(pending.some((n) => n.deviceId === 'CPE-001')).toBe(true);
  });

  it('BTS node has cascade hop 0', () => {
    const bts = MOCK_TOPOLOGY.nodes.find((n) => n.deviceType === 'BTS');
    expect(bts?.cascadeHop).toBe(0);
  });

  it('CPE children have cascade hop 1', () => {
    const cpes = MOCK_TOPOLOGY.nodes.filter((n) => n.deviceType === 'CPE');
    cpes.forEach((c) => expect(c.cascadeHop).toBe(1));
  });

  it('edges connect real node device IDs', () => {
    const deviceIds = new Set(MOCK_TOPOLOGY.nodes.map((n) => n.deviceId));
    for (const edge of MOCK_TOPOLOGY.edges) {
      expect(deviceIds.has(edge.sourceDeviceId)).toBe(true);
      expect(deviceIds.has(edge.targetDeviceId)).toBe(true);
    }
  });

  it('nodes with location have valid coordinates', () => {
    const withLoc = MOCK_TOPOLOGY.nodes.filter((n) => n.location);
    withLoc.forEach((n) => {
      expect(n.location!.lat).toBeGreaterThan(-90);
      expect(n.location!.lat).toBeLessThan(90);
      expect(n.location!.lng).toBeGreaterThan(-180);
      expect(n.location!.lng).toBeLessThan(180);
    });
  });

  it('search highlighting: finds node by deviceId', () => {
    const target = MOCK_TOPOLOGY.nodes.find((n) => n.deviceId.includes('CPE-001'));
    expect(target).toBeDefined();
    expect(target!.id).toBe('n2');
  });
});
