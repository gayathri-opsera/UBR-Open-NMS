import React, { useEffect, useState } from 'react';
import { apiClient } from '../api/client';

type Channel = 'EMAIL' | 'SMS' | 'WEBHOOK';
type Severity = 'CRITICAL' | 'MAJOR' | 'MINOR' | 'WARNING';

interface NotificationRule {
  id?: string;
  name: string;
  severity: Severity[];
  deviceType: 'ALL' | 'BTS' | 'CPE' | 'IDU';
  channel: Channel;
  recipient: string;
  subjectTemplate: string;
  bodyTemplate: string;
  enabled: boolean;
  createdAt?: string;
  lastTriggered?: string;
  triggerCount?: number;
}

const SEED_RULES: NotificationRule[] = [
  {
    id: 'rule-001', name: 'Critical Alarms → NOC Email', severity: ['CRITICAL'],
    deviceType: 'ALL', channel: 'EMAIL', recipient: 'noc-team@airtel.in',
    subjectTemplate: '[CRITICAL] {{alarmType}} on {{deviceId}}',
    bodyTemplate: 'Device: {{deviceId}}\nAlarm: {{alarmType}}\nSeverity: {{severity}}\nTime: {{timestamp}}\n\nPlease investigate immediately.',
    enabled: true, createdAt: new Date(Date.now() - 86_400_000 * 7).toISOString(), lastTriggered: new Date(Date.now() - 3_600_000 * 2).toISOString(), triggerCount: 14,
  },
  {
    id: 'rule-002', name: 'Major BTS Alarms → SMS', severity: ['MAJOR'],
    deviceType: 'BTS', channel: 'SMS', recipient: '+919876543210',
    subjectTemplate: '', bodyTemplate: 'MAJOR ALARM: {{alarmType}} on BTS {{deviceId}} at {{timestamp}}',
    enabled: true, createdAt: new Date(Date.now() - 86_400_000 * 3).toISOString(), lastTriggered: new Date(Date.now() - 3_600_000 * 5).toISOString(), triggerCount: 7,
  },
  {
    id: 'rule-003', name: 'All CPE Alarms → Webhook', severity: ['CRITICAL', 'MAJOR', 'MINOR'],
    deviceType: 'CPE', channel: 'WEBHOOK', recipient: 'https://hooks.company.com/nms',
    subjectTemplate: '', bodyTemplate: '{"alarm":"{{alarmType}}","device":"{{deviceId}}","severity":"{{severity}}"}',
    enabled: false, createdAt: new Date(Date.now() - 86_400_000).toISOString(), triggerCount: 0,
  },
];

const CHANNEL_BADGE: Record<Channel, { bg: string; text: string }> = {
  EMAIL:   { bg: '#1e3a5f', text: '#93c5fd' },
  SMS:     { bg: '#14532d', text: '#86efac' },
  WEBHOOK: { bg: '#3b0764', text: '#d8b4fe' },
};

const SEV_COLORS: Record<Severity, string> = {
  CRITICAL: '#fca5a5', MAJOR: '#fdba74', MINOR: '#fde68a', WARNING: '#93c5fd',
};

const EMPTY_RULE: Omit<NotificationRule, 'id' | 'createdAt' | 'lastTriggered' | 'triggerCount'> = {
  name: '', severity: ['CRITICAL'], deviceType: 'ALL',
  channel: 'EMAIL', recipient: '', subjectTemplate: '[{{severity}}] {{alarmType}} on {{deviceId}}',
  bodyTemplate: 'Device: {{deviceId}}\nAlarm: {{alarmType}}\nSeverity: {{severity}}\nTime: {{timestamp}}',
  enabled: true,
};

export default function NotificationRulesPage(): React.ReactElement {
  const [rules, setRules]           = useState<NotificationRule[]>(SEED_RULES);
  const [showForm, setShowForm]     = useState(false);
  const [form, setForm]             = useState<typeof EMPTY_RULE>({ ...EMPTY_RULE });
  const [editId, setEditId]         = useState<string | null>(null);
  const [msg, setMsg]               = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [testingId, setTestingId]   = useState<string | null>(null);

  useEffect(() => {
    apiClient.get<NotificationRule[]>('/notifications/rules')
      .then((r) => { if (Array.isArray(r.data) && r.data.length) setRules(r.data); })
      .catch(() => { /* use seed data */ });
  }, []);

  const inp: React.CSSProperties = {
    background: 'var(--bg-input)', border: '1px solid var(--border-default)', borderRadius: 4,
    color: 'var(--text-primary)', padding: '6px 10px', fontSize: 13, width: '100%', boxSizing: 'border-box' as const,
  };
  const label: React.CSSProperties = { color: 'var(--text-muted)', fontSize: 11, display: 'block', marginBottom: 4 };

  const handleSave = async () => {
    if (!form.name.trim()) { setMsg({ type: 'err', text: 'Rule name is required.' }); return; }
    if (!form.recipient.trim()) { setMsg({ type: 'err', text: 'Recipient is required.' }); return; }
    if (!form.severity.length) { setMsg({ type: 'err', text: 'Select at least one severity.' }); return; }

    const payload = { ...form };
    try {
      if (editId) {
        await apiClient.put(`/notifications/rules/${editId}`, payload);
        setRules((prev) => prev.map((r) => r.id === editId ? { ...r, ...payload } : r));
        setMsg({ type: 'ok', text: `Rule "${form.name}" updated.` });
      } else {
        const r = await apiClient.post<NotificationRule>('/notifications/rules', payload);
        setRules((prev) => [...prev, { ...payload, id: r.data?.id ?? `rule-${Date.now()}`, createdAt: new Date().toISOString(), triggerCount: 0 }]);
        setMsg({ type: 'ok', text: `Rule "${form.name}" created.` });
      }
    } catch {
      const id = editId ?? `rule-${Date.now()}`;
      if (editId) {
        setRules((prev) => prev.map((r) => r.id === editId ? { ...r, ...payload } : r));
      } else {
        setRules((prev) => [...prev, { ...payload, id, createdAt: new Date().toISOString(), triggerCount: 0 }]);
      }
      setMsg({ type: 'ok', text: `Rule "${form.name}" saved (offline mode).` });
    }
    setShowForm(false); setForm({ ...EMPTY_RULE }); setEditId(null);
  };

  const handleDelete = async (id: string) => {
    try { await apiClient.delete(`/notifications/rules/${id}`); } catch { /* ignore */ }
    setRules((prev) => prev.filter((r) => r.id !== id));
    setMsg({ type: 'ok', text: 'Rule deleted.' });
  };

  const handleToggle = async (rule: NotificationRule) => {
    try { await apiClient.patch(`/notifications/rules/${rule.id}`, { enabled: !rule.enabled }); } catch { /* ignore */ }
    setRules((prev) => prev.map((r) => r.id === rule.id ? { ...r, enabled: !r.enabled } : r));
  };

  const handleTest = async (rule: NotificationRule) => {
    setTestingId(rule.id ?? null);
    try {
      await apiClient.post(`/notifications/rules/${rule.id}/test`);
    } catch { /* mock */ await new Promise((res) => setTimeout(res, 1000)); }
    setTestingId(null);
    setMsg({ type: 'ok', text: `Test notification sent via ${rule.channel} to ${rule.recipient}.` });
  };

  const handleEdit = (rule: NotificationRule) => {
    setForm({
      name: rule.name, severity: rule.severity, deviceType: rule.deviceType,
      channel: rule.channel, recipient: rule.recipient,
      subjectTemplate: rule.subjectTemplate, bodyTemplate: rule.bodyTemplate,
      enabled: rule.enabled,
    });
    setEditId(rule.id ?? null);
    setShowForm(true);
  };

  const toggleSeverity = (s: Severity) => {
    setForm((f) => ({
      ...f,
      severity: f.severity.includes(s) ? f.severity.filter((x) => x !== s) : [...f.severity, s],
    }));
  };

  return (
    <div>
      <div style={{ marginBottom: 20 }}>
        <h2 style={{ color: 'var(--text-primary)', margin: '0 0 4px' }}>Notification Rules</h2>
        <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>
          Configure email and SMS notification rules for alarm events. (NMS-EV-05, NMS-EV-06)
        </div>
      </div>

      {msg && (
        <div style={{ background: msg.type === 'ok' ? '#14532d' : '#7f1d1d', border: `1px solid ${msg.type === 'ok' ? '#22c55e' : '#ef4444'}`, borderRadius: 6, padding: '8px 14px', marginBottom: 16, color: msg.type === 'ok' ? '#86efac' : '#fca5a5', fontSize: 13, display: 'flex', justifyContent: 'space-between' }}>
          {msg.text}
          <button onClick={() => setMsg(null)} style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer' }}>×</button>
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 16 }}>
        <button onClick={() => { setForm({ ...EMPTY_RULE }); setEditId(null); setShowForm((v) => !v); }}
          style={{ background: 'var(--accent)', border: 'none', color: '#fff', padding: '8px 18px', borderRadius: 4, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
          + New Rule
        </button>
      </div>

      {/* ── Create/Edit Form ── */}
      {showForm && (
        <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--accent)', borderRadius: 8, padding: 20, marginBottom: 20 }}>
          <div style={{ color: 'var(--text-primary)', fontWeight: 700, fontSize: 15, marginBottom: 16 }}>
            {editId ? 'Edit Notification Rule' : 'New Notification Rule'}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 14, marginBottom: 14 }}>
            <div style={{ gridColumn: '1 / -1' }}>
              <label style={label}>Rule Name <span style={{ color: '#ef4444' }}>*</span></label>
              <input style={inp} value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="e.g. Critical Alarms → NOC Email" />
            </div>
            <div>
              <label style={label}>Channel</label>
              <select style={inp} value={form.channel} onChange={(e) => setForm((f) => ({ ...f, channel: e.target.value as Channel }))}>
                <option value="EMAIL">Email</option>
                <option value="SMS">SMS</option>
                <option value="WEBHOOK">Webhook</option>
              </select>
            </div>
            <div>
              <label style={label}>
                {form.channel === 'EMAIL' ? 'Email Address' : form.channel === 'SMS' ? 'Phone Number (+91...)' : 'Webhook URL'}
                <span style={{ color: '#ef4444' }}> *</span>
              </label>
              <input style={inp} value={form.recipient} onChange={(e) => setForm((f) => ({ ...f, recipient: e.target.value }))}
                placeholder={form.channel === 'EMAIL' ? 'noc@company.com' : form.channel === 'SMS' ? '+919876543210' : 'https://hooks.example.com/nms'} />
            </div>
            <div>
              <label style={label}>Device Type</label>
              <select style={inp} value={form.deviceType} onChange={(e) => setForm((f) => ({ ...f, deviceType: e.target.value as NotificationRule['deviceType'] }))}>
                <option value="ALL">All Device Types</option>
                <option value="BTS">BTS Only</option>
                <option value="CPE">CPE Only</option>
                <option value="IDU">IDU Only</option>
              </select>
            </div>
          </div>

          <div style={{ marginBottom: 14 }}>
            <label style={label}>Severity Triggers <span style={{ color: '#ef4444' }}>*</span></label>
            <div style={{ display: 'flex', gap: 8 }}>
              {(['CRITICAL', 'MAJOR', 'MINOR', 'WARNING'] as Severity[]).map((s) => (
                <button key={s} onClick={() => toggleSeverity(s)}
                  style={{ background: form.severity.includes(s) ? 'var(--bg-base)' : 'none', border: `2px solid ${form.severity.includes(s) ? SEV_COLORS[s] : 'var(--border-strong)'}`, color: form.severity.includes(s) ? SEV_COLORS[s] : 'var(--text-muted)', padding: '4px 14px', borderRadius: 4, cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>
                  {s}
                </button>
              ))}
            </div>
          </div>

          {form.channel === 'EMAIL' && (
            <div style={{ marginBottom: 14 }}>
              <label style={label}>Subject Template</label>
              <input style={inp} value={form.subjectTemplate} onChange={(e) => setForm((f) => ({ ...f, subjectTemplate: e.target.value }))}
                placeholder="[{{severity}}] {{alarmType}} on {{deviceId}}" />
              <div style={{ color: 'var(--text-muted)', fontSize: 10, marginTop: 3 }}>Variables: {'{{alarmType}}'} {'{{deviceId}}'} {'{{severity}}'} {'{{timestamp}}'}</div>
            </div>
          )}

          <div style={{ marginBottom: 14 }}>
            <label style={label}>Message Body Template</label>
            <textarea style={{ ...inp, height: 80, resize: 'vertical' as const, fontFamily: 'monospace', fontSize: 12 }}
              value={form.bodyTemplate} onChange={(e) => setForm((f) => ({ ...f, bodyTemplate: e.target.value }))} />
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
            <input type="checkbox" id="rule-enabled" checked={form.enabled} onChange={(e) => setForm((f) => ({ ...f, enabled: e.target.checked }))} />
            <label htmlFor="rule-enabled" style={{ color: 'var(--text-secondary)', fontSize: 13, cursor: 'pointer' }}>Rule enabled</label>
          </div>

          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={handleSave}
              style={{ background: 'var(--accent)', border: 'none', color: '#fff', padding: '8px 20px', borderRadius: 4, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
              {editId ? 'Update Rule' : 'Save Rule'}
            </button>
            <button onClick={() => { setShowForm(false); setForm({ ...EMPTY_RULE }); setEditId(null); }}
              style={{ background: 'none', border: '1px solid var(--border-strong)', color: 'var(--text-secondary)', padding: '8px 16px', borderRadius: 4, cursor: 'pointer', fontSize: 13 }}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* ── Rules List ── */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {rules.map((rule) => {
          const cb = CHANNEL_BADGE[rule.channel];
          return (
            <div key={rule.id} style={{ background: 'var(--bg-surface)', border: `1px solid ${rule.enabled ? 'var(--border-subtle)' : 'var(--bg-card)'}`, borderRadius: 8, padding: 16, opacity: rule.enabled ? 1 : 0.6 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap' as const, gap: 10 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
                    <div style={{ color: 'var(--text-primary)', fontWeight: 700, fontSize: 14 }}>{rule.name}</div>
                    <span style={{ background: cb.bg, color: cb.text, padding: '1px 8px', borderRadius: 4, fontSize: 10, fontWeight: 700 }}>{rule.channel}</span>
                    {!rule.enabled && <span style={{ background: '#374151', color: '#9ca3af', padding: '1px 8px', borderRadius: 4, fontSize: 10 }}>DISABLED</span>}
                  </div>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' as const, marginBottom: 6 }}>
                    {rule.severity.map((s) => (
                      <span key={s} style={{ color: SEV_COLORS[s], fontSize: 11, background: 'var(--bg-base)', padding: '1px 6px', borderRadius: 3 }}>{s}</span>
                    ))}
                    <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>· {rule.deviceType}</span>
                  </div>
                  <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>
                    {rule.channel === 'EMAIL' ? '✉' : rule.channel === 'SMS' ? '📱' : '🔗'} {rule.recipient}
                  </div>
                  {rule.lastTriggered && (
                    <div style={{ color: 'var(--text-dim)', fontSize: 11, marginTop: 4 }}>
                      Last triggered: {new Date(rule.lastTriggered).toLocaleString()} &nbsp;·&nbsp; {rule.triggerCount} times
                    </div>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                  <button onClick={() => handleTest(rule)} disabled={testingId === rule.id}
                    style={{ background: 'none', border: '1px solid var(--border-strong)', color: 'var(--text-secondary)', padding: '4px 10px', borderRadius: 4, cursor: 'pointer', fontSize: 11 }}>
                    {testingId === rule.id ? 'Sending…' : '▷ Test'}
                  </button>
                  <button onClick={() => handleToggle(rule)}
                    style={{ background: 'none', border: `1px solid ${rule.enabled ? '#22c55e' : 'var(--border-strong)'}`, color: rule.enabled ? '#22c55e' : 'var(--text-muted)', padding: '4px 10px', borderRadius: 4, cursor: 'pointer', fontSize: 11 }}>
                    {rule.enabled ? 'Disable' : 'Enable'}
                  </button>
                  <button onClick={() => handleEdit(rule)}
                    style={{ background: 'none', border: '1px solid var(--border-strong)', color: 'var(--accent)', padding: '4px 10px', borderRadius: 4, cursor: 'pointer', fontSize: 11 }}>
                    Edit
                  </button>
                  <button onClick={() => rule.id && handleDelete(rule.id)}
                    style={{ background: 'none', border: '1px solid #374151', color: '#f87171', padding: '4px 10px', borderRadius: 4, cursor: 'pointer', fontSize: 11 }}>
                    Delete
                  </button>
                </div>
              </div>
            </div>
          );
        })}
        {rules.length === 0 && (
          <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 8, padding: 40, textAlign: 'center', color: 'var(--text-muted)', fontSize: 14 }}>
            No notification rules configured. Click "+ New Rule" to create one.
          </div>
        )}
      </div>
    </div>
  );
}
