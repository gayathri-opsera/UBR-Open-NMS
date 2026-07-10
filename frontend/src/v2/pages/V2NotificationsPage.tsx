import { useEffect, useState } from 'react';
import { Badge } from '../components/common/Badge';
import { Button } from '../components/common/Button';
import { Input } from '../components/common/Input';
import { Select } from '../components/common/Select';
import { Modal } from '../components/common/Modal';
import { MetricCard } from '../components/common/MetricCard';
import { EmptyState, LoadingState } from '../components/common/States';
import { useToast } from '../components/common/Toast';
import { apiClient } from '../../api/client';
import { logger } from '../utils/logger';

interface NotificationRule {
  id: string;
  name: string;
  enabled: boolean;
  severity: string;
  alarmType?: string;
  channels: ('EMAIL' | 'WEBHOOK' | 'SMS')[];
  target: string;
  createdAt?: string;
}

const SEVERITY_OPTIONS = [
  { value: 'CRITICAL', label: 'Critical' },
  { value: 'MAJOR', label: 'Major' },
  { value: 'MINOR', label: 'Minor' },
  { value: 'WARNING', label: 'Warning' },
  { value: 'ANY', label: 'Any' },
];

const EMPTY_RULE: Partial<NotificationRule> = {
  name: '', enabled: true, severity: 'CRITICAL', channels: ['EMAIL'], target: '',
};

async function fetchRules(): Promise<NotificationRule[]> {
  try {
    const res = await apiClient.get<NotificationRule[]>('/notifications/rules');
    return Array.isArray(res.data) ? res.data : [];
  } catch {
    return [];
  }
}

async function saveRule(rule: Partial<NotificationRule>): Promise<NotificationRule> {
  if (rule.id) {
    const res = await apiClient.put<NotificationRule>(`/notifications/rules/${rule.id}`, rule);
    return res.data;
  }
  const res = await apiClient.post<NotificationRule>('/notifications/rules', rule);
  return res.data;
}

async function deleteRule(id: string): Promise<void> {
  await apiClient.delete(`/notifications/rules/${id}`);
}

export default function V2NotificationsPage() {
  const { addToast } = useToast();
  const [rules, setRules] = useState<NotificationRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [editRule, setEditRule] = useState<Partial<NotificationRule> | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [showDelete, setShowDelete] = useState<NotificationRule | null>(null);
  const [saving, setSaving] = useState(false);

  const load = () => {
    setLoading(true);
    fetchRules()
      .then(setRules)
      .catch((e) => { logger.error('Notification rules fetch failed', e); addToast('Failed to load notification rules', 'error'); })
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const openCreate = () => { setEditRule({ ...EMPTY_RULE }); setShowForm(true); };
  const openEdit = (r: NotificationRule) => { setEditRule({ ...r }); setShowForm(true); };

  const handleSave = async () => {
    if (!editRule?.name || !editRule.target) { addToast('Name and target are required', 'warning'); return; }
    setSaving(true);
    try {
      const saved = await saveRule(editRule);
      if (editRule.id) {
        setRules((r) => r.map((x) => x.id === saved.id ? saved : x));
      } else {
        setRules((r) => [...r, saved]);
      }
      addToast(editRule.id ? 'Rule updated' : 'Rule created', 'success');
      setShowForm(false);
    } catch (e) {
      logger.error('Rule save failed', e);
      addToast('Failed to save rule', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!showDelete) return;
    try {
      await deleteRule(showDelete.id);
      setRules((r) => r.filter((x) => x.id !== showDelete.id));
      addToast('Rule deleted', 'success');
    } catch {
      addToast('Failed to delete rule', 'error');
    } finally {
      setShowDelete(null);
    }
  };

  const handleToggle = async (rule: NotificationRule) => {
    try {
      const updated = await saveRule({ ...rule, enabled: !rule.enabled });
      setRules((r) => r.map((x) => x.id === updated.id ? updated : x));
    } catch {
      addToast('Failed to toggle rule', 'error');
    }
  };

  const visible = rules.filter((r) => !search || [r.name, r.severity, r.target].some((v) => v.toLowerCase().includes(search.toLowerCase())));
  const activeCount = rules.filter((r) => r.enabled).length;

  return (
    <div className="vf-page">
      <div className="vf-page-header">
        <h1 className="vf-page-title">Notifications</h1>
        <div className="vf-page-actions">
          <Button variant="primary" size="sm" onClick={openCreate}>+ New Rule</Button>
        </div>
      </div>

      {/* Stats */}
      <div className="vf-kpi-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))' }}>
        <MetricCard label="Total Rules" value={rules.length} loading={loading} />
        <MetricCard label="Active" value={activeCount} variant="success" loading={loading} />
        <MetricCard label="Disabled" value={rules.length - activeCount} loading={loading} />
      </div>

      {/* Search */}
      <div style={{ display: 'flex', gap: 8 }}>
        <Input placeholder="Search rules…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ width: 280 }} />
        <Button variant="ghost" size="sm" onClick={() => setSearch('')}>Clear</Button>
      </div>

      {/* Table */}
      {loading ? (
        <LoadingState label="Loading notification rules…" />
      ) : visible.length === 0 ? (
        <EmptyState
          title="No notification rules"
          description="Create rules to receive alerts when alarms are triggered."
          action={<Button onClick={openCreate}>Create Rule</Button>}
        />
      ) : (
        <div style={{ overflowX: 'auto', border: '1px solid var(--vf-border-subtle)', borderRadius: 'var(--vf-radius-md)' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--vf-font-sans)', fontSize: 13 }}>
            <thead>
              <tr style={{ background: 'var(--vf-surface)' }}>
                {['Name', 'Severity', 'Channels', 'Target', 'Status', ''].map((h) => (
                  <th key={h} style={{ padding: '10px 12px', textAlign: 'left', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--vf-text-muted)', borderBottom: '1px solid var(--vf-border-subtle)' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visible.map((rule) => (
                <tr key={rule.id} style={{ borderBottom: '1px solid var(--vf-border-subtle)' }}>
                  <td style={{ padding: '9px 12px', fontWeight: 600, color: 'var(--vf-text-primary)' }}>{rule.name}</td>
                  <td style={{ padding: '9px 12px' }}>
                    <Badge variant={rule.severity === 'CRITICAL' ? 'critical' : rule.severity === 'MAJOR' ? 'major' : rule.severity === 'MINOR' ? 'minor' : 'default'}>
                      {rule.severity}
                    </Badge>
                  </td>
                  <td style={{ padding: '9px 12px' }}>
                    <div style={{ display: 'flex', gap: 4 }}>
                      {rule.channels.map((c) => <Badge key={c} variant="accent">{c}</Badge>)}
                    </div>
                  </td>
                  <td style={{ padding: '9px 12px', color: 'var(--vf-text-secondary)', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{rule.target}</td>
                  <td style={{ padding: '9px 12px' }}>
                    <button
                      onClick={() => handleToggle(rule)}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
                      aria-label={rule.enabled ? 'Disable rule' : 'Enable rule'}
                    >
                      <Badge variant={rule.enabled ? 'success' : 'default'} dot>{rule.enabled ? 'Active' : 'Disabled'}</Badge>
                    </button>
                  </td>
                  <td style={{ padding: '9px 12px' }}>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <Button variant="ghost" size="sm" onClick={() => openEdit(rule)}>Edit</Button>
                      <Button variant="danger" size="sm" onClick={() => setShowDelete(rule)}>Delete</Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Create/Edit Modal */}
      <Modal
        open={showForm}
        onClose={() => setShowForm(false)}
        title={editRule?.id ? 'Edit Rule' : 'Create Notification Rule'}
        footer={
          <>
            <Button variant="ghost" onClick={() => setShowForm(false)}>Cancel</Button>
            <Button variant="primary" loading={saving} onClick={handleSave}>
              {editRule?.id ? 'Save Changes' : 'Create Rule'}
            </Button>
          </>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Input label="Rule Name" value={editRule?.name ?? ''} onChange={(e) => setEditRule((r) => r ? { ...r, name: e.target.value } : r)} fullWidth />
          <Select label="Minimum Severity" options={SEVERITY_OPTIONS} value={editRule?.severity ?? 'CRITICAL'} onChange={(e) => setEditRule((r) => r ? { ...r, severity: e.target.value } : r)} fullWidth />
          <Input label="Alarm Type (optional)" value={editRule?.alarmType ?? ''} onChange={(e) => setEditRule((r) => r ? { ...r, alarmType: e.target.value } : r)} hint="Leave blank to match all alarm types" fullWidth />
          <Input label="Target (email / webhook URL)" value={editRule?.target ?? ''} onChange={(e) => setEditRule((r) => r ? { ...r, target: e.target.value } : r)} fullWidth />
          <div>
            <label style={{ fontSize: 11, fontWeight: 700, color: 'var(--vf-text-secondary)', letterSpacing: '0.03em', display: 'block', marginBottom: 6 }}>Channels</label>
            <div style={{ display: 'flex', gap: 8 }}>
              {(['EMAIL', 'WEBHOOK', 'SMS'] as const).map((ch) => (
                <button
                  key={ch}
                  onClick={() => setEditRule((r) => {
                    if (!r) return r;
                    const channels = r.channels ?? [];
                    return { ...r, channels: channels.includes(ch) ? channels.filter((c) => c !== ch) : [...channels, ch] };
                  })}
                  style={{
                    padding: '5px 12px', borderRadius: 'var(--vf-radius-sm)', cursor: 'pointer',
                    background: editRule?.channels?.includes(ch) ? 'var(--vf-accent-subtle)' : 'var(--vf-elevated)',
                    color: editRule?.channels?.includes(ch) ? 'var(--vf-accent)' : 'var(--vf-text-muted)',
                    border: `1px solid ${editRule?.channels?.includes(ch) ? 'var(--vf-accent)' : 'var(--vf-border-subtle)'}`,
                    fontFamily: 'var(--vf-font-sans)', fontSize: 12, fontWeight: 600,
                  }}
                >
                  {ch}
                </button>
              ))}
            </div>
          </div>
        </div>
      </Modal>

      {/* Delete confirm */}
      <Modal open={!!showDelete} onClose={() => setShowDelete(null)} title="Delete Rule"
        footer={<><Button variant="ghost" onClick={() => setShowDelete(null)}>Cancel</Button><Button variant="danger" onClick={handleDelete}>Delete</Button></>}>
        <p style={{ color: 'var(--vf-text-primary)', fontSize: 14 }}>
          Delete rule <strong>{showDelete?.name}</strong>? This cannot be undone.
        </p>
      </Modal>
    </div>
  );
}
