/**
 * V2 Org / Hierarchy / Network Management — REQ-009
 *
 * Three-level tree:
 *   Organization → Hierarchy Views → Networks
 *
 * Full CRUD at each level using the existing hierarchy.api.ts endpoints.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  fetchOrganizations, createOrganization, updateOrganization, deleteOrganization,
  fetchHierarchies, createHierarchy, deleteHierarchy,
  fetchNetworks, createNetwork, deleteNetwork,
} from '../../api/hierarchy.api';
import type { Organization, HierarchyView, Network } from '../../api/hierarchy.api';
import { Badge } from '../components/common/Badge';
import { Button } from '../components/common/Button';
import { Input } from '../components/common/Input';
import { Modal } from '../components/common/Modal';
import { MetricCard } from '../components/common/MetricCard';
import { LoadingState, EmptyState } from '../components/common/States';
import { useToast } from '../components/common/Toast';
import { logger } from '../utils/logger';

// ── Confirmation modal helper ─────────────────────────────────────────────────
function ConfirmModal({ open, title, message, onConfirm, onCancel }: {
  open: boolean; title: string; message: string;
  onConfirm: () => void; onCancel: () => void;
}) {
  return (
    <Modal open={open} onClose={onCancel} title={title}
      footer={<><Button variant="ghost" onClick={onCancel}>Cancel</Button><Button variant="danger" onClick={onConfirm}>Delete</Button></>}>
      <p style={{ color: 'var(--vf-text-primary)', fontSize: 14 }}>{message}</p>
    </Modal>
  );
}

// ── Org card ───────────────────────────────────────────────────────────────────
function OrgCard({ org, selected, onSelect, onEdit, onDelete }: {
  org: Organization; selected: boolean;
  onSelect: () => void; onEdit: () => void; onDelete: () => void;
}) {
  return (
    <div onClick={onSelect} style={{
      background: selected ? 'rgba(77,158,255,0.1)' : 'var(--vf-surface)',
      border: `1px solid ${selected ? 'rgba(77,158,255,0.4)' : 'rgba(77,158,255,0.08)'}`,
      borderRadius: 10, padding: '14px 16px', cursor: 'pointer',
      transition: 'border-color 0.15s, background 0.15s',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--vf-text-primary)' }}>{org.name}</div>
          {org.description && <div style={{ fontSize: 12, color: 'var(--vf-text-muted)', marginTop: 3 }}>{org.description}</div>}
          {org.createdAt && <div style={{ fontSize: 11, color: 'var(--vf-text-dim)', marginTop: 4 }}>{new Date(org.createdAt).toLocaleDateString()}</div>}
        </div>
        <div style={{ display: 'flex', gap: 4, flexShrink: 0 }} onClick={(e) => e.stopPropagation()}>
          <Button variant="ghost" size="sm" onClick={onEdit}>Edit</Button>
          <Button variant="danger" size="sm" onClick={onDelete}>Delete</Button>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Main Component
// ═══════════════════════════════════════════════════════════════════════════════
export default function V2HierarchyPage() {
  const { addToast } = useToast();

  // ── State ────────────────────────────────────────────────────────────────────
  const [orgs, setOrgs]             = useState<Organization[]>([]);
  const [hierarchies, setHierarchies] = useState<HierarchyView[]>([]);
  const [networks, setNetworks]     = useState<Network[]>([]);

  const [selectedOrg, setSelectedOrg]   = useState<Organization | null>(null);
  const [selectedHier, setSelectedHier] = useState<HierarchyView | null>(null);

  const [loadingOrgs, setLoadingOrgs]     = useState(true);
  const [loadingHiers, setLoadingHiers]   = useState(false);
  const [loadingNets, setLoadingNets]     = useState(false);

  // Modal state
  const [orgModal, setOrgModal]   = useState<{ open: boolean; editing: Organization | null }>({ open: false, editing: null });
  const [orgForm, setOrgForm]     = useState({ name: '', description: '' });
  const [hierModal, setHierModal] = useState(false);
  const [hierForm, setHierForm]   = useState({ name: '', description: '' });
  const [netModal, setNetModal]   = useState(false);
  const [netForm, setNetForm]     = useState({ name: '', description: '' });
  const [confirmDel, setConfirmDel] = useState<{ type: 'org' | 'hier' | 'net'; id: string; name: string } | null>(null);
  const [saving, setSaving]       = useState(false);

  // ── Load orgs ────────────────────────────────────────────────────────────────
  const loadOrgs = useCallback(() => {
    setLoadingOrgs(true);
    fetchOrganizations()
      .then(setOrgs)
      .catch((e) => { logger.error('Orgs fetch failed', e); addToast('Failed to load organizations', 'error'); })
      .finally(() => setLoadingOrgs(false));
  }, [addToast]);

  useEffect(loadOrgs, [loadOrgs]);

  // ── Load hierarchies when org is selected ────────────────────────────────────
  useEffect(() => {
    if (!selectedOrg?.id) { setHierarchies([]); setSelectedHier(null); setNetworks([]); return; }
    setLoadingHiers(true);
    fetchHierarchies(selectedOrg.id)
      .then(setHierarchies)
      .catch((e) => { logger.error('Hierarchies fetch failed', e); addToast('Failed to load hierarchies', 'error'); })
      .finally(() => setLoadingHiers(false));
    setSelectedHier(null);
    setNetworks([]);
  }, [selectedOrg, addToast]);

  // ── Load networks when hierarchy is selected ─────────────────────────────────
  useEffect(() => {
    if (!selectedOrg?.id || !selectedHier?.id) { setNetworks([]); return; }
    setLoadingNets(true);
    fetchNetworks(selectedOrg.id, selectedHier.id)
      .then(setNetworks)
      .catch((e) => { logger.error('Networks fetch failed', e); addToast('Failed to load networks', 'error'); })
      .finally(() => setLoadingNets(false));
  }, [selectedOrg, selectedHier, addToast]);

  // ── CRUD: Org ─────────────────────────────────────────────────────────────────
  const openCreateOrg = () => { setOrgForm({ name: '', description: '' }); setOrgModal({ open: true, editing: null }); };
  const openEditOrg   = (org: Organization) => { setOrgForm({ name: org.name, description: org.description ?? '' }); setOrgModal({ open: true, editing: org }); };

  const handleSaveOrg = async () => {
    if (!orgForm.name) { addToast('Name is required', 'warning'); return; }
    setSaving(true);
    try {
      if (orgModal.editing?.id) {
        const updated = await updateOrganization(orgModal.editing.id, orgForm);
        setOrgs((o) => o.map((x) => x.id === updated.id ? updated : x));
        if (selectedOrg?.id === updated.id) setSelectedOrg(updated);
        addToast('Organization updated', 'success');
      } else {
        const created = await createOrganization(orgForm);
        setOrgs((o) => [...o, created]);
        addToast('Organization created', 'success');
      }
      setOrgModal({ open: false, editing: null });
    } catch (e) { logger.error('Org save failed', e); addToast('Failed to save organization', 'error'); }
    finally { setSaving(false); }
  };

  // ── CRUD: Hierarchy ───────────────────────────────────────────────────────────
  const handleSaveHier = async () => {
    if (!hierForm.name || !selectedOrg?.id) return;
    setSaving(true);
    try {
      const created = await createHierarchy(selectedOrg.id, hierForm);
      setHierarchies((h) => [...h, created]);
      addToast('Hierarchy created', 'success');
      setHierModal(false);
      setHierForm({ name: '', description: '' });
    } catch (e) { logger.error('Hierarchy create failed', e); addToast('Failed to create hierarchy', 'error'); }
    finally { setSaving(false); }
  };

  // ── CRUD: Network ─────────────────────────────────────────────────────────────
  const handleSaveNet = async () => {
    if (!netForm.name || !selectedOrg?.id || !selectedHier?.id) return;
    setSaving(true);
    try {
      const created = await createNetwork(selectedOrg.id, selectedHier.id, netForm);
      setNetworks((n) => [...n, created]);
      addToast('Network created', 'success');
      setNetModal(false);
      setNetForm({ name: '', description: '' });
    } catch (e) { logger.error('Network create failed', e); addToast('Failed to create network', 'error'); }
    finally { setSaving(false); }
  };

  // ── Delete handler ─────────────────────────────────────────────────────────────
  const handleDelete = async () => {
    if (!confirmDel) return;
    try {
      if (confirmDel.type === 'org' && selectedOrg?.id) {
        await deleteOrganization(confirmDel.id);
        setOrgs((o) => o.filter((x) => x.id !== confirmDel.id));
        if (selectedOrg?.id === confirmDel.id) setSelectedOrg(null);
        addToast('Organization deleted', 'success');
      } else if (confirmDel.type === 'hier' && selectedOrg?.id) {
        await deleteHierarchy(selectedOrg.id, confirmDel.id);
        setHierarchies((h) => h.filter((x) => x.id !== confirmDel.id));
        if (selectedHier?.id === confirmDel.id) setSelectedHier(null);
        addToast('Hierarchy deleted', 'success');
      } else if (confirmDel.type === 'net' && selectedOrg?.id && selectedHier?.id) {
        await deleteNetwork(selectedOrg.id, selectedHier.id, confirmDel.id);
        setNetworks((n) => n.filter((x) => x.id !== confirmDel.id));
        addToast('Network deleted', 'success');
      }
    } catch { addToast('Failed to delete', 'error'); }
    finally { setConfirmDel(null); }
  };

  // ── Render ────────────────────────────────────────────────────────────────────
  return (
    <div className="vf-page">
      <div className="vf-page-header">
        <div>
          <h1 className="vf-page-title">Organization / Hierarchy</h1>
          <p style={{ fontSize: 13, color: 'var(--vf-text-muted)', margin: '4px 0 0' }}>
            Manage your multi-tenant org structure: Organizations → Hierarchy Views → Networks
          </p>
        </div>
      </div>

      {/* KPI row */}
      <div className="vf-kpi-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))' }}>
        <MetricCard label="Organizations" value={orgs.length} loading={loadingOrgs} />
        <MetricCard label="Hierarchies"   value={hierarchies.length} loading={loadingHiers} />
        <MetricCard label="Networks"      value={networks.length} loading={loadingNets} />
      </div>

      {/* Three-panel layout */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16, alignItems: 'start' }}>

        {/* ── Panel 1: Organizations ─── */}
        <div style={{ background: 'var(--vf-surface)', border: '1px solid rgba(77,158,255,0.08)', borderRadius: 12, overflow: 'hidden' }}>
          <div style={{ padding: '12px 16px', borderBottom: '1px solid rgba(77,158,255,0.08)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--vf-text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Organizations</span>
            <Button variant="primary" size="sm" onClick={openCreateOrg}>+ Add</Button>
          </div>
          <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8, minHeight: 120 }}>
            {loadingOrgs ? <LoadingState label="Loading…" compact /> : orgs.length === 0 ? (
              <EmptyState title="No organizations" compact action={<Button size="sm" onClick={openCreateOrg}>Create first</Button>} />
            ) : orgs.map((org) => (
              <OrgCard key={org.id} org={org} selected={selectedOrg?.id === org.id}
                onSelect={() => setSelectedOrg(org)}
                onEdit={() => openEditOrg(org)}
                onDelete={() => setConfirmDel({ type: 'org', id: org.id!, name: org.name })} />
            ))}
          </div>
        </div>

        {/* ── Panel 2: Hierarchies ─── */}
        <div style={{ background: 'var(--vf-surface)', border: '1px solid rgba(77,158,255,0.08)', borderRadius: 12, overflow: 'hidden', opacity: selectedOrg ? 1 : 0.5 }}>
          <div style={{ padding: '12px 16px', borderBottom: '1px solid rgba(77,158,255,0.08)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--vf-text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              Hierarchy Views {selectedOrg ? `— ${selectedOrg.name}` : ''}
            </span>
            <Button variant="primary" size="sm" onClick={() => { setHierForm({ name: '', description: '' }); setHierModal(true); }} disabled={!selectedOrg}>+ Add</Button>
          </div>
          <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8, minHeight: 120 }}>
            {!selectedOrg ? (
              <div style={{ padding: 16, textAlign: 'center', color: 'var(--vf-text-dim)', fontSize: 13 }}>Select an organization</div>
            ) : loadingHiers ? <LoadingState label="Loading…" compact /> : hierarchies.length === 0 ? (
              <EmptyState title="No hierarchies" compact />
            ) : hierarchies.map((h) => (
              <div key={h.id} onClick={() => setSelectedHier(h)}
                style={{
                  background: selectedHier?.id === h.id ? 'rgba(77,158,255,0.1)' : 'var(--vf-elevated)',
                  border: `1px solid ${selectedHier?.id === h.id ? 'rgba(77,158,255,0.4)' : 'rgba(77,158,255,0.06)'}`,
                  borderRadius: 8, padding: '10px 12px', cursor: 'pointer',
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                }}>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--vf-text-primary)' }}>{h.name}</div>
                  {h.description && <div style={{ fontSize: 11, color: 'var(--vf-text-muted)' }}>{h.description}</div>}
                </div>
                <Button variant="danger" size="sm" onClick={(e) => { e.stopPropagation(); setConfirmDel({ type: 'hier', id: h.id!, name: h.name }); }}>Delete</Button>
              </div>
            ))}
          </div>
        </div>

        {/* ── Panel 3: Networks ─── */}
        <div style={{ background: 'var(--vf-surface)', border: '1px solid rgba(77,158,255,0.08)', borderRadius: 12, overflow: 'hidden', opacity: selectedHier ? 1 : 0.5 }}>
          <div style={{ padding: '12px 16px', borderBottom: '1px solid rgba(77,158,255,0.08)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--vf-text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              Networks {selectedHier ? `— ${selectedHier.name}` : ''}
            </span>
            <Button variant="primary" size="sm" onClick={() => { setNetForm({ name: '', description: '' }); setNetModal(true); }} disabled={!selectedHier}>+ Add</Button>
          </div>
          <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8, minHeight: 120 }}>
            {!selectedHier ? (
              <div style={{ padding: 16, textAlign: 'center', color: 'var(--vf-text-dim)', fontSize: 13 }}>Select a hierarchy view</div>
            ) : loadingNets ? <LoadingState label="Loading…" compact /> : networks.length === 0 ? (
              <EmptyState title="No networks" compact />
            ) : networks.map((n) => (
              <div key={n.id} style={{ background: 'var(--vf-elevated)', border: '1px solid rgba(77,158,255,0.06)', borderRadius: 8, padding: '10px 12px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--vf-text-primary)' }}>{n.name}</div>
                  {n.description && <div style={{ fontSize: 11, color: 'var(--vf-text-muted)' }}>{n.description}</div>}
                </div>
                <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                  <Badge variant="default">Network</Badge>
                  <Button variant="danger" size="sm" onClick={() => setConfirmDel({ type: 'net', id: n.id!, name: n.name })}>Delete</Button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ── Modals ────────────────────────────────────────────────────────────── */}

      {/* Org create/edit */}
      <Modal open={orgModal.open} onClose={() => setOrgModal({ open: false, editing: null })}
        title={orgModal.editing ? `Edit ${orgModal.editing.name}` : 'Create Organization'}
        footer={<><Button variant="ghost" onClick={() => setOrgModal({ open: false, editing: null })}>Cancel</Button><Button variant="primary" loading={saving} onClick={handleSaveOrg}>{orgModal.editing ? 'Save' : 'Create'}</Button></>}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Input label="Name" value={orgForm.name} onChange={(e) => setOrgForm((f) => ({ ...f, name: e.target.value }))} fullWidth />
          <Input label="Description (optional)" value={orgForm.description} onChange={(e) => setOrgForm((f) => ({ ...f, description: e.target.value }))} fullWidth />
        </div>
      </Modal>

      {/* Hierarchy create */}
      <Modal open={hierModal} onClose={() => setHierModal(false)}
        title={`Add Hierarchy View — ${selectedOrg?.name}`}
        footer={<><Button variant="ghost" onClick={() => setHierModal(false)}>Cancel</Button><Button variant="primary" loading={saving} onClick={handleSaveHier}>Create</Button></>}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Input label="Name" value={hierForm.name} onChange={(e) => setHierForm((f) => ({ ...f, name: e.target.value }))} fullWidth />
          <Input label="Description (optional)" value={hierForm.description} onChange={(e) => setHierForm((f) => ({ ...f, description: e.target.value }))} fullWidth />
        </div>
      </Modal>

      {/* Network create */}
      <Modal open={netModal} onClose={() => setNetModal(false)}
        title={`Add Network — ${selectedHier?.name}`}
        footer={<><Button variant="ghost" onClick={() => setNetModal(false)}>Cancel</Button><Button variant="primary" loading={saving} onClick={handleSaveNet}>Create</Button></>}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Input label="Name" value={netForm.name} onChange={(e) => setNetForm((f) => ({ ...f, name: e.target.value }))} fullWidth />
          <Input label="Description (optional)" value={netForm.description} onChange={(e) => setNetForm((f) => ({ ...f, description: e.target.value }))} fullWidth />
        </div>
      </Modal>

      {/* Confirm delete */}
      <ConfirmModal
        open={!!confirmDel}
        title={`Delete ${confirmDel?.type === 'org' ? 'Organization' : confirmDel?.type === 'hier' ? 'Hierarchy' : 'Network'}`}
        message={`Delete "${confirmDel?.name}"? This action cannot be undone.`}
        onConfirm={handleDelete}
        onCancel={() => setConfirmDel(null)}
      />
    </div>
  );
}
