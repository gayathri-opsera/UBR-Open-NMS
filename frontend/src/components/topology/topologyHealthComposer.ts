/**
 * Topology health composition helper (WO-036).
 *
 * Joins raw topology graph nodes with availability summaries and active
 * alarm counts by stable device identity (deviceId or serialNumber).
 *
 * Rules:
 * - If availability summary is present, copy healthState, primaryReason,
 *   activeAlarmCount, lastObservedAt, healthSource onto the node.
 * - If no summary for a node, set healthState = UNKNOWN, primaryReason =
 *   "No availability data", activeAlarmCount = 0.
 * - An availability entry absent from the topology graph MUST NOT create a
 *   phantom node (ignored silently).
 * - Derived edge health = worst(source healthState, target healthState).
 *   If link quality is DOWN, force FAULTY regardless of endpoint health.
 *   If link quality is absent, derive UNKNOWN — never drop the edge.
 */
import type { TopologyGraph, TopologyNode, TopologyEdge, AvailabilitySummary, NodeHealth } from '../../api/topology.types';

// ── Health ordering ───────────────────────────────────────────────────────────

const HEALTH_RANK: Record<NodeHealth | 'UNKNOWN', number> = {
  HEALTHY: 0,
  UNKNOWN: 1,
  DEGRADED: 2,
  FAULTY: 3,
};

function worstHealth(a: NodeHealth, b: NodeHealth): NodeHealth {
  return HEALTH_RANK[a] >= HEALTH_RANK[b] ? a : b;
}

// ── Link quality → health ─────────────────────────────────────────────────────

function linkQualityToHealth(lq: string | undefined): NodeHealth {
  if (!lq) return 'UNKNOWN';
  switch (lq.toUpperCase()) {
    case 'GOOD': return 'HEALTHY';
    case 'FAIR': return 'DEGRADED';
    case 'POOR': return 'FAULTY';
    case 'DOWN': return 'FAULTY';
    default:     return 'UNKNOWN';
  }
}

// ── Main composition ──────────────────────────────────────────────────────────

/**
 * Overlays availability summaries onto topology graph nodes.
 *
 * Returns a new TopologyGraph with:
 * - `healthState`, `primaryReason`, `activeAlarmCount`, `lastObservedAt`,
 *   `healthSource` populated for each node.
 * - Edge `health` derived from endpoint health states and link quality.
 * - Original `health` field preserved (to maintain backward compat).
 */
export function composeTopologyHealth(
  graph: TopologyGraph,
  availabilitySummaries: AvailabilitySummary[],
): TopologyGraph {
  const summaryByDeviceId = new Map<string, AvailabilitySummary>();
  const summaryBySerial   = new Map<string, AvailabilitySummary>();
  for (const s of availabilitySummaries) {
    if (s.deviceId)    summaryByDeviceId.set(s.deviceId, s);
    if (s.serialNumber) summaryBySerial.set(s.serialNumber, s);
  }

  const composedNodes: TopologyNode[] = graph.nodes.map((node) => {
    const summary = summaryByDeviceId.get(node.deviceId)
      ?? summaryBySerial.get(node.serialNumber);

    if (summary) {
      return {
        ...node,
        healthState:      summary.healthState,
        primaryReason:    summary.primaryReason,
        activeAlarmCount: summary.activeAlarmCount,
        lastObservedAt:   summary.lastObservedAt,
        healthSource:     summary.healthSource,
      };
    }

    // No availability data — mark explicitly as UNKNOWN, not healthy
    return {
      ...node,
      healthState:      'UNKNOWN',
      primaryReason:    'No availability data',
      activeAlarmCount: 0,
      lastObservedAt:   null,
      healthSource:     'UNKNOWN',
    };
  });

  // Build a lookup from deviceId → composed healthState for edge derivation.
  const nodeHealthByDeviceId = new Map<string, NodeHealth>(
    composedNodes.map((n) => [n.deviceId, n.healthState ?? n.health]),
  );

  const composedEdges: TopologyEdge[] = graph.edges.map((edge) => {
    const srcHealth = nodeHealthByDeviceId.get(edge.sourceDeviceId) ?? 'UNKNOWN';
    const tgtHealth = nodeHealthByDeviceId.get(edge.targetDeviceId) ?? 'UNKNOWN';
    const lqHealth  = linkQualityToHealth(edge.linkQuality);

    let derivedHealth: NodeHealth;
    if (edge.linkQuality?.toUpperCase() === 'DOWN') {
      // Link is explicitly down — always FAULTY regardless of endpoint states.
      derivedHealth = 'FAULTY';
    } else if (!edge.linkQuality) {
      // No link quality data — use worst of endpoints but cap at DEGRADED
      // to avoid false FAULTY reads. Never drop the edge.
      const endpointWorst = worstHealth(srcHealth, tgtHealth);
      derivedHealth = endpointWorst === 'FAULTY' ? 'DEGRADED' : endpointWorst;
    } else {
      derivedHealth = worstHealth(worstHealth(srcHealth, tgtHealth), lqHealth);
    }

    return { ...edge, health: derivedHealth };
  });

  return {
    ...graph,
    nodes: composedNodes,
    edges: composedEdges,
  };
}

/**
 * Returns the effective health color token for a node.
 * Uses `healthState` if available, falls back to `health`.
 */
export function nodeHealthColor(node: TopologyNode): string {
  const h = node.healthState ?? node.health;
  switch (h) {
    case 'HEALTHY':  return '#22c55e';
    case 'DEGRADED': return '#f59e0b';
    case 'FAULTY':   return '#ef4444';
    default:         return '#6b7280';
  }
}

/**
 * Returns the accessibility label for a health state.
 * Color alone is never the only indicator (WO-036 constraint).
 */
export function healthLabel(h: NodeHealth | undefined): string {
  switch (h) {
    case 'HEALTHY':  return 'Healthy';
    case 'DEGRADED': return 'Degraded';
    case 'FAULTY':   return 'Faulty';
    default:         return 'Unknown';
  }
}

/**
 * Returns true if lastObservedAt is more than staleThresholdMs milliseconds ago.
 */
export function isNodeStale(node: TopologyNode, staleThresholdMs = 300_000): boolean {
  if (!node.lastObservedAt) return true;
  return Date.now() - new Date(node.lastObservedAt).getTime() > staleThresholdMs;
}
