import React from 'react';
import { MapContainer, TileLayer, CircleMarker, Tooltip } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import type { TopologyNode, NodeHealth } from '../../api/topology.types';

interface Props {
  nodes: TopologyNode[];
  highlightedId?: string;
  onNodeClick(node: TopologyNode): void;
  onError?: () => void;
}

const HEALTH_COLOR: Record<NodeHealth, string> = {
  HEALTHY: '#22c55e',
  DEGRADED: '#f59e0b',
  FAULTY: '#ef4444',
  UNKNOWN: '#6b7280',
};

export function TopologyMapView({ nodes, highlightedId, onNodeClick, onError }: Props): React.ReactElement {
  const geoNodes = nodes.filter((n) => n.location);
  const center: [number, number] = geoNodes.length > 0
    ? [geoNodes[0].location!.lat, geoNodes[0].location!.lng]
    : [23.8103, 90.4125];

  return (
    <MapContainer
      center={center}
      zoom={13}
      style={{ width: '100%', height: '100%', borderRadius: 8 }}
    >
      <TileLayer
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        attribution='&copy; OpenStreetMap contributors'
        eventHandlers={{ tileerror: () => onError?.() }}
      />
      {geoNodes.map((node) => (
        <CircleMarker
          key={node.id}
          center={[node.location!.lat, node.location!.lng]}
          radius={node.deviceType === 'BTS' ? 14 : 9}
          pathOptions={{
            color: node.id === highlightedId ? '#60a5fa' : HEALTH_COLOR[node.health],
            fillColor: node.id === highlightedId ? '#60a5fa' : '#0d1b2a',
            fillOpacity: 0.9,
            weight: node.id === highlightedId ? 4 : 2,
          }}
          eventHandlers={{ click: () => onNodeClick(node) }}
        >
          <Tooltip>
            <div style={{ fontFamily: 'monospace', fontSize: 12 }}>
              <strong>{node.deviceType} — {node.deviceId}</strong><br />
              Serial: {node.serialNumber}<br />
              IP: {node.ipAddress}<br />
              RSSI: {node.rssi ?? '—'} dBm<br />
              SNR: {node.snr ?? '—'} dB<br />
              Health: {node.health}
            </div>
          </Tooltip>
        </CircleMarker>
      ))}
    </MapContainer>
  );
}
