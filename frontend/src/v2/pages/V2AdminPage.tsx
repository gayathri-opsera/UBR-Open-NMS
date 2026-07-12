import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchUsers, createUser, updateUser, deleteUser, resetPassword,
  fetchSessions, terminateSession, fetchSystemHealth,
  fetchAuditLog, fetchBackups, triggerBackup, restoreBackup, deleteBackup,
  fetchNorthboundConfig, updateNorthboundConfig,
  fetchRedundancyStatus, forceSyncRedundancy, triggerManualSwitchover,
} from '../../api/admin.api';
import type {
  NmsUser, UserRole, UserSession, SystemHealth, ServiceStatus,
  AuditEntry, BackupRecord, NorthboundConfig, RedundancyStatus, RedundancySite,
} from '../../api/admin.types';
import {
  fetchOrganizations, fetchHierarchies, fetchNetworks,
  createOrganization, createHierarchy, createNetwork,
} from '../../api/hierarchy.api';
import type { Organization, HierarchyView as HierarchyViewType, Network } from '../../api/hierarchy.api';

// ── ITSAR Password Policy (REQ-011 / NMS-SEC-03) ───────────────────────────────
// ITSAR requires: ≥12 chars, upper + lower + digit + special, no repeated chars
interface PasswordCheck { label: string; pass: boolean; }
function evalPassword(pwd: string): PasswordCheck[] {
  return [
    { label: 'At least 12 characters',             pass: pwd.length >= 12 },
    { label: 'Uppercase letter (A–Z)',              pass: /[A-Z]/.test(pwd) },
    { label: 'Lowercase letter (a–z)',              pass: /[a-z]/.test(pwd) },
    { label: 'Digit (0–9)',                         pass: /\d/.test(pwd) },
    { label: 'Special character (!@#$%^&* etc.)',   pass: /[^A-Za-z0-9]/.test(pwd) },
    { label: 'No three repeated characters',        pass: !/(.)\1\1/.test(pwd) },
  ];
}
function passwordStrength(checks: PasswordCheck[]): { score: number; label: string; color: string } {
  const pass = checks.filter((c) => c.pass).length;
  if (pass <= 2) return { score: pass, label: 'Weak',   color: '#ef4444' };
  if (pass <= 4) return { score: pass, label: 'Fair',   color: '#f59e0b' };
  if (pass === 5) return { score: pass, label: 'Good',  color: '#3b82f6' };
  return           { score: pass, label: 'Strong', color: '#22c55e' };
}

function PasswordStrengthWidget({ password }: { password: string }) {
  if (!password) return null;
  const checks   = evalPassword(password);
  const strength = passwordStrength(checks);
  const total    = checks.length;
  return (
    <div style={{ marginTop: 8 }}>
      {/* Progress bar */}
      <div style={{ height: 4, background: 'rgba(255,255,255,0.1)', borderRadius: 4, marginBottom: 8, overflow: 'hidden' }}>
        <div style={{
          height: '100%', borderRadius: 4, transition: 'width 0.3s, background 0.3s',
          width: `${(strength.score / total) * 100}%`,
          background: strength.color,
        }} />
      </div>
      <div style={{ fontSize: 11, color: strength.color, fontWeight: 600, marginBottom: 6 }}>
        Strength: {strength.label}
      </div>
      {/* Checklist */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        {checks.map((c) => (
          <div key={c.label} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: c.pass ? '#22c55e' : 'rgba(148,163,184,0.7)' }}>
            <span>{c.pass ? '✓' : '○'}</span>
            <span>{c.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function isPasswordValid(pwd: string): boolean {
  return evalPassword(pwd).every((c) => c.pass);
}
import { Badge } from '../components/common/Badge';
import { Button } from '../components/common/Button';
import { Input } from '../components/common/Input';
import { Select } from '../components/common/Select';
import { Modal } from '../components/common/Modal';
import { MetricCard } from '../components/common/MetricCard';
import { LoadingState, EmptyState } from '../components/common/States';
import { useToast } from '../components/common/Toast';
import { logger } from '../utils/logger';

type AdminTab = 'users' | 'sessions' | 'health' | 'hierarchy' | 'audit' | 'backup' | 'northbound' | 'redundancy';

const ROLE_OPTIONS = [
  { value: 'admin',    label: 'Admin' },
  { value: 'operator', label: 'Operator' },
  { value: 'user',     label: 'Viewer' },
];

// Map legacy/display role values to backend-valid values
function normalizeRole(r: string): string {
  const lower = r.toLowerCase();
  if (lower === 'viewer') return 'user';
  return lower;
}

interface UserFormState {
  username: string; email: string; role: UserRole; password: string;
}
const EMPTY_FORM: UserFormState = { username: '', email: '', role: 'user' as UserRole, password: '' };

// ── Status colour helpers ──────────────────────────────────────────────────────
function svcVariant(s: ServiceStatus): 'success' | 'warning' | 'danger' {
  if (s === 'UP')       return 'success';
  if (s === 'DEGRADED') return 'warning';
  return 'danger';
}
function infraVariant(s: ServiceStatus) { return svcVariant(s); }
function formatUptime(ms?: number): string {
  if (!ms) return '—';
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// ── Tab bar ───────────────────────────────────────────────────────────────────
function TabBtn({ id, active, label, onClick }: { id: AdminTab; active: boolean; label: string; onClick: (t: AdminTab) => void }) {
  return (
    <button onClick={() => onClick(id)}
      style={{
        padding: '10px 16px', border: 'none', background: 'none', cursor: 'pointer',
        fontSize: 13, fontWeight: active ? 700 : 500, whiteSpace: 'nowrap',
        color: active ? '#60a5fa' : 'rgba(255,255,255,0.75)',
        borderBottom: active ? '2px solid #60a5fa' : '2px solid transparent',
        transition: 'color 0.15s',
      }}>
      {label}
    </button>
  );
}

// ── Small shared helpers ───────────────────────────────────────────────────────
function FieldInput({ value, onChange, placeholder, type = 'text', disabled }: { value: string | number; onChange: (v: string) => void; placeholder?: string; type?: string; disabled?: boolean }) {
  return (
    <input
      type={type} value={value} placeholder={placeholder} disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      style={{ width: '100%', padding: '7px 10px', borderRadius: 6, border: '1px solid var(--vf-border-subtle)', background: 'var(--vf-surface)', color: 'var(--vf-text-primary)', fontSize: 13, outline: 'none' }}
    />
  );
}
function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--vf-text-muted)', marginBottom: 6 }}>{children}</div>;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Users tab
// ═══════════════════════════════════════════════════════════════════════════════
function UsersTab() {
  const { addToast } = useToast();
  const [users, setUsers]         = useState<NmsUser[]>([]);
  const [loading, setLoading]     = useState(true);
  const [search, setSearch]       = useState('');
  const [editUser, setEditUser]   = useState<NmsUser | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showDelete, setShowDelete] = useState<NmsUser | null>(null);
  const [showPwd, setShowPwd]     = useState<NmsUser | null>(null);
  const [formState, setFormState] = useState<UserFormState>(EMPTY_FORM);
  const [newPwd, setNewPwd]       = useState('');
  const [saving, setSaving]       = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    fetchUsers()
      .then(setUsers)
      .catch((e) => { logger.error('Users fetch failed', e); addToast('Failed to load users', 'error'); })
      .finally(() => setLoading(false));
  }, [addToast]);

  useEffect(load, [load]);

  const openCreate = () => { setFormState(EMPTY_FORM); setEditUser(null); setShowCreate(true); };
  const openEdit   = (u: NmsUser) => { setFormState({ username: u.username, email: u.email ?? '', role: normalizeRole(u.role) as UserRole, password: '' }); setEditUser(u); setShowCreate(true); };

  const handleSave = async () => {
    if (!formState.username || !formState.role) { addToast('Username and role are required', 'warning'); return; }
    if (!formState.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formState.email)) {
      addToast('A valid email address is required', 'warning'); return;
    }
    if (!editUser) {
      if (!formState.password) { addToast('Password required for new user', 'warning'); return; }
      if (!isPasswordValid(formState.password)) {
        addToast('Password does not meet ITSAR policy requirements', 'warning'); return;
      }
    }
    setSaving(true);
    try {
      if (editUser) {
        const updated = await updateUser(editUser.id, { username: formState.username, email: formState.email, role: formState.role });
        setUsers((u) => u.map((x) => x.id === updated.id ? updated : x));
        addToast('User updated', 'success');
      } else {
        const created = await createUser({ ...formState });
        setUsers((u) => [...u, created]);
        addToast('User created', 'success');
      }
      setShowCreate(false);
    } catch (e) { logger.error('User save failed', e); addToast('Failed to save user', 'error'); }
    finally { setSaving(false); }
  };

  const handleDelete = async () => {
    if (!showDelete) return;
    try {
      await deleteUser(showDelete.id);
      setUsers((u) => u.filter((x) => x.id !== showDelete.id));
      addToast('User deleted', 'success');
    } catch { addToast('Failed to delete user', 'error'); }
    finally { setShowDelete(null); }
  };

  const handleResetPwd = async () => {
    if (!showPwd || !newPwd) return;
    try { await resetPassword(showPwd.id, newPwd); addToast('Password reset', 'success'); }
    catch { addToast('Failed to reset password', 'error'); }
    finally { setShowPwd(null); setNewPwd(''); }
  };

  const visible = users.filter((u) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return [u.username, u.email, u.role].some((v) => (v ?? '').toLowerCase().includes(q));
  });

  const adminCount    = users.filter((u) => ['admin', 'Admin'].includes(u.role)).length;
  const operatorCount = users.filter((u) => ['operator', 'Operator'].includes(u.role)).length;

  return (
    <>
      <div className="vf-kpi-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', marginBottom: 20 }}>
        <MetricCard label="Total Users"  value={users.length}                         loading={loading} />
        <MetricCard label="Admins"       value={adminCount}                           loading={loading} />
        <MetricCard label="Operators"    value={operatorCount}                        loading={loading} />
        <MetricCard label="Viewers"      value={users.length - adminCount - operatorCount} loading={loading} />
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 16 }}>
        <Input placeholder="Search users…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ width: 280 }} />
        <Button variant="ghost" size="sm" onClick={() => setSearch('')}>Clear</Button>
        <div style={{ flex: 1 }} />
        <Button variant="primary" size="sm" onClick={openCreate}>+ New User</Button>
      </div>

      {loading ? (
        <LoadingState label="Loading users…" />
      ) : visible.length === 0 ? (
        <EmptyState title="No users" description={search ? 'No users match the search.' : 'No users yet.'} action={<Button onClick={openCreate}>Create User</Button>} />
      ) : (
        <div style={{ overflowX: 'auto', border: '1px solid rgba(77,158,255,0.1)', borderRadius: 10 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: 'var(--vf-surface)' }}>
                {['Username', 'Email', 'Role', 'Last Login', 'Status', 'Actions'].map((h) => (
                  <th key={h} style={{ padding: '10px 12px', textAlign: 'left', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--vf-text-muted)', borderBottom: '1px solid var(--vf-border-subtle)' }}>{h !== 'Actions' ? h : ''}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visible.map((u) => (
                <tr key={u.id} style={{ borderBottom: '1px solid var(--vf-border-subtle)' }}>
                  <td style={{ padding: '9px 12px', fontWeight: 600, color: 'var(--vf-text-primary)' }}>{u.username}</td>
                  <td style={{ padding: '9px 12px', color: 'var(--vf-text-secondary)' }}>{u.email ?? '—'}</td>
                  <td style={{ padding: '9px 12px' }}>
                    <Badge variant={['admin','Admin'].includes(u.role) ? 'danger' : ['operator','Operator'].includes(u.role) ? 'warning' : 'default'}>{u.role}</Badge>
                  </td>
                  <td style={{ padding: '9px 12px', color: 'var(--vf-text-muted)', fontSize: 12 }}>
                    {(u.lastLoginAt ?? u.lastLogin) ? new Date(u.lastLoginAt ?? u.lastLogin!).toLocaleString() : '—'}
                  </td>
                  <td style={{ padding: '9px 12px' }}>
                    <Badge variant={(u.isActive ?? u.enabled) !== false ? 'success' : 'default'} dot>
                      {(u.isActive ?? u.enabled) !== false ? 'Active' : 'Inactive'}
                    </Badge>
                  </td>
                  <td style={{ padding: '9px 12px' }}>
                    <div style={{ display: 'flex', gap: 4 }}>
                      <Button variant="ghost" size="sm" onClick={() => openEdit(u)}>Edit</Button>
                      <Button variant="ghost" size="sm" onClick={() => { setShowPwd(u); setNewPwd(''); }}>Reset Pwd</Button>
                      <Button variant="danger" size="sm" onClick={() => setShowDelete(u)}>Delete</Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal open={showCreate} onClose={() => setShowCreate(false)} title={editUser ? `Edit ${editUser.username}` : 'Create User'}
        footer={<><Button variant="ghost" onClick={() => setShowCreate(false)}>Cancel</Button><Button variant="primary" loading={saving} onClick={handleSave}>{editUser ? 'Save' : 'Create'}</Button></>}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Input label="Username"  value={formState.username} onChange={(e) => setFormState((f) => ({ ...f, username: e.target.value }))} fullWidth />
          <Input label="Email"     type="email" value={formState.email} onChange={(e) => setFormState((f) => ({ ...f, email: e.target.value }))} fullWidth />
          <Select label="Role"     options={ROLE_OPTIONS} value={formState.role} onChange={(e) => setFormState((f) => ({ ...f, role: e.target.value as UserRole }))} fullWidth />
          {!editUser && (
            <>
              <Input label="Password" type="password" value={formState.password} onChange={(e) => setFormState((f) => ({ ...f, password: e.target.value }))} fullWidth />
              <PasswordStrengthWidget password={formState.password} />
              <div style={{ fontSize: 11, color: 'var(--vf-text-muted)', padding: '6px 10px', background: 'rgba(59,130,246,0.06)', borderRadius: 6, border: '1px solid rgba(59,130,246,0.15)' }}>
                <strong style={{ color: '#60a5fa' }}>ITSAR Password Policy</strong> — 12+ characters, uppercase, lowercase, digit, and special character required.
              </div>
            </>
          )}
        </div>
      </Modal>

      <Modal open={!!showPwd} onClose={() => setShowPwd(null)} title={`Reset Password — ${showPwd?.username}`}
        footer={<>
          <Button variant="ghost" onClick={() => setShowPwd(null)}>Cancel</Button>
          <Button variant="primary" onClick={handleResetPwd} disabled={!newPwd || !isPasswordValid(newPwd)}>Reset</Button>
        </>}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <Input label="New Password" type="password" value={newPwd} onChange={(e) => setNewPwd(e.target.value)} fullWidth />
          <PasswordStrengthWidget password={newPwd} />
          <div style={{ fontSize: 11, color: 'var(--vf-text-muted)', padding: '6px 10px', background: 'rgba(59,130,246,0.06)', borderRadius: 6, border: '1px solid rgba(59,130,246,0.15)', marginTop: 4 }}>
            <strong style={{ color: '#60a5fa' }}>ITSAR Policy</strong> — All six requirements below must be satisfied.
          </div>
        </div>
      </Modal>

      <Modal open={!!showDelete} onClose={() => setShowDelete(null)} title="Delete User"
        footer={<><Button variant="ghost" onClick={() => setShowDelete(null)}>Cancel</Button><Button variant="danger" onClick={handleDelete}>Delete</Button></>}>
        <p style={{ color: 'var(--vf-text-primary)', fontSize: 14 }}>
          Delete <strong>{showDelete?.username}</strong>? This cannot be undone.
        </p>
      </Modal>
    </>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Sessions tab
// ═══════════════════════════════════════════════════════════════════════════════
function SessionsTab() {
  const { addToast } = useToast();
  const [sessions, setSessions] = useState<UserSession[]>([]);
  const [loading, setLoading]   = useState(true);
  const [termId, setTermId]     = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    fetchSessions()
      .then(setSessions)
      .catch((e) => { logger.error('Sessions fetch failed', e); addToast('Failed to load sessions', 'error'); })
      .finally(() => setLoading(false));
  }, [addToast]);

  useEffect(load, [load]);

  const handleTerminate = async () => {
    if (!termId) return;
    try {
      await terminateSession(termId);
      setSessions((s) => s.filter((x) => x.sessionId !== termId));
      addToast('Session terminated', 'success');
    } catch { addToast('Failed to terminate session', 'error'); }
    finally { setTermId(null); }
  };

  const active  = sessions.filter((s) => !s.stale).length;
  const stale   = sessions.filter((s) => s.stale).length;

  return (
    <>
      <div className="vf-kpi-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', marginBottom: 20 }}>
        <MetricCard label="Total Sessions" value={sessions.length} loading={loading} />
        <MetricCard label="Active"         value={active}          variant="success" loading={loading} />
        <MetricCard label="Stale"          value={stale}           variant={stale > 0 ? 'warning' : 'default'} loading={loading} />
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
        <Button variant="ghost" size="sm" onClick={load}>↻ Refresh</Button>
      </div>

      {loading ? (
        <LoadingState label="Loading sessions…" />
      ) : sessions.length === 0 ? (
        <EmptyState title="No active sessions" description="No users are currently logged in." icon={<span aria-hidden>🔒</span>} />
      ) : (
        <div style={{ overflowX: 'auto', border: '1px solid rgba(77,158,255,0.1)', borderRadius: 10 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: 'var(--vf-surface)' }}>
                {['User', 'IP Address', 'Login Time', 'Last Activity', 'Status', ''].map((h) => (
                  <th key={h} style={{ padding: '10px 12px', textAlign: 'left', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--vf-text-muted)', borderBottom: '1px solid var(--vf-border-subtle)' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => (
                <tr key={s.sessionId} style={{ borderBottom: '1px solid var(--vf-border-subtle)' }}>
                  <td style={{ padding: '9px 12px', fontWeight: 600, color: 'var(--vf-text-primary)' }}>{s.username}</td>
                  <td style={{ padding: '9px 12px', fontFamily: 'var(--vf-font-mono)', fontSize: 12, color: 'var(--vf-text-secondary)' }}>{s.ipAddress}</td>
                  <td style={{ padding: '9px 12px', color: 'var(--vf-text-muted)', fontSize: 12 }}>{new Date(s.loginAt).toLocaleString()}</td>
                  <td style={{ padding: '9px 12px', color: 'var(--vf-text-muted)', fontSize: 12 }}>{new Date(s.lastActivityAt).toLocaleString()}</td>
                  <td style={{ padding: '9px 12px' }}>
                    <Badge variant={s.stale ? 'warning' : 'success'} dot>{s.stale ? 'Stale' : 'Active'}</Badge>
                  </td>
                  <td style={{ padding: '9px 12px' }}>
                    <Button variant="danger" size="sm" onClick={() => setTermId(s.sessionId)}>Terminate</Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal open={!!termId} onClose={() => setTermId(null)} title="Terminate Session"
        footer={<><Button variant="ghost" onClick={() => setTermId(null)}>Cancel</Button><Button variant="danger" onClick={handleTerminate}>Terminate</Button></>}>
        <p style={{ color: 'var(--vf-text-primary)', fontSize: 14 }}>
          Force-terminate this session? The user will be logged out immediately.
        </p>
      </Modal>
    </>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// System Health tab
// ═══════════════════════════════════════════════════════════════════════════════
function HealthTab() {
  const { addToast } = useToast();
  const [health, setHealth]   = useState<SystemHealth | null>(null);
  const [loading, setLoading] = useState(true);
  const intervalRef           = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(() => {
    fetchSystemHealth()
      .then(setHealth)
      .catch((e) => { logger.error('Health fetch failed', e); addToast('Failed to load system health', 'error'); })
      .finally(() => setLoading(false));
  }, [addToast]);

  useEffect(() => {
    load();
    intervalRef.current = setInterval(load, 30_000);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [load]);

  if (loading) return <LoadingState label="Loading system health…" />;
  if (!health)  return <EmptyState title="Health data unavailable" description="System health endpoint returned no data." />;

  const upCount   = health.services.filter((s) => s.status === 'UP').length;
  const downCount = health.services.filter((s) => s.status === 'DOWN').length;
  const degraded  = health.services.filter((s) => s.status === 'DEGRADED').length;

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
        <span style={{ fontSize: 12, color: 'var(--vf-text-muted)' }}>
          Last checked: {new Date(health.checkedAt).toLocaleTimeString()} · auto-refresh every 30s
        </span>
        <Button variant="ghost" size="sm" onClick={load}>↻ Refresh</Button>
      </div>

      {/* Infrastructure KPIs */}
      <div className="vf-kpi-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', marginBottom: 20 }}>
        <MetricCard label="Services Up"   value={upCount}   variant="success" />
        <MetricCard label="Down"          value={downCount} variant={downCount > 0 ? 'danger' : 'default'} />
        <MetricCard label="Degraded"      value={degraded}  variant={degraded > 0 ? 'warning' : 'default'} />
        <MetricCard label="Kafka"         value={health.kafka}   />
        <MetricCard label="MongoDB"       value={health.mongodb} />
        <MetricCard label="Redis"         value={health.redis}   />
      </div>

      {/* Services table */}
      <div style={{ overflowX: 'auto', border: '1px solid rgba(77,158,255,0.1)', borderRadius: 10 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ background: 'var(--vf-surface)' }}>
              {['Service', 'Status', 'Version', 'Uptime', 'Response Time'].map((h) => (
                <th key={h} style={{ padding: '10px 12px', textAlign: 'left', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--vf-text-muted)', borderBottom: '1px solid var(--vf-border-subtle)' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {health.services.map((svc) => (
              <tr key={svc.name} style={{ borderBottom: '1px solid var(--vf-border-subtle)' }}>
                <td style={{ padding: '9px 12px', fontWeight: 600, color: 'var(--vf-text-primary)' }}>{svc.name}</td>
                <td style={{ padding: '9px 12px' }}>
                  <Badge variant={svcVariant(svc.status)} dot>{svc.status}</Badge>
                </td>
                <td style={{ padding: '9px 12px', fontFamily: 'var(--vf-font-mono)', fontSize: 12, color: 'var(--vf-text-muted)' }}>{svc.version ?? '—'}</td>
                <td style={{ padding: '9px 12px', color: 'var(--vf-text-secondary)' }}>{formatUptime(svc.uptimeMs)}</td>
                <td style={{ padding: '9px 12px', color: svc.responseTimeMs && svc.responseTimeMs > 500 ? '#f87171' : 'var(--vf-text-secondary)' }}>
                  {svc.responseTimeMs != null ? `${svc.responseTimeMs} ms` : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Infrastructure status row */}
      <div style={{ display: 'flex', gap: 12, marginTop: 16, flexWrap: 'wrap' as const }}>
        {(['kafka', 'mongodb', 'redis'] as const).map((k) => (
          <div key={k} style={{ background: 'var(--vf-surface)', border: '1px solid rgba(77,158,255,0.08)', borderRadius: 10, padding: '12px 20px', display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ width: 10, height: 10, borderRadius: '50%', background: health[k] === 'UP' ? '#22c55e' : health[k] === 'DEGRADED' ? '#fbbf24' : '#ef4444', display: 'inline-block', boxShadow: `0 0 8px ${health[k] === 'UP' ? 'rgba(34,197,94,0.5)' : health[k] === 'DEGRADED' ? 'rgba(251,191,36,0.5)' : 'rgba(239,68,68,0.5)'}` }} />
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--vf-text-primary)', textTransform: 'capitalize' }}>{k}</span>
            <Badge variant={infraVariant(health[k])}>{health[k]}</Badge>
          </div>
        ))}
      </div>
    </>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Hierarchy tab  (inline — mirrors V2HierarchyPage but compact)
// ═══════════════════════════════════════════════════════════════════════════════
function HierarchyTab() {
  const { addToast } = useToast();
  const [orgs, setOrgs]           = useState<Organization[]>([]);
  const [hierarchies, setHiers]   = useState<HierarchyViewType[]>([]);
  const [networks, setNets]       = useState<Network[]>([]);
  const [selectedOrg, setOrg]     = useState<Organization | null>(null);
  const [selectedHier, setHier]   = useState<HierarchyViewType | null>(null);
  const [loading, setLoading]     = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    fetchOrganizations()
      .then(setOrgs)
      .catch(() => addToast('Failed to load organizations', 'error'))
      .finally(() => setLoading(false));
  }, [addToast]);

  useEffect(load, [load]);
  useEffect(() => {
    if (!selectedOrg) { setHiers([]); return; }
    fetchHierarchies(selectedOrg.id!).then(setHiers).catch(() => setHiers([]));
  }, [selectedOrg]);
  useEffect(() => {
    if (!selectedHier || !selectedOrg) { setNets([]); return; }
    fetchNetworks(selectedOrg.id!, selectedHier.id!).then(setNets).catch(() => setNets([]));
  }, [selectedHier, selectedOrg]);

  const panelStyle: React.CSSProperties = {
    background: 'var(--vf-surface)', border: '1px solid var(--vf-border-subtle)',
    borderRadius: 10, padding: '16px', flex: 1, minWidth: 0,
  };

  if (loading) return <LoadingState label="Loading hierarchy…" />;

  return (
    <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
      {/* Organizations */}
      <div style={panelStyle}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <SectionLabel>Organizations ({orgs.length})</SectionLabel>
          <Button variant="ghost" size="sm" onClick={() => { createOrganization({ name: 'New Org', description: '' }).then(load).catch(() => addToast('Failed', 'error')); }}>+ Add</Button>
        </div>
        {orgs.map((o) => (
          <div key={o.id} onClick={() => { setOrg(o); setHier(null); }}
            style={{ padding: '8px 10px', borderRadius: 6, cursor: 'pointer', marginBottom: 4, fontSize: 13,
              background: selectedOrg?.id === o.id ? 'rgba(59,130,246,0.12)' : 'transparent',
              border: selectedOrg?.id === o.id ? '1px solid rgba(59,130,246,0.3)' : '1px solid transparent',
            }}>
            <div style={{ fontWeight: 600 }}>{o.name}</div>
            {o.description && <div style={{ fontSize: 11, color: 'var(--vf-text-muted)' }}>{o.description}</div>}
          </div>
        ))}
        {orgs.length === 0 && <EmptyState title="No organizations" description="Click + Add to create one." />}
      </div>
      {/* Hierarchies */}
      <div style={panelStyle}>
        <SectionLabel>Hierarchy Views {selectedOrg ? `(${hierarchies.length})` : ''}</SectionLabel>
        {!selectedOrg ? <p style={{ fontSize: 12, color: 'var(--vf-text-muted)', marginTop: 8 }}>Select an organization first.</p> : (
          <>
            {hierarchies.map((h) => (
              <div key={h.id} onClick={() => setHier(h)}
                style={{ padding: '8px 10px', borderRadius: 6, cursor: 'pointer', marginBottom: 4, fontSize: 13,
                  background: selectedHier?.id === h.id ? 'rgba(59,130,246,0.12)' : 'transparent',
                  border: selectedHier?.id === h.id ? '1px solid rgba(59,130,246,0.3)' : '1px solid transparent',
                }}>
                {h.name}
              </div>
            ))}
            {hierarchies.length === 0 && <EmptyState title="No hierarchy views" description="" />}
            <Button variant="ghost" size="sm" style={{ marginTop: 8 }}
              onClick={() => createHierarchy(selectedOrg.id!, { name: 'New Hierarchy', description: '' }).then(() => fetchHierarchies(selectedOrg.id!).then(setHiers)).catch(() => addToast('Failed', 'error'))}>
              + Add
            </Button>
          </>
        )}
      </div>
      {/* Networks */}
      <div style={panelStyle}>
        <SectionLabel>Networks {selectedHier ? `(${networks.length})` : ''}</SectionLabel>
        {!selectedHier ? <p style={{ fontSize: 12, color: 'var(--vf-text-muted)', marginTop: 8 }}>Select a hierarchy view first.</p> : (
          <>
            {networks.map((n) => (
              <div key={n.id} style={{ padding: '8px 10px', borderRadius: 6, marginBottom: 4, fontSize: 13, background: 'rgba(255,255,255,0.02)', border: '1px solid var(--vf-border-subtle)' }}>
                {n.name}
              </div>
            ))}
            {networks.length === 0 && <EmptyState title="No networks" description="" />}
            <Button variant="ghost" size="sm" style={{ marginTop: 8 }}
              onClick={() => createNetwork(selectedOrg!.id!, selectedHier.id!, { name: 'New Network', description: '' }).then(() => fetchNetworks(selectedOrg!.id!, selectedHier.id!).then(setNets)).catch(() => addToast('Failed', 'error'))}>
              + Add
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Audit Log tab
// ═══════════════════════════════════════════════════════════════════════════════
function AuditTab() {
  const { addToast } = useToast();
  const [entries, setEntries]     = useState<AuditEntry[]>([]);
  const [loading, setLoading]     = useState(true);
  const [actorFilter, setActor]   = useState('');

  const load = useCallback(() => {
    setLoading(true);
    fetchAuditLog({ limit: 200 })
      .then(setEntries)
      .catch(() => addToast('Failed to load audit log', 'error'))
      .finally(() => setLoading(false));
  }, [addToast]);

  useEffect(load, [load]);

  const visible = entries.filter((e) => !actorFilter || e.actor.toLowerCase().includes(actorFilter.toLowerCase()));

  return (
    <>
      <div style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
        <Input placeholder="Filter by actor…" value={actorFilter} onChange={(e) => setActor(e.target.value)} style={{ width: 260 }} />
        <Button variant="ghost" size="sm" onClick={load}>↻ Refresh</Button>
        <span style={{ fontSize: 12, color: 'var(--vf-text-muted)', alignSelf: 'center' }}>{visible.length} entries</span>
      </div>
      {loading ? <LoadingState label="Loading audit log…" /> : visible.length === 0 ? (
        <EmptyState title="No audit entries" description="Actions performed by admins and operators are recorded here." icon={<span>📋</span>} />
      ) : (
        <div style={{ overflowX: 'auto', border: '1px solid var(--vf-border-subtle)', borderRadius: 10, background: 'var(--vf-surface)' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: 'rgba(30,41,59,0.5)' }}>
                {['Time', 'Actor', 'Action', 'Resource', 'Outcome', 'IP'].map((h) => (
                  <th key={h} style={{ padding: '10px 14px', textAlign: 'left', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--vf-text-muted)', borderBottom: '1px solid var(--vf-border-subtle)', whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visible.map((e, i) => (
                <tr key={e.id ?? i} style={{ borderBottom: '1px solid var(--vf-border-subtle)' }}>
                  <td style={{ padding: '9px 14px', fontFamily: 'var(--vf-font-mono)', fontSize: 11, color: 'var(--vf-text-muted)', whiteSpace: 'nowrap' }}>{new Date(e.timestamp).toLocaleString()}</td>
                  <td style={{ padding: '9px 14px', fontWeight: 600 }}>{e.actor}</td>
                  <td style={{ padding: '9px 14px', fontFamily: 'var(--vf-font-mono)', fontSize: 12 }}>{e.action}</td>
                  <td style={{ padding: '9px 14px', color: 'var(--vf-text-muted)' }}>{e.resource}{e.resourceId ? ` (${e.resourceId})` : ''}</td>
                  <td style={{ padding: '9px 14px' }}>
                    <Badge variant={e.outcome === 'SUCCESS' ? 'success' : 'danger'}>{e.outcome}</Badge>
                  </td>
                  <td style={{ padding: '9px 14px', fontFamily: 'var(--vf-font-mono)', fontSize: 11, color: 'var(--vf-text-muted)' }}>{e.ipAddress ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Backup & Restore tab
// ═══════════════════════════════════════════════════════════════════════════════
function BackupTab() {
  const { addToast } = useToast();
  const [backups, setBackups]   = useState<BackupRecord[]>([]);
  const [loading, setLoading]   = useState(true);
  const [running, setRunning]   = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    fetchBackups().then(setBackups).catch(() => addToast('Failed to load backups', 'error')).finally(() => setLoading(false));
  }, [addToast]);

  useEffect(load, [load]);

  async function handleBackup(type: 'FULL' | 'INCREMENTAL') {
    setRunning(true);
    try {
      await triggerBackup(type);
      addToast(`${type} backup started`, 'success');
      setTimeout(load, 3000);
    } catch { addToast('Backup failed to start', 'error'); }
    finally { setRunning(false); }
  }

  async function handleRestore(id: string) {
    try { await restoreBackup(id); addToast('Restore initiated', 'success'); }
    catch { addToast('Restore failed', 'error'); }
  }

  function fmtSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
    return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  }

  return (
    <>
      <div style={{ display: 'flex', gap: 10, marginBottom: 20 }}>
        <Button variant="primary" size="sm" onClick={() => handleBackup('FULL')} disabled={running}>
          {running ? 'Running…' : '+ Full Backup'}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => handleBackup('INCREMENTAL')} disabled={running}>
          + Incremental Backup
        </Button>
        <Button variant="ghost" size="sm" onClick={load} style={{ marginLeft: 'auto' }}>↻ Refresh</Button>
      </div>

      {/* Policy info */}
      <div style={{ padding: '12px 16px', background: 'rgba(59,130,246,0.06)', border: '1px solid rgba(59,130,246,0.15)', borderRadius: 8, marginBottom: 20, fontSize: 12, color: 'var(--vf-text-muted)' }}>
        <strong style={{ color: '#60a5fa' }}>Retention policy:</strong> Full backups retained for 30 days · Incrementals for 7 days · Stored encrypted at rest (AES-256)
      </div>

      {loading ? <LoadingState label="Loading backups…" /> : backups.length === 0 ? (
        <EmptyState title="No backups yet" description="Click 'Full Backup' to create the first snapshot." icon={<span>💾</span>} />
      ) : (
        <div style={{ overflowX: 'auto', border: '1px solid var(--vf-border-subtle)', borderRadius: 10, background: 'var(--vf-surface)' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: 'rgba(30,41,59,0.5)' }}>
                {['Name', 'Type', 'Size', 'Created', 'Status', ''].map((h) => (
                  <th key={h} style={{ padding: '10px 14px', textAlign: 'left', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--vf-text-muted)', borderBottom: '1px solid var(--vf-border-subtle)', whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {backups.map((b) => (
                <tr key={b.id} style={{ borderBottom: '1px solid var(--vf-border-subtle)' }}>
                  <td style={{ padding: '9px 14px', fontFamily: 'var(--vf-font-mono)', fontSize: 12 }}>{b.name}</td>
                  <td style={{ padding: '9px 14px' }}><Badge variant={b.type === 'FULL' ? 'info' : 'default'}>{b.type}</Badge></td>
                  <td style={{ padding: '9px 14px', color: 'var(--vf-text-muted)' }}>{fmtSize(b.sizeBytes)}</td>
                  <td style={{ padding: '9px 14px', color: 'var(--vf-text-muted)', fontSize: 12 }}>{new Date(b.createdAt).toLocaleString()}</td>
                  <td style={{ padding: '9px 14px' }}>
                    <Badge variant={b.status === 'COMPLETED' ? 'success' : b.status === 'RUNNING' ? 'warning' : 'danger'} dot>{b.status}</Badge>
                  </td>
                  <td style={{ padding: '9px 14px' }}>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <Button variant="ghost" size="sm" onClick={() => handleRestore(b.id)} disabled={b.status !== 'COMPLETED'}>Restore</Button>
                      <Button variant="danger" size="sm" onClick={() => deleteBackup(b.id).then(load).catch(() => addToast('Delete failed', 'error'))}>Del</Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Northbound OSS/BSS config tab
// ═══════════════════════════════════════════════════════════════════════════════
function NorthboundTab() {
  const { addToast } = useToast();
  const [cfg, setCfg]       = useState<NorthboundConfig | null>(null);
  const [loading, setLoad]  = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetchNorthboundConfig().then(setCfg).catch(() => addToast('Failed to load northbound config', 'error')).finally(() => setLoad(false));
  }, [addToast]);

  async function handleSave() {
    if (!cfg) return;
    setSaving(true);
    try { await updateNorthboundConfig(cfg); addToast('Northbound configuration saved', 'success'); }
    catch { addToast('Failed to save configuration', 'error'); }
    finally { setSaving(false); }
  }

  if (loading || !cfg) return <LoadingState label="Loading northbound config…" />;

  const sectionStyle: React.CSSProperties = { background: 'var(--vf-surface)', border: '1px solid var(--vf-border-subtle)', borderRadius: 10, padding: '18px 20px', marginBottom: 16 };
  const gridStyle: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 14, marginTop: 12 };

  function toggle(key: keyof NorthboundConfig) {
    setCfg((c) => c ? { ...c, [key]: { ...c[key], enabled: !(c[key] as { enabled: boolean }).enabled } } : c);
  }
  function patch<K extends keyof NorthboundConfig>(key: K, field: string, val: string | number | boolean) {
    setCfg((c) => c ? { ...c, [key]: { ...(c[key] as object), [field]: val } } : c);
  }

  return (
    <>
      <div style={{ marginBottom: 20, display: 'flex', justifyContent: 'flex-end' }}>
        <Button variant="primary" size="sm" onClick={handleSave} disabled={saving}>{saving ? 'Saving…' : 'Save Configuration'}</Button>
      </div>

      {/* Netcool */}
      <div style={sectionStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 4 }}>
          <span style={{ fontWeight: 700, fontSize: 14 }}>Netcool Alarm Forwarder</span>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer' }}>
            <input type="checkbox" checked={cfg.netcool.enabled} onChange={() => toggle('netcool')} /> Enabled
          </label>
        </div>
        <p style={{ fontSize: 12, color: 'var(--vf-text-muted)', marginBottom: 12 }}>Forwards CRITICAL/MAJOR alarms to IBM Netcool/OMNIbus via REST probe.</p>
        <div style={gridStyle}>
          <div><SectionLabel>Host</SectionLabel><FieldInput value={cfg.netcool.host} onChange={(v) => patch('netcool', 'host', v)} placeholder="netcool.host.local" disabled={!cfg.netcool.enabled} /></div>
          <div><SectionLabel>Port</SectionLabel><FieldInput value={cfg.netcool.port} type="number" onChange={(v) => patch('netcool', 'port', Number(v))} placeholder="9999" disabled={!cfg.netcool.enabled} /></div>
          <div><SectionLabel>Username</SectionLabel><FieldInput value={cfg.netcool.username ?? ''} onChange={(v) => patch('netcool', 'username', v)} placeholder="omnibus" disabled={!cfg.netcool.enabled} /></div>
        </div>
      </div>

      {/* Mycom */}
      <div style={sectionStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 4 }}>
          <span style={{ fontWeight: 700, fontSize: 14 }}>Mycom KPI Export</span>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer' }}>
            <input type="checkbox" checked={cfg.mycom.enabled} onChange={() => toggle('mycom')} /> Enabled
          </label>
        </div>
        <p style={{ fontSize: 12, color: 'var(--vf-text-muted)', marginBottom: 12 }}>Exports KPI metrics to Mycom OSS via REST API.</p>
        <div style={gridStyle}>
          <div><SectionLabel>Host</SectionLabel><FieldInput value={cfg.mycom.host} onChange={(v) => patch('mycom', 'host', v)} placeholder="mycom.host.local" disabled={!cfg.mycom.enabled} /></div>
          <div><SectionLabel>Port</SectionLabel><FieldInput value={cfg.mycom.port} type="number" onChange={(v) => patch('mycom', 'port', Number(v))} placeholder="8080" disabled={!cfg.mycom.enabled} /></div>
          <div><SectionLabel>API Key</SectionLabel><FieldInput value={cfg.mycom.apiKey ?? ''} onChange={(v) => patch('mycom', 'apiKey', v)} placeholder="sk-…" disabled={!cfg.mycom.enabled} /></div>
        </div>
      </div>

      {/* Mobinet */}
      <div style={sectionStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 4 }}>
          <span style={{ fontWeight: 700, fontSize: 14 }}>Mobinet Inventory Sync</span>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer' }}>
            <input type="checkbox" checked={cfg.mobinet.enabled} onChange={() => toggle('mobinet')} /> Enabled
          </label>
        </div>
        <p style={{ fontSize: 12, color: 'var(--vf-text-muted)', marginBottom: 12 }}>Bi-directional inventory synchronization with Mobinet OSS.</p>
        <div style={gridStyle}>
          <div><SectionLabel>URL</SectionLabel><FieldInput value={cfg.mobinet.url} onChange={(v) => patch('mobinet', 'url', v)} placeholder="https://mobinet.host/api" disabled={!cfg.mobinet.enabled} /></div>
          <div><SectionLabel>API Key</SectionLabel><FieldInput value={cfg.mobinet.apiKey ?? ''} onChange={(v) => patch('mobinet', 'apiKey', v)} placeholder="sk-…" disabled={!cfg.mobinet.enabled} /></div>
        </div>
      </div>

      {/* Syslog */}
      <div style={sectionStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 4 }}>
          <span style={{ fontWeight: 700, fontSize: 14 }}>Syslog Forwarder</span>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer' }}>
            <input type="checkbox" checked={cfg.syslog.enabled} onChange={() => toggle('syslog')} /> Enabled
          </label>
        </div>
        <p style={{ fontSize: 12, color: 'var(--vf-text-muted)', marginBottom: 12 }}>Forwards RFC 5424 syslog messages to an external SIEM/log collector.</p>
        <div style={gridStyle}>
          <div><SectionLabel>Host</SectionLabel><FieldInput value={cfg.syslog.host} onChange={(v) => patch('syslog', 'host', v)} placeholder="siem.host.local" disabled={!cfg.syslog.enabled} /></div>
          <div><SectionLabel>Port</SectionLabel><FieldInput value={cfg.syslog.port} type="number" onChange={(v) => patch('syslog', 'port', Number(v))} placeholder="514" disabled={!cfg.syslog.enabled} /></div>
          <div>
            <SectionLabel>Protocol</SectionLabel>
            <select value={cfg.syslog.protocol} disabled={!cfg.syslog.enabled} onChange={(e) => patch('syslog', 'protocol', e.target.value)}
              style={{ width: '100%', padding: '7px 10px', borderRadius: 6, border: '1px solid var(--vf-border-subtle)', background: 'var(--vf-surface)', color: 'var(--vf-text-primary)', fontSize: 13 }}>
              <option value="UDP">UDP</option><option value="TCP">TCP</option>
            </select>
          </div>
        </div>
      </div>

      {/* NIAM LDAP */}
      <div style={sectionStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 4 }}>
          <span style={{ fontWeight: 700, fontSize: 14 }}>NIAM LDAP Integration</span>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer' }}>
            <input type="checkbox" checked={cfg.niam.enabled} onChange={() => toggle('niam')} /> Enabled
          </label>
        </div>
        <p style={{ fontSize: 12, color: 'var(--vf-text-muted)', marginBottom: 12 }}>Authenticates operators against Airtel NIAM LDAP directory.</p>
        <div style={gridStyle}>
          <div><SectionLabel>LDAP URL</SectionLabel><FieldInput value={cfg.niam.ldapUrl} onChange={(v) => patch('niam', 'ldapUrl', v)} placeholder="ldap://niam.airtel.in:389" disabled={!cfg.niam.enabled} /></div>
          <div><SectionLabel>Base DN</SectionLabel><FieldInput value={cfg.niam.baseDn} onChange={(v) => patch('niam', 'baseDn', v)} placeholder="ou=users,dc=airtel,dc=in" disabled={!cfg.niam.enabled} /></div>
          <div><SectionLabel>Bind DN</SectionLabel><FieldInput value={cfg.niam.bindDn ?? ''} onChange={(v) => patch('niam', 'bindDn', v)} placeholder="cn=svc-nms,ou=service,dc=airtel,dc=in" disabled={!cfg.niam.enabled} /></div>
        </div>
      </div>
    </>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Redundancy tab  (matches the screenshot: Active/Standby HA monitoring)
// ═══════════════════════════════════════════════════════════════════════════════
function RedundancyTab() {
  const { addToast } = useToast();
  const [status, setStatus]   = useState<RedundancyStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [acting, setActing]   = useState(false);
  const intervalRef           = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(() => {
    fetchRedundancyStatus().then(setStatus).catch(() => addToast('Failed to load redundancy status', 'error')).finally(() => setLoading(false));
  }, [addToast]);

  useEffect(() => {
    load();
    intervalRef.current = setInterval(load, 15_000);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [load]);

  async function handleForceSync() {
    setActing(true);
    try { await forceSyncRedundancy(); addToast('Sync triggered', 'success'); setTimeout(load, 2000); }
    catch { addToast('Sync failed', 'error'); }
    finally { setActing(false); }
  }

  async function handleSwitchover() {
    if (!window.confirm('This will promote the standby site to PRIMARY. Continue?')) return;
    setActing(true);
    try { await triggerManualSwitchover(); addToast('Switchover initiated', 'success'); setTimeout(load, 3000); }
    catch { addToast('Switchover failed', 'error'); }
    finally { setActing(false); }
  }

  if (loading || !status) return <LoadingState label="Loading redundancy status…" />;

  const primary  = status.sites.find((s) => s.role === 'PRIMARY');
  const standby  = status.sites.find((s) => s.role === 'STANDBY');
  const allSync  = status.sites.every((s) => s.syncStatus === 'IN_SYNC');

  function SiteCard({ site }: { site: RedundancySite }) {
    const isActive = site.status === 'ACTIVE';
    return (
      <div style={{
        flex: 1, minWidth: 0, background: 'var(--vf-surface)',
        border: `2px solid ${isActive ? 'rgba(34,197,94,0.4)' : 'var(--vf-border-subtle)'}`,
        borderRadius: 12, padding: '20px 22px',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 16 }}>{site.name}</div>
            <div style={{ fontFamily: 'var(--vf-font-mono)', fontSize: 12, color: 'var(--vf-text-muted)', marginTop: 2 }}>{site.ipAddress}</div>
          </div>
          <span style={{ background: isActive ? '#22c55e' : '#334155', color: '#fff', borderRadius: 6, padding: '3px 10px', fontSize: 11, fontWeight: 700, letterSpacing: '0.08em' }}>
            {site.status}
          </span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 4 }}>
          <div>
            <div style={{ fontSize: 11, color: 'var(--vf-text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Sync Status</div>
            <div style={{ fontWeight: 700, color: site.syncStatus === 'IN_SYNC' ? '#22c55e' : '#f59e0b', fontSize: 15 }}>{site.syncStatus}</div>
          </div>
          <div>
            <div style={{ fontSize: 11, color: 'var(--vf-text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Last Sync</div>
            <div style={{ fontSize: 13 }}>{site.lastSyncAt ? new Date(site.lastSyncAt).toLocaleTimeString() : '—'}</div>
          </div>
          <div>
            <div style={{ fontSize: 11, color: 'var(--vf-text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>CPU</div>
            <div style={{ fontSize: 15, fontWeight: 600 }}>{site.cpuPct != null ? `${site.cpuPct}%` : '—'}</div>
          </div>
          <div>
            <div style={{ fontSize: 11, color: 'var(--vf-text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Memory</div>
            <div style={{ fontSize: 15, fontWeight: 600 }}>{site.memPct != null ? `${site.memPct}%` : '—'}</div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      {/* Header bar */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
        <div>
          <h2 style={{ fontSize: 17, fontWeight: 700, margin: 0 }}>Active / Standby Redundancy</h2>
          <p style={{ fontSize: 12, color: 'var(--vf-text-muted)', margin: '4px 0 0' }}>
            Monitor NMS high-availability sites. Automatic failover within ~{status.maxFailoverTimeSec}s (NMS-RED-01, NMS-RED-02, NMS-RED-03)
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Button variant="ghost" size="sm" onClick={handleForceSync} disabled={acting}>↻ Force Sync</Button>
          <Button variant="danger" size="sm" onClick={handleSwitchover} disabled={acting}>⚡ Manual Switchover</Button>
        </div>
      </div>

      {/* Sync status banner */}
      {!allSync && (
        <div style={{ padding: '10px 14px', background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.3)', borderRadius: 8, marginBottom: 16, fontSize: 13, color: '#fbbf24' }}>
          ⚠️ One or more sites are not in sync — check replication lag.
        </div>
      )}

      {/* Site cards */}
      <div style={{ display: 'flex', gap: 16, marginBottom: 24 }}>
        {primary && <SiteCard site={primary} />}
        {standby && <SiteCard site={standby} />}
      </div>

      {/* Failover Configuration */}
      <div style={{ background: 'var(--vf-surface)', border: '1px solid var(--vf-border-subtle)', borderRadius: 10, padding: '18px 20px' }}>
        <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--vf-text-muted)', marginBottom: 14 }}>Failover Configuration</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 16 }}>
          {[
            ['VIP Address',            status.vipAddress],
            ['Heartbeat Interval',     `${status.heartbeatIntervalSec}s`],
            ['Failover Threshold',     `${status.failoverThresholdMissed} missed heartbeats`],
            ['Max Failover Time',      `~${status.maxFailoverTimeSec} seconds`],
            ['DB Replication',         status.dbReplication],
            ['Data Loss Tolerance',    status.dataLossTolerance],
          ].map(([label, val]) => (
            <div key={label}>
              <div style={{ fontSize: 11, color: 'var(--vf-text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>{label}</div>
              <div style={{ fontSize: 13, fontWeight: 600 }}>{val}</div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Main Admin Page
// ═══════════════════════════════════════════════════════════════════════════════
export default function V2AdminPage() {
  const [tab, setTab] = useState<AdminTab>('users');

  return (
    <div className="vf-page">
      <div className="vf-page-header">
        <h1 className="vf-page-title">Admin Panel</h1>
      </div>

      {/* Tab bar — scrollable so all 8 tabs fit on smaller screens */}
      <div style={{ display: 'flex', background: 'var(--vf-surface)', borderBottom: '1px solid rgba(77,158,255,0.1)', marginBottom: 24, marginLeft: -28, marginRight: -28, paddingLeft: 28, overflowX: 'auto' }}>
        <TabBtn id="users"      active={tab === 'users'}      label="Users"          onClick={setTab} />
        <TabBtn id="sessions"   active={tab === 'sessions'}   label="Sessions"       onClick={setTab} />
        <TabBtn id="health"     active={tab === 'health'}     label="System Health"  onClick={setTab} />
        <TabBtn id="hierarchy"  active={tab === 'hierarchy'}  label="Hierarchy"      onClick={setTab} />
        <TabBtn id="audit"      active={tab === 'audit'}      label="Audit Log"      onClick={setTab} />
        <TabBtn id="backup"     active={tab === 'backup'}     label="Backup & Restore" onClick={setTab} />
        <TabBtn id="northbound" active={tab === 'northbound'} label="Northbound"     onClick={setTab} />
        <TabBtn id="redundancy" active={tab === 'redundancy'} label="Redundancy"     onClick={setTab} />
      </div>

      {tab === 'users'      && <UsersTab />}
      {tab === 'sessions'   && <SessionsTab />}
      {tab === 'health'     && <HealthTab />}
      {tab === 'hierarchy'  && <HierarchyTab />}
      {tab === 'audit'      && <AuditTab />}
      {tab === 'backup'     && <BackupTab />}
      {tab === 'northbound' && <NorthboundTab />}
      {tab === 'redundancy' && <RedundancyTab />}
    </div>
  );
}
