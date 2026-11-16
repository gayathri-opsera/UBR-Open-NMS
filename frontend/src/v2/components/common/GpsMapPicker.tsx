import { useEffect, useRef, useState } from 'react';
import 'leaflet/dist/leaflet.css';

// ── GPS Map Picker ─────────────────────────────────────────────────────────────
/**
 * Inline Leaflet map that lets the user click to pick GPS coordinates.
 * Uses a simple <iframe> to OpenStreetMap so no extra Leaflet setup is needed;
 * we layer a transparent overlay to capture click coordinates via the
 * projection formula instead of relying on Leaflet events.
 * We use a real Leaflet map created imperatively so we get accurate clicks.
 */
export function GpsMapPicker({ lat, lng, onPick }: {
  lat?: number;
  lng?: number;
  onPick(lat: number, lng: number): void;
}) {
  const [expanded, setExpanded] = useState(false);
  const mapRef = useRef<HTMLDivElement>(null);
  // Store the Leaflet map and marker instances across renders
  const mapInstanceRef = useRef<{ map: import('leaflet').Map; marker: import('leaflet').Marker | null } | null>(null);

  // Initialise Leaflet imperatively when the panel opens
  useEffect(() => {
    if (!expanded || !mapRef.current) return;

    // Dynamically import Leaflet so the bundle isn't bloated for users who never open this
    import('leaflet').then((mod) => {
      // Leaflet is CJS — the module IS the namespace, but Vite may wrap it
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const Lf = ((mod as any).default ?? mod) as typeof import('leaflet');
      if (!mapRef.current) return;

      // Clean up any previous map on the same element
      if (mapInstanceRef.current) {
        mapInstanceRef.current.map.remove();
        mapInstanceRef.current = null;
      }

      const centre: [number, number] = lat != null && lng != null ? [lat, lng] : [20.5937, 78.9629]; // India centre fallback
      const map = Lf.map(mapRef.current, { center: centre, zoom: lat != null ? 12 : 5, zoomControl: true });
      Lf.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap',
      }).addTo(map);

      const icon = Lf.divIcon({
        className: '',
        html: '<div style="width:14px;height:14px;background:#7c3aed;border:2px solid #fff;border-radius:50%;box-shadow:0 0 6px rgba(124,58,237,0.8)"></div>',
        iconAnchor: [7, 7],
      });

      let marker: import('leaflet').Marker | null = null;
      if (lat != null && lng != null) {
        marker = Lf.marker([lat, lng], { icon }).addTo(map);
      }

      map.on('click', (e: import('leaflet').LeafletMouseEvent) => {
        const { lat: clickLat, lng: clickLng } = e.latlng;
        if (marker) {
          marker.setLatLng([clickLat, clickLng]);
        } else {
          marker = Lf.marker([clickLat, clickLng], { icon }).addTo(map);
        }
        mapInstanceRef.current!.marker = marker;
        onPick(clickLat, clickLng);
      });

      mapInstanceRef.current = { map, marker };
    });

    return () => {
      if (mapInstanceRef.current) {
        mapInstanceRef.current.map.remove();
        mapInstanceRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded]);

  // Move marker when lat/lng inputs change
  useEffect(() => {
    if (!mapInstanceRef.current || lat == null || lng == null) return;
    const { map, marker } = mapInstanceRef.current;
    if (marker) {
      marker.setLatLng([lat, lng]);
    }
    map.setView([lat, lng], map.getZoom());
  }, [lat, lng]);

  return (
    <div>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        style={{
          display: 'flex', alignItems: 'center', gap: 6,
          background: 'none', border: '1px dashed var(--vf-border-default)',
          borderRadius: 6, padding: '7px 14px', cursor: 'pointer',
          color: 'var(--vf-accent)', fontSize: 13, width: '100%',
        }}>
        📍 {expanded ? 'Hide map picker' : 'Pick location from map'}
        {lat != null && lng != null && !expanded && (
          <span style={{ color: 'var(--vf-text-muted)', fontFamily: 'monospace', fontSize: 12 }}>
            ({lat.toFixed(4)}, {lng.toFixed(4)})
          </span>
        )}
      </button>
      {expanded && (
        <div style={{ marginTop: 8, borderRadius: 8, overflow: 'hidden', border: '1px solid var(--vf-border-subtle)', height: 280, position: 'relative' }}>
          <div style={{ position: 'absolute', top: 6, left: 8, zIndex: 1000, background: 'rgba(0,0,0,0.65)', color: '#fff', fontSize: 11, padding: '3px 8px', borderRadius: 4, pointerEvents: 'none' }}>
            Click map to set location
          </div>
          <div ref={mapRef} style={{ width: '100%', height: '100%' }} />
        </div>
      )}
    </div>
  );
}
