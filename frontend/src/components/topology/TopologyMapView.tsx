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
        url="https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png"
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/">CARTO</a>'
        subdomains="abcd"
        maxZoom={19}
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
            <div style={{ fontFamily: 'monospace', fontSize: 12, lineHeight: 1.6 }}>
              <strong>{node.deviceType} — {node.serialNumber || node.deviceId}</strong><br />
              IP: {node.ipAddress}<br />
              RSSI: {node.rssi ?? '—'} dBm | SNR: {node.snr ?? '—'} dB<br />
              Health: <strong>{node.health}</strong><br />
              <span style={{ color: '#60a5fa', fontSize: 11 }}>🔗 Click to open device detail</span>
            </div>
          </Tooltip>
        </CircleMarker>
      ))}
    </MapContainer>
  );
}
