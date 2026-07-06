import React from 'react';

interface SkeletonProps {
  width?: string | number;
  height?: string | number;
  borderRadius?: number;
  style?: React.CSSProperties;
}

export function Skeleton({ width = '100%', height = 16, borderRadius = 4, style }: SkeletonProps): React.ReactElement {
  return (
    <div
      aria-hidden="true"
      style={{
        width,
        height,
        borderRadius,
        background: 'linear-gradient(90deg, #1e293b 25%, #0f2744 50%, #1e293b 75%)',
        backgroundSize: '200% 100%',
        animation: 'skeleton-shimmer 1.4s ease-in-out infinite',
        ...style,
      }}
    />
  );
}

export function SkeletonRow({ cols = 5, height = 36 }: { cols?: number; height?: number }): React.ReactElement {
  return (
    <tr aria-hidden="true">
      {Array.from({ length: cols }).map((_, i) => (
        <td key={i} style={{ padding: '8px 12px', borderBottom: '1px solid #0f172a' }}>
          <Skeleton height={height - 16} width={i === 0 ? 80 : i === cols - 1 ? 60 : '85%'} />
        </td>
      ))}
    </tr>
  );
}

export function SkeletonCard({ style }: { style?: React.CSSProperties }): React.ReactElement {
  return (
    <div style={{ background: '#0d1b2a', border: '1px solid #1e293b', borderRadius: 8, padding: 20, ...style }}>
      <Skeleton height={12} width="50%" style={{ marginBottom: 12 }} />
      <Skeleton height={28} width="65%" style={{ marginBottom: 8 }} />
      <Skeleton height={10} width="40%" />
    </div>
  );
}
