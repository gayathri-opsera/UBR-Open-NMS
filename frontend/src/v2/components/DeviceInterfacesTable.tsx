import type { CSSProperties } from 'react';
import type { DeviceInterface } from '../../api/devices.types';

const TH: CSSProperties = {
  padding: '8px 14px', textAlign: 'left', fontWeight: 700, fontSize: 10, textTransform: 'uppercase',
  letterSpacing: '0.06em', color: 'var(--vf-text-muted)', borderBottom: '1px solid var(--vf-border-subtle)',
};
const TD: CSSProperties = { padding: '8px 14px', fontSize: 12, color: 'var(--vf-text-primary)' };

const statusColor = (s?: string | null) =>
  s === 'up' ? '#22c55e' : s === 'down' ? '#ef4444' : 'var(--vf-text-muted)';

/**
 * Interfaces the device reported at discovery (IF-MIB). This is inventory data and is
 * independent of the product definition that drives the Node View parameters.
 */
export function DeviceInterfacesTable({ interfaces, collectedAt }: { interfaces: DeviceInterface[]; collectedAt?: string }) {
  if (!interfaces.length) return null;
  return (
    <div style={{ background: 'var(--vf-surface)', border: '1px solid var(--vf-border-subtle)', borderRadius: 12, overflow: 'hidden' }}>
      <div style={{ padding: '10px 16px', background: 'rgba(255,255,255,0.03)', borderBottom: '1px solid var(--vf-border-subtle)', fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'var(--vf-text-muted)', display: 'flex', alignItems: 'center', gap: 8 }}>
        Interfaces (discovered)
        <span style={{ marginLeft: 'auto', fontSize: 10, fontWeight: 500, textTransform: 'none', letterSpacing: 0 }}>
          {interfaces.length} interface{interfaces.length !== 1 ? 's' : ''}
          {collectedAt ? ` · collected ${new Date(collectedAt).toLocaleString()}` : ''}
        </span>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={TH}>#</th><th style={TH}>Name</th><th style={TH}>MAC address</th>
              <th style={TH}>Speed</th><th style={TH}>Admin</th><th style={TH}>Oper</th><th style={TH}>IP addresses</th>
            </tr>
          </thead>
          <tbody>
            {interfaces.map((i) => (
              <tr key={i.index} style={{ borderBottom: '1px solid var(--vf-border-subtle)' }}>
                <td style={{ ...TD, color: 'var(--vf-text-muted)' }}>{i.index}</td>
                <td style={{ ...TD, fontWeight: 600 }}>{i.name}</td>
                <td style={{ ...TD, fontFamily: 'var(--vf-font-mono)' }}>{i.macAddress || '—'}</td>
                <td style={TD}>{i.speedMbps ? `${i.speedMbps} Mbps` : '—'}</td>
                <td style={{ ...TD, color: statusColor(i.adminStatus) }}>{i.adminStatus || '—'}</td>
                <td style={{ ...TD, color: statusColor(i.operStatus) }}>{i.operStatus || '—'}</td>
                <td style={{ ...TD, fontFamily: 'var(--vf-font-mono)' }}>{i.ipAddresses?.length ? i.ipAddresses.join(', ') : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
