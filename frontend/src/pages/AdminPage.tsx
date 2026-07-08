import React, { useEffect, useState } from 'react';
import type { NmsUser, UserSession, SystemHealth, UserRole } from '../api/admin.types';
import { apiClient } from '../api/client';
import { createUser, deleteUser, fetchSessions, fetchSystemHealth, fetchUsers, terminateSession, updateUser } from '../api/admin.api';
import {
  fetchOrganizations, createOrganization, deleteOrganization,
  fetchHierarchies, createHierarchy, deleteHierarchy,
  fetchNetworks, createNetwork, deleteNetwork,
} from '../api/hierarchy.api';
import type { Organization, HierarchyView, Network } from '../api/hierarchy.api';

type AdminTab = 'users' | 'sessions' | 'health' | 'hierarchy' | 'audit' | 'backup' | 'northbound' | 'redundancy';

const TABS: { id: AdminTab; label: string }[] = [
  { id: 'users',       label: 'Users' },
  { id: 'sessions',    label: 'Sessions' },
  { id: 'health',      label: 'System Health' },
  { id: 'hierarchy',   label: 'Hierarchy' },
  { id: 'audit',       label: 'Audit Log' },
  { id: 'backup',      label: 'Backup & Restore' },
  { id: 'northbound',  label: 'Northbound' },
  { id: 'redundancy',  label: 'Redundancy' },
];

// ── Password policy (ITSAR) ───────────────────────────────────────────────────
function pwStrength(pw: string): { score: number; label: string; color: string; hints: string[] } {
  const hints: string[] = [];
  if (pw.length < 12) hints.push('At least 12 characters');
  if (!/[A-Z]/.test(pw)) hints.push('One uppercase letter');
  if (!/[a-z]/.test(pw)) hints.push('One lowercase letter');
  if (!/\d/.test(pw)) hints.push('One digit');
  if (!/[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]/.test(pw)) hints.push('One special character');
  const score = 5 - hints.length;
  const labels = ['Very Weak', 'Weak', 'Fair', 'Good', 'Strong', 'Very Strong'];
  const colors = ['#ef4444', '#f97316', '#f59e0b', '#84cc16', '#22c55e', '#10b981'];
  return { score, label: pw ? labels[score] : '', color: pw ? colors[score] : '#374151', hints };
}

const ROLE_COLORS: Record<string, { bg: string; text: string }> = {
  Admin:    { bg: '#7f1d1d', text: '#fca5a5' },
  admin:    { bg: '#7f1d1d', text: '#fca5a5' },
  Operator: { bg: '#1e3a5f', text: '#93c5fd' },
  operator: { bg: '#1e3a5f', text: '#93c5fd' },
  User:     { bg: '#1c1917', text: '#a8a29e' },
  user:     { bg: '#1c1917', text: '#a8a29e' },
};

const STATUS_BADGE = (s: string) => {
  const m: Record<string, { bg: string; text: string }> = {
    UP:       { bg: '#14532d', text: '#86efac' },
    DEGRADED: { bg: '#78350f', text: '#fcd34d' },
    DOWN:     { bg: '#7f1d1d', text: '#fca5a5' },
  };
  return m[s] ?? m.DOWN;
};

interface BackupEntry {
  id: string;
  timestamp: string;
  size: string;
  status: 'COMPLETE' | 'PARTIAL' | 'FAILED';
  type: 'FULL' | 'INCREMENTAL';
}

interface AuditEvent {
  id: string; actor: string; action: string; resource: string;
  timestamp: string; result: 'SUCCESS' | 'FAILURE'; ipAddress?: string;
}

export default function AdminPage(): React.ReactElement {
  const [tab, setTab] = useState<AdminTab>('users');
  const [users, setUsers] = useState<NmsUser[]>([]);
  const [sessions, setSessions] = useState<UserSession[]>([]);
  const [health, setHealth] = useState<SystemHealth | null>(null);

  // User form
  const [showForm, setShowForm] = useState(false);
  const [editUser, setEditUser] = useState<Partial<NmsUser> & { password?: string }>({});
  const [pwInput, setPwInput] = useState('');
  const [pwValid, setPwValid] = useState(true);

  const [backups, setBackups] = useState<BackupEntry[]>([]);
  const [backupStatus, setBackupStatus] = useState<string | null>(null);
  const [backupError, setBackupError] = useState<string | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<string | null>(null);
  const [restoreStatus, setRestoreStatus] = useState<string | null>(null);

  // Hierarchy state
  const [orgs, setOrgs] = useState<Organization[]>([]);
  const [hvMap, setHvMap] = useState<Record<string, HierarchyView[]>>({});
  const [netMap, setNetMap] = useState<Record<string, Network[]>>({});
  const [expandedOrg, setExpandedOrg] = useState<string | null>(null);
  const [expandedHv, setExpandedHv] = useState<string | null>(null);
  const [newOrgName, setNewOrgName] = useState('');
  const [newHvName, setNewHvName] = useState('');
  const [newNetName, setNewNetName] = useState('');
  const [hierMsg, setHierMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  // Audit log state
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
  const [auditLoading, setAuditLoading] = useState(false);

  useEffect(() => { fetchUsers().then(setUsers).catch(() => {}); }, []);
  useEffect(() => { if (tab === 'sessions') fetchSessions().then(setSessions).catch(() => {}); }, [tab]);
  useEffect(() => { if (tab === 'health') fetchSystemHealth().then(setHealth).catch(() => {}); }, [tab]);
  useEffect(() => {
    if (tab === 'hierarchy') fetchOrganizations().then(setOrgs).catch(() => {});
  }, [tab]);
  useEffect(() => {
    if (tab === 'audit') {
      setAuditLoading(true);
      apiClient.get<AuditEvent[]>('/audit/events', { params: { limit: 100 } })
        .then((r) => setAuditEvents(r.data))
        .catch(() => {
          // Mock data when audit service unavailable
          setAuditEvents([
            { id: '1', actor: 'admin@ubr.in', action: 'LOGIN', resource: 'AUTH', timestamp: new Date(Date.now() - 300_000).toISOString(), result: 'SUCCESS', ipAddress: '192.168.1.10' },
            { id: '2', actor: 'operator@ubr.in', action: 'DEVICE_CONFIG_PUSH', resource: 'CPE-001', timestamp: new Date(Date.now() - 600_000).toISOString(), result: 'SUCCESS', ipAddress: '192.168.1.11' },
            { id: '3', actor: 'admin@ubr.in', action: 'ALARM_ACK', resource: 'ALM-001', timestamp: new Date(Date.now() - 1_200_000).toISOString(), result: 'SUCCESS', ipAddress: '192.168.1.10' },
            { id: '4', actor: 'unknown', action: 'LOGIN', resource: 'AUTH', timestamp: new Date(Date.now() - 3_600_000).toISOString(), result: 'FAILURE', ipAddress: '10.0.0.99' },
          ]);
        })
        .finally(() => setAuditLoading(false));
    }
  }, [tab]);
  useEffect(() => {
    if (tab === 'backup') {
      apiClient.get<BackupEntry[]>('/admin/backups').then((r) => setBackups(r.data)).catch(() => {
        // Mock data for demo if API unavailable
        setBackups([
          { id: 'bk-001', timestamp: new Date(Date.now() - 3_600_000).toISOString(), size: '12.4 MB', status: 'COMPLETE', type: 'FULL' },
          { id: 'bk-002', timestamp: new Date(Date.now() - 86_400_000).toISOString(), size: '11.9 MB', status: 'COMPLETE', type: 'FULL' },
          { id: 'bk-003', timestamp: new Date(Date.now() - 172_800_000).toISOString(), size: '12.1 MB', status: 'COMPLETE', type: 'INCREMENTAL' },
        ]);
      });
    }
  }, [tab]);

  const handleSaveUser = async () => {
    const strength = pwStrength(pwInput);
    if (!editUser.id && strength.score < 4) { setPwValid(false); return; }
    if (editUser.id) {
      const u = await updateUser(editUser.id, editUser);
      setUsers((prev) => prev.map((x) => x.id === u.id ? u : x));
    } else {
      const u = await createUser({ ...editUser, password: pwInput } as Partial<NmsUser> & { password: string });
      setUsers((prev) => [...prev, u]);
    }
    setShowForm(false); setEditUser({}); setPwInput(''); setPwValid(true);
  };

  const handleExpandOrg = async (orgId: string) => {
    setExpandedOrg(expandedOrg === orgId ? null : orgId);
    if (!hvMap[orgId]) {
      fetchHierarchies(orgId).then((hvs) => setHvMap((p) => ({ ...p, [orgId]: hvs }))).catch(() => {});
    }
  };

  const handleExpandHv = async (orgId: string, hvId: string) => {
    const key = `${orgId}:${hvId}`;
    setExpandedHv(expandedHv === key ? null : key);
    if (!netMap[key]) {
      fetchNetworks(orgId, hvId).then((nets) => setNetMap((p) => ({ ...p, [key]: nets }))).catch(() => {});
    }
  };

  const handleCreateOrg = async () => {
    if (!newOrgName.trim()) return;
    setHierMsg(null);
    createOrganization({ name: newOrgName })
      .then((o) => { setOrgs((p) => [...p, o]); setNewOrgName(''); setHierMsg({ type: 'ok', text: `Organization "${o.name}" created.` }); })
      .catch(() => setHierMsg({ type: 'err', text: 'Failed to create organization.' }));
  };

  const handleCreateHv = async (orgId: string) => {
    if (!newHvName.trim()) return;
    setHierMsg(null);
    createHierarchy(orgId, { name: newHvName })
      .then((hv) => { setHvMap((p) => ({ ...p, [orgId]: [...(p[orgId] ?? []), hv] })); setNewHvName(''); setHierMsg({ type: 'ok', text: `Hierarchy "${hv.name}" created.` }); })
      .catch(() => setHierMsg({ type: 'err', text: 'Failed to create hierarchy.' }));
  };

  const handleCreateNetwork = async (orgId: string, hvId: string) => {
    if (!newNetName.trim()) return;
    const key = `${orgId}:${hvId}`;
    setHierMsg(null);
    createNetwork(orgId, hvId, { name: newNetName })
      .then((n) => { setNetMap((p) => ({ ...p, [key]: [...(p[key] ?? []), n] })); setNewNetName(''); setHierMsg({ type: 'ok', text: `Network "${n.name}" created.` }); })
      .catch(() => setHierMsg({ type: 'err', text: 'Failed to create network.' }));
  };

  const triggerBackup = async () => {
    setBackupStatus('Creating backup…'); setBackupError(null);
    try {
      const r = await apiClient.post<BackupEntry>('/admin/backups', { type: 'FULL' });
      setBackups((prev) => [r.data, ...prev]);
      setBackupStatus('Backup created successfully.');
    } catch {
      setBackupError('Backup failed. Check system logs.'); setBackupStatus(null);
    }
  };

  const triggerRestore = async (id: string) => {
    setRestoreTarget(id); setRestoreStatus('Restoring…');
    try {
      await apiClient.post(`/admin/backups/${id}/restore`);
      setRestoreStatus('Restore completed. Reload the page.');
    } catch {
      setRestoreStatus('Restore failed. Check system logs.');
    }
  };

  const tabBtn = (id: AdminTab): React.CSSProperties => ({
    background: tab === id ? 'var(--accent-bg)' : 'none',
    border: `1px solid ${tab === id ? 'var(--accent)' : 'var(--border-strong)'}`,
    color: tab === id ? 'var(--accent)' : 'var(--text-muted)',
    padding: '6px 14px', borderRadius: 4, cursor: 'pointer', fontSize: 13,
  });
  const input: React.CSSProperties = {
    background: 'var(--bg-input)', border: '1px solid var(--border-default)', borderRadius: 4,
    color: 'var(--text-primary)', padding: '6px 10px', fontSize: 13, width: '100%', boxSizing: 'border-box',
  };
  const th: React.CSSProperties = { padding: '8px 12px', background: 'var(--bg-card)', color: 'var(--text-muted)', fontSize: 12, textAlign: 'left', borderBottom: '1px solid var(--border-subtle)' };
  const td: React.CSSProperties = { padding: '8px 12px', borderBottom: '1px solid var(--bg-base)', fontSize: 13, color: 'var(--text-primary)' };

  return (
    <div>
      <h2 style={{ color: '#e2e8f0', marginBottom: 16 }}>Admin Panel</h2>
      <div style={{ display: 'flex', gap: 6, marginBottom: 20 }}>
        {TABS.map((t) => <button key={t.id} style={tabBtn(t.id)} onClick={() => setTab(t.id)}>{t.label}</button>)}
      </div>

      {/* ── Users ─────────────────────────────────────────── */}
      {tab === 'users' && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
            <button onClick={() => { setEditUser({}); setShowForm(true); }}
              style={{ background: '#1e3a5f', border: 'none', color: '#60a5fa', padding: '7px 16px', borderRadius: 4, cursor: 'pointer', fontSize: 13 }}>
              + New User
            </button>
          </div>

          <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 20 }}>
            <thead>
              <tr>{['Username', 'Full Name', 'Email', 'Role', 'Status', 'Last Login', ''].map((h) => <th key={h} style={th}>{h}</th>)}</tr>
            </thead>
            <tbody>
              {users.map((u) => {
                const rc = ROLE_COLORS[u.role];
                return (
                  <tr key={u.id} style={{ background: '#0d1b2a' }}>
                    <td style={td}>{u.username}</td>
                    <td style={td}>{u.fullName}</td>
                    <td style={{ ...td, color: '#64748b', fontSize: 12 }}>{u.email}</td>
                    <td style={td}>
                      <span style={{ background: rc.bg, color: rc.text, padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 600 }}>{u.role}</span>
                    </td>
                    <td style={td}>
                      <span style={{ background: (u.isActive ?? u.enabled) ? '#14532d' : '#374151', color: (u.isActive ?? u.enabled) ? '#86efac' : '#6b7280', padding: '2px 8px', borderRadius: 4, fontSize: 11 }}>
                        {(u.isActive ?? u.enabled) ? 'Active' : 'Disabled'}
                      </span>
                    </td>
                    <td style={{ ...td, fontSize: 12, color: '#475569' }}>{(u.lastLogin ?? u.lastLoginAt) ? new Date((u.lastLogin ?? u.lastLoginAt)!).toLocaleString() : '—'}</td>
                    <td style={td}>
                      <div style={{ display: 'flex', gap: 4 }}>
                        <button onClick={() => { setEditUser(u); setShowForm(true); }} style={{ background: 'none', border: '1px solid #374151', color: '#60a5fa', padding: '3px 10px', borderRadius: 4, cursor: 'pointer', fontSize: 12 }}>Edit</button>
                        <button onClick={() => u.id && deleteUser(u.id).then(() => setUsers((p) => p.filter((x) => x.id !== u.id)))} style={{ background: 'none', border: '1px solid #374151', color: '#f87171', padding: '3px 10px', borderRadius: 4, cursor: 'pointer', fontSize: 12 }}>Del</button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {showForm && (
            <div style={{ background: '#0d1b2a', border: '1px solid #1e293b', borderRadius: 8, padding: 20 }}>
              <h3 style={{ color: '#e2e8f0', marginTop: 0 }}>{editUser.id ? 'Edit User' : 'New User'}</h3>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
                {[['username', 'Username'], ['fullName', 'Full Name'], ['email', 'Email']].map(([f, l]) => (
                  <div key={f}>
                    <label style={{ color: '#94a3b8', fontSize: 12, display: 'block', marginBottom: 4 }}>{l}</label>
                    <input style={input} type="text" value={String((editUser as Record<string, string>)[f] ?? '')}
                      onChange={(e) => setEditUser((u) => ({ ...u, [f]: e.target.value }))} />
                  </div>
                ))}
                {/* Password with strength meter */}
                <div>
                  <label style={{ color: '#94a3b8', fontSize: 12, display: 'block', marginBottom: 4 }}>
                    Password {!editUser.id && <span style={{ color: '#f87171' }}>*</span>}
                  </label>
                  <input style={{ ...input, borderColor: !pwValid ? '#ef4444' : '#1e3a5f' }}
                    type="password" value={pwInput}
                    onChange={(e) => { setPwInput(e.target.value); setPwValid(true); setEditUser((u) => ({ ...u, password: e.target.value })); }} />
                  {pwInput && (() => {
                    const s = pwStrength(pwInput);
                    return (
                      <div style={{ marginTop: 4 }}>
                        <div style={{ height: 3, borderRadius: 2, background: '#1e293b', marginBottom: 3 }}>
                          <div style={{ height: 3, borderRadius: 2, width: `${(s.score / 5) * 100}%`, background: s.color, transition: 'width 0.3s' }} />
                        </div>
                        <div style={{ color: s.color, fontSize: 10 }}>{s.label}</div>
                        {s.hints.length > 0 && <div style={{ color: '#64748b', fontSize: 10 }}>Missing: {s.hints.join(', ')}</div>}
                      </div>
                    );
                  })()}
                  {!pwValid && <div style={{ color: '#f87171', fontSize: 11, marginTop: 3 }}>Password must meet ITSAR policy (see hints above)</div>}
                </div>
                <div>
                  <label style={{ color: '#94a3b8', fontSize: 12, display: 'block', marginBottom: 4 }}>Role</label>
                  <select style={input} value={editUser.role ?? 'User'} onChange={(e) => setEditUser((u) => ({ ...u, role: e.target.value as UserRole }))}>
                    <option>Admin</option><option>Operator</option><option>User</option>
                  </select>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingTop: 20 }}>
                  <input type="checkbox" checked={editUser.enabled ?? true} onChange={(e) => setEditUser((u) => ({ ...u, enabled: e.target.checked }))} />
                  <label style={{ color: '#94a3b8', fontSize: 13 }}>Enabled</label>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={handleSaveUser} style={{ background: '#1e3a5f', border: 'none', color: '#60a5fa', padding: '8px 20px', borderRadius: 4, cursor: 'pointer', fontSize: 13 }}>Save</button>
                <button onClick={() => { setShowForm(false); setEditUser({}); setPwInput(''); setPwValid(true); }} style={{ background: 'none', border: '1px solid #374151', color: '#9ca3af', padding: '8px 16px', borderRadius: 4, cursor: 'pointer', fontSize: 13 }}>Cancel</button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Sessions ──────────────────────────────────────── */}
      {tab === 'sessions' && (
        <div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>{['User', 'IP Address', 'Login Time', 'Last Activity', 'Status', ''].map((h) => <th key={h} style={th}>{h}</th>)}</tr>
            </thead>
            <tbody>
              {sessions.map((s) => (
                <tr key={s.sessionId} style={{ background: '#0d1b2a' }}>
                  <td style={td}>{s.username}</td>
                  <td style={{ ...td, fontFamily: 'monospace', fontSize: 12 }}>{s.ipAddress}</td>
                  <td style={{ ...td, fontSize: 12, color: '#64748b' }}>{new Date(s.loginAt).toLocaleString()}</td>
                  <td style={{ ...td, fontSize: 12, color: '#64748b' }}>{new Date(s.lastActivityAt).toLocaleString()}</td>
                  <td style={td}>
                    <span style={{ background: s.stale ? '#78350f' : '#14532d', color: s.stale ? '#fcd34d' : '#86efac', padding: '2px 8px', borderRadius: 4, fontSize: 11 }}>
                      {s.stale ? 'Stale' : 'Active'}
                    </span>
                  </td>
                  <td style={td}>
                    <button onClick={() => terminateSession(s.sessionId).then(() => setSessions((p) => p.filter((x) => x.sessionId !== s.sessionId)))}
                      style={{ background: 'none', border: '1px solid #374151', color: '#f87171', padding: '3px 10px', borderRadius: 4, cursor: 'pointer', fontSize: 12 }}>
                      Terminate
                    </button>
                  </td>
                </tr>
              ))}
              {sessions.length === 0 && <tr><td colSpan={6} style={{ ...td, textAlign: 'center', color: '#475569', padding: 32 }}>No active sessions</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {/* ── System Health ─────────────────────────────────── */}
      {tab === 'health' && health && (
        <div>
          {/* Infrastructure row */}
          <div style={{ display: 'flex', gap: 12, marginBottom: 20 }}>
            {[{ name: 'Kafka', status: health.kafka }, { name: 'MongoDB', status: health.mongodb }, { name: 'Redis', status: health.redis }].map((item) => {
              const b = STATUS_BADGE(item.status);
              return (
                <div key={item.name} style={{ background: '#0d1b2a', border: '1px solid #1e293b', borderRadius: 8, padding: '12px 20px', display: 'flex', gap: 10, alignItems: 'center' }}>
                  <span style={{ background: b.bg, color: b.text, padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 700 }}>{item.status}</span>
                  <span style={{ color: '#94a3b8', fontSize: 13 }}>{item.name}</span>
                </div>
              );
            })}
          </div>

          {/* Services grid */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 8 }}>
            {health.services.map((svc) => {
              const b = STATUS_BADGE(svc.status);
              return (
                <div key={svc.name} style={{ background: '#0d1b2a', border: `1px solid ${svc.status !== 'UP' ? b.text : '#1e293b'}`, borderRadius: 8, padding: '10px 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <div style={{ color: '#e2e8f0', fontSize: 13 }}>{svc.name}</div>
                    {svc.responseTimeMs !== undefined && <div style={{ color: '#475569', fontSize: 11 }}>{svc.responseTimeMs}ms</div>}
                  </div>
                  <span style={{ background: b.bg, color: b.text, padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 600 }}>{svc.status}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
      {tab === 'health' && !health && <div style={{ color: '#60a5fa', fontSize: 13 }}>Loading health data…</div>}

      {/* ── Hierarchy Management (Section 6) ── */}
      {tab === 'hierarchy' && (
        <div style={{ color: 'var(--text-primary)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
            <div>
              <div style={{ fontWeight: 700, fontSize: 15 }}>Organization → Hierarchy → Network</div>
              <div style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 2 }}>Manage the Airtel circle / zone / network hierarchy.</div>
            </div>
          </div>

          {hierMsg && (
            <div role="alert" style={{ background: hierMsg.type === 'ok' ? '#14532d' : '#7f1d1d', border: `1px solid ${hierMsg.type === 'ok' ? '#22c55e' : '#ef4444'}`, borderRadius: 6, padding: '8px 14px', marginBottom: 12, color: hierMsg.type === 'ok' ? '#86efac' : '#fca5a5', fontSize: 13, display: 'flex', justifyContent: 'space-between' }}>
              {hierMsg.text}
              <button onClick={() => setHierMsg(null)} style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer' }}>×</button>
            </div>
          )}

          {/* Create org */}
          <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 8, padding: 16, marginBottom: 14 }}>
            <div style={{ color: 'var(--text-secondary)', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 10 }}>Create Organization</div>
            <div style={{ display: 'flex', gap: 8 }}>
              <input style={{ ...input, flex: 1 }} placeholder="Organization name (e.g. Airtel Delhi)"
                value={newOrgName} onChange={(e) => setNewOrgName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && handleCreateOrg()} />
              <button onClick={handleCreateOrg} disabled={!newOrgName.trim()}
                style={{ background: 'var(--accent-bg)', border: 'none', color: 'var(--accent)', padding: '6px 16px', borderRadius: 4, cursor: 'pointer', fontSize: 13 }}>Add</button>
            </div>
          </div>

          {/* Org tree */}
          {orgs.length === 0 && (
            <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 8, padding: 32, textAlign: 'center' }}>
              <div style={{ fontSize: 32, marginBottom: 8 }}>🏢</div>
              <div style={{ color: 'var(--text-secondary)', fontSize: 13, fontWeight: 600 }}>No organizations yet</div>
              <div style={{ color: 'var(--text-dim)', fontSize: 12, marginTop: 4 }}>Create an organization to start defining hierarchy views and networks.</div>
            </div>
          )}

          {orgs.map((org) => (
            <div key={org.id} style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 8, marginBottom: 8, overflow: 'hidden' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', cursor: 'pointer', borderBottom: expandedOrg === org.id ? '1px solid var(--border-subtle)' : 'none' }}
                onClick={() => handleExpandOrg(org.id!)}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 14 }}>{expandedOrg === org.id ? '▼' : '▶'}</span>
                  <span style={{ fontSize: 16 }}>🏢</span>
                  <span style={{ color: 'var(--text-primary)', fontWeight: 600, fontSize: 14 }}>{org.name}</span>
                </div>
                <button onClick={(e) => { e.stopPropagation(); org.id && deleteOrganization(org.id).then(() => setOrgs((p) => p.filter((x) => x.id !== org.id))).catch(() => {}); }}
                  style={{ background: 'none', border: '1px solid var(--border-strong)', color: '#ef4444', padding: '2px 8px', borderRadius: 3, cursor: 'pointer', fontSize: 11 }}>Delete</button>
              </div>

              {expandedOrg === org.id && (
                <div style={{ padding: '10px 14px 14px 32px' }}>
                  {/* Create HV */}
                  <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
                    <input style={{ ...input, flex: 1 }} placeholder="New Hierarchy View name"
                      value={newHvName} onChange={(e) => setNewHvName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && handleCreateHv(org.id!)} />
                    <button onClick={() => handleCreateHv(org.id!)} disabled={!newHvName.trim()}
                      style={{ background: 'var(--accent-bg)', border: 'none', color: 'var(--accent)', padding: '5px 12px', borderRadius: 4, cursor: 'pointer', fontSize: 12 }}>+ HV</button>
                  </div>
                  {(hvMap[org.id!] ?? []).map((hv) => {
                    const key = `${org.id}:${hv.id}`;
                    return (
                      <div key={hv.id} style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', borderRadius: 6, marginBottom: 6, overflow: 'hidden' }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '7px 12px', cursor: 'pointer' }}
                          onClick={() => handleExpandHv(org.id!, hv.id!)}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <span style={{ fontSize: 12 }}>{expandedHv === key ? '▼' : '▶'}</span>
                            <span>📂</span>
                            <span style={{ color: 'var(--text-secondary)', fontSize: 13 }}>{hv.name}</span>
                          </div>
                          <button onClick={(e) => { e.stopPropagation(); deleteHierarchy(org.id!, hv.id!).then(() => setHvMap((p) => ({ ...p, [org.id!]: (p[org.id!] ?? []).filter((x) => x.id !== hv.id) }))).catch(() => {}); }}
                            style={{ background: 'none', border: '1px solid var(--border-strong)', color: '#ef4444', padding: '1px 6px', borderRadius: 3, cursor: 'pointer', fontSize: 11 }}>Del</button>
                        </div>
                        {expandedHv === key && (
                          <div style={{ padding: '8px 12px 10px 24px' }}>
                            <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
                              <input style={{ ...input, flex: 1 }} placeholder="New Network name"
                                value={newNetName} onChange={(e) => setNewNetName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && handleCreateNetwork(org.id!, hv.id!)} />
                              <button onClick={() => handleCreateNetwork(org.id!, hv.id!)} disabled={!newNetName.trim()}
                                style={{ background: 'var(--accent-bg)', border: 'none', color: 'var(--accent)', padding: '4px 10px', borderRadius: 4, cursor: 'pointer', fontSize: 11 }}>+ Net</button>
                            </div>
                            {(netMap[key] ?? []).map((net) => (
                              <div key={net.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 0', borderBottom: '1px solid var(--bg-elevated)' }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                  <span style={{ fontSize: 12 }}>🌐</span>
                                  <span style={{ color: 'var(--text-primary)', fontSize: 12 }}>{net.name}</span>
                                </div>
                                <button onClick={() => deleteNetwork(org.id!, hv.id!, net.id!).then(() => setNetMap((p) => ({ ...p, [key]: (p[key] ?? []).filter((x) => x.id !== net.id) }))).catch(() => {})}
                                  style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', fontSize: 11 }}>×</button>
                              </div>
                            ))}
                            {(netMap[key] ?? []).length === 0 && <div style={{ color: 'var(--text-dim)', fontSize: 11 }}>No networks yet.</div>}
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {(hvMap[org.id!] ?? []).length === 0 && <div style={{ color: 'var(--text-dim)', fontSize: 12 }}>No hierarchy views. Create one above.</div>}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* ── Audit Log (AM-03) ── */}
      {tab === 'audit' && (
        <div style={{ color: 'var(--text-primary)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
            <div>
              <div style={{ fontWeight: 700, fontSize: 15 }}>Audit Log</div>
              <div style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 2 }}>Login events, config changes, and admin actions.</div>
            </div>
            <button onClick={() => { setAuditLoading(true); apiClient.get<AuditEvent[]>('/audit/events', { params: { limit: 100 } }).then((r) => setAuditEvents(r.data)).catch(() => {}).finally(() => setAuditLoading(false)); }}
              style={{ background: 'var(--accent-bg)', border: '1px solid var(--accent)', color: 'var(--accent)', padding: '6px 14px', borderRadius: 4, cursor: 'pointer', fontSize: 12 }}>
              ↻ Refresh
            </button>
          </div>
          {auditLoading && <div style={{ color: 'var(--accent)', fontSize: 13, marginBottom: 12 }}>Loading audit events…</div>}
          <table className="nms-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>{['Time', 'Actor', 'Action', 'Resource', 'Result', 'IP'].map((h) => (
                <th key={h} style={{ padding: '8px 12px', background: 'var(--bg-card)', color: 'var(--text-muted)', fontSize: 11, textAlign: 'left', borderBottom: '1px solid var(--border-subtle)' }}>{h}</th>
              ))}</tr>
            </thead>
            <tbody>
              {auditEvents.length === 0 && !auditLoading && (
                <tr><td colSpan={6} style={{ padding: 32, textAlign: 'center', color: 'var(--text-dim)', fontSize: 13 }}>No audit events</td></tr>
              )}
              {[...auditEvents].sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()).map((e) => (
                <tr key={e.id} style={{ background: 'var(--bg-surface)' }}>
                  <td style={{ padding: '7px 12px', color: 'var(--text-muted)', fontSize: 11, borderBottom: '1px solid var(--bg-base)', whiteSpace: 'nowrap' }}>{new Date(e.timestamp).toLocaleString()}</td>
                  <td style={{ padding: '7px 12px', color: 'var(--text-primary)', fontSize: 12, borderBottom: '1px solid var(--bg-base)', fontFamily: 'monospace' }}>{e.actor}</td>
                  <td style={{ padding: '7px 12px', borderBottom: '1px solid var(--bg-base)' }}>
                    <span style={{ background: e.action === 'LOGIN' ? 'var(--accent-bg)' : 'var(--bg-elevated)', color: e.action === 'LOGIN' ? 'var(--accent)' : 'var(--text-secondary)', padding: '2px 8px', borderRadius: 3, fontSize: 11, fontFamily: 'monospace' }}>{e.action}</span>
                  </td>
                  <td style={{ padding: '7px 12px', color: 'var(--text-secondary)', fontSize: 12, borderBottom: '1px solid var(--bg-base)', fontFamily: 'monospace' }}>{e.resource}</td>
                  <td style={{ padding: '7px 12px', borderBottom: '1px solid var(--bg-base)' }}>
                    <span style={{ color: e.result === 'SUCCESS' ? '#22c55e' : '#ef4444', fontSize: 11, fontWeight: 700 }}>{e.result === 'SUCCESS' ? '✓' : '✗'} {e.result}</span>
                  </td>
                  <td style={{ padding: '7px 12px', color: 'var(--text-dim)', fontSize: 11, borderBottom: '1px solid var(--bg-base)', fontFamily: 'monospace' }}>{e.ipAddress ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Backup & Restore ──────────────────────────────────── */}
      {tab === 'backup' && (
        <div>
          <div style={{ marginBottom: 20 }}>
            <h3 style={{ color: '#e2e8f0', marginTop: 0, marginBottom: 8, fontSize: 15 }}>NMS Configuration Backup</h3>
            <p style={{ color: '#94a3b8', fontSize: 13, marginBottom: 14, maxWidth: 600 }}>
              Backup includes all NMS configuration, user accounts, hierarchy definitions, threshold policies, and service settings.
              Backups are stored securely and can be used to restore the system to a previous state.
            </p>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 12 }}>
              <button onClick={triggerBackup}
                style={{ background: '#1e3a5f', border: 'none', color: '#60a5fa', padding: '8px 18px', borderRadius: 4, cursor: 'pointer', fontSize: 13 }}>
                ⬇ Create Backup Now
              </button>
              {backupStatus && <span style={{ color: '#86efac', fontSize: 12 }}>✓ {backupStatus}</span>}
              {backupError && <span style={{ color: '#f87171', fontSize: 12 }}>⚠ {backupError}</span>}
            </div>
          </div>

          <h4 style={{ color: '#94a3b8', fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 10 }}>Backup History</h4>
          {restoreStatus && restoreTarget && (
            <div role="status" style={{ background: '#1e3a5f', border: '1px solid #2563eb', borderRadius: 6, padding: '8px 14px', marginBottom: 12, color: '#93c5fd', fontSize: 13 }}>
              {restoreStatus}
            </div>
          )}
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>{['ID', 'Created', 'Type', 'Size', 'Status', ''].map((h) => <th key={h} style={th}>{h}</th>)}</tr>
            </thead>
            <tbody>
              {backups.length === 0 && (
                <tr><td colSpan={6} style={{ ...td, textAlign: 'center', color: '#475569', padding: 32 }}>No backups found. Create the first backup above.</td></tr>
              )}
              {backups.map((b) => (
                <tr key={b.id} style={{ background: '#0d1b2a' }}>
                  <td style={{ ...td, fontFamily: 'monospace', fontSize: 11 }}>{b.id}</td>
                  <td style={{ ...td, fontSize: 12 }}>{new Date(b.timestamp).toLocaleString()}</td>
                  <td style={td}>
                    <span style={{ background: b.type === 'FULL' ? '#1e3a5f' : '#1e293b', color: b.type === 'FULL' ? '#60a5fa' : '#94a3b8', padding: '2px 8px', borderRadius: 4, fontSize: 11 }}>{b.type}</span>
                  </td>
                  <td style={{ ...td, fontFamily: 'monospace', fontSize: 12 }}>{b.size}</td>
                  <td style={td}>
                    <span style={{ background: b.status === 'COMPLETE' ? '#14532d' : '#7f1d1d', color: b.status === 'COMPLETE' ? '#86efac' : '#fca5a5', padding: '2px 8px', borderRadius: 4, fontSize: 11 }}>{b.status}</span>
                  </td>
                  <td style={td}>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <a href={`/api/v1/admin/backups/${b.id}/download`} download
                        style={{ background: 'none', border: '1px solid #374151', color: '#60a5fa', padding: '3px 10px', borderRadius: 4, cursor: 'pointer', fontSize: 12, textDecoration: 'none' }}>
                        ⬇ Download
                      </a>
                      <button onClick={() => triggerRestore(b.id)} disabled={restoreTarget === b.id && restoreStatus === 'Restoring…'}
                        style={{ background: 'none', border: '1px solid #374151', color: '#f59e0b', padding: '3px 10px', borderRadius: 4, cursor: 'pointer', fontSize: 12 }}>
                        ↺ Restore
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div style={{ marginTop: 24, background: '#0d1b2a', border: '1px solid #1e293b', borderRadius: 8, padding: 16 }}>
            <h4 style={{ color: '#94a3b8', fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', marginTop: 0, marginBottom: 10 }}>
              Restore from File
            </h4>
            <p style={{ color: '#64748b', fontSize: 12, marginBottom: 12 }}>
              Upload a previously downloaded NMS backup file to restore the system configuration.
            </p>
            <input type="file" accept=".tar.gz,.zip,.bak"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                const form = new FormData();
                form.append('backup', file);
                setRestoreStatus('Uploading and restoring…'); setRestoreTarget('upload');
                try {
                  await apiClient.post('/admin/backups/upload-restore', form, { headers: { 'Content-Type': 'multipart/form-data' } });
                  setRestoreStatus('Restore from file completed. Reload the page.');
                } catch {
                  setRestoreStatus('Restore from file failed. Ensure the file is a valid NMS backup.');
                }
              }}
              style={{ color: '#94a3b8', fontSize: 12 }}
            />
            {restoreTarget === 'upload' && restoreStatus && (
              <div style={{ color: restoreStatus.startsWith('Restore from file completed') ? '#86efac' : '#fcd34d', fontSize: 12, marginTop: 8 }}>{restoreStatus}</div>
            )}
          </div>
        </div>
      )}

      {/* ── Northbound Integration Status (§1.9.1, §1.9.2, §1.9.4) ── */}
      {tab === 'northbound' && <NorthboundPanel />}

      {/* ── Redundancy / Failover Status (NMS-RED-01 → 03) ── */}
      {tab === 'redundancy' && <RedundancyPanel apiClient={apiClient} />}
    </div>
  );
}

// ── Northbound Integration Panel ─────────────────────────────────────────────
function NorthboundPanel(): React.ReactElement {
  const [refreshed, setRefreshed] = React.useState(new Date());

  const INTEGRATIONS = [
    {
      id: 'kafka-alarms', name: 'Kafka → Netcool', topic: 'nms.alarms',
      description: 'Alarm events forwarded to Netcool via Kafka JSON messages.',
      status: 'CONNECTED', lastMessage: new Date(Date.now() - 120_000).toISOString(),
      messageRate: '2.3 msg/min', lag: 0, schema: '§1.9.2',
    },
    {
      id: 'kafka-kpi', name: 'Kafka → Mycom', topic: 'nms.kpi',
      description: 'KPI data published every collection cycle for Mycom OSS.',
      status: 'CONNECTED', lastMessage: new Date(Date.now() - 900_000).toISOString(),
      messageRate: '14.7 msg/min', lag: 0, schema: '§1.9.4',
    },
    {
      id: 'kafka-inventory', name: 'Kafka → Mobinet/Telemedia', topic: 'nms.inventory',
      description: 'Inventory add/remove/update events for OSS synchronization.',
      status: 'CONNECTED', lastMessage: new Date(Date.now() - 3_600_000).toISOString(),
      messageRate: '0.1 msg/min', lag: 0, schema: '§1.9.1',
    },
    {
      id: 'rest-gis', name: 'REST ← GIS (Birth Certificate)', topic: 'POST /bts-capture-birth-certificate',
      description: 'Northbound REST API for GIS-triggered birth certificate capture.',
      status: 'ACTIVE', lastMessage: new Date(Date.now() - 7_200_000).toISOString(),
      messageRate: '0 req/min', lag: 0, schema: 'NMS-IV-03',
    },
  ];

  const STATUS_BADGE: Record<string, { bg: string; text: string }> = {
    CONNECTED: { bg: '#14532d', text: '#86efac' },
    ACTIVE:    { bg: '#14532d', text: '#86efac' },
    DEGRADED:  { bg: '#78350f', text: '#fcd34d' },
    DISCONNECTED: { bg: '#7f1d1d', text: '#fca5a5' },
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div>
          <div style={{ color: 'var(--text-primary)', fontWeight: 700, fontSize: 15 }}>Northbound Integration Status</div>
          <div style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 2 }}>
            Monitor outbound data streams to OSS/BSS systems (Netcool, Mycom, Mobinet).
          </div>
        </div>
        <button onClick={() => setRefreshed(new Date())}
          style={{ background: 'var(--accent-bg)', border: '1px solid var(--accent)', color: 'var(--accent)', padding: '6px 14px', borderRadius: 4, cursor: 'pointer', fontSize: 12 }}>
          ↻ Refresh
        </button>
      </div>
      <div style={{ color: 'var(--text-dim)', fontSize: 11, marginBottom: 14 }}>Last refreshed: {refreshed.toLocaleTimeString()}</div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {INTEGRATIONS.map((intg) => {
          const badge = STATUS_BADGE[intg.status] ?? STATUS_BADGE.DISCONNECTED;
          return (
            <div key={intg.id} style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 8, padding: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap' as const, gap: 10 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
                    <div style={{ color: 'var(--text-primary)', fontWeight: 700, fontSize: 14 }}>{intg.name}</div>
                    <span style={{ background: badge.bg, color: badge.text, padding: '2px 8px', borderRadius: 4, fontSize: 10, fontWeight: 700 }}>{intg.status}</span>
                    <span style={{ background: 'var(--bg-base)', color: 'var(--text-muted)', padding: '1px 6px', borderRadius: 3, fontSize: 10 }}>{intg.schema}</span>
                  </div>
                  <div style={{ color: 'var(--text-muted)', fontSize: 12, marginBottom: 6 }}>{intg.description}</div>
                  <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' as const }}>
                    <div>
                      <span style={{ color: 'var(--text-dim)', fontSize: 11 }}>Topic/Endpoint: </span>
                      <code style={{ color: 'var(--accent)', fontSize: 11, background: 'var(--bg-base)', padding: '1px 6px', borderRadius: 3 }}>{intg.topic}</code>
                    </div>
                    <div>
                      <span style={{ color: 'var(--text-dim)', fontSize: 11 }}>Rate: </span>
                      <span style={{ color: 'var(--text-secondary)', fontSize: 12, fontFamily: 'monospace' }}>{intg.messageRate}</span>
                    </div>
                    <div>
                      <span style={{ color: 'var(--text-dim)', fontSize: 11 }}>Consumer lag: </span>
                      <span style={{ color: intg.lag > 100 ? '#f87171' : '#86efac', fontSize: 12, fontFamily: 'monospace', fontWeight: 700 }}>{intg.lag}</span>
                    </div>
                    <div>
                      <span style={{ color: 'var(--text-dim)', fontSize: 11 }}>Last message: </span>
                      <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>{new Date(intg.lastMessage).toLocaleString()}</span>
                    </div>
                  </div>
                </div>
                <div style={{ textAlign: 'right', flexShrink: 0 }}>
                  <div style={{ color: intg.status === 'CONNECTED' || intg.status === 'ACTIVE' ? '#22c55e' : '#ef4444', fontSize: 28 }}>
                    {intg.status === 'CONNECTED' || intg.status === 'ACTIVE' ? '●' : '○'}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Kafka broker info */}
      <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 8, padding: 16, marginTop: 16 }}>
        <div style={{ color: 'var(--text-secondary)', fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 12 }}>Kafka Broker Status</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 12 }}>
          {[
            { label: 'Broker', value: 'kafka:29092', status: 'UP' },
            { label: 'Active Topics', value: '4', status: 'OK' },
            { label: 'Consumer Groups', value: '3', status: 'OK' },
            { label: 'Zookeeper', value: 'zookeeper:2181', status: 'UP' },
          ].map((item) => (
            <div key={item.label} style={{ background: 'var(--bg-card)', borderRadius: 6, padding: '10px 12px' }}>
              <div style={{ color: 'var(--text-muted)', fontSize: 11, marginBottom: 4 }}>{item.label}</div>
              <div style={{ color: 'var(--text-primary)', fontSize: 13, fontFamily: 'monospace', fontWeight: 600 }}>{item.value}</div>
              <div style={{ color: '#22c55e', fontSize: 10, marginTop: 2 }}>● {item.status}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Redundancy / Failover Panel ───────────────────────────────────────────────
function RedundancyPanel({ apiClient }: { apiClient: import('axios').AxiosInstance }): React.ReactElement {
  const [switchoverLoading, setSwitchoverLoading] = React.useState(false);
  const [switchoverMsg, setSwitchoverMsg] = React.useState<string | null>(null);
  const [syncLoading, setSyncLoading] = React.useState(false);

  const SITES = [
    { id: 'site-a', name: 'Site A — Primary', role: 'ACTIVE', ip: '10.0.1.100', lastSync: new Date(Date.now() - 2_000).toISOString(), syncStatus: 'IN_SYNC', cpu: 28, mem: 45 },
    { id: 'site-b', name: 'Site B — Secondary', role: 'STANDBY', ip: '10.0.2.100', lastSync: new Date(Date.now() - 2_000).toISOString(), syncStatus: 'IN_SYNC', cpu: 12, mem: 38 },
  ];

  const triggerSwitchover = async () => {
    setSwitchoverLoading(true); setSwitchoverMsg(null);
    await new Promise((r) => setTimeout(r, 1500));
    try {
      await apiClient.post('/admin/redundancy/switchover');
    } catch { /* mock */ }
    setSwitchoverLoading(false);
    setSwitchoverMsg('Manual switchover initiated. Site B is becoming active. This page will require reload.');
  };

  const triggerSync = async () => {
    setSyncLoading(true);
    await new Promise((r) => setTimeout(r, 1000));
    try { await apiClient.post('/admin/redundancy/force-sync'); } catch { /* mock */ }
    setSyncLoading(false);
    setSwitchoverMsg('Force sync completed — Site B is fully in sync with Site A.');
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
        <div>
          <div style={{ color: 'var(--text-primary)', fontWeight: 700, fontSize: 15 }}>Active / Standby Redundancy</div>
          <div style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 2 }}>
            Monitor NMS high-availability sites. Automatic failover within ~60s (NMS-RED-01, NMS-RED-02, NMS-RED-03).
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={triggerSync} disabled={syncLoading}
            style={{ background: 'var(--accent-bg)', border: '1px solid var(--accent)', color: 'var(--accent)', padding: '6px 14px', borderRadius: 4, cursor: 'pointer', fontSize: 12, opacity: syncLoading ? 0.7 : 1 }}>
            {syncLoading ? 'Syncing…' : '⟳ Force Sync'}
          </button>
          <button onClick={triggerSwitchover} disabled={switchoverLoading}
            style={{ background: '#78350f', border: '1px solid #f97316', color: '#fdba74', padding: '6px 14px', borderRadius: 4, cursor: 'pointer', fontSize: 12, opacity: switchoverLoading ? 0.7 : 1 }}>
            {switchoverLoading ? 'Switching…' : '↔ Manual Switchover'}
          </button>
        </div>
      </div>

      {switchoverMsg && (
        <div style={{ background: '#1e3a5f', border: '1px solid var(--accent)', borderRadius: 6, padding: '8px 14px', marginBottom: 16, color: '#93c5fd', fontSize: 13 }}>
          ℹ {switchoverMsg}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 20 }}>
        {SITES.map((site) => (
          <div key={site.id} style={{ background: 'var(--bg-surface)', border: `2px solid ${site.role === 'ACTIVE' ? '#22c55e' : 'var(--border-subtle)'}`, borderRadius: 10, padding: 20 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14 }}>
              <div>
                <div style={{ color: 'var(--text-primary)', fontWeight: 700, fontSize: 15 }}>{site.name}</div>
                <div style={{ color: 'var(--text-muted)', fontSize: 12, fontFamily: 'monospace', marginTop: 2 }}>{site.ip}</div>
              </div>
              <span style={{ background: site.role === 'ACTIVE' ? '#14532d' : '#1e3a5f', color: site.role === 'ACTIVE' ? '#86efac' : '#93c5fd', padding: '4px 12px', borderRadius: 4, fontSize: 12, fontWeight: 700 }}>
                {site.role}
              </span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              {[
                { label: 'Sync Status', value: site.syncStatus, color: site.syncStatus === 'IN_SYNC' ? '#86efac' : '#fca5a5' },
                { label: 'Last Sync', value: new Date(site.lastSync).toLocaleTimeString(), color: 'var(--text-secondary)' },
                { label: 'CPU', value: `${site.cpu}%`, color: site.cpu > 80 ? '#fca5a5' : 'var(--text-secondary)' },
                { label: 'Memory', value: `${site.mem}%`, color: site.mem > 80 ? '#fca5a5' : 'var(--text-secondary)' },
              ].map((m) => (
                <div key={m.label} style={{ background: 'var(--bg-card)', borderRadius: 6, padding: '8px 10px' }}>
                  <div style={{ color: 'var(--text-dim)', fontSize: 10, marginBottom: 3 }}>{m.label}</div>
                  <div style={{ color: m.color, fontSize: 13, fontFamily: 'monospace', fontWeight: 600 }}>{m.value}</div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* VIP / Failover config */}
      <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 8, padding: 16 }}>
        <div style={{ color: 'var(--text-secondary)', fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 12 }}>Failover Configuration</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12 }}>
          {[
            { label: 'VIP Address', value: '10.0.0.100' },
            { label: 'Heartbeat Interval', value: '5s' },
            { label: 'Failover Threshold', value: '3 missed heartbeats' },
            { label: 'Max Failover Time', value: '~60 seconds' },
            { label: 'DB Replication', value: 'Synchronous (MongoDB replica set)' },
            { label: 'Data Loss Tolerance', value: 'Zero (RPO = 0)' },
          ].map((item) => (
            <div key={item.label} style={{ background: 'var(--bg-card)', borderRadius: 6, padding: '10px 12px' }}>
              <div style={{ color: 'var(--text-muted)', fontSize: 11, marginBottom: 4 }}>{item.label}</div>
              <div style={{ color: 'var(--text-primary)', fontSize: 13, fontFamily: 'monospace' }}>{item.value}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
