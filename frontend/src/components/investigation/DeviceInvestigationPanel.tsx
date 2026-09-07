/**
 * WO-047: Device Investigation Panel - unified context for KPI, topology, and alarms
 */
import React, { useEffect, useState } from 'react';
import {
  DeviceInvestigationContext,
  DeviceIdentity,
  InvestigationContextLoading,
  InvestigationContextError,
  normalizeDeviceIdentity,
} from '../../types/device-investigation-context';

interface DeviceInvestigationPanelProps {
  deviceId?: string;
  serialNumber?: string;
  onClose?: () => void;
}

export const DeviceInvestigationPanel: React.FC<DeviceInvestigationPanelProps> = ({
  deviceId,
  serialNumber,
  onClose,
}) => {
  const [context, setContext] = useState<DeviceInvestigationContext | null>(null);
  const [loading, setLoading] = useState<InvestigationContextLoading>({
    device: true,
    availability: true,
    alarms: true,
    kpi: true,
    topology: true,
  });
  const [errors, setErrors] = useState<InvestigationContextError[]>([]);

  useEffect(() => {
    if (!deviceId && !serialNumber) return;

    // Fetch investigation context from API
    fetchInvestigationContext();
  }, [deviceId, serialNumber]);

  const fetchInvestigationContext = async () => {
    try {
      const id = deviceId || serialNumber;
      const response = await fetch(`/api/v1/devices/${id}/investigation-context`);

      if (response.ok) {
        const data = await response.json();
        setContext(data);
        setLoading({
          device: false,
          availability: false,
          alarms: false,
          kpi: false,
          topology: false,
        });
      } else if (response.status === 404) {
        setErrors([{
          domain: 'device',
          message: 'Device not found or has been decommissioned',
          retryable: false,
        }]);
      } else {
        throw new Error(`HTTP ${response.status}`);
      }
    } catch (error) {
      // Handle partial context failure - try to load domains independently
      await fetchPartialContext();
    }
  };

  const fetchPartialContext = async () => {
    const partialErrors: InvestigationContextError[] = [];
    const id = deviceId || serialNumber;

    // Try to fetch each domain independently
    try {
      const deviceResp = await fetch(`/api/v1/devices/${id}`);
      if (deviceResp.ok) {
        const deviceData = await deviceResp.json();
        // Set partial context with device info only
        setContext((prev) => ({
          ...(prev || {
            device: normalizeDeviceIdentity(deviceData),
            availability: { status: 'UNKNOWN' },
            activeAlarms: [],
            recentKpiBreaches: [],
            topologyNeighbors: [],
            permittedActions: [],
            generatedAt: new Date().toISOString(),
          }),
          device: normalizeDeviceIdentity(deviceData),
        }));
        setLoading((prev) => ({ ...prev, device: false }));
      }
    } catch (err) {
      partialErrors.push({
        domain: 'device',
        message: 'Failed to load device information',
        retryable: true,
      });
    }

    setErrors(partialErrors);
  };

  const retryDomain = (domain: InvestigationContextError['domain']) => {
    // Implement retry logic for specific domain
    fetchPartialContext();
  };

  if (!deviceId && !serialNumber) {
    return <div>No device selected</div>;
  }

  if (loading.device) {
    return <div>Loading device investigation context...</div>;
  }

  if (errors.length > 0 && !context) {
    return (
      <div className="investigation-error">
        <h3>Failed to load device context</h3>
        {errors.map((err, idx) => (
          <div key={idx} className="error-item">
            <span>{err.domain}: {err.message}</span>
            {err.retryable && (
              <button onClick={() => retryDomain(err.domain)}>Retry</button>
            )}
          </div>
        ))}
      </div>
    );
  }

  if (!context) {
    return <div>No context available</div>;
  }

  return (
    <div className="device-investigation-panel">
      <div className="panel-header">
        <h2>Device Investigation: {context.device.displayName}</h2>
        {onClose && <button onClick={onClose}>Close</button>}
      </div>

      <div className="panel-content">
        {/* Device Identity */}
        <section className="device-identity">
          <h3>Device Identity</h3>
          <dl>
            <dt>Device ID:</dt>
            <dd>{context.device.deviceId}</dd>
            {context.device.serialNumber && (
              <>
                <dt>Serial Number:</dt>
                <dd>{context.device.serialNumber}</dd>
              </>
            )}
            {context.device.macAddress && (
              <>
                <dt>MAC Address:</dt>
                <dd>{context.device.macAddress}</dd>
              </>
            )}
            {context.device.deviceType && (
              <>
                <dt>Type:</dt>
                <dd>{context.device.deviceType}</dd>
              </>
            )}
          </dl>
        </section>

        {/* Availability State */}
        <section className="availability-state">
          <h3>Availability</h3>
          {loading.availability ? (
            <p>Loading...</p>
          ) : (
            <>
              <div className={`status-badge status-${context.availability.status.toLowerCase()}`}>
                {context.availability.status}
              </div>
              {context.availability.healthReason && (
                <p className="health-reason">{context.availability.healthReason}</p>
              )}
              {context.availability.lastSeen && (
                <p>Last seen: {new Date(context.availability.lastSeen).toLocaleString()}</p>
              )}
            </>
          )}
        </section>

        {/* Active Alarms */}
        <section className="active-alarms">
          <h3>Active Alarms ({context.activeAlarms.length})</h3>
          {loading.alarms ? (
            <p>Loading...</p>
          ) : context.activeAlarms.length > 0 ? (
            <ul>
              {context.activeAlarms.map((alarm) => (
                <li key={alarm.alarmId} className={`alarm-${alarm.severity.toLowerCase()}`}>
                  <strong>{alarm.severity}</strong>: {alarm.message}
                  <br />
                  <small>Raised: {new Date(alarm.raisedAt).toLocaleString()}</small>
                  {alarm.acknowledged && <span className="badge">Acknowledged</span>}
                </li>
              ))}
            </ul>
          ) : (
            <p>No active alarms</p>
          )}
        </section>

        {/* Recent KPI Breaches */}
        <section className="kpi-breaches">
          <h3>Recent KPI Breaches</h3>
          {loading.kpi ? (
            <p>Loading...</p>
          ) : context.recentKpiBreaches.length > 0 ? (
            <ul>
              {context.recentKpiBreaches.map((breach, idx) => (
                <li key={idx} className={`breach-${breach.severity.toLowerCase()}`}>
                  <strong>{breach.metricName}</strong>: {breach.actualValue} (threshold: {breach.thresholdValue})
                  <br />
                  <small>{new Date(breach.breachTime).toLocaleString()}</small>
                </li>
              ))}
            </ul>
          ) : (
            <p>No recent KPI breaches</p>
          )}
        </section>

        {/* Topology Neighbors */}
        <section className="topology-neighbors">
          <h3>Topology Neighbors ({context.topologyNeighbors.length})</h3>
          {loading.topology ? (
            <p>Loading...</p>
          ) : context.topologyNeighbors.length > 0 ? (
            <ul>
              {context.topologyNeighbors.map((neighbor) => (
                <li key={neighbor.deviceId}>
                  <strong>{neighbor.displayName}</strong> ({neighbor.relationship})
                  <br />
                  <span className={`link-status-${neighbor.linkStatus.toLowerCase()}`}>
                    Link: {neighbor.linkStatus}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p>No topology neighbors</p>
          )}
        </section>

        {/* Partial Failure Warnings */}
        {errors.length > 0 && (
          <section className="warnings">
            <h3>Partial Context Warnings</h3>
            {errors.map((err, idx) => (
              <div key={idx} className="warning-item">
                <span>{err.domain}: {err.message}</span>
                {err.retryable && (
                  <button onClick={() => retryDomain(err.domain)}>Retry</button>
                )}
              </div>
            ))}
          </section>
        )}
      </div>
    </div>
  );
};

export default DeviceInvestigationPanel;
