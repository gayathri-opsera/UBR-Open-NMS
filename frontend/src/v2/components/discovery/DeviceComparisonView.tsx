/**
 * DeviceComparisonView — side-by-side property comparison for 2–4 selected devices (WO-030).
 */
import { Button } from '../common/Button';
import { Modal } from '../common/Modal';
import type { DiscoveryResult } from '../../../api/discovery.api';

export interface ComparisonProperty {
  key: keyof DiscoveryResult | 'sysUpTimeSeconds';
  label: string;
  format?: (row: DiscoveryResult) => string;
}

export const COMPARISON_PROPERTIES: ComparisonProperty[] = [
  { key: 'ip', label: 'IP Address' },
  { key: 'vendor', label: 'Vendor' },
  { key: 'model', label: 'Model' },
  { key: 'genericDeviceType', label: 'Device Type' },
  { key: 'sysObjectID', label: 'sysObjectID' },
  { key: 'sysDescr', label: 'sysDescr' },
  { key: 'sysName', label: 'sysName (hostname)' },
  { key: 'sysContact', label: 'sysContact' },
  { key: 'sysLocation', label: 'sysLocation' },
  {
    key: 'sysUpTimeSeconds',
    label: 'sysUpTime',
    format: (r) => (r.sysUpTimeSeconds != null ? `${r.sysUpTimeSeconds}s` : 'N/A'),
  },
  { key: 'icmpStatus', label: 'ICMP Status' },
  { key: 'snmpStatus', label: 'SNMP Status' },
  { key: 'classificationStatus', label: 'Classification' },
];

function cellValue(row: DiscoveryResult, prop: ComparisonProperty): string {
  if (prop.format) return prop.format(row);
  const raw = row[prop.key as keyof DiscoveryResult];
  if (raw == null || raw === '') return 'N/A';
  return String(raw);
}

/** True when any compared device differs on this property. */
export function propertyDiffers(devices: DiscoveryResult[], prop: ComparisonProperty): boolean {
  const values = devices.map((d) => cellValue(d, prop));
  return new Set(values).size > 1;
}

export interface DeviceComparisonViewProps {
  devices: DiscoveryResult[];
  open: boolean;
  onClose: () => void;
  onAddToInventory?: (selected: DiscoveryResult[]) => void;
}

export function DeviceComparisonView({
  devices,
  open,
  onClose,
  onAddToInventory,
}: DeviceComparisonViewProps) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Compare ${devices.length} device${devices.length !== 1 ? 's' : ''}`}
      size="xl"
    >
      <div style={{ overflowX: 'auto' }}>
        <table
          style={{
            width: '100%',
            borderCollapse: 'collapse',
            fontSize: 13,
          }}
        >
          <thead>
            <tr>
              <th
                style={{
                  textAlign: 'left',
                  padding: '8px 12px',
                  borderBottom: '1px solid var(--vf-border-subtle)',
                  minWidth: 140,
                }}
              >
                Property
              </th>
              {devices.map((d) => (
                <th
                  key={d.ip}
                  style={{
                    textAlign: 'left',
                    padding: '8px 12px',
                    borderBottom: '1px solid var(--vf-border-subtle)',
                    fontFamily: 'var(--vf-font-mono)',
                    minWidth: 160,
                  }}
                >
                  {d.ip}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {COMPARISON_PROPERTIES.map((prop) => {
              const differs = propertyDiffers(devices, prop);
              return (
                <tr
                  key={prop.key}
                  style={{
                    background: differs ? 'var(--vf-warning-subtle)' : undefined,
                  }}
                >
                  <td
                    style={{
                      padding: '8px 12px',
                      fontWeight: 600,
                      borderBottom: '1px solid var(--vf-border-subtle)',
                      color: 'var(--vf-text-secondary)',
                    }}
                  >
                    {prop.label}
                  </td>
                  {devices.map((d) => (
                    <td
                      key={`${d.ip}-${String(prop.key)}`}
                      style={{
                        padding: '8px 12px',
                        borderBottom: '1px solid var(--vf-border-subtle)',
                        fontFamily: prop.key === 'sysObjectID' || prop.key === 'sysDescr'
                          ? 'var(--vf-font-mono)'
                          : undefined,
                        fontSize: prop.key === 'sysDescr' ? 11 : 13,
                        wordBreak: 'break-word',
                      }}
                    >
                      {cellValue(d, prop)}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div
        style={{
          display: 'flex',
          justifyContent: 'flex-end',
          gap: 10,
          marginTop: 20,
        }}
      >
        <Button variant="ghost" size="sm" onClick={onClose}>
          Close
        </Button>
        {onAddToInventory && (
          <Button variant="primary" size="sm" onClick={() => onAddToInventory(devices)}>
            Add Selected to Inventory
          </Button>
        )}
      </div>
    </Modal>
  );
}
