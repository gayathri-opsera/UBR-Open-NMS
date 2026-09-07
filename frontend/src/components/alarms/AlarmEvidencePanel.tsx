// WO-061: Surface Alarm Evidence Workflow
import React, { useState, useEffect } from 'react';

interface AlarmEvidenceProps {
  alarmId: string;
}

export const AlarmEvidencePanel: React.FC<AlarmEvidenceProps> = ({ alarmId }) => {
  const [evidence, setEvidence] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchEvidence();
  }, [alarmId]);

  const fetchEvidence = async () => {
    try {
      const response = await fetch(`/api/v1/alarms/${alarmId}/evidence`);
      const data = await response.json();
      setEvidence(data);
    } finally {
      setLoading(false);
    }
  };

  const exportEvidence = async () => {
    const response = await fetch(`/api/v1/alarms/${alarmId}/evidence/export`);
    const blob = await response.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `alarm-${alarmId}-evidence.zip`;
    a.click();
  };

  if (loading) return <div>Loading evidence...</div>;
  if (!evidence) return <div>No evidence available</div>;

  return (
    <div className="alarm-evidence-panel">
      <h3>Alarm Evidence</h3>

      <section>
        <h4>Related KPI Breaches</h4>
        <ul>
          {evidence.kpiBreaches?.map((breach: any, idx: number) => (
            <li key={idx}>
              {breach.metricName}: {breach.value} at {breach.timestamp}
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h4>Topology State</h4>
        <p>Affected devices: {evidence.topologyState?.affectedDevices?.length || 0}</p>
      </section>

      <section>
        <h4>Audit Events</h4>
        <ul>
          {evidence.auditEvents?.map((event: any, idx: number) => (
            <li key={idx}>
              {event.action} at {event.timestamp}
            </li>
          ))}
        </ul>
      </section>

      <button onClick={exportEvidence}>Export Evidence Package</button>
    </div>
  );
};

export default AlarmEvidencePanel;
