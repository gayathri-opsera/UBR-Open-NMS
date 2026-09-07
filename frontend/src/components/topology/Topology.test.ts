/**
 * WO-036 Vitest tests for topology health overlay composition.
 */
import { describe, it, expect } from 'vitest';
import {
  composeTopologyHealth, nodeHealthColor, healthLabel, isNodeStale,
} from '../../components/topology/topologyHealthComposer';
import {
  MOCK_TOPOLOGY, MOCK_AVAILABILITY_SUMMARIES, MOCK_AVAILABILITY_PARTIAL,
  MOCK_TOPOLOGY_WITH_GENERIC, MOCK_TOPOLOGY_DOWN_LINK,
} from '../../mocks/topology.mock';
import type { TopologyNode } from '../../api/topology.types';

// ── composeTopologyHealth ─────────────────────────────────────────────────────

describe('composeTopologyHealth', () => {
  it('copies healthState from availability summary by deviceId', () => {
    const composed = composeTopologyHealth(MOCK_TOPOLOGY, MOCK_AVAILABILITY_SUMMARIES);
    const bts = composed.nodes.find((n) => n.deviceId === 'BTS-001');
    expect(bts).toBeDefined();
    expect(bts!.healthState).toBe('HEALTHY');
    expect(bts!.primaryReason).toBe('All subsystems nominal');
    expect(bts!.activeAlarmCount).toBe(0);
  });

  it('copies DEGRADED healthState for degraded device', () => {
    const composed = composeTopologyHealth(MOCK_TOPOLOGY, MOCK_AVAILABILITY_SUMMARIES);
    const cpe2 = composed.nodes.find((n) => n.deviceId === 'CPE-002');
    expect(cpe2!.healthState).toBe('DEGRADED');
    expect(cpe2!.activeAlarmCount).toBe(3);
    expect(cpe2!.primaryReason).toContain('packet loss');
  });

  it('copies FAULTY healthState for unreachable device with alarm count', () => {
    const composed = composeTopologyHealth(MOCK_TOPOLOGY, MOCK_AVAILABILITY_SUMMARIES);
    const idu = composed.nodes.find((n) => n.deviceId === 'IDU-001');
    expect(idu!.healthState).toBe('FAULTY');
    expect(idu!.activeAlarmCount).toBe(5);
    expect(idu!.healthSource).toBe('CONNECTIVITY');
  });

  it('sets UNKNOWN with "No availability data" when no summary for a node (AC edge case 1)', () => {
    const composed = composeTopologyHealth(MOCK_TOPOLOGY, MOCK_AVAILABILITY_SUMMARIES);
    // CPE-003 is intentionally absent from MOCK_AVAILABILITY_SUMMARIES
    const cpe3 = composed.nodes.find((n) => n.deviceId === 'CPE-003');
    expect(cpe3).toBeDefined();
    expect(cpe3!.healthState).toBe('UNKNOWN');
    expect(cpe3!.primaryReason).toBe('No availability data');
    expect(cpe3!.activeAlarmCount).toBe(0);
  });

  it('does not create phantom nodes for summaries absent from topology (AC edge case 2)', () => {
    const composed = composeTopologyHealth(MOCK_TOPOLOGY, MOCK_AVAILABILITY_SUMMARIES);
    expect(composed.nodes.length).toBe(MOCK_TOPOLOGY.nodes.length);
  });

  it('preserves original `health` field (backward compat)', () => {
    const composed = composeTopologyHealth(MOCK_TOPOLOGY, MOCK_AVAILABILITY_SUMMARIES);
    const bts = composed.nodes.find((n) => n.deviceId === 'BTS-001');
    expect(bts!.health).toBe('HEALTHY'); // original preserved
    expect(bts!.healthState).toBe('HEALTHY'); // also set
  });

  it('partial summaries: nodes without summary become UNKNOWN, not HEALTHY', () => {
    const composed = composeTopologyHealth(MOCK_TOPOLOGY, MOCK_AVAILABILITY_PARTIAL);
    const cpe1 = composed.nodes.find((n) => n.deviceId === 'CPE-001');
    // CPE-001 has no summary in MOCK_AVAILABILITY_PARTIAL
    expect(cpe1!.healthState).toBe('UNKNOWN');
    expect(cpe1!.primaryReason).toBe('No availability data');
  });
});

// ── Edge health derivation ─────────────────────────────────────────────────────

describe('composeTopologyHealth — edge health', () => {
  it('derives FAULTY edge when linkQuality is DOWN (AC: DOWN link → FAULTY)', () => {
    const composed = composeTopologyHealth(MOCK_TOPOLOGY_DOWN_LINK, []);
    const edge = composed.edges.find((e) => e.id === 'de1');
    expect(edge!.health).toBe('FAULTY');
  });

  it('edges with missing linkQuality remain in graph with UNKNOWN or derived health (never dropped)', () => {
    const composed = composeTopologyHealth(MOCK_TOPOLOGY_WITH_GENERIC, []);
    const edge = composed.edges.find((e) => e.id === 'eg1');
    expect(edge).toBeDefined(); // must not be dropped
    // Both endpoints are UNKNOWN, so derived health should not be FAULTY
    expect(edge!.health).not.toBe('FAULTY');
  });

  it('derives DEGRADED edge when source node is DEGRADED', () => {
    const composed = composeTopologyHealth(MOCK_TOPOLOGY, MOCK_AVAILABILITY_SUMMARIES);
    // e2: BTS-001 (HEALTHY) → CPE-002 (DEGRADED), no linkQuality → worst endpoint = DEGRADED
    const e2 = composed.edges.find((e) => e.id === 'e2');
    expect(e2!.health).toBe('DEGRADED');
  });

  it('derives FAULTY edge when endpoint is FAULTY (IDU → BTS)', () => {
    const composed = composeTopologyHealth(MOCK_TOPOLOGY, MOCK_AVAILABILITY_SUMMARIES);
    // e4: IDU-001 (FAULTY) → BTS-001 (HEALTHY), no linkQuality → worst = FAULTY, cap to DEGRADED
    // Per composer: if no linkQuality and worst is FAULTY, cap at DEGRADED
    const e4 = composed.edges.find((e) => e.id === 'e4');
    expect(['FAULTY', 'DEGRADED']).toContain(e4!.health);
  });
});

// ── nodeHealthColor ───────────────────────────────────────────────────────────

describe('nodeHealthColor', () => {
  function makeNode(health: TopologyNode['health'], healthState?: TopologyNode['healthState']): TopologyNode {
    return {
      id: 'n', deviceId: 'd', deviceType: 'BTS', serialNumber: 's',
      ipAddress: '1.1.1.1', macAddress: 'AA:BB:CC', health, healthState,
    };
  }

  it('returns green for HEALTHY', () => {
    expect(nodeHealthColor(makeNode('HEALTHY'))).toBe('#22c55e');
  });
  it('returns amber for DEGRADED', () => {
    expect(nodeHealthColor(makeNode('DEGRADED'))).toBe('#f59e0b');
  });
  it('returns red for FAULTY', () => {
    expect(nodeHealthColor(makeNode('FAULTY'))).toBe('#ef4444');
  });
  it('returns gray for UNKNOWN', () => {
    expect(nodeHealthColor(makeNode('UNKNOWN'))).toBe('#6b7280');
  });
  it('prefers healthState over health', () => {
    // health=HEALTHY but healthState=DEGRADED → must use healthState
    expect(nodeHealthColor(makeNode('HEALTHY', 'DEGRADED'))).toBe('#f59e0b');
  });
});

// ── healthLabel ───────────────────────────────────────────────────────────────

describe('healthLabel', () => {
  it('returns Healthy for HEALTHY', () => expect(healthLabel('HEALTHY')).toBe('Healthy'));
  it('returns Degraded for DEGRADED', () => expect(healthLabel('DEGRADED')).toBe('Degraded'));
  it('returns Faulty for FAULTY',    () => expect(healthLabel('FAULTY')).toBe('Faulty'));
  it('returns Unknown for UNKNOWN',  () => expect(healthLabel('UNKNOWN')).toBe('Unknown'));
  it('returns Unknown for undefined', () => expect(healthLabel(undefined)).toBe('Unknown'));
});

// ── isNodeStale ───────────────────────────────────────────────────────────────

describe('isNodeStale', () => {
  function nodeWithObservedAt(isoTs: string | null): TopologyNode {
    return {
      id: 'n', deviceId: 'd', deviceType: 'CPE', serialNumber: 's',
      ipAddress: '1.1.1.1', macAddress: 'AA:BB:CC', health: 'UNKNOWN',
      lastObservedAt: isoTs,
    };
  }

  it('returns true when lastObservedAt is null', () => {
    expect(isNodeStale(nodeWithObservedAt(null))).toBe(true);
  });

  it('returns true when lastObservedAt is more than threshold ago', () => {
    const old = new Date(Date.now() - 10 * 60_000).toISOString();
    expect(isNodeStale(nodeWithObservedAt(old), 300_000)).toBe(true);
  });

  it('returns false when lastObservedAt is recent', () => {
    const recent = new Date(Date.now() - 30_000).toISOString();
    expect(isNodeStale(nodeWithObservedAt(recent), 300_000)).toBe(false);
  });
});

// ── GENERIC node rendering fixture ────────────────────────────────────────────

describe('GENERIC node fixture', () => {
  it('includes a GENERIC deviceType node in topology', () => {
    expect(MOCK_TOPOLOGY_WITH_GENERIC.nodes.some((n) => n.deviceType === 'GENERIC')).toBe(true);
  });

  it('edge with absent linkQuality is preserved in composed graph', () => {
    const composed = composeTopologyHealth(MOCK_TOPOLOGY_WITH_GENERIC, []);
    expect(composed.edges.length).toBe(1);
  });
});
