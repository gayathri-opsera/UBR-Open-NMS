/**
 * NodeViewParameters — Pure Renderer
 * ===================================
 *
 * NEW ARCHITECTURE (pre-built wireframe):
 *   Props shape:
 *     wireframe  — static layout from node_view_wireframes (built at upload time)
 *     values     — flat map of parameterId → live value (from /parameters/current)
 *
 *   The component is a PURE RENDERER. It:
 *     ✅ Binds values to wireframe parameters (O(1) map lookup)
 *     ✅ Renders groups / sub-groups / parameter table rows
 *     ✅ Shows UNMAPPED / STALE / FAILED / FRESH states
 *     ❌ Does NOT calculate groups
 *     ❌ Does NOT sort parameters
 *     ❌ Does NOT parse any definition format
 *
 * BACKWARD-COMPATIBLE overload:
 *   To avoid breaking the existing V2DeviceDetailPage while it migrates,
 *   the component also accepts the legacy `groups` + `current` props shape.
 *   When `wireframe` is provided, it takes precedence.
 */

import { useState } from 'react';
import type { CSSProperties } from 'react';

// ── New architecture types (from persisted wireframe) ─────────────────────────
import type { WireframeGroup, WireframeParameter, NodeViewValues, ParameterValueRecord } from '../../api/nodeView.types';

// ── Legacy types (kept for backward compat) ───────────────────────────────────
import type { AdaptiveParameter, AdaptiveParameterGroup } from '../../api/framework-panels.types';
import type { ParameterCurrentValue, ParameterCurrentValueData } from '../../api/framework-parameters.types';

import { Badge } from './common/Badge';
import { Button } from './common/Button';
import { Spinner } from './common/Spinner';

// ── Props ─────────────────────────────────────────────────────────────────────

/** New architecture props — use when consuming the node-view API. */
interface NewArchProps {
  wireframe:           WireframeGroup[];
  values:              NodeViewValues;
  loading:             boolean;
  refreshing:          boolean;
  onRefresh:           () => void;
  deviceStatus:        string;
  productDefinitionId: string;
  registryVersion:     string;
  collectedAt?:        string | null;
  pollStatus?:         string;
  // Legacy props not used in new arch — marked optional for compat
  groups?:   never;
  current?:  never;
}

/** Legacy props — kept for backward compat during migration. */
interface LegacyProps {
  groups:              AdaptiveParameterGroup[];
  current:             ParameterCurrentValueData | null;
  loading:             boolean;
  refreshing:          boolean;
  onRefresh:           () => void;
  deviceStatus:        string;
  productDefinitionId: string;
  registryVersion:     string;
  // New arch props not used in legacy mode
  wireframe?: never;
  values?:    never;
  collectedAt?: string | null;
  pollStatus?:  string;
}

type Props = NewArchProps | LegacyProps;

// ── Shared styles ─────────────────────────────────────────────────────────────

const th: CSSProperties = {
  textAlign: 'left', padding: '6px 12px', fontSize: 10, fontWeight: 700, textTransform: 'uppercase',
  letterSpacing: '0.06em', color: 'var(--vf-text-muted)', borderBottom: '1px solid var(--vf-border-subtle)',
};
const td: CSSProperties = {
  padding: '6px 12px', fontSize: 13, borderBottom: '1px solid var(--vf-border-subtle)', verticalAlign: 'top',
};

const NO_SUB = '\u0000none';

// ── Value cell — handles UNMAPPED / STALE / FAILED / FRESH ────────────────────

function ValueCell({ record, text }: {
  record: ParameterValueRecord | ParameterCurrentValue | undefined;
  text:   string | null;
}) {
  if (!record) {
    return <span style={{ color: 'var(--vf-text-muted)' }}>—</span>;
  }
  if ((record as ParameterCurrentValue).readStatus === 'UNMAPPED' ||
      (record as ParameterValueRecord).readStatus === 'UNMAPPED') {
    return <span title="no OID in product definition" style={{ color: 'var(--vf-text-muted)' }}>—</span>;
  }
  const fs = (record as ParameterValueRecord).freshnessState ?? (record as ParameterCurrentValue).freshnessState;
  const bad = fs === 'STALE' || fs === 'FAILED';
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
      <span style={{
        fontFamily: 'var(--vf-font-mono)', fontWeight: 600, wordBreak: 'break-all',
        color: bad || text === null ? 'var(--vf-text-muted)' : 'var(--vf-text-primary)',
        opacity: bad ? 0.7 : 1,
      }}>
        {text ?? '—'}
      </span>
      {bad && (
        <Badge
          variant={fs === 'FAILED' ? 'danger' : 'warning'}
          title={(record as ParameterCurrentValue).failureReason ?? undefined}
        >
          {fs === 'FAILED' ? 'Failed' : 'Stale'}
        </Badge>
      )}
    </span>
  );
}

// ── NEW ARCH: Section table using flat values map ─────────────────────────────

function NewSectionTable({
  params, values,
}: { params: WireframeParameter[]; values: NodeViewValues }) {
  // Collect table indexes across all table parameters in this section
  const indexes: string[] = [];
  for (const p of params) {
    const v = values[p.parameterId];
    if (!v?.isTable) continue;
    for (const inst of v.instances ?? []) {
      if (!indexes.includes(inst.index)) indexes.push(inst.index);
    }
  }
  const isTable = indexes.length > 0;
  indexes.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th style={th}>Parameter</th>
            {isTable
              ? indexes.map((i) => <th key={i} style={th}>#{i}</th>)
              : <th style={th}>Value</th>}
          </tr>
        </thead>
        <tbody>
          {params.map((p) => {
            const v = values[p.parameterId] as ParameterValueRecord | undefined;
            const getText = (idx: string | null) => {
              if (!v) return null;
              if (idx !== null && v.isTable && v.instances?.length) {
                const inst = v.instances.find((i) => i.index === idx);
                return inst ? (inst.display || inst.value || null) : null;
              }
              return v.display || v.value || null;
            };
            return (
              <tr key={p.parameterId}>
                <td style={{ ...td, color: 'var(--vf-text-secondary)' }}>
                  {p.displayName || p.parameterId}
                  {p.unit && (
                    <span style={{ color: 'var(--vf-text-muted)', marginLeft: 4, fontSize: 11 }}>({p.unit})</span>
                  )}
                  {p.readOnly && (
                    <span title="Read-only" aria-label="Read-only" style={{ marginLeft: 6, fontSize: 11 }}>🔒</span>
                  )}
                </td>
                {isTable ? (
                  v?.isTable ? (
                    indexes.map((i) => (
                      <td key={i} style={td}><ValueCell record={v} text={getText(i)} /></td>
                    ))
                  ) : (
                    <td style={td} colSpan={indexes.length}><ValueCell record={v} text={getText(null)} /></td>
                  )
                ) : (
                  <td style={td}><ValueCell record={v} text={getText(null)} /></td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── LEGACY ARCH: Section table using nested current value structure ────────────

function LegacySectionTable({
  groupId, params, values,
}: { groupId: string; params: AdaptiveParameter[]; values: Map<string, ParameterCurrentValue> }) {
  const legacyKey = (pid: string) => `${groupId}\u0000${pid}`;
  const indexes: string[] = [];
  for (const p of params) {
    const v = values.get(legacyKey(p.parameterId));
    if (!v?.isTable) continue;
    for (const inst of v.instances ?? []) if (!indexes.includes(inst.index)) indexes.push(inst.index);
  }
  const isTable = indexes.length > 0;
  indexes.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th style={th}>Parameter</th>
            {isTable ? indexes.map((i) => <th key={i} style={th}>#{i}</th>) : <th style={th}>Value</th>}
          </tr>
        </thead>
        <tbody>
          {params.map((p) => {
            const v = values.get(legacyKey(p.parameterId));
            const getText = (idx: string | null) => {
              if (!v) return null;
              if (idx !== null && v.instances?.length) {
                const inst = v.instances.find((i) => i.index === idx);
                return inst ? (inst.display || inst.value || null) : null;
              }
              return v.display || v.value || null;
            };
            return (
              <tr key={p.parameterId}>
                <td style={{ ...td, color: 'var(--vf-text-secondary)' }}>
                  {p.label || p.parameterId}
                  {p.unit && <span style={{ color: 'var(--vf-text-muted)', marginLeft: 4, fontSize: 11 }}>({p.unit})</span>}
                  {p.readOnly && <span title="Read-only" style={{ marginLeft: 6, fontSize: 11 }}>🔒</span>}
                </td>
                {isTable ? (
                  v?.isTable
                    ? indexes.map((i) => <td key={i} style={td}><ValueCell record={v} text={getText(i)} /></td>)
                    : <td style={td} colSpan={indexes.length}><ValueCell record={v} text={getText(null)} /></td>
                ) : (
                  <td style={td}><ValueCell record={v} text={getText(null)} /></td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Status bar ────────────────────────────────────────────────────────────────

function StatusBar({
  deviceStatus, productDefinitionId, registryVersion,
  collectedAt, pollStatus, pollError, loading, refreshing, onRefresh,
}: {
  deviceStatus:        string;
  productDefinitionId: string;
  registryVersion:     string;
  collectedAt?:        string | null;
  pollStatus?:         string;
  pollError?:          string;
  loading:             boolean;
  refreshing:          boolean;
  onRefresh:           () => void;
}) {
  const pollOk = pollStatus === 'OK';
  const strip: CSSProperties = { fontSize: 11, color: 'var(--vf-text-muted)' };
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', padding: '10px 16px',
      background: 'var(--vf-surface)', border: '1px solid var(--vf-border-subtle)', borderRadius: 10,
    }}>
      <span style={strip}>Status: <strong style={{ color: 'var(--vf-text-primary)' }}>{deviceStatus || '—'}</strong></span>
      <span style={{ ...strip, fontFamily: 'var(--vf-font-mono)' }}>def: {productDefinitionId} · rv{registryVersion}</span>
      <span style={strip}>
        Last polled: <strong style={{ color: 'var(--vf-text-primary)' }}>
          {collectedAt ? new Date(collectedAt).toLocaleString() : '—'}
        </strong>
      </span>
      {pollStatus && (
        <span style={strip}>
          Poll: <Badge variant={pollOk ? 'success' : pollStatus === 'NOT_POLLED' ? 'default' : 'danger'}>
            {pollStatus}
          </Badge>
          {!pollOk && pollError && (
            <span style={{ marginLeft: 6, color: 'var(--vf-warning)' }}>{pollError}</span>
          )}
        </span>
      )}
      {loading && <Spinner />}
      <span style={{ marginLeft: 'auto' }}>
        <Button variant="ghost" onClick={onRefresh} loading={refreshing}>↻ Refresh</Button>
      </span>
    </div>
  );
}

// ── Tab bar ────────────────────────────────────────────────────────────────────

function TabBar({
  tabs, active, onChange,
}: { tabs: { id: string; label: string }[]; active: string; onChange: (id: string) => void }) {
  return (
    <div style={{
      display: 'flex', gap: 0, borderBottom: '1px solid var(--vf-border-subtle)',
      overflowX: 'auto', flexShrink: 0,
    }}>
      {tabs.map((t) => {
        const isActive = t.id === active;
        return (
          <button
            key={t.id}
            onClick={() => onChange(t.id)}
            style={{
              background: 'transparent',
              border: 'none',
              borderBottom: isActive ? '2px solid var(--vf-accent, #4F8EF7)' : '2px solid transparent',
              padding: '10px 18px',
              fontSize: 13,
              fontWeight: isActive ? 700 : 500,
              color: isActive ? 'var(--vf-text-primary)' : 'var(--vf-text-muted)',
              cursor: 'pointer',
              whiteSpace: 'nowrap',
              marginBottom: -1,
              transition: 'color 0.15s, border-color 0.15s',
              letterSpacing: '0.01em',
              outline: 'none',
            }}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

// ── Tab content panel ──────────────────────────────────────────────────────────

function TabPanel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      background: 'var(--vf-surface)',
      border: '1px solid var(--vf-border-subtle)',
      borderTop: 'none',
      borderRadius: '0 0 12px 12px',
      overflow: 'hidden',
    }}>
      {children}
    </div>
  );
}

// ── Second-level sub-group tab bar ────────────────────────────────────────────
// Renders inside a top-level tab to show sub-groups as a second tab tier.
// Styled more compact than the top bar to express hierarchy.

function SubGroupTabBar({
  tabs, active, onChange,
}: { tabs: { id: string; label: string }[]; active: string; onChange: (id: string) => void }) {
  // Single sub-group — no tab bar needed, just render directly
  if (tabs.length <= 1) return null;
  return (
    <div style={{
      display: 'flex', gap: 0,
      borderBottom: '1px solid var(--vf-border-subtle)',
      background: 'rgba(255,255,255,0.02)',
      overflowX: 'auto', flexShrink: 0,
    }}>
      {tabs.map((t) => {
        const isActive = t.id === active;
        return (
          <button
            key={t.id}
            onClick={() => onChange(t.id)}
            style={{
              background: 'transparent', border: 'none',
              borderBottom: isActive
                ? '2px solid rgba(79,142,247,0.7)'
                : '2px solid transparent',
              padding: '7px 16px',
              fontSize: 12,
              fontWeight: isActive ? 600 : 400,
              color: isActive ? 'var(--vf-text-secondary)' : 'var(--vf-text-muted)',
              cursor: 'pointer', whiteSpace: 'nowrap',
              marginBottom: -1,
              transition: 'color 0.15s, border-color 0.15s',
              outline: 'none',
            }}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

// ── Sub-group tabs wrapper (stateful) ─────────────────────────────────────────

function SubGroupTabs({
  subGroupOrder,
  renderSubGroup,
}: {
  subGroupOrder: string[];
  renderSubGroup: (key: string) => React.ReactNode;
}) {
  const [activeKey, setActiveKey] = useState<string>(subGroupOrder[0] ?? '');
  const tabs = subGroupOrder.map((k) => ({
    id: k,
    label: k === '\u0000none'
      ? 'General'
      : k.charAt(0).toUpperCase() + k.slice(1).replace(/_/g, ' '),
  }));
  const current = subGroupOrder.includes(activeKey) ? activeKey : subGroupOrder[0];
  return (
    <div>
      <SubGroupTabBar tabs={tabs} active={current} onChange={setActiveKey} />
      {renderSubGroup(current)}
    </div>
  );
}

// ── Tabbed wrapper ─────────────────────────────────────────────────────────────

function TabbedGroups<G extends { groupId: string; label?: string; subGroups?: string[] }>({
  groups,
  renderContent,
}: {
  groups: G[];
  renderContent: (g: G) => React.ReactNode;
}) {
  const visible = groups.filter((g) => g !== null);
  const [activeId, setActiveId] = useState<string>(visible[0]?.groupId ?? '');
  const activeGroup = visible.find((g) => g.groupId === activeId) ?? visible[0];

  if (visible.length === 0) return null;

  const tabs = visible.map((g) => ({
    id: g.groupId,
    label: g.label || g.groupId.charAt(0).toUpperCase() + g.groupId.slice(1).replace(/_/g, ' '),
  }));

  return (
    <div style={{
      background: 'var(--vf-surface)',
      border: '1px solid var(--vf-border-subtle)',
      borderRadius: 12,
      overflow: 'hidden',
    }}>
      <TabBar tabs={tabs} active={activeGroup?.groupId ?? ''} onChange={setActiveId} />
      <TabPanel>
        {activeGroup ? renderContent(activeGroup) : null}
      </TabPanel>
    </div>
  );
}

// ── Main export ───────────────────────────────────────────────────────────────

export function NodeViewParameters(props: Props) {
  const {
    loading, refreshing, onRefresh, deviceStatus, productDefinitionId, registryVersion,
  } = props;

  // ── New architecture: wireframe + flat values map ─────────────────────────
  if ('wireframe' in props && props.wireframe !== undefined) {
    const { wireframe, values = {}, collectedAt, pollStatus } = props as NewArchProps;

    const visibleGroups = wireframe.filter((g) => g.parameters.some((p) => !p.hidden));

    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, paddingTop: 16 }}>
        <StatusBar
          deviceStatus={deviceStatus}
          productDefinitionId={productDefinitionId}
          registryVersion={registryVersion}
          collectedAt={collectedAt}
          pollStatus={pollStatus}
          loading={loading}
          refreshing={refreshing}
          onRefresh={onRefresh}
        />

        {loading && Object.keys(values).length === 0 && (
          <div style={{ padding: 24, textAlign: 'center' }}><Spinner /></div>
        )}

        <TabbedGroups
          groups={visibleGroups}
          renderContent={(g) => {
            const visible = g.parameters.filter((p) => !p.hidden);
            const bySub = new Map<string, WireframeParameter[]>();
            for (const p of visible) {
              const k = p.subGroup ?? NO_SUB;
              bySub.set(k, [...(bySub.get(k) ?? []), p]);
            }
            const order = [NO_SUB, ...(g.subGroups ?? [])];
            for (const k of bySub.keys()) if (!order.includes(k)) order.push(k);
            const filtered = order.filter((k) => bySub.has(k));

            // Single sub-group → no second tab bar needed
            if (filtered.length === 1) {
              return <NewSectionTable params={bySub.get(filtered[0]) ?? []} values={values} />;
            }

            // Multiple sub-groups → render as second-level tabs
            return (
              <SubGroupTabs
                subGroupOrder={filtered}
                renderSubGroup={(k) => (
                  <NewSectionTable params={bySub.get(k) ?? []} values={values} />
                )}
              />
            );
          }}
        />
      </div>
    );
  }

  // ── Legacy architecture: groups[] + ParameterCurrentValueData ────────────
  const { groups = [], current } = props as LegacyProps;

  const legacyValues = new Map<string, ParameterCurrentValue>();
  for (const g of current?.groups ?? []) {
    for (const p of g.parameters) legacyValues.set(`${g.groupId}\u0000${p.parameterId}`, p);
  }

  const visibleLegacyGroups = groups.filter((g) => g.parameters.some((p) => !p.hidden));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, paddingTop: 16 }}>
      <StatusBar
        deviceStatus={deviceStatus}
        productDefinitionId={productDefinitionId}
        registryVersion={registryVersion}
        collectedAt={current?.collectedAt}
        pollStatus={current?.pollStatus}
        pollError={current?.pollError}
        loading={loading}
        refreshing={refreshing}
        onRefresh={onRefresh}
      />

      {loading && !current && <div style={{ padding: 24, textAlign: 'center' }}><Spinner /></div>}

      <TabbedGroups
        groups={visibleLegacyGroups}
        renderContent={(g) => {
          const visible = g.parameters.filter((p) => !p.hidden);
          const bySub = new Map<string, AdaptiveParameter[]>();
          for (const p of visible) {
            const k = p.subGroup ?? NO_SUB;
            bySub.set(k, [...(bySub.get(k) ?? []), p]);
          }
          const order = [NO_SUB, ...(g.subGroups ?? [])];
          for (const k of bySub.keys()) if (!order.includes(k)) order.push(k);
          const filtered = order.filter((k) => bySub.has(k));

          if (filtered.length === 1) {
            return <LegacySectionTable groupId={g.groupId} params={bySub.get(filtered[0]) ?? []} values={legacyValues} />;
          }

          return (
            <SubGroupTabs
              subGroupOrder={filtered}
              renderSubGroup={(k) => (
                <LegacySectionTable groupId={g.groupId} params={bySub.get(k) ?? []} values={legacyValues} />
              )}
            />
          );
        }}
      />
    </div>
  );
}
