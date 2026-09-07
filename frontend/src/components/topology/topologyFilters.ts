/**
 * Pure topology investigation filter utilities (WO-043).
 *
 * All functions are side-effect-free and unit-testable without rendering
 * D3, Leaflet, or any React component. Filter predicates operate on the
 * TopologyNode shape and are composed by filterNodes().
 *
 * Severity precedence: CRITICAL > MAJOR > MINOR > WARNING > INFO
 * Node alarm filtering requires maxAlarmSeverity >= requested level.
 *
 * Parent-context preservation:
 *   When a child-type filter (CPE or IDU) is active, parent BTS nodes
 *   that own at least one matched child are included with a contextual
 *   flag so the graph does not show orphaned child nodes.
 */

import type { TopologyNode, NodeHealth, DiscoveryParadigm, AlarmSeverityLevel } from '../../api/topology.types';

// ── Filter state shape ────────────────────────────────────────────────────────

export interface TopologyFilterCriteria {
  healthFilter: NodeHealth | '';
  typeFilter: string;
  searchText: string;
  alarmSeverity: AlarmSeverityLevel | '';
  discoveryParadigm: DiscoveryParadigm | '';
  networkId: string;
  tag: string;
}

export function emptyFilterCriteria(): TopologyFilterCriteria {
  return {
    healthFilter: '',
    typeFilter: '',
    searchText: '',
    alarmSeverity: '',
    discoveryParadigm: '',
    networkId: '',
    tag: '',
  };
}

// ── Severity ranking ──────────────────────────────────────────────────────────

const SEVERITY_RANK: Record<AlarmSeverityLevel, number> = {
  CRITICAL: 5,
  MAJOR:    4,
  MINOR:    3,
  WARNING:  2,
  INFO:     1,
};

// ── Search normalization ──────────────────────────────────────────────────────

/**
 * Normalize free-text search input: trim whitespace, lowercase, enforce max length.
 * Never pass raw user input into server-side fetch targets — callers must
 * use this before constructing API query strings.
 */
export function normalizeSearch(text: string, maxLen = 128): string {
  if (!text) return '';
  return text.trim().slice(0, maxLen).toLowerCase();
}

// ── Individual predicates ─────────────────────────────────────────────────────

export function matchesHealthFilter(node: TopologyNode, healthFilter: NodeHealth | ''): boolean {
  if (!healthFilter) return true;
  // WO-036 healthState takes precedence over raw health for overlay-aware filtering
  const effective = node.healthState ?? node.health;
  return effective === healthFilter;
}

export function matchesTypeFilter(node: TopologyNode, typeFilter: string): boolean {
  if (!typeFilter) return true;
  return node.deviceType === typeFilter;
}

export function matchesSearchText(node: TopologyNode, normalizedSearch: string): boolean {
  if (!normalizedSearch) return true;
  const fields = [node.serialNumber, node.ipAddress, node.deviceName, node.macAddress];
  return fields.some((v) => (v ?? '').toLowerCase().includes(normalizedSearch));
}

export function matchesAlarmSeverity(
  node: TopologyNode,
  severity: AlarmSeverityLevel | '',
): boolean {
  if (!severity) return true;
  if (!node.maxAlarmSeverity) return false;
  const nodeRank = SEVERITY_RANK[node.maxAlarmSeverity] ?? 0;
  const filterRank = SEVERITY_RANK[severity] ?? 0;
  return nodeRank >= filterRank;
}

export function matchesDiscoveryParadigm(
  node: TopologyNode,
  paradigm: DiscoveryParadigm | '',
): boolean {
  if (!paradigm) return true;
  if (!node.discoveryParadigm) return false;
  return node.discoveryParadigm.toUpperCase() === paradigm.toUpperCase();
}

export function matchesNetworkId(node: TopologyNode, networkId: string): boolean {
  if (!networkId) return true;
  return (node.networkId ?? '') === networkId;
}

export function matchesTag(node: TopologyNode, tag: string): boolean {
  if (!tag) return true;
  if (!node.tags || node.tags.length === 0) return false;
  const normalTag = tag.toLowerCase();
  return node.tags.some((t) => t.toLowerCase().includes(normalTag));
}

// ── Composed filter + parent-context engine ───────────────────────────────────

export interface FilterResult {
  /** Nodes that matched filters directly or are contextual parents. */
  visible: TopologyNode[];
  /**
   * Device IDs of nodes that are visible only because they are contextual
   * parents of a matched child. These nodes should receive a distinct visual
   * treatment (e.g. dimmed border) to distinguish them from direct matches.
   */
  contextualIds: Set<string>;
}

/**
 * Apply all filter criteria to a node list and return visible nodes plus
 * the set of contextual parent IDs.
 *
 * When `preserveParentContext` is true and a non-BTS type filter is active,
 * parent BTS nodes that own matched children are included with their IDs
 * recorded in contextualIds so the graph can render them distinctly.
 *
 * Tag filters handle missing tag arrays safely — no TypeError on undefined.
 */
export function filterNodes(
  nodes: TopologyNode[],
  criteria: TopologyFilterCriteria,
  opts: { preserveParentContext?: boolean } = {},
): FilterResult {
  const { preserveParentContext = true } = opts;
  const normalized = normalizeSearch(criteria.searchText);

  const directly = nodes.filter((n) =>
    matchesHealthFilter(n, criteria.healthFilter) &&
    matchesTypeFilter(n, criteria.typeFilter) &&
    matchesSearchText(n, normalized) &&
    matchesAlarmSeverity(n, criteria.alarmSeverity) &&
    matchesDiscoveryParadigm(n, criteria.discoveryParadigm) &&
    matchesNetworkId(n, criteria.networkId) &&
    matchesTag(n, criteria.tag),
  );

  const contextualIds = new Set<string>();

  // When a child-type filter is active, inject BTS parents so children
  // don't appear disconnected in the graph and map views.
  if (
    preserveParentContext &&
    criteria.typeFilter &&
    criteria.typeFilter !== 'BTS' &&
    directly.length > 0
  ) {
    const nodeByDeviceId = new Map(nodes.map((n) => [n.deviceId, n]));
    const directIds = new Set(directly.map((n) => n.deviceId));

    for (const child of directly) {
      if (child.parentDeviceId) {
        const parent = nodeByDeviceId.get(child.parentDeviceId);
        if (parent && !directIds.has(parent.deviceId)) {
          contextualIds.add(parent.deviceId);
        }
      }
    }
  }

  const contextualNodes = nodes.filter((n) => contextualIds.has(n.deviceId));

  return {
    visible: [...directly, ...contextualNodes],
    contextualIds,
  };
}

// ── Active filter helpers ─────────────────────────────────────────────────────

export function hasActiveFilters(criteria: TopologyFilterCriteria): boolean {
  return !!(
    criteria.healthFilter ||
    criteria.typeFilter ||
    criteria.searchText.trim() ||
    criteria.alarmSeverity ||
    criteria.discoveryParadigm ||
    criteria.networkId ||
    criteria.tag
  );
}

/** Returns human-readable chip labels for all active filter dimensions. */
export function activeFilterChips(
  criteria: TopologyFilterCriteria,
): Array<{ key: keyof TopologyFilterCriteria; label: string }> {
  const chips: Array<{ key: keyof TopologyFilterCriteria; label: string }> = [];
  if (criteria.healthFilter)      chips.push({ key: 'healthFilter',      label: `Health: ${criteria.healthFilter}` });
  if (criteria.typeFilter)        chips.push({ key: 'typeFilter',        label: `Type: ${criteria.typeFilter}` });
  if (criteria.searchText.trim()) chips.push({ key: 'searchText',        label: `Search: "${criteria.searchText.trim()}"` });
  if (criteria.alarmSeverity)     chips.push({ key: 'alarmSeverity',     label: `Alarm ≥ ${criteria.alarmSeverity}` });
  if (criteria.discoveryParadigm) chips.push({ key: 'discoveryParadigm', label: `Paradigm: ${criteria.discoveryParadigm}` });
  if (criteria.networkId)         chips.push({ key: 'networkId',         label: `Network: ${criteria.networkId}` });
  if (criteria.tag)               chips.push({ key: 'tag',               label: `Tag: ${criteria.tag}` });
  return chips;
}
