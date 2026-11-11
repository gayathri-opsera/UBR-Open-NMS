/**
 * V2DeviceTypesPage — Admin screen for Device Type Combinations (DT-02)
 *
 * Lets admins define and manage (model + role) combinations, each linked to
 * an optional Product Definition (configuration) and Node View descriptor.
 * Also shows the full audit log of device type changes (DT-10).
 */
import { useCallback, useEffect, useState } from 'react';
import {
  listCombinations, createCombination, updateCombination, deleteCombination, fetchAuditLog,
  type DeviceTypeCombination, type DeviceTypeAuditEntry,
} from '../../api/deviceTypeCombinations.api';
import { useToast } from '../components/common/Toast';
import { Button } from '../components/common/Button';
import { Modal } from '../components/common/Modal';

// ── Role suggestions ──────────────────────────────────────────────────────────
const COMMON_ROLES = ['BTS', 'CPE', 'IDU', 'RADIO', 'SWITCH', 'ROUTER', 'GATEWAY', 'FIREWALL', 'AP', 'OLT', 'ONU', 'SERVER', 'UNKNOWN'];

const ROLE_EMOJI: Record<string, string> = {
  BTS: '📡', CPE: '🏠', IDU: '🔌', RADIO: '📻', SWITCH: '🔄',
  ROUTER: '🌐', GATEWAY: '🚪', FIREWALL: '🔥', AP: '📶',
  OLT: '💡', ONU: '📦', SERVER: '🖥️', UNKNOWN: '❓',
};

function roleEmoji(role: string) { return ROLE_EMOJI[role?.toUpperCase()] ?? '🔧'; }

function relativeTime(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1)   return 'just now';
  if (m < 60)  return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24)  return `${h}h ago`;
  return new Date(iso).toLocaleDateString();
}

// ── Form modal ────────────────────────────────────────────────────────────────
interface ComboFormProps {
  initial?: DeviceTypeCombination | null;
  open: boolean;
  onClose: () => void;
  onSave: (data: { model: string; role: string; description: string; productDefinitionId: string; nodeViewDescriptorId: string }) => Promise<void>;
  saving?: boolean;
}

function ComboForm({ initial, open, onClose, onSave, saving }: ComboFormProps) {
  const [model,                setModel]                = useState('');
  const [role,                 setRole]                 = useState('');
  const [description,          setDescription]          = useState('');
  const [productDefinitionId,  setProductDefinitionId]  = useState('');
  const [nodeViewDescriptorId, setNodeViewDescriptorId] = useState('');

  useEffect(() => {
    if (open) {
      setModel(initial?.model ?? '');
      setRole(initial?.role ?? '');
      setDescription(initial?.description ?? '');
      setProductDefinitionId(initial?.productDefinitionId ?? '');
      setNodeViewDescriptorId(initial?.nodeViewDescriptorId ?? '');
    }
  }, [open, initial]);

  const canSubmit = model.trim() && role.trim();

  return (
    <Modal open={open} onClose={onClose} title={initial ? 'Edit Combination' : 'New Device Type Combination'}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 420 }}>

        {/* Model */}
        <div>
          <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--vf-text-secondary)', marginBottom: 6 }}>
            Model *
          </label>
          <input
            value={model} onChange={(e) => setModel(e.target.value)}
            placeholder="e.g. Model-X, Switch-2960, AP-1200"
            style={{ width: '100%', padding: '8px 12px', background: 'var(--vf-surface-raised)', border: '1px solid var(--vf-border-default)', borderRadius: 6, color: 'var(--vf-text-primary)', fontSize: 13, boxSizing: 'border-box' }}
          />
        </div>

        {/* Role */}
        <div>
          <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--vf-text-secondary)', marginBottom: 6 }}>
            Role *
          </label>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
            {COMMON_ROLES.map((r) => (
              <button
                key={r} onClick={() => setRole(r)}
                style={{
                  padding: '3px 10px', fontSize: 11, borderRadius: 12, cursor: 'pointer', fontWeight: 600,
                  background: role === r ? 'var(--vf-accent)' : 'var(--vf-surface-raised)',
                  color:      role === r ? '#fff' : 'var(--vf-text-secondary)',
                  border:     role === r ? '1px solid var(--vf-accent)' : '1px solid var(--vf-border-default)',
                }}
              >
                {roleEmoji(r)} {r}
              </button>
            ))}
          </div>
          <input
            value={role} onChange={(e) => setRole(e.target.value.toUpperCase())}
            placeholder="Or type a custom role…"
            style={{ width: '100%', padding: '8px 12px', background: 'var(--vf-surface-raised)', border: '1px solid var(--vf-border-default)', borderRadius: 6, color: 'var(--vf-text-primary)', fontSize: 13, boxSizing: 'border-box' }}
          />
        </div>

        {/* Description */}
        <div>
          <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--vf-text-secondary)', marginBottom: 6 }}>
            Description
          </label>
          <input
            value={description} onChange={(e) => setDescription(e.target.value)}
            placeholder="e.g. Base Transceiver Station"
            style={{ width: '100%', padding: '8px 12px', background: 'var(--vf-surface-raised)', border: '1px solid var(--vf-border-default)', borderRadius: 6, color: 'var(--vf-text-primary)', fontSize: 13, boxSizing: 'border-box' }}
          />
        </div>

        {/* Product Definition ID */}
        <div>
          <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--vf-text-secondary)', marginBottom: 6 }}>
            Product Definition ID <span style={{ color: 'var(--vf-text-muted)', fontWeight: 400 }}>(links configuration)</span>
          </label>
          <input
            value={productDefinitionId} onChange={(e) => setProductDefinitionId(e.target.value)}
            placeholder="e.g. eoc-configurations-gui"
            style={{ width: '100%', padding: '8px 12px', background: 'var(--vf-surface-raised)', border: '1px solid var(--vf-border-default)', borderRadius: 6, color: 'var(--vf-text-primary)', fontSize: 13, fontFamily: 'var(--vf-font-mono)', boxSizing: 'border-box' }}
          />
        </div>

        {/* Node View Descriptor ID */}
        <div>
          <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--vf-text-secondary)', marginBottom: 6 }}>
            Node View Descriptor ID <span style={{ color: 'var(--vf-text-muted)', fontWeight: 400 }}>(links node view)</span>
          </label>
          <input
            value={nodeViewDescriptorId} onChange={(e) => setNodeViewDescriptorId(e.target.value)}
            placeholder="e.g. eoc640-bts-v1"
            style={{ width: '100%', padding: '8px 12px', background: 'var(--vf-surface-raised)', border: '1px solid var(--vf-border-default)', borderRadius: 6, color: 'var(--vf-text-primary)', fontSize: 13, fontFamily: 'var(--vf-font-mono)', boxSizing: 'border-box' }}
          />
        </div>

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            variant="primary" loading={saving} disabled={!canSubmit}
            onClick={() => onSave({ model: model.trim(), role: role.trim(), description: description.trim(), productDefinitionId: productDefinitionId.trim(), nodeViewDescriptorId: nodeViewDescriptorId.trim() })}
          >
            {initial ? 'Save changes' : 'Create combination'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function V2DeviceTypesPage() {
  const { addToast } = useToast();

  const [combos,    setCombos]    = useState<DeviceTypeCombination[]>([]);
  const [auditLog,  setAuditLog]  = useState<DeviceTypeAuditEntry[]>([]);
  const [loading,   setLoading]   = useState(true);
  const [tab,       setTab]       = useState<'combinations' | 'audit'>('combinations');
  const [showForm,  setShowForm]  = useState(false);
  const [editing,   setEditing]   = useState<DeviceTypeCombination | null>(null);
  const [deleting,  setDeleting]  = useState<DeviceTypeCombination | null>(null);
  const [saving,    setSaving]    = useState(false);
  const [search,    setSearch]    = useState('');

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const [c, a] = await Promise.all([listCombinations(), fetchAuditLog()]);
      setCombos(c.filter((x) => x.isActive));
      setAuditLog(a);
    } catch (e) {
      addToast('Failed to load device type combinations', 'error');
    } finally {
      setLoading(false);
    }
  }, [addToast]);

  useEffect(() => { load(); }, [load]);

  const handleSave = async (data: { model: string; role: string; description: string; productDefinitionId: string; nodeViewDescriptorId: string }) => {
    setSaving(true);
    try {
      if (editing) {
        const updated = await updateCombination(editing.id, data);
        setCombos((prev) => prev.map((c) => c.id === editing.id ? updated : c));
        addToast(`Updated ${data.model} / ${data.role}`, 'success');
      } else {
        const created = await createCombination(data);
        setCombos((prev) => [...prev, created]);
        addToast(`Created ${data.model} / ${data.role}`, 'success');
      }
      setShowForm(false);
      setEditing(null);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Save failed';
      addToast(msg.includes('409') || msg.includes('CONFLICT') ? `Combination ${data.model}/${data.role} already exists` : msg, 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (combo: DeviceTypeCombination) => {
    try {
      await deleteCombination(combo.id);
      setCombos((prev) => prev.filter((c) => c.id !== combo.id));
      addToast(`Removed ${combo.model} / ${combo.role}`, 'success');
    } catch {
      addToast('Delete failed', 'error');
    } finally {
      setDeleting(null);
    }
  };

  const filtered = combos.filter((c) => {
    const q = search.toLowerCase();
    return !q || c.model.toLowerCase().includes(q) || c.role.toLowerCase().includes(q) || (c.description || '').toLowerCase().includes(q);
  });

  // Group by model
  const byModel: Record<string, DeviceTypeCombination[]> = {};
  filtered.forEach((c) => { (byModel[c.model] = byModel[c.model] || []).push(c); });

  return (
    <div style={{ padding: '24px 32px', maxWidth: 1100 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 24 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: 'var(--vf-text-primary)', margin: 0 }}>Device Type Combinations</h1>
          <p style={{ fontSize: 13, color: 'var(--vf-text-muted)', margin: '6px 0 0' }}>
            Define model + role combinations. Each combination links a hardware model in a specific network role
            to its configuration (Product Definition) and Node View.
          </p>
        </div>
        <Button variant="primary" onClick={() => { setEditing(null); setShowForm(true); }}>
          + New Combination
        </Button>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 0, borderBottom: '1px solid var(--vf-border-default)', marginBottom: 24 }}>
        {(['combinations', 'audit'] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)}
            style={{
              padding: '8px 20px', fontSize: 13, fontWeight: 600, cursor: 'pointer', background: 'transparent',
              border: 'none', borderBottom: tab === t ? '2px solid var(--vf-accent)' : '2px solid transparent',
              color: tab === t ? 'var(--vf-accent)' : 'var(--vf-text-muted)',
            }}>
            {t === 'combinations' ? `Combinations (${combos.length})` : `Audit Log (${auditLog.length})`}
          </button>
        ))}
      </div>

      {/* ── COMBINATIONS TAB ── */}
      {tab === 'combinations' && (
        <>
          {/* Search */}
          <div style={{ marginBottom: 20 }}>
            <input
              value={search} onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by model, role, or description…"
              style={{ padding: '8px 14px', width: 320, background: 'var(--vf-surface-raised)', border: '1px solid var(--vf-border-default)', borderRadius: 6, color: 'var(--vf-text-primary)', fontSize: 13 }}
            />
          </div>

          {loading ? (
            <div style={{ color: 'var(--vf-text-muted)', fontSize: 13, padding: 32, textAlign: 'center' }}>Loading…</div>
          ) : filtered.length === 0 ? (
            <div style={{ color: 'var(--vf-text-muted)', fontSize: 13, padding: 32, textAlign: 'center', border: '1px dashed var(--vf-border-default)', borderRadius: 8 }}>
              No combinations found. Click <strong>+ New Combination</strong> to create the first one.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
              {Object.entries(byModel).map(([model, rows]) => (
                <div key={model} style={{ background: 'var(--vf-surface)', border: '1px solid var(--vf-border-default)', borderRadius: 10, overflow: 'hidden' }}>
                  {/* Model header */}
                  <div style={{ padding: '12px 20px', background: 'var(--vf-surface-raised)', borderBottom: '1px solid var(--vf-border-default)', display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span style={{ fontSize: 16 }}>🔧</span>
                    <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--vf-text-primary)' }}>{model}</span>
                    <span style={{ fontSize: 11, color: 'var(--vf-text-muted)', background: 'var(--vf-surface)', border: '1px solid var(--vf-border-default)', borderRadius: 10, padding: '2px 8px' }}>
                      {rows.length} role{rows.length !== 1 ? 's' : ''}
                    </span>
                  </div>

                  {/* Roles table */}
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                    <thead>
                      <tr style={{ background: 'var(--vf-surface-raised)' }}>
                        {['Role', 'Description', 'Configuration (Product Def)', 'Node View', 'Actions'].map((h) => (
                          <th key={h} style={{ padding: '8px 16px', textAlign: 'left', fontSize: 11, fontWeight: 700, color: 'var(--vf-text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', borderBottom: '1px solid var(--vf-border-default)' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((combo) => (
                        <tr key={combo.id} style={{ borderBottom: '1px solid var(--vf-border-subtle)' }}>
                          <td style={{ padding: '12px 16px', fontWeight: 600, color: 'var(--vf-text-primary)' }}>
                            <span style={{ marginRight: 6 }}>{roleEmoji(combo.role)}</span>
                            {combo.role}
                          </td>
                          <td style={{ padding: '12px 16px', color: 'var(--vf-text-secondary)', fontSize: 12 }}>
                            {combo.description || <span style={{ color: 'var(--vf-text-muted)' }}>—</span>}
                          </td>
                          <td style={{ padding: '12px 16px' }}>
                            {combo.productDefinitionId
                              ? <span style={{ fontFamily: 'var(--vf-font-mono)', fontSize: 11, color: '#60a5fa', background: 'rgba(96,165,250,0.1)', padding: '2px 8px', borderRadius: 4 }}>{combo.productDefinitionId}</span>
                              : <span style={{ fontSize: 12, color: '#f59e0b' }}>⚠ Not linked</span>
                            }
                          </td>
                          <td style={{ padding: '12px 16px' }}>
                            {combo.nodeViewDescriptorId
                              ? <span style={{ fontFamily: 'var(--vf-font-mono)', fontSize: 11, color: '#a78bfa', background: 'rgba(167,139,250,0.1)', padding: '2px 8px', borderRadius: 4 }}>{combo.nodeViewDescriptorId}</span>
                              : <span style={{ fontSize: 12, color: 'var(--vf-text-muted)' }}>—</span>
                            }
                          </td>
                          <td style={{ padding: '12px 16px' }}>
                            <div style={{ display: 'flex', gap: 6 }}>
                              <button
                                onClick={() => { setEditing(combo); setShowForm(true); }}
                                style={{ padding: '4px 12px', fontSize: 11, background: 'var(--vf-surface-raised)', border: '1px solid var(--vf-border-default)', color: 'var(--vf-text-secondary)', borderRadius: 5, cursor: 'pointer', fontWeight: 600 }}
                              >Edit</button>
                              <button
                                onClick={() => setDeleting(combo)}
                                style={{ padding: '4px 12px', fontSize: 11, background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.3)', color: '#ef4444', borderRadius: 5, cursor: 'pointer', fontWeight: 600 }}
                              >Remove</button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* ── AUDIT LOG TAB ── */}
      {tab === 'audit' && (
        <div>
          {auditLog.length === 0 ? (
            <div style={{ color: 'var(--vf-text-muted)', fontSize: 13, padding: 32, textAlign: 'center', border: '1px dashed var(--vf-border-default)', borderRadius: 8 }}>
              No type changes logged yet.
            </div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: 'var(--vf-surface-raised)' }}>
                  {['Device', 'Old type', 'New type', 'Changed by', 'When', 'Reason'].map((h) => (
                    <th key={h} style={{ padding: '10px 16px', textAlign: 'left', fontSize: 11, fontWeight: 700, color: 'var(--vf-text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', borderBottom: '1px solid var(--vf-border-default)' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {auditLog.map((entry, i) => (
                  <tr key={entry._id || i} style={{ borderBottom: '1px solid var(--vf-border-subtle)' }}>
                    <td style={{ padding: '10px 16px', fontFamily: 'var(--vf-font-mono)', fontSize: 11, color: 'var(--vf-accent)' }}>{entry.serialNumber}</td>
                    <td style={{ padding: '10px 16px' }}>
                      {entry.oldType
                        ? <span style={{ color: '#ef4444', fontWeight: 600 }}>{entry.oldType}{entry.oldRole && entry.oldRole !== entry.oldType ? ` / ${entry.oldRole}` : ''}</span>
                        : <span style={{ color: 'var(--vf-text-muted)', fontSize: 11 }}>Initial</span>
                      }
                    </td>
                    <td style={{ padding: '10px 16px', fontWeight: 600, color: '#22c55e' }}>
                      {entry.newType}{entry.newRole && entry.newRole !== entry.newType ? ` / ${entry.newRole}` : ''}
                    </td>
                    <td style={{ padding: '10px 16px', color: 'var(--vf-text-secondary)' }}>{entry.changedBy}</td>
                    <td style={{ padding: '10px 16px', color: 'var(--vf-text-muted)', fontSize: 11 }}>{relativeTime(entry.changedAt)}</td>
                    <td style={{ padding: '10px 16px', color: 'var(--vf-text-muted)', fontSize: 11 }}>{entry.reason || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* Create / Edit form */}
      <ComboForm
        open={showForm} initial={editing} saving={saving}
        onClose={() => { setShowForm(false); setEditing(null); }}
        onSave={handleSave}
      />

      {/* Delete confirmation */}
      <Modal open={!!deleting} onClose={() => setDeleting(null)} title="Remove Combination">
        {deleting && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <p style={{ fontSize: 13, color: 'var(--vf-text-secondary)', margin: 0 }}>
              Remove <strong>{deleting.model} / {deleting.role}</strong>? Devices already provisioned with this combination will keep their existing type, but new devices will not be able to select it.
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <Button variant="ghost" onClick={() => setDeleting(null)}>Cancel</Button>
              <Button variant="danger" onClick={() => handleDelete(deleting)}>Remove</Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
