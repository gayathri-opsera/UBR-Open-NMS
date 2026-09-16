/**
 * Tests for WO-043: Add Topology Investigation Filters
 *
 * Covers: filter predicate logic, search normalization, parent-context
 * preservation, active-filter chips, reset behavior, no-results handling,
 * and edge cases from the WO (special chars, missing tags, combined filters).
 */
import { describe, it, expect } from 'vitest';
import {
  normalizeSearch,
  matchesSearchText,
  matchesHealthFilter,
  matchesTypeFilter,
  matchesAlarmSeverity,
  matchesDiscoveryParadigm,
  matchesNetworkId,
  matchesTag,
  filterNodes,
  hasActiveFilters,
  activeFilterChips,
  emptyFilterCriteria,
} from './topologyFilters';
import type { TopologyFilterCriteria } from './topologyFilters';
import type { TopologyNode } from '../../api/topology.types';
import { MOCK_TOPOLOGY, MOCK_TOPOLOGY_FILTER_MIXED } from '../../mocks/topology.mock';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeNode(overrides: Partial<TopologyNode>): TopologyNode {
  return {
    id: 'n-test', deviceId: 'DEV-TEST', deviceType: 'BTS',
    serialNumber: 'SN-TEST', ipAddress: '10.0.0.1', macAddress: 'AA:BB:CC:DD:EE:FF',
    health: 'HEALTHY',
    ...overrides,
  };
}

function baseFilters(overrides: Partial<TopologyFilterCriteria> = {}): TopologyFilterCriteria {
  return { ...emptyFilterCriteria(), ...overrides };
}

// ── normalizeSearch ───────────────────────────────────────────────────────────

describe('normalizeSearch', () => {
  it('trims leading and trailing whitespace', () => {
    expect(normalizeSearch('  hello  ')).toBe('hello');
  });

  it('lowercases input', () => {
    expect(normalizeSearch('BTS-SN-001')).toBe('bts-sn-001');
  });

  it('enforces maxLen truncation at 128 by default', () => {
    const long = 'a'.repeat(200);
    expect(normalizeSearch(long).length).toBe(128);
  });

  it('enforces custom maxLen', () => {
    expect(normalizeSearch('hello world', 5).length).toBe(5);
  });

  it('returns empty string for empty input', () => {
    expect(normalizeSearch('')).toBe('');
  });

  it('returns empty string for whitespace-only input', () => {
    expect(normalizeSearch('   ')).toBe('');
  });
});

// ── matchesSearchText ─────────────────────────────────────────────────────────

describe('matchesSearchText', () => {
  const node = makeNode({ serialNumber: 'SN-BTS-001', ipAddress: '10.0.0.1', deviceName: 'Site-Alpha', macAddress: 'AA:BB:CC:DD:EE:FF' });

  it('matches on partial serial number', () => {
    expect(matchesSearchText(node, 'bts-001')).toBe(true);
  });

  it('matches on full IP address', () => {
    expect(matchesSearchText(node, '10.0.0.1')).toBe(true);
  });

  it('matches on partial device name (case-insensitive)', () => {
    expect(matchesSearchText(node, 'alpha')).toBe(true);
  });

  it('matches on partial MAC address', () => {
    expect(matchesSearchText(node, 'aa:bb')).toBe(true);
  });

  it('returns false when no field matches', () => {
    expect(matchesSearchText(node, 'zzz-not-found')).toBe(false);
  });

  it('returns true for empty normalized search (pass-all)', () => {
    expect(matchesSearchText(node, '')).toBe(true);
  });

  it('handles undefined deviceName safely', () => {
    const n = makeNode({ deviceName: undefined });
    expect(matchesSearchText(n, 'alpha')).toBe(false);
  });
});

// ── matchesHealthFilter ───────────────────────────────────────────────────────

describe('matchesHealthFilter', () => {
  it('returns true for empty filter (pass-all)', () => {
    expect(matchesHealthFilter(makeNode({ health: 'HEALTHY' }), '')).toBe(true);
  });

  it('matches node.health when healthState is absent', () => {
    expect(matchesHealthFilter(makeNode({ health: 'DEGRADED' }), 'DEGRADED')).toBe(true);
  });

  it('prefers healthState over health when both present', () => {
    const node = makeNode({ health: 'HEALTHY', healthState: 'DEGRADED' });
    expect(matchesHealthFilter(node, 'DEGRADED')).toBe(true);
    expect(matchesHealthFilter(node, 'HEALTHY')).toBe(false);
  });

  it('returns false when health does not match filter', () => {
    expect(matchesHealthFilter(makeNode({ health: 'HEALTHY' }), 'FAULTY')).toBe(false);
  });
});

// ── matchesTypeFilter ─────────────────────────────────────────────────────────

describe('matchesTypeFilter', () => {
  it('returns true for empty filter (pass-all)', () => {
    expect(matchesTypeFilter(makeNode({ deviceType: 'BTS' }), '')).toBe(true);
  });

  it('matches exact deviceType', () => {
    expect(matchesTypeFilter(makeNode({ deviceType: 'CPE' }), 'CPE')).toBe(true);
  });

  it('returns false for mismatched type', () => {
    expect(matchesTypeFilter(makeNode({ deviceType: 'IDU' }), 'BTS')).toBe(false);
  });

  it('handles GENERIC device type', () => {
    expect(matchesTypeFilter(makeNode({ deviceType: 'GENERIC' }), 'GENERIC')).toBe(true);
  });
});

// ── matchesAlarmSeverity ──────────────────────────────────────────────────────

describe('matchesAlarmSeverity', () => {
  it('returns true for empty filter (pass-all)', () => {
    expect(matchesAlarmSeverity(makeNode({}), '')).toBe(true);
  });

  it('returns false when node has no alarm severity', () => {
    expect(matchesAlarmSeverity(makeNode({}), 'WARNING')).toBe(false);
  });

  it('matches when node severity equals filter level', () => {
    expect(matchesAlarmSeverity(makeNode({ maxAlarmSeverity: 'MAJOR' }), 'MAJOR')).toBe(true);
  });

  it('matches when node severity is higher than filter (CRITICAL >= MAJOR)', () => {
    expect(matchesAlarmSeverity(makeNode({ maxAlarmSeverity: 'CRITICAL' }), 'MAJOR')).toBe(true);
  });

  it('does not match when node severity is lower than filter (WARNING < MAJOR)', () => {
    expect(matchesAlarmSeverity(makeNode({ maxAlarmSeverity: 'WARNING' }), 'MAJOR')).toBe(false);
  });

  it('INFO filter matches nodes with any alarm', () => {
    expect(matchesAlarmSeverity(makeNode({ maxAlarmSeverity: 'INFO' }), 'INFO')).toBe(true);
    expect(matchesAlarmSeverity(makeNode({ maxAlarmSeverity: 'CRITICAL' }), 'INFO')).toBe(true);
  });
});

// ── matchesDiscoveryParadigm ──────────────────────────────────────────────────

describe('matchesDiscoveryParadigm', () => {
  it('returns true for empty filter (pass-all)', () => {
    expect(matchesDiscoveryParadigm(makeNode({}), '')).toBe(true);
  });

  it('matches UBR paradigm', () => {
    expect(matchesDiscoveryParadigm(makeNode({ discoveryParadigm: 'UBR' }), 'UBR')).toBe(true);
  });

  it('matches SNMP paradigm', () => {
    expect(matchesDiscoveryParadigm(makeNode({ discoveryParadigm: 'SNMP' }), 'SNMP')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(matchesDiscoveryParadigm(makeNode({ discoveryParadigm: 'UBR' }), 'ubr' as any)).toBe(true);
  });

  it('returns false when paradigm is absent', () => {
    expect(matchesDiscoveryParadigm(makeNode({}), 'UBR')).toBe(false);
  });

  it('returns false for paradigm mismatch', () => {
    expect(matchesDiscoveryParadigm(makeNode({ discoveryParadigm: 'SSH' }), 'SNMP')).toBe(false);
  });
});

// ── matchesNetworkId ──────────────────────────────────────────────────────────

describe('matchesNetworkId', () => {
  it('returns true for empty filter (pass-all)', () => {
    expect(matchesNetworkId(makeNode({ networkId: 'NET-001' }), '')).toBe(true);
  });

  it('matches exact networkId', () => {
    expect(matchesNetworkId(makeNode({ networkId: 'NET-ALPHA' }), 'NET-ALPHA')).toBe(true);
  });

  it('returns false for mismatch', () => {
    expect(matchesNetworkId(makeNode({ networkId: 'NET-ALPHA' }), 'NET-BETA')).toBe(false);
  });

  it('returns false when networkId is absent', () => {
    expect(matchesNetworkId(makeNode({}), 'NET-ALPHA')).toBe(false);
  });
});

// ── matchesTag ────────────────────────────────────────────────────────────────

describe('matchesTag', () => {
  it('returns true for empty filter (pass-all)', () => {
    expect(matchesTag(makeNode({ tags: ['site:alpha'] }), '')).toBe(true);
  });

  it('matches when tag is exactly present', () => {
    expect(matchesTag(makeNode({ tags: ['site:alpha', 'tier:core'] }), 'tier:core')).toBe(true);
  });

  it('matches on partial tag substring', () => {
    expect(matchesTag(makeNode({ tags: ['customer:residential'] }), 'residential')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(matchesTag(makeNode({ tags: ['site:ALPHA'] }), 'alpha')).toBe(true);
  });

  it('returns false when node has no tags (missing array)', () => {
    expect(matchesTag(makeNode({}), 'site:alpha')).toBe(false);
  });

  it('returns false when node has empty tag array', () => {
    expect(matchesTag(makeNode({ tags: [] }), 'site:alpha')).toBe(false);
  });

  it('returns false when tag is not present', () => {
    expect(matchesTag(makeNode({ tags: ['customer:sme'] }), 'site:alpha')).toBe(false);
  });
});

// ── filterNodes ───────────────────────────────────────────────────────────────

describe('filterNodes — empty criteria', () => {
  it('returns all nodes when no filter is set', () => {
    const { visible } = filterNodes(MOCK_TOPOLOGY.nodes, emptyFilterCriteria());
    expect(visible.length).toBe(MOCK_TOPOLOGY.nodes.length);
  });

  it('contextualIds is empty when no type filter', () => {
    const { contextualIds } = filterNodes(MOCK_TOPOLOGY.nodes, emptyFilterCriteria());
    expect(contextualIds.size).toBe(0);
  });
});

describe('filterNodes — type filter with parent context', () => {
  it('includes BTS parent when CPE filter is active (parent context preservation)', () => {
    const { visible, contextualIds } = filterNodes(
      MOCK_TOPOLOGY_FILTER_MIXED.nodes,
      baseFilters({ typeFilter: 'CPE' }),
    );
    const bts1 = visible.find((n) => n.deviceId === 'BTS-FILTER-001');
    expect(bts1).toBeDefined();
    expect(contextualIds.has('BTS-FILTER-001')).toBe(true);
  });

  it('contextual parent is not duplicated in visible list', () => {
    const { visible } = filterNodes(
      MOCK_TOPOLOGY_FILTER_MIXED.nodes,
      baseFilters({ typeFilter: 'CPE' }),
    );
    const btsCopies = visible.filter((n) => n.deviceId === 'BTS-FILTER-001');
    expect(btsCopies.length).toBe(1);
  });

  it('does not add contextual parents when preserveParentContext is false', () => {
    const { contextualIds } = filterNodes(
      MOCK_TOPOLOGY_FILTER_MIXED.nodes,
      baseFilters({ typeFilter: 'CPE' }),
      { preserveParentContext: false },
    );
    expect(contextualIds.size).toBe(0);
  });

  it('does not add contextual parents when BTS type filter is active', () => {
    const { contextualIds } = filterNodes(
      MOCK_TOPOLOGY_FILTER_MIXED.nodes,
      baseFilters({ typeFilter: 'BTS' }),
    );
    expect(contextualIds.size).toBe(0);
  });
});

describe('filterNodes — alarm severity filter', () => {
  it('returns only nodes with CRITICAL alarm when CRITICAL filter is active', () => {
    const { visible } = filterNodes(
      MOCK_TOPOLOGY_FILTER_MIXED.nodes,
      baseFilters({ alarmSeverity: 'CRITICAL' }),
    );
    expect(visible.every((n) => n.maxAlarmSeverity === 'CRITICAL')).toBe(true);
  });

  it('returns CRITICAL and MAJOR nodes when MAJOR filter is active', () => {
    const { visible } = filterNodes(
      MOCK_TOPOLOGY_FILTER_MIXED.nodes,
      baseFilters({ alarmSeverity: 'MAJOR' }),
    );
    const severities = visible.map((n) => n.maxAlarmSeverity);
    expect(severities.every((s) => s === 'CRITICAL' || s === 'MAJOR')).toBe(true);
  });

  it('returns empty when no node matches alarm filter', () => {
    const { visible } = filterNodes(
      [makeNode({ maxAlarmSeverity: 'WARNING' })],
      baseFilters({ alarmSeverity: 'CRITICAL' }),
    );
    expect(visible.length).toBe(0);
  });
});

describe('filterNodes — paradigm filter', () => {
  it('returns only UBR devices when UBR filter is active', () => {
    const { visible } = filterNodes(
      MOCK_TOPOLOGY_FILTER_MIXED.nodes,
      baseFilters({ discoveryParadigm: 'UBR' }),
    );
    expect(visible.every((n) => n.discoveryParadigm === 'UBR' || contextualParentHasUbr(n))).toBe(true);
  });

  it('returns only SNMP devices when SNMP filter is active', () => {
    const { visible } = filterNodes(
      MOCK_TOPOLOGY_FILTER_MIXED.nodes,
      baseFilters({ discoveryParadigm: 'SNMP' }),
    );
    expect(visible.every((n) => n.discoveryParadigm === 'SNMP')).toBe(true);
  });

  function contextualParentHasUbr(_: TopologyNode) { return false; }
});

describe('filterNodes — network filter', () => {
  it('returns only nodes in NET-ALPHA', () => {
    const { visible } = filterNodes(
      MOCK_TOPOLOGY.nodes,
      baseFilters({ networkId: 'NET-DHAKA-01' }),
    );
    expect(visible.every((n) => n.networkId === 'NET-DHAKA-01')).toBe(true);
  });

  it('returns empty for unknown network', () => {
    const { visible } = filterNodes(
      MOCK_TOPOLOGY.nodes,
      baseFilters({ networkId: 'NET-DOES-NOT-EXIST' }),
    );
    expect(visible.length).toBe(0);
  });
});

describe('filterNodes — tag filter', () => {
  it('returns only nodes with matching tag', () => {
    const { visible } = filterNodes(
      MOCK_TOPOLOGY.nodes,
      baseFilters({ tag: 'tier:core' }),
    );
    expect(visible.every((n) => (n.tags ?? []).some((t) => t.includes('tier:core')))).toBe(true);
  });

  it('handles nodes without tags array safely (no TypeError)', () => {
    const nodes = [makeNode({}), makeNode({ tags: ['foo'] })];
    expect(() => filterNodes(nodes, baseFilters({ tag: 'foo' }))).not.toThrow();
  });
});

describe('filterNodes — combined filters', () => {
  it('combined type + health returns only matching intersection', () => {
    const { visible } = filterNodes(
      MOCK_TOPOLOGY_FILTER_MIXED.nodes,
      baseFilters({ typeFilter: 'CPE', healthFilter: 'FAULTY' }),
    );
    expect(visible.every((n) => n.deviceType === 'CPE' || n.deviceType === 'BTS')).toBe(true);
    // Only CPE-FILTER-003 (FAULTY CPE) should be in directly matched; BTS-FILTER-002 is parent
    const directMatches = visible.filter((n) => n.deviceType === 'CPE');
    expect(directMatches.every((n) => n.health === 'FAULTY')).toBe(true);
  });

  it('combined alarm + paradigm returns correct intersection', () => {
    const { visible } = filterNodes(
      MOCK_TOPOLOGY_FILTER_MIXED.nodes,
      baseFilters({ alarmSeverity: 'CRITICAL', discoveryParadigm: 'SNMP' }),
    );
    expect(visible.every((n) =>
      n.discoveryParadigm === 'SNMP' && n.maxAlarmSeverity === 'CRITICAL',
    )).toBe(true);
  });
});

describe('filterNodes — no-results case', () => {
  it('returns empty visible array when no nodes match', () => {
    const { visible, contextualIds } = filterNodes(
      MOCK_TOPOLOGY.nodes,
      baseFilters({ searchText: 'zzz-absolutely-does-not-exist' }),
    );
    expect(visible.length).toBe(0);
    expect(contextualIds.size).toBe(0);
  });
});

// ── hasActiveFilters ──────────────────────────────────────────────────────────

describe('hasActiveFilters', () => {
  it('returns false for empty criteria', () => {
    expect(hasActiveFilters(emptyFilterCriteria())).toBe(false);
  });

  it('returns true when any filter is set', () => {
    expect(hasActiveFilters(baseFilters({ healthFilter: 'HEALTHY' }))).toBe(true);
    expect(hasActiveFilters(baseFilters({ typeFilter: 'CPE' }))).toBe(true);
    expect(hasActiveFilters(baseFilters({ searchText: 'bts' }))).toBe(true);
    expect(hasActiveFilters(baseFilters({ alarmSeverity: 'CRITICAL' }))).toBe(true);
    expect(hasActiveFilters(baseFilters({ discoveryParadigm: 'UBR' }))).toBe(true);
    expect(hasActiveFilters(baseFilters({ networkId: 'NET-001' }))).toBe(true);
    expect(hasActiveFilters(baseFilters({ tag: 'site:alpha' }))).toBe(true);
  });

  it('whitespace-only searchText is not treated as active', () => {
    expect(hasActiveFilters(baseFilters({ searchText: '   ' }))).toBe(false);
  });
});

// ── activeFilterChips ─────────────────────────────────────────────────────────

describe('activeFilterChips', () => {
  it('returns empty array for empty criteria', () => {
    expect(activeFilterChips(emptyFilterCriteria())).toEqual([]);
  });

  it('returns chip for each active filter dimension', () => {
    const criteria = baseFilters({
      healthFilter: 'HEALTHY',
      typeFilter: 'BTS',
      searchText: 'dhaka',
      alarmSeverity: 'MAJOR',
      discoveryParadigm: 'UBR',
      networkId: 'NET-001',
      tag: 'tier:core',
    });
    const chips = activeFilterChips(criteria);
    expect(chips.length).toBe(7);
    expect(chips.map((c) => c.key)).toContain('healthFilter');
    expect(chips.map((c) => c.key)).toContain('alarmSeverity');
    expect(chips.map((c) => c.key)).toContain('discoveryParadigm');
  });

  it('includes human-readable label for health chip', () => {
    const chips = activeFilterChips(baseFilters({ healthFilter: 'FAULTY' }));
    expect(chips[0].label).toContain('FAULTY');
  });

  it('includes alarm severity label with ≥ notation', () => {
    const chips = activeFilterChips(baseFilters({ alarmSeverity: 'CRITICAL' }));
    expect(chips[0].label).toContain('CRITICAL');
    expect(chips[0].label).toContain('≥');
  });
});

// ── emptyFilterCriteria ────────────────────────────────────────────────────────

describe('emptyFilterCriteria', () => {
  it('returns all-empty criteria', () => {
    const c = emptyFilterCriteria();
    expect(c.healthFilter).toBe('');
    expect(c.typeFilter).toBe('');
    expect(c.searchText).toBe('');
    expect(c.alarmSeverity).toBe('');
    expect(c.discoveryParadigm).toBe('');
    expect(c.networkId).toBe('');
    expect(c.tag).toBe('');
  });

  it('produces a fresh object each call (not shared reference)', () => {
    const a = emptyFilterCriteria();
    const b = emptyFilterCriteria();
    a.healthFilter = 'HEALTHY';
    expect(b.healthFilter).toBe('');
  });
});

// ── MOCK_TOPOLOGY_FILTER_MIXED fixture coverage ───────────────────────────────

describe('MOCK_TOPOLOGY_FILTER_MIXED fixture', () => {
  it('contains UBR and SNMP paradigm devices', () => {
    const paradigms = new Set(MOCK_TOPOLOGY_FILTER_MIXED.nodes.map((n) => n.discoveryParadigm));
    expect(paradigms).toContain('UBR');
    expect(paradigms).toContain('SNMP');
    expect(paradigms).toContain('GENERIC');
  });

  it('contains CRITICAL and MAJOR alarm severity devices', () => {
    const severities = new Set(MOCK_TOPOLOGY_FILTER_MIXED.nodes.map((n) => n.maxAlarmSeverity).filter(Boolean));
    expect(severities).toContain('CRITICAL');
    expect(severities).toContain('MAJOR');
  });

  it('covers both NET-ALPHA and NET-BETA networks', () => {
    const networks = new Set(MOCK_TOPOLOGY_FILTER_MIXED.nodes.map((n) => n.networkId));
    expect(networks).toContain('NET-ALPHA');
    expect(networks).toContain('NET-BETA');
  });

  it('contains tagged nodes for tag filter testing', () => {
    const allTags = MOCK_TOPOLOGY_FILTER_MIXED.nodes.flatMap((n) => n.tags ?? []);
    expect(allTags.some((t) => t.includes('site:'))).toBe(true);
    expect(allTags.some((t) => t.includes('customer:'))).toBe(true);
  });
});
