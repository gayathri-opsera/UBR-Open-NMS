import React, { useEffect, useState } from 'react';
import type { NmsUser, UserSession, SystemHealth, UserRole } from '../api/admin.types';
import { apiClient } from '../api/client';
import { createUser, deleteUser, fetchSessions, fetchSystemHealth, fetchUsers, terminateSession, updateUser } from '../api/admin.api';

type AdminTab = 'users' | 'sessions' | 'health' | 'hierarchy' | 'audit' | 'backup';

const TABS: { id: AdminTab; label: string }[] = [
  { id: 'users', label: 'Users' },
  { id: 'sessions', label: 'Sessions' },
  { id: 'health', label: 'System Health' },
  { id: 'hierarchy', label: 'Hierarchy' },
  { id: 'audit', label: 'Audit Log' },
  { id: 'backup', label: 'Backup & Restore' },
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

  // Backup/Restore state
  const [backups, setBackups] = useState<BackupEntry[]>([]);
  const [backupStatus, setBackupStatus] = useState<string | null>(null);
  const [backupError, setBackupError] = useState<string | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<string | null>(null);
  const [restoreStatus, setRestoreStatus] = useState<string | null>(null);

  useEffect(() => { fetchUsers().then(setUsers).catch(() => {}); }, []);
  useEffect(() => { if (tab === 'sessions') fetchSessions().then(setSessions).catch(() => {}); }, [tab]);
  useEffect(() => { if (tab === 'health') fetchSystemHealth().then(setHealth).catch(() => {}); }, [tab]);
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
    background: tab === id ? '#1e3a5f' : 'none',
    border: `1px solid ${tab === id ? '#60a5fa' : '#374151'}`,
    color: tab === id ? '#60a5fa' : '#64748b',
    padding: '6px 14px', borderRadius: 4, cursor: 'pointer', fontSize: 13,
  });
  const input: React.CSSProperties = {
    background: '#0f172a', border: '1px solid #1e3a5f', borderRadius: 4,
    color: '#e2e8f0', padding: '6px 10px', fontSize: 13, width: '100%', boxSizing: 'border-box',
  };
  const th: React.CSSProperties = { padding: '8px 12px', background: '#0f172a', color: '#64748b', fontSize: 12, textAlign: 'left', borderBottom: '1px solid #1e293b' };
  const td: React.CSSProperties = { padding: '8px 12px', borderBottom: '1px solid #0f172a', fontSize: 13, color: '#cbd5e1' };

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

      {/* ── Hierarchy & Audit: stubs for now ─────────────── */}
      {tab === 'hierarchy' && (
        <div style={{ color: '#94a3b8', fontSize: 13, padding: 32, textAlign: 'center' }}>
          Hierarchy management — Organization → Hierarchy View → Network CRUD
          <br /><br />
          <span style={{ color: '#475569' }}>API integration via /api/v1/admin/hierarchy</span>
        </div>
      )}
      {tab === 'audit' && (
        <div style={{ color: '#94a3b8', fontSize: 13, padding: 32, textAlign: 'center' }}>
          Audit log viewer — last 24h events from Audit Service
          <br /><br />
          <span style={{ color: '#475569' }}>API integration via GET /api/v1/audit/events</span>
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
    </div>
  );
}

interface BackupEntry {
  id: string;
  timestamp: string;
  size: string;
  status: 'COMPLETE' | 'PARTIAL' | 'FAILED';
  type: 'FULL' | 'INCREMENTAL';
}
