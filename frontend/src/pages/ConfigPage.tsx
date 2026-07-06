import React, { useEffect, useRef, useState } from 'react';
import type { ConfigTemplate, ConfigJob, ConfigVersion, ConfigCategory } from '../api/config.types';
import { CONFIG_PARAMS, validateTemplate } from '../api/config.types';
import {
  bulkPush, createTemplate, deleteTemplate, fetchTemplates,
  getJobStatus, getVersionHistory, pushConfig, updateTemplate,
} from '../api/config.api';

type Tab = 'templates' | 'push' | 'bulk' | 'history';

const TABS: { id: Tab; label: string }[] = [
  { id: 'templates', label: 'Templates' },
  { id: 'push', label: 'Push Config' },
  { id: 'bulk', label: 'Bulk Operations' },
  { id: 'history', label: 'Version History' },
];

export default function ConfigPage(): React.ReactElement {
  const [activeTab, setActiveTab] = useState<Tab>('templates');
  const [templates, setTemplates] = useState<ConfigTemplate[]>([]);
  const [editingTemplate, setEditingTemplate] = useState<ConfigTemplate | null>(null);
  const [formErrors, setFormErrors] = useState<string[]>([]);

  // Push state
  const [pushDeviceId, setPushDeviceId] = useState('');
  const [pushTemplateId, setPushTemplateId] = useState('');
  const [pushStatus, setPushStatus] = useState<string>('');

  // Bulk state
  const [bulkNetworkId, setBulkNetworkId] = useState('');
  const [bulkTemplateId, setBulkTemplateId] = useState('');
  const [currentJob, setCurrentJob] = useState<ConfigJob | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // History state
  const [historyDeviceId, setHistoryDeviceId] = useState('');
  const [versions, setVersions] = useState<ConfigVersion[]>([]);

  useEffect(() => {
    fetchTemplates().then(setTemplates).catch(() => {});
  }, []);

  // ── Templates ────────────────────────────────────────────────

  const handleSaveTemplate = async () => {
    if (!editingTemplate) return;
    const errors = validateTemplate(editingTemplate.parameters);
    if (errors.length > 0) { setFormErrors(errors); return; }
    setFormErrors([]);
    if (editingTemplate.id) {
      const updated = await updateTemplate(editingTemplate.id, editingTemplate);
      setTemplates((prev) => prev.map((t) => t.id === updated.id ? updated : t));
    } else {
      const created = await createTemplate(editingTemplate);
      setTemplates((prev) => [...prev, created]);
    }
    setEditingTemplate(null);
  };

  const handleDeleteTemplate = async (id: string) => {
    await deleteTemplate(id);
    setTemplates((prev) => prev.filter((t) => t.id !== id));
  };

  // ── Push ──────────────────────────────────────────────────────

  const handlePush = async () => {
    if (!pushDeviceId || !pushTemplateId) return;
    const result = await pushConfig(pushDeviceId, pushTemplateId);
    if (result.status === 'DEVICE_OFFLINE' || result.status === 'REJECTED') {
      setPushStatus(`⛔ Device offline — command not queued: ${result.message}`);
    } else {
      setPushStatus(`✅ ${result.status}: ${result.message}`);
    }
  };

  // ── Bulk ──────────────────────────────────────────────────────

  const handleBulkPush = async () => {
    if (!bulkTemplateId) return;
    const job = await bulkPush({ networkId: bulkNetworkId }, bulkTemplateId);
    setCurrentJob(job);
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      const updated = await getJobStatus(job.jobId);
      setCurrentJob(updated);
      if (updated.status === 'COMPLETED' || updated.status === 'FAILED') {
        clearInterval(pollRef.current!);
      }
    }, 3000);
  };

  // ── History ───────────────────────────────────────────────────

  const handleLoadHistory = async () => {
    const hist = await getVersionHistory(historyDeviceId);
    setVersions(hist);
  };

  const tabBtn = (id: Tab): React.CSSProperties => ({
    background: activeTab === id ? '#1e3a5f' : 'none',
    border: `1px solid ${activeTab === id ? '#60a5fa' : '#374151'}`,
    color: activeTab === id ? '#60a5fa' : '#64748b',
    padding: '6px 16px', borderRadius: 4, cursor: 'pointer', fontSize: 13,
  });
  const input: React.CSSProperties = {
    background: '#0f172a', border: '1px solid #1e3a5f', borderRadius: 4,
    color: '#e2e8f0', padding: '6px 10px', fontSize: 13, width: '100%', boxSizing: 'border-box',
  };
  const label: React.CSSProperties = { color: '#94a3b8', fontSize: 12, display: 'block', marginBottom: 4 };

  return (
    <div>
      <h2 style={{ color: '#e2e8f0', marginBottom: 16 }}>Configuration Management</h2>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 20 }}>
        {TABS.map((tab) => (
          <button key={tab.id} style={tabBtn(tab.id)} onClick={() => setActiveTab(tab.id)}>{tab.label}</button>
        ))}
      </div>

      {/* ── Templates Tab ────────────────────────────────────── */}
      {activeTab === 'templates' && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
            <button
              onClick={() => setEditingTemplate({ name: '', isDefault: false, parameters: {} })}
              style={{ background: '#1e3a5f', border: 'none', color: '#60a5fa', padding: '7px 16px', borderRadius: 4, cursor: 'pointer', fontSize: 13 }}
            >
              + New Template
            </button>
          </div>

          {/* Template list */}
          <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 20 }}>
            <thead>
              <tr>
                {['Name', 'Default', 'Parameters', 'Created', ''].map((h) => (
                  <th key={h} style={{ padding: '8px 12px', background: '#0f172a', color: '#64748b', fontSize: 12, textAlign: 'left', borderBottom: '1px solid #1e293b' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {templates.map((t) => (
                <tr key={t.id} style={{ background: '#0d1b2a' }}>
                  <td style={{ padding: '8px 12px', color: '#e2e8f0', fontSize: 13 }}>{t.name}</td>
                  <td style={{ padding: '8px 12px' }}>
                    {t.isDefault && <span style={{ background: '#14532d', color: '#86efac', padding: '2px 8px', borderRadius: 4, fontSize: 11 }}>Default</span>}
                  </td>
                  <td style={{ padding: '8px 12px', color: '#64748b', fontSize: 12 }}>{Object.keys(t.parameters).length} params</td>
                  <td style={{ padding: '8px 12px', color: '#475569', fontSize: 12 }}>{t.createdAt ? new Date(t.createdAt).toLocaleDateString() : '—'}</td>
                  <td style={{ padding: '8px 12px' }}>
                    <div style={{ display: 'flex', gap: 4 }}>
                      <button onClick={() => setEditingTemplate(t)} style={{ background: 'none', border: '1px solid #374151', color: '#60a5fa', padding: '3px 10px', borderRadius: 4, cursor: 'pointer', fontSize: 12 }}>Edit</button>
                      <button onClick={() => t.id && handleDeleteTemplate(t.id)} style={{ background: 'none', border: '1px solid #374151', color: '#f87171', padding: '3px 10px', borderRadius: 4, cursor: 'pointer', fontSize: 12 }}>Delete</button>
                    </div>
                  </td>
                </tr>
              ))}
              {templates.length === 0 && (
                <tr><td colSpan={5} style={{ padding: '32px', textAlign: 'center', color: '#475569', fontSize: 13 }}>No templates. Create one to get started.</td></tr>
              )}
            </tbody>
          </table>

          {/* Editor */}
          {editingTemplate && (
            <div style={{ background: '#0d1b2a', border: '1px solid #1e293b', borderRadius: 8, padding: 20 }}>
              <h3 style={{ color: '#e2e8f0', marginTop: 0 }}>{editingTemplate.id ? 'Edit' : 'New'} Template</h3>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
                <div>
                  <label style={label}>Name *</label>
                  <input style={input} value={editingTemplate.name}
                    onChange={(e) => setEditingTemplate((t) => t ? ({ ...t, name: e.target.value }) : t)} />
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingTop: 20 }}>
                  <input type="checkbox" checked={editingTemplate.isDefault}
                    onChange={(e) => setEditingTemplate((t) => t ? ({ ...t, isDefault: e.target.checked }) : t)} />
                  <label style={{ color: '#94a3b8', fontSize: 13 }}>Set as default</label>
                </div>
              </div>

              {/* Parameter categories */}
              {(Object.entries(CONFIG_PARAMS) as [ConfigCategory, readonly string[]][]).map(([cat, params]) => (
                <div key={cat} style={{ marginBottom: 16 }}>
                  <div style={{ color: '#60a5fa', fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>{cat}</div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 8 }}>
                    {params.map((p) => (
                      <div key={p}>
                        <label style={label}>{p}</label>
                        <input
                          style={input}
                          value={String(editingTemplate.parameters[p] ?? '')}
                          onChange={(e) => setEditingTemplate((t) => t ? ({
                            ...t,
                            parameters: { ...t.parameters, [p]: e.target.value },
                          }) : t)}
                          placeholder="leave blank to skip"
                        />
                      </div>
                    ))}
                  </div>
                </div>
              ))}

              {formErrors.length > 0 && (
                <div style={{ background: '#7f1d1d', borderRadius: 6, padding: 12, marginBottom: 12 }}>
                  {formErrors.map((e) => <div key={e} style={{ color: '#fca5a5', fontSize: 13 }}>{e}</div>)}
                </div>
              )}
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={handleSaveTemplate} style={{ background: '#1e3a5f', border: 'none', color: '#60a5fa', padding: '8px 20px', borderRadius: 4, cursor: 'pointer', fontSize: 13 }}>Save</button>
                <button onClick={() => { setEditingTemplate(null); setFormErrors([]); }} style={{ background: 'none', border: '1px solid #374151', color: '#9ca3af', padding: '8px 16px', borderRadius: 4, cursor: 'pointer', fontSize: 13 }}>Cancel</button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Push Config Tab ───────────────────────────────────── */}
      {activeTab === 'push' && (
        <div style={{ background: '#0d1b2a', border: '1px solid #1e293b', borderRadius: 8, padding: 20 }}>
          <h3 style={{ color: '#e2e8f0', marginTop: 0 }}>Push Configuration to Device</h3>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
            <div>
              <label style={label}>Device ID *</label>
              <input style={input} value={pushDeviceId} onChange={(e) => setPushDeviceId(e.target.value)} placeholder="CPE-001" />
            </div>
            <div>
              <label style={label}>Template *</label>
              <select style={input} value={pushTemplateId} onChange={(e) => setPushTemplateId(e.target.value)}>
                <option value="">Select template…</option>
                {templates.map((t) => <option key={t.id} value={t.id!}>{t.name}</option>)}
              </select>
            </div>
          </div>
          <button
            onClick={handlePush}
            disabled={!pushDeviceId || !pushTemplateId}
            style={{ background: '#1e3a5f', border: 'none', color: '#60a5fa', padding: '8px 24px', borderRadius: 4, cursor: 'pointer', fontSize: 13 }}
          >
            Push Config
          </button>
          {pushStatus && (
            <div style={{
              marginTop: 12, padding: 12, borderRadius: 6,
              background: pushStatus.startsWith('✅') ? '#14532d' : '#7f1d1d',
              color: pushStatus.startsWith('✅') ? '#86efac' : '#fca5a5',
              fontSize: 13,
            }}>
              {pushStatus}
            </div>
          )}
        </div>
      )}

      {/* ── Bulk Operations Tab ───────────────────────────────── */}
      {activeTab === 'bulk' && (
        <div style={{ background: '#0d1b2a', border: '1px solid #1e293b', borderRadius: 8, padding: 20 }}>
          <h3 style={{ color: '#e2e8f0', marginTop: 0 }}>Bulk Configuration Push</h3>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
            <div>
              <label style={label}>Network ID</label>
              <input style={input} value={bulkNetworkId} onChange={(e) => setBulkNetworkId(e.target.value)} placeholder="net-1" />
            </div>
            <div>
              <label style={label}>Template *</label>
              <select style={input} value={bulkTemplateId} onChange={(e) => setBulkTemplateId(e.target.value)}>
                <option value="">Select template…</option>
                {templates.map((t) => <option key={t.id} value={t.id!}>{t.name}</option>)}
              </select>
            </div>
          </div>
          <div style={{ color: '#94a3b8', fontSize: 12, marginBottom: 12 }}>
            Note: offline devices will be queued with 72-hour TTL.
          </div>
          <button
            onClick={handleBulkPush}
            disabled={!bulkTemplateId}
            style={{ background: '#1e3a5f', border: 'none', color: '#60a5fa', padding: '8px 24px', borderRadius: 4, cursor: 'pointer', fontSize: 13 }}
          >
            Start Bulk Push
          </button>

          {currentJob && (
            <div style={{ marginTop: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', color: '#94a3b8', fontSize: 13, marginBottom: 6 }}>
                <span>Job: {currentJob.jobId}</span>
                <span style={{ color: currentJob.status === 'COMPLETED' ? '#86efac' : '#60a5fa' }}>{currentJob.status}</span>
              </div>
              <div style={{ background: '#0f172a', borderRadius: 4, height: 8, overflow: 'hidden' }}>
                <div style={{ background: '#2563eb', height: '100%', width: `${currentJob.progressPercent}%`, transition: 'width 0.5s' }} />
              </div>
              <div style={{ display: 'flex', gap: 16, marginTop: 8, fontSize: 12, color: '#64748b' }}>
                <span style={{ color: '#86efac' }}>✓ {currentJob.successCount}</span>
                <span style={{ color: '#f87171' }}>✗ {currentJob.failureCount}</span>
                <span style={{ color: '#fcd34d' }}>⏳ {currentJob.pendingCount}</span>
                <span>of {currentJob.totalDevices}</span>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Version History Tab ───────────────────────────────── */}
      {activeTab === 'history' && (
        <div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
            <input
              style={{ ...input, width: 200 }}
              value={historyDeviceId}
              onChange={(e) => setHistoryDeviceId(e.target.value)}
              placeholder="Device ID"
            />
            <button
              onClick={handleLoadHistory}
              style={{ background: '#1e3a5f', border: 'none', color: '#60a5fa', padding: '7px 16px', borderRadius: 4, cursor: 'pointer', fontSize: 13 }}
            >
              Load History
            </button>
          </div>

          {versions.map((v) => (
            <div key={v.id} style={{ background: '#0d1b2a', border: '1px solid #1e293b', borderRadius: 8, padding: 16, marginBottom: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10 }}>
                <span style={{ color: '#60a5fa', fontWeight: 600 }}>Version {v.versionNumber}</span>
                <span style={{ color: '#475569', fontSize: 12 }}>{new Date(v.appliedAt).toLocaleString()} — {v.actor}</span>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                {v.previousValues && (
                  <div>
                    <div style={{ color: '#f87171', fontSize: 11, marginBottom: 6 }}>Previous</div>
                    {Object.entries(v.previousValues).map(([k, val]) => (
                      <div key={k} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#94a3b8', padding: '2px 0' }}>
                        <span>{k}</span><span style={{ fontFamily: 'monospace', color: '#f87171' }}>{String(val)}</span>
                      </div>
                    ))}
                  </div>
                )}
                <div>
                  <div style={{ color: '#86efac', fontSize: 11, marginBottom: 6 }}>New</div>
                  {Object.entries(v.newValues).map(([k, val]) => (
                    <div key={k} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#94a3b8', padding: '2px 0' }}>
                      <span>{k}</span><span style={{ fontFamily: 'monospace', color: '#86efac' }}>{String(val)}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ))}
          {versions.length === 0 && historyDeviceId && <div style={{ color: '#475569', fontSize: 13 }}>No history found for {historyDeviceId}</div>}
        </div>
      )}
    </div>
  );
}
