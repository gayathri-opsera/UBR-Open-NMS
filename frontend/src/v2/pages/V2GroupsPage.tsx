/**
 * V2 Device Groups — REQ-015 / NMS-INV-05
 *
 * Full CRUD for device groups with per-group summary (online/offline/alarms).
 * Groups enable bulk operations, filtered KPI views, and topology group overlays.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  fetchGroups, fetchGroupSummaries,
  createGroup, updateGroup, deleteGroup,
  addDevicesToGroup, removeDevicesFromGroup,
} from '../../api/groups.api';
import type { DeviceGroup, GroupSummary } from '../../api/groups.api';
import { fetchDevices } from '../../api/devices.api';
import type { Device } from '../../api/devices.types';
import { Badge } from '../components/common/Badge';
import { Button } from '../components/common/Button';
import { Input } from '../components/common/Input';
import { Modal } from '../components/common/Modal';
import { MetricCard } from '../components/common/MetricCard';
import { LoadingState, EmptyState } from '../components/common/States';
import { useToast } from '../components/common/Toast';
import { logger } from '../utils/logger';

// ── Constants ─────────────────────────────────────────────────────────────────
const PRESET_COLORS = [
  '#3b82f6', '#22c55e', '#f59e0b', '#ef4444',
  '#8b5cf6', '#06b6d4', '#ec4899', '#14b8a6',
];

// ── Helpers ───────────────────────────────────────────────────────────────────
function colorDot(color: string, size = 12) {
  return (
    <span style={{ width: size, height: size, borderRadius: '50%', background: color, display: 'inline-block', flexShrink: 0 }} />
  );
}

// ── Group form modal ───────────────────────────────────────────────────────────
interface GroupFormModalProps {
  open: boolean;
  editing: DeviceGroup | null;
  onClose: () => void;
  onSave: (name: string, description: string, color: string) => void;
  saving: boolean;
}
function GroupFormModal({ open, editing, onClose, onSave, saving }: GroupFormModalProps) {
  const [name, setName]         = useState('');
  const [description, setDesc]  = useState('');
  const [color, setColor]       = useState(PRESET_COLORS[0]);

  useEffect(() => {
    if (editing) {
      setName(editing.name);
      setDesc(editing.description ?? '');
      setColor(editing.color ?? PRESET_COLORS[0]);
    } else {
      setName(''); setDesc(''); setColor(PRESET_COLORS[0]);
    }
  }, [editing, open]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editing ? `Edit Group — ${editing.name}` : 'Create Device Group'}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button variant="primary" size="sm" onClick={() => onSave(name, description, color)} disabled={saving || !name.trim()}>
            {saving ? 'Saving…' : editing ? 'Save' : 'Create'}
          </Button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Input label="Group Name *" value={name} onChange={(e) => setName(e.target.value)} fullWidth placeholder="e.g. Delhi Ring" />
        <div>
          <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 6, color: 'var(--vf-text-secondary)' }}>Description</label>
          <textarea
            value={description}
            onChange={(e) => setDesc(e.target.value)}
            rows={2}
            placeholder="Optional description…"
            style={{
              width: '100%', padding: '8px 10px', borderRadius: 6,
              border: '1px solid var(--vf-border-subtle)', background: 'var(--vf-surface)',
              color: 'var(--vf-text-primary)', fontSize: 13, resize: 'vertical', outline: 'none',
            }}
          />
        </div>
        <div>
          <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 8, color: 'var(--vf-text-secondary)' }}>Color</label>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {PRESET_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setColor(c)}
                style={{
                  width: 28, height: 28, borderRadius: '50%', background: c,
                  border: color === c ? '3px solid #fff' : '2px solid transparent',
                  cursor: 'pointer', outline: 'none', transition: 'border 0.15s',
                  boxShadow: color === c ? `0 0 0 2px ${c}` : 'none',
                }}
              />
            ))}
          </div>
        </div>
      </div>
    </Modal>
  );
}

// ── Device picker modal ────────────────────────────────────────────────────────
interface DevicePickerModalProps {
  open: boolean;
  group: DeviceGroup | null;
  onClose: () => void;
  onSave: (add: string[], remove: string[]) => void;
  saving: boolean;
}
function DevicePickerModal({ open, group, onClose, onSave, saving }: DevicePickerModalProps) {
  const [all, setAll]           = useState<Device[]>([]);
  const [loading, setLoading]   = useState(true);
  const [search, setSearch]     = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    fetchDevices({}).then(setAll).catch(() => setAll([])).finally(() => setLoading(false));
    setSelected(new Set(group?.deviceIds ?? []));
    setSearch('');
  }, [open, group]);

  const filtered = all.filter((d) => {
    const q = search.toLowerCase();
    return !q || d.serialNumber.toLowerCase().includes(q) || d.ipAddress.toLowerCase().includes(q) || d.deviceType.toLowerCase().includes(q);
  });

  function toggle(id: string) {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function handleSave() {
    const prev = new Set(group?.deviceIds ?? []);
    const add    = [...selected].filter((id) => !prev.has(id));
    const remove = [...prev].filter((id)    => !selected.has(id));
    onSave(add, remove);
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Manage Devices — ${group?.name}`}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button variant="primary" size="sm" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : `Save (${selected.size} devices)`}
          </Button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search serial, IP, type…"
          fullWidth
        />
        {loading ? <LoadingState label="Loading devices…" /> : (
          <div style={{ maxHeight: 320, overflowY: 'auto', border: '1px solid var(--vf-border-subtle)', borderRadius: 6 }}>
            {filtered.map((d) => {
              const checked = selected.has(d.id);
              return (
                <label
                  key={d.id}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    padding: '8px 12px', cursor: 'pointer',
                    background: checked ? 'rgba(59,130,246,0.08)' : 'transparent',
                    borderBottom: '1px solid var(--vf-border-subtle)',
                    fontSize: 13, userSelect: 'none',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggle(d.id)}
                    style={{ accentColor: '#3b82f6', width: 14, height: 14 }}
                  />
                  <Badge variant={d.deviceType === 'BTS' ? 'accent' : d.deviceType === 'CPE' ? 'success' : 'warning'}>{d.deviceType}</Badge>
                  <span style={{ fontFamily: 'var(--vf-font-mono)', fontSize: 12 }}>{d.serialNumber}</span>
                  <span style={{ color: 'var(--vf-text-muted)', fontSize: 12 }}>{d.ipAddress}</span>
                  <span style={{ marginLeft: 'auto', color: d.status === 'ONLINE' ? '#22c55e' : '#ef4444', fontSize: 11 }}>{d.status}</span>
                </label>
              );
            })}
          </div>
        )}
        <div style={{ fontSize: 11, color: 'var(--vf-text-muted)' }}>
          {selected.size} device{selected.size !== 1 ? 's' : ''} in this group
        </div>
      </div>
    </Modal>
  );
}

// ── Group card ─────────────────────────────────────────────────────────────────
function GroupCard({
  group, summary, onEdit, onManageDevices, onDelete,
}: {
  group: DeviceGroup;
  summary?: GroupSummary;
  onEdit: () => void;
  onManageDevices: () => void;
  onDelete: () => void;
}) {
  const color = group.color ?? '#3b82f6';
  return (
    <div style={{
      background: 'var(--vf-surface)', borderRadius: 10,
      border: `1px solid rgba(${hexToRgb(color)},0.25)`,
      borderLeft: `4px solid ${color}`,
      padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 12,
    }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        {colorDot(color, 14)}
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--vf-text-primary)' }}>{group.name}</div>
          {group.description && <div style={{ fontSize: 12, color: 'var(--vf-text-muted)', marginTop: 2 }}>{group.description}</div>}
        </div>
        <Badge variant="default">{group.deviceIds.length} devices</Badge>
      </div>

      {/* Summary stats */}
      {summary ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
          {[
            { label: 'Online',   val: summary.onlineCount,       color: '#22c55e' },
            { label: 'Offline',  val: summary.offlineCount,      color: '#ef4444' },
            { label: 'Alarms',   val: summary.criticalAlarmCount, color: summary.criticalAlarmCount > 0 ? '#f59e0b' : '#6b7280' },
          ].map(({ label, val, color: c }) => (
            <div key={label} style={{ textAlign: 'center', background: 'rgba(255,255,255,0.03)', borderRadius: 6, padding: '6px 4px' }}>
              <div style={{ fontSize: 20, fontWeight: 700, color: c }}>{val}</div>
              <div style={{ fontSize: 10, color: 'var(--vf-text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</div>
            </div>
          ))}
        </div>
      ) : (
        <div style={{ height: 56, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--vf-text-muted)', fontSize: 12 }}>
          Loading stats…
        </div>
      )}

      {/* Actions */}
      <div style={{ display: 'flex', gap: 6 }}>
        <Button variant="ghost" size="sm" onClick={onManageDevices} style={{ flex: 1 }}>Manage Devices</Button>
        <Button variant="ghost" size="sm" onClick={onEdit}>Edit</Button>
        <Button variant="danger" size="sm" onClick={onDelete}>Delete</Button>
      </div>
    </div>
  );
}

function hexToRgb(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `${r},${g},${b}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Page
// ─────────────────────────────────────────────────────────────────────────────
export default function V2GroupsPage() {
  const { addToast } = useToast();
  const [groups, setGroups]       = useState<DeviceGroup[]>([]);
  const [summaries, setSummaries] = useState<GroupSummary[]>([]);
  const [loading, setLoading]     = useState(true);

  // Modals
  const [formModal, setFormModal]     = useState<{ open: boolean; editing: DeviceGroup | null }>({ open: false, editing: null });
  const [devModal, setDevModal]       = useState<{ open: boolean; group: DeviceGroup | null }>({ open: false, group: null });
  const [confirmDel, setConfirmDel]   = useState<DeviceGroup | null>(null);
  const [saving, setSaving]           = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    Promise.allSettled([fetchGroups(), fetchGroupSummaries()])
      .then(([g, s]) => {
        if (g.status === 'fulfilled') setGroups(g.value);
        if (s.status === 'fulfilled') setSummaries(s.value);
      })
      .catch((e) => { logger.error('Groups fetch failed', e); addToast('Failed to load groups', 'error'); })
      .finally(() => setLoading(false));
  }, [addToast]);

  useEffect(load, [load]);

  // ── CRUD ──────────────────────────────────────────────────────────────────
  async function handleSaveGroup(name: string, description: string, color: string) {
    setSaving(true);
    try {
      if (formModal.editing) {
        const updated = await updateGroup(formModal.editing.id, { name, description, color });
        setGroups((prev) => prev.map((g) => g.id === updated.id ? updated : g));
        addToast('Group updated', 'success');
      } else {
        const created = await createGroup({ name, description, color, deviceIds: [], tags: [] });
        setGroups((prev) => [...prev, created]);
        addToast('Group created', 'success');
      }
      setFormModal({ open: false, editing: null });
    } catch (e) {
      logger.error('Group save failed', e);
      addToast('Failed to save group', 'error');
    } finally { setSaving(false); }
  }

  async function handleDeviceSave(add: string[], remove: string[]) {
    if (!devModal.group) return;
    setSaving(true);
    try {
      let latest = devModal.group;
      if (add.length)    latest = await addDevicesToGroup(latest.id, add);
      if (remove.length) latest = await removeDevicesFromGroup(latest.id, remove);
      setGroups((prev) => prev.map((g) => g.id === latest.id ? latest : g));
      addToast('Group membership updated', 'success');
      setDevModal({ open: false, group: null });
    } catch (e) {
      logger.error('Group devices save failed', e);
      addToast('Failed to update group devices', 'error');
    } finally { setSaving(false); }
  }

  async function handleDelete() {
    if (!confirmDel) return;
    try {
      await deleteGroup(confirmDel.id);
      setGroups((prev) => prev.filter((g) => g.id !== confirmDel.id));
      addToast('Group deleted', 'success');
    } catch { addToast('Failed to delete group', 'error'); }
    finally { setConfirmDel(null); }
  }

  const totalDevicesInGroups = groups.reduce((n, g) => n + (g.deviceIds?.length ?? 0), 0);
  const totalOnline  = summaries.reduce((n, s) => n + (s.onlineCount ?? 0), 0);
  const totalAlarms  = summaries.reduce((n, s) => n + (s.criticalAlarmCount ?? 0), 0);

  return (
    <div className="vf-page">
      {/* Header */}
      <div className="vf-page-header">
        <div>
          <h1 className="vf-page-title">Device Groups</h1>
          <p style={{ fontSize: 13, color: 'var(--vf-text-muted)', margin: '4px 0 0' }}>
            Organise devices into logical groups for bulk operations, KPI filtering, and topology overlays. (REQ-015)
          </p>
        </div>
        <Button variant="primary" size="sm" onClick={() => setFormModal({ open: true, editing: null })}>
          + New Group
        </Button>
      </div>

      {/* KPI Row */}
      <div className="vf-kpi-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))' }}>
        <MetricCard label="Total Groups"    value={groups.length}         loading={loading} />
        <MetricCard label="Devices in Groups" value={totalDevicesInGroups} loading={loading} />
        <MetricCard label="Online"          value={totalOnline}           variant="success" loading={loading} />
        <MetricCard label="Critical Alarms" value={totalAlarms}           variant={totalAlarms > 0 ? 'danger' : 'default'} loading={loading} />
      </div>

      {/* Groups grid */}
      {loading ? (
        <LoadingState label="Loading groups…" />
      ) : groups.length === 0 ? (
        <EmptyState
          title="No device groups yet"
          description="Create groups to organise your BTS, CPE, and IDU devices for bulk operations, KPI filtering, and topology views."
          icon={<span aria-hidden style={{ fontSize: 32 }}>📂</span>}
          action={<Button variant="primary" onClick={() => setFormModal({ open: true, editing: null })}>Create First Group</Button>}
        />
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 16 }}>
          {groups.map((g) => (
            <GroupCard
              key={g.id}
              group={g}
              summary={summaries.find((s) => s.id === g.id)}
              onEdit={()            => setFormModal({ open: true, editing: g })}
              onManageDevices={() => setDevModal({ open: true, group: g })}
              onDelete={()          => setConfirmDel(g)}
            />
          ))}
        </div>
      )}

      {/* Modals */}
      <GroupFormModal
        open={formModal.open}
        editing={formModal.editing}
        onClose={() => setFormModal({ open: false, editing: null })}
        onSave={handleSaveGroup}
        saving={saving}
      />
      <DevicePickerModal
        open={devModal.open}
        group={devModal.group}
        onClose={() => setDevModal({ open: false, group: null })}
        onSave={handleDeviceSave}
        saving={saving}
      />
      {/* Confirm delete */}
      <Modal
        open={!!confirmDel}
        onClose={() => setConfirmDel(null)}
        title="Delete Group"
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setConfirmDel(null)}>Cancel</Button>
            <Button variant="danger" size="sm" onClick={handleDelete}>Delete</Button>
          </>
        }
      >
        <p style={{ color: 'var(--vf-text-primary)', fontSize: 14 }}>
          Delete group <strong>"{confirmDel?.name}"</strong>? The {confirmDel?.deviceIds.length} assigned devices will not be affected.
        </p>
      </Modal>
    </div>
  );
}
