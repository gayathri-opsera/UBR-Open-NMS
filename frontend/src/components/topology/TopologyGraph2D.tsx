import React, { useEffect, useRef } from 'react';
import * as d3 from 'd3';
import type { TopologyGraph, TopologyNode, TopologyEdge, NodeType, NodeHealth } from '../../api/topology.types';

// Augment TopologyNode with d3 simulation fields (x, y, vx, vy, fx, fy, index)
type SimNode = TopologyNode & d3.SimulationNodeDatum;
type SimLink = Omit<TopologyEdge, 'sourceDeviceId' | 'targetDeviceId'> &
  d3.SimulationLinkDatum<SimNode> & { health: NodeHealth };

interface Props {
  graph: TopologyGraph;
  highlightedId?: string;
  onNodeClick(node: TopologyNode): void;
  onNodeHover(node: TopologyNode | null): void;
}

const HEALTH_COLOR: Record<NodeHealth, string> = {
  HEALTHY: '#22c55e',
  DEGRADED: '#f59e0b',
  FAULTY: '#ef4444',
  UNKNOWN: '#6b7280',
};

const NODE_ICON: Record<NodeType, string> = {
  BTS: '🗼',
  CPE: '📡',
  IDU: '🔌',
};

export function TopologyGraph2D({ graph, highlightedId, onNodeClick, onNodeHover }: Props): React.ReactElement {
  const svgRef = useRef<SVGSVGElement>(null);
  const simRef = useRef<d3.Simulation<SimNode, SimLink> | null>(null);

  // Build simulation
  useEffect(() => {
    if (!svgRef.current) return;

    const W = svgRef.current.clientWidth || 800;
    const H = svgRef.current.clientHeight || 600;

    const nodes: SimNode[] = graph.nodes.map((n) => ({ ...n }));
    const edgeMap = new Map(nodes.map((n) => [n.deviceId, n]));
    const links: SimLink[] = graph.edges
      .map((e) => ({
        ...e,
        source: edgeMap.get(e.sourceDeviceId)!,
        target: edgeMap.get(e.targetDeviceId)!,
        health: e.health,
      }))
      .filter((l) => l.source && l.target);

    const svg = d3.select(svgRef.current);
    svg.selectAll('*').remove();

    const g = svg.append('g');

    // Zoom
    const zoom = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.1, 4])
      .on('zoom', (event) => g.attr('transform', event.transform));
    svg.call(zoom);

    // Links
    const link = g.append('g').selectAll('line')
      .data(links).join('line')
      .attr('stroke', (d) => HEALTH_COLOR[d.health] ?? '#374151')
      .attr('stroke-width', 2)
      .attr('stroke-opacity', 0.7);

    // Node groups
    const node = g.append('g').selectAll<SVGGElement, SimNode>('g')
      .data(nodes).join('g')
      .style('cursor', 'pointer')
      .on('click', (_, d) => onNodeClick(d))
      .on('mouseover', (_, d) => onNodeHover(d))
      .on('mouseout', () => onNodeHover(null));

    node.append('circle')
      .attr('r', (d) => d.deviceType === 'BTS' ? 18 : d.deviceType === 'IDU' ? 15 : 12)
      .attr('fill', (d) => d.id === highlightedId ? '#60a5fa' : '#0d1b2a')
      .attr('stroke', (d) => HEALTH_COLOR[d.health])
      .attr('stroke-width', (d) => d.id === highlightedId ? 4 : 2);

    node.append('text')
      .text((d) => NODE_ICON[d.deviceType])
      .attr('text-anchor', 'middle')
      .attr('dominant-baseline', 'central')
      .style('font-size', (d) => d.deviceType === 'BTS' ? '16px' : d.deviceType === 'IDU' ? '13px' : '11px')
      .style('user-select', 'none');

    // Pending badge
    node.filter((d) => (d.pendingCommandCount ?? 0) > 0)
      .append('circle')
      .attr('cx', 10).attr('cy', -10).attr('r', 7)
      .attr('fill', '#f59e0b');

    // Force simulation
    const sim = d3.forceSimulation<SimNode>(nodes)
      .force('link', d3.forceLink<SimNode, SimLink>(links).id((d) => d.id).distance(120))
      .force('charge', d3.forceManyBody().strength(-400))
      .force('center', d3.forceCenter(W / 2, H / 2))
      .on('tick', () => {
        link
          .attr('x1', (d) => (d.source as SimNode).x ?? 0)
          .attr('y1', (d) => (d.source as SimNode).y ?? 0)
          .attr('x2', (d) => (d.target as SimNode).x ?? 0)
          .attr('y2', (d) => (d.target as SimNode).y ?? 0);
        node.attr('transform', (d) => `translate(${d.x ?? 0},${d.y ?? 0})`);
      });

    // Drag
    node.call(
      d3.drag<SVGGElement, SimNode>()
        .on('start', (event, d) => {
          if (!event.active) sim.alphaTarget(0.3).restart();
          d.fx = d3.pointer(event, svgRef.current)[0];
          d.fy = d3.pointer(event, svgRef.current)[1];
        })
        .on('drag', (event, d) => {
          d.fx = event.x;
          d.fy = event.y;
        })
        .on('end', (event, d) => {
          if (!event.active) sim.alphaTarget(0);
          d.fx = null;
          d.fy = null;
        }),
    );

    simRef.current = sim;
    return (): void => { sim.stop(); };
  }, [graph, highlightedId]);

  return (
    <svg
      ref={svgRef}
      style={{ width: '100%', height: '100%', background: '#0a1628', borderRadius: 8 }}
    />
  );
}
