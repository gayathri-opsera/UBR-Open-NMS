/**
 * NodeViewParameters — Card-Style Wireframe Renderer
 * ====================================================
 *
 * NEW ARCHITECTURE (pre-built wireframe):
 *   Renders groups as top-level accent-underline tabs.
 *   Sub-groups within each group are shown as stacked section CARDS
 *   (matching the Wireless / Network tab visual language).
 *   Parameters inside each card use a 2-column grid with label + value box.
 *
 * BACKWARD-COMPATIBLE overload:
 *   Also accepts the legacy `groups` + `current` props shape.
 */

import { useState } from 'react';

// ── New architecture types ────────────────────────────────────────────────────
import type {
  WireframeGroup, WireframeParameter, NodeViewValues, ParameterValueRecord,
} from '../../api/nodeView.types';

// ── Legacy types ──────────────────────────────────────────────────────────────
import type { AdaptiveParameter, AdaptiveParameterGroup } from '../../api/framework-panels.types';
import type { ParameterCurrentValue, ParameterCurrentValueData } from '../../api/framework-parameters.types';

import { Badge }    from './common/Badge';
import { Button }   from './common/Button';
import { Spinner }  from './common/Spinner';

// ── Sentinel for parameters that have no explicit sub-group ───────────────────
const NO_SUB = '\u0000none';

// ─────────────────────────────────────────────────────────────────────────────
// Props
// ─────────────────────────────────────────────────────────────────────────────

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
  groups?:  never;
  current?: never;
}

interface LegacyProps {
  groups:              AdaptiveParameterGroup[];
  current:             ParameterCurrentValueData | null;
  loading:             boolean;
  refreshing:          boolean;
  onRefresh:           () => void;
  deviceStatus:        string;
  productDefinitionId: string;
  registryVersion:     string;
  wireframe?: never;
  values?:    never;
  collectedAt?: string | null;
  pollStatus?:  string;
}

type Props = NewArchProps | LegacyProps;

// ─────────────────────────────────────────────────────────────────────────────
// Status bar
// ─────────────────────────────────────────────────────────────────────────────

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
  const pollOk  = pollStatus === 'OK';
  const strip = { fontSize: 11, color: 'var(--vf-text-muted)' } as const;
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap',
      padding: '8px 14px',
      background: 'var(--vf-surface)',
      border: '1px solid var(--vf-border-subtle)',
      borderRadius: 8,
      marginBottom: 16,
    }}>
      <span style={strip}>
        Status: <strong style={{ color: 'var(--vf-text-primary)' }}>{deviceStatus || '—'}</strong>
      </span>
      <span style={{ ...strip, fontFamily: 'var(--vf-font-mono)' }}>
        def: {productDefinitionId} · rv{registryVersion}
      </span>
      <span style={strip}>
        Last polled:{' '}
        <strong style={{ color: 'var(--vf-text-primary)' }}>
          {collectedAt ? new Date(collectedAt).toLocaleString() : '—'}
        </strong>
      </span>
      {pollStatus && (
        <span style={strip}>
          Poll:{' '}
          <Badge variant={pollOk ? 'success' : pollStatus === 'NOT_POLLED' ? 'default' : 'danger'}>
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

// ─────────────────────────────────────────────────────────────────────────────
// Group tab bar  (accent-underline style, matches Wireless / Network tabs)
// ─────────────────────────────────────────────────────────────────────────────

function GroupTabBar({
  groups, activeId, onChange,
}: { groups: { id: string; label: string }[]; activeId: string; onChange: (id: string) => void }) {
  if (groups.length <= 1) return null;
  return (
    <div style={{
      display: 'flex',
      gap: 0,
      marginBottom: 20,
      borderBottom: '1px solid var(--vf-border-subtle)',
      paddingBottom: 0,
      overflowX: 'auto',
      flexShrink: 0,
    }}>
      {groups.map((g) => {
        const active = g.id === activeId;
        return (
          <button
            key={g.id}
            aria-selected={active}
            onClick={() => onChange(g.id)}
            style={{
              padding: '8px 16px',
              background: 'none',
              border: 'none',
              borderBottom: active ? '2px solid var(--vf-accent)' : '2px solid transparent',
              color: active ? 'var(--vf-accent)' : 'var(--vf-text-secondary)',
              fontFamily: 'var(--vf-font-sans)',
              fontSize: 13,
              fontWeight: active ? 600 : 400,
              cursor: 'pointer',
              marginBottom: -1,
              whiteSpace: 'nowrap',
              transition: 'color 0.15s, border-color 0.15s',
              outline: 'none',
            }}
          >
            {g.label}
          </button>
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Parameter value display (read-only field box)
// ─────────────────────────────────────────────────────────────────────────────

function ParamValueBox({ record, text }: {
  record: ParameterValueRecord | ParameterCurrentValue | undefined;
  text:   string | null;
}) {
  const fs  = (record as ParameterValueRecord)?.freshnessState ?? (record as ParameterCurrentValue)?.freshnessState;
  const bad = fs === 'STALE' || fs === 'FAILED';
  const empty = text === null || text === undefined;

  return (
    <div style={{
      padding: '7px 10px',
      background: 'var(--vf-input-bg, rgba(255,255,255,0.04))',
      border: '1px solid var(--vf-border-default, rgba(255,255,255,0.08))',
      borderRadius: 'var(--vf-radius-md, 6px)',
      minHeight: 34,
      display: 'flex',
      alignItems: 'center',
      gap: 6,
    }}>
      <span style={{
        fontFamily: (record && !empty) ? 'var(--vf-font-mono)' : 'var(--vf-font-sans)',
        fontSize: 13,
        fontWeight: 500,
        color: empty || bad ? 'var(--vf-text-muted)' : 'var(--vf-text-primary)',
        wordBreak: 'break-all',
        opacity: bad ? 0.75 : 1,
      }}>
        {text ?? '—'}
      </span>
      {bad && (
        <Badge
          variant={fs === 'FAILED' ? 'danger' : 'warning'}
          title={(record as ParameterCurrentValue)?.failureReason ?? undefined}
        >
          {fs === 'FAILED' ? 'Failed' : 'Stale'}
        </Badge>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Single parameter field (label + value box)
// ─────────────────────────────────────────────────────────────────────────────

function ParameterField({ param, record }: {
  param:  WireframeParameter;
  record: ParameterValueRecord | undefined;
}) {
  const displayText = record?.display || record?.value || null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{
        fontSize: 'var(--vf-type-caption-size, 11px)',
        fontWeight: 600,
        color: 'var(--vf-text-secondary)',
        letterSpacing: '0.04em',
        textTransform: 'uppercase',
        lineHeight: 1.4,
      }}>
        {param.displayName || param.parameterId}
        {param.unit && (
          <span style={{ fontWeight: 400, marginLeft: 4, opacity: 0.65 }}>({param.unit})</span>
        )}
        {param.readOnly && (
          <span title="Read-only" style={{ marginLeft: 5, opacity: 0.45 }}>🔒</span>
        )}
      </span>
      <ParamValueBox record={record} text={displayText} />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Table parameter (SNMP table with instances) — spans full width
// ─────────────────────────────────────────────────────────────────────────────

function TableParamSection({ param, record }: {
  param:  WireframeParameter;
  record: ParameterValueRecord | undefined;
}) {
  if (!record?.isTable || !record.instances?.length) {
    return <ParameterField param={param} record={record} />;
  }

  const instances = [...record.instances].sort((a, b) =>
    a.index.localeCompare(b.index, undefined, { numeric: true }),
  );
  const th = {
    padding: '5px 10px',
    fontSize: 10,
    fontWeight: 700,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.06em',
    color: 'var(--vf-text-muted)',
    borderBottom: '1px solid var(--vf-border-subtle)',
    textAlign: 'left' as const,
  };
  const td = {
    padding: '5px 10px',
    fontSize: 12,
    borderBottom: '1px solid var(--vf-border-subtle)',
  };

  return (
    <div style={{ gridColumn: '1 / -1', marginTop: 8 }}>
      <span style={{
        fontSize: 11, fontWeight: 600, color: 'var(--vf-text-secondary)',
        letterSpacing: '0.04em', textTransform: 'uppercase', display: 'block', marginBottom: 6,
      }}>
        {param.displayName || param.parameterId}
      </span>
      <div style={{ overflowX: 'auto', border: '1px solid var(--vf-border-subtle)', borderRadius: 6 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr>
              <th style={th}>#</th>
              <th style={th}>Value</th>
            </tr>
          </thead>
          <tbody>
            {instances.map((inst) => (
              <tr key={inst.index}>
                <td style={{ ...td, color: 'var(--vf-text-muted)' }}>{inst.index}</td>
                <td style={{ ...td, fontFamily: 'var(--vf-font-mono)' }}>
                  {inst.display || inst.value || '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Section card  (one sub-group → one rounded card with section header)
// ─────────────────────────────────────────────────────────────────────────────

function SectionCard({ title, params, values }: {
  title:  string;
  params: WireframeParameter[];
  values: NodeViewValues;
}) {
  const visible = params.filter((p) => !p.hidden);
  if (visible.length === 0) return null;

  // Split table vs scalar params
  const isTableParam = (p: WireframeParameter) => {
    const v = values[p.parameterId] as ParameterValueRecord | undefined;
    return v?.isTable && (v.instances?.length ?? 0) > 0;
  };

  return (
    <div style={{
      background: 'var(--vf-surface)',
      border: '1px solid var(--vf-border-subtle)',
      borderRadius: 'var(--vf-radius-lg, 12px)',
      boxShadow: 'var(--vf-shadow-low)',
      overflow: 'hidden',
      marginBottom: 16,
    }}>
      {title && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          padding: '10px 16px',
          borderBottom: '1px solid var(--vf-border-subtle)',
        }}>
          <span style={{
            fontSize: 'var(--vf-type-h4-size, 14px)',
            fontWeight: 'var(--vf-type-h4-weight, 600)' as unknown as number,
            color: 'var(--vf-text-primary)',
            letterSpacing: 'var(--vf-type-h4-tracking, 0)',
          }}>
            {title}
          </span>
        </div>
      )}

      <div style={{ padding: 16 }}>
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(2, 1fr)',
          gap: 16,
          alignItems: 'start',
        }}>
          {visible.map((p) => {
            const record = values[p.parameterId] as ParameterValueRecord | undefined;
            return isTableParam(p)
              ? <TableParamSection key={p.parameterId} param={p} record={record} />
              : <ParameterField    key={p.parameterId} param={p} record={record} />;
          })}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Legacy section table (unchanged, for backward compat)
// ─────────────────────────────────────────────────────────────────────────────

function LegacyParamValueBox({ groupId, param, values }: {
  groupId: string;
  param:   AdaptiveParameter;
  values:  Map<string, ParameterCurrentValue>;
}) {
  const key = `${groupId}\u0000${param.parameterId}`;
  const v   = values.get(key);
  const getText = () => {
    if (!v) return null;
    return v.display || v.value || null;
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{
        fontSize: 11, fontWeight: 600, color: 'var(--vf-text-secondary)',
        letterSpacing: '0.04em', textTransform: 'uppercase',
      }}>
        {param.label || param.parameterId}
        {param.unit && <span style={{ fontWeight: 400, marginLeft: 4, opacity: 0.65 }}>({param.unit})</span>}
        {param.readOnly && <span title="Read-only" style={{ marginLeft: 5, opacity: 0.45 }}>🔒</span>}
      </span>
      <ParamValueBox record={v} text={getText()} />
    </div>
  );
}

function LegacySectionCard({ group, values }: {
  group:  AdaptiveParameterGroup;
  values: Map<string, ParameterCurrentValue>;
}) {
  const visible = group.parameters.filter((p) => !p.hidden);
  if (visible.length === 0) return null;

  return (
    <div style={{
      background: 'var(--vf-surface)',
      border: '1px solid var(--vf-border-subtle)',
      borderRadius: 'var(--vf-radius-lg, 12px)',
      boxShadow: 'var(--vf-shadow-low)',
      overflow: 'hidden',
      marginBottom: 16,
    }}>
      <div style={{
        display: 'flex', alignItems: 'center',
        padding: '10px 16px',
        borderBottom: '1px solid var(--vf-border-subtle)',
      }}>
        <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--vf-text-primary)' }}>
          {group.label || group.groupId}
        </span>
      </div>
      <div style={{ padding: 16 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 16 }}>
          {visible.map((p) => (
            <LegacyParamValueBox key={p.parameterId} groupId={group.groupId} param={p} values={values} />
          ))}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main export
// ─────────────────────────────────────────────────────────────────────────────

export function NodeViewParameters(props: Props) {
  const {
    loading, refreshing, onRefresh,
    deviceStatus, productDefinitionId, registryVersion,
  } = props;

  // ── NEW ARCHITECTURE ───────────────────────────────────────────────────────
  if ('wireframe' in props && props.wireframe !== undefined) {
    const { wireframe, values = {}, collectedAt, pollStatus } = props as NewArchProps;

    const visibleGroups = wireframe.filter((g) =>
      g.parameters.some((p) => !p.hidden),
    );

    // eslint-disable-next-line react-hooks/rules-of-hooks
    const [activeGroupId, setActiveGroupId] = useState<string>(
      visibleGroups[0]?.groupId ?? '',
    );
    const activeGroup = visibleGroups.find((g) => g.groupId === activeGroupId) ?? visibleGroups[0];

    // Organise active group's parameters into sub-groups (cards)
    const activeParams = activeGroup?.parameters.filter((p) => !p.hidden) ?? [];
    const bySub        = new Map<string, WireframeParameter[]>();
    for (const p of activeParams) {
      const key = p.subGroup ?? NO_SUB;
      bySub.set(key, [...(bySub.get(key) ?? []), p]);
    }
    // Sub-group order: NO_SUB first, then declaration order, then any extras
    const subOrder = [NO_SUB, ...(activeGroup?.subGroups ?? [])];
    for (const k of bySub.keys()) if (!subOrder.includes(k)) subOrder.push(k);
    const filteredSubs = subOrder.filter((k) => bySub.has(k));

    const groupTabs = visibleGroups.map((g) => ({
      id:    g.groupId,
      label: g.label || g.groupId.charAt(0).toUpperCase() + g.groupId.slice(1).replace(/_/g, ' '),
    }));

    const singleGroup = visibleGroups.length === 1;

    return (
      <div style={{ display: 'flex', flexDirection: 'column', paddingTop: 16 }}>
        {/* Status bar */}
        <StatusBar
          deviceStatus={deviceStatus}
          productDefinitionId={productDefinitionId}
          registryVersion={String(registryVersion)}
          collectedAt={collectedAt}
          pollStatus={pollStatus}
          loading={loading}
          refreshing={refreshing}
          onRefresh={onRefresh}
        />

        {/* Loading state */}
        {loading && Object.keys(values).length === 0 && (
          <div style={{ padding: 32, textAlign: 'center' }}><Spinner /></div>
        )}

        {/* Group tabs (only shown when >1 group) */}
        <GroupTabBar
          groups={groupTabs}
          activeId={activeGroup?.groupId ?? ''}
          onChange={setActiveGroupId}
        />

        {/* Section cards — one per sub-group */}
        {filteredSubs.map((subKey) => {
          const subParams = bySub.get(subKey) ?? [];

          // Card title logic:
          //   • single group, no sub-group → use group label (or empty for clarity)
          //   • single group, named sub-group → use sub-group name
          //   • multiple groups, no sub-group → use group label
          //   • multiple groups, named sub-group → use sub-group name
          const cardTitle = subKey === NO_SUB
            ? (singleGroup ? '' : (activeGroup?.label || ''))
            : subKey.charAt(0).toUpperCase() + subKey.slice(1).replace(/_/g, ' ');

          return (
            <SectionCard
              key={subKey}
              title={cardTitle}
              params={subParams}
              values={values}
            />
          );
        })}

        {visibleGroups.length === 0 && !loading && (
          <div style={{
            padding: 24, textAlign: 'center',
            color: 'var(--vf-text-muted)', fontSize: 13,
          }}>
            No parameters defined in this definition.
          </div>
        )}
      </div>
    );
  }

  // ── LEGACY ARCHITECTURE ────────────────────────────────────────────────────
  const { groups = [], current } = props as LegacyProps;

  const legacyValues = new Map<string, ParameterCurrentValue>();
  for (const g of current?.groups ?? []) {
    for (const p of g.parameters) {
      legacyValues.set(`${g.groupId}\u0000${p.parameterId}`, p);
    }
  }

  const visibleLegacyGroups = groups.filter((g) =>
    g.parameters.some((p) => !p.hidden),
  );

  // eslint-disable-next-line react-hooks/rules-of-hooks
  const [activeLegacyId, setActiveLegacyId] = useState<string>(
    visibleLegacyGroups[0]?.groupId ?? '',
  );
  const activeLegacyGroup =
    visibleLegacyGroups.find((g) => g.groupId === activeLegacyId) ?? visibleLegacyGroups[0];

  const legacyTabs = visibleLegacyGroups.map((g) => ({
    id:    g.groupId,
    label: g.label || g.groupId.charAt(0).toUpperCase() + g.groupId.slice(1).replace(/_/g, ' '),
  }));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', paddingTop: 16 }}>
      <StatusBar
        deviceStatus={deviceStatus}
        productDefinitionId={productDefinitionId}
        registryVersion={String(registryVersion)}
        collectedAt={current?.collectedAt}
        pollStatus={current?.pollStatus}
        pollError={current?.pollError}
        loading={loading}
        refreshing={refreshing}
        onRefresh={onRefresh}
      />

      {loading && !current && (
        <div style={{ padding: 32, textAlign: 'center' }}><Spinner /></div>
      )}

      <GroupTabBar
        groups={legacyTabs}
        activeId={activeLegacyGroup?.groupId ?? ''}
        onChange={setActiveLegacyId}
      />

      {activeLegacyGroup && (
        <LegacySectionCard group={activeLegacyGroup} values={legacyValues} />
      )}
    </div>
  );
}
