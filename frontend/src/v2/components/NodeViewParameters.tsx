/**
 * Node View: renders ONLY what the product definition declares (ui-template)
 * together with the live values the backend returns (parameters/current).
 * One card per group, one section per sub-group, one table per section.
 */
import type { CSSProperties } from 'react';
import type { AdaptiveParameter, AdaptiveParameterGroup } from '../../api/framework-panels.types';
import type {
  ParameterCurrentValue,
  ParameterCurrentValueData,
} from '../../api/framework-parameters.types';
import { Badge } from './common/Badge';
import { Button } from './common/Button';
import { Spinner } from './common/Spinner';

interface Props {
  groups: AdaptiveParameterGroup[];
  current: ParameterCurrentValueData | null;
  loading: boolean;
  refreshing: boolean;
  onRefresh: () => void;
  deviceStatus: string;
  productDefinitionId: string;
  registryVersion: string;
}

const th: CSSProperties = {
  textAlign: 'left', padding: '6px 12px', fontSize: 10, fontWeight: 700, textTransform: 'uppercase',
  letterSpacing: '0.06em', color: 'var(--vf-text-muted)', borderBottom: '1px solid var(--vf-border-subtle)',
};
const td: CSSProperties = {
  padding: '6px 12px', fontSize: 13, borderBottom: '1px solid var(--vf-border-subtle)', verticalAlign: 'top',
};

const NO_SUB = '\u0000none';

function valueKey(groupId: string, parameterId: string) {
  return `${groupId}\u0000${parameterId}`;
}

function instanceText(v: ParameterCurrentValue | undefined, index: string | null): string | null {
  if (!v) return null;
  if (index !== null && v.instances && v.instances.length > 0) {
    const inst = v.instances.find((i) => i.index === index);
    if (!inst) return null;
    return inst.display || inst.value || null;
  }
  return v.display || v.value || null;
}

function ValueCell({ v, text }: { v: ParameterCurrentValue | undefined; text: string | null }) {
  if (v?.readStatus === 'UNMAPPED') {
    return <span title="no OID in product definition" style={{ color: 'var(--vf-text-muted)' }}>—</span>;
  }
  const bad = v?.freshnessState === 'STALE' || v?.freshnessState === 'FAILED';
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
        <Badge variant={v?.freshnessState === 'FAILED' ? 'danger' : 'warning'} title={v?.failureReason}>
          {v?.freshnessState === 'FAILED' ? 'Failed' : 'Stale'}
        </Badge>
      )}
    </span>
  );
}

function SectionTable({
  groupId, params, values,
}: { groupId: string; params: AdaptiveParameter[]; values: Map<string, ParameterCurrentValue> }) {
  const indexes: string[] = [];
  for (const p of params) {
    const v = values.get(valueKey(groupId, p.parameterId));
    if (!v?.isTable) continue;
    for (const i of v.instances ?? []) if (!indexes.includes(i.index)) indexes.push(i.index);
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
            const v = values.get(valueKey(groupId, p.parameterId));
            return (
              <tr key={p.parameterId}>
                <td style={{ ...td, color: 'var(--vf-text-secondary)' }}>
                  {p.label || p.parameterId}
                  {p.unit && <span style={{ color: 'var(--vf-text-muted)', marginLeft: 4, fontSize: 11 }}>({p.unit})</span>}
                  {p.readOnly && (
                    <span title="Read-only" aria-label="Read-only" style={{ marginLeft: 6, fontSize: 11 }}>🔒</span>
                  )}
                </td>
                {isTable ? (
                  v?.isTable ? (
                    indexes.map((i) => (
                      <td key={i} style={td}><ValueCell v={v} text={instanceText(v, i)} /></td>
                    ))
                  ) : (
                    <td style={td} colSpan={indexes.length}><ValueCell v={v} text={instanceText(v, null)} /></td>
                  )
                ) : (
                  <td style={td}><ValueCell v={v} text={instanceText(v, null)} /></td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function NodeViewParameters({
  groups, current, loading, refreshing, onRefresh, deviceStatus, productDefinitionId, registryVersion,
}: Props) {
  const values = new Map<string, ParameterCurrentValue>();
  for (const g of current?.groups ?? []) {
    for (const p of g.parameters) values.set(valueKey(g.groupId, p.parameterId), p);
  }
  const pollStatus = current?.pollStatus;
  const pollOk = pollStatus === 'OK';
  const strip: CSSProperties = { fontSize: 11, color: 'var(--vf-text-muted)' };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', padding: '10px 16px',
        background: 'var(--vf-surface)', border: '1px solid var(--vf-border-subtle)', borderRadius: 10,
      }}>
        <span style={strip}>Status: <strong style={{ color: 'var(--vf-text-primary)' }}>{deviceStatus || '—'}</strong></span>
        <span style={{ ...strip, fontFamily: 'var(--vf-font-mono)' }}>def: {productDefinitionId} · rv{registryVersion}</span>
        <span style={strip}>
          Last polled: <strong style={{ color: 'var(--vf-text-primary)' }}>
            {current?.collectedAt ? new Date(current.collectedAt).toLocaleString() : '—'}
          </strong>
        </span>
        <span style={strip}>
          Poll: <Badge variant={pollOk ? 'success' : pollStatus === 'NOT_POLLED' || !pollStatus ? 'default' : 'danger'}>
            {pollStatus ?? '—'}
          </Badge>
          {!pollOk && current?.pollError && (
            <span style={{ marginLeft: 6, color: 'var(--vf-warning)' }}>{current.pollError}</span>
          )}
        </span>
        <span style={{ marginLeft: 'auto' }}>
          <Button variant="ghost" onClick={onRefresh} loading={refreshing}>↻ Refresh</Button>
        </span>
      </div>

      {loading && !current && <div style={{ padding: 24, textAlign: 'center' }}><Spinner /></div>}

      {groups.map((g) => {
        const visible = g.parameters.filter((p) => !p.hidden);
        if (visible.length === 0) return null;
        const bySub = new Map<string, AdaptiveParameter[]>();
        for (const p of visible) {
          const k = p.subGroup ?? NO_SUB;
          bySub.set(k, [...(bySub.get(k) ?? []), p]);
        }
        const order = [NO_SUB, ...(g.subGroups ?? [])];
        for (const k of bySub.keys()) if (!order.includes(k)) order.push(k);
        return (
          <div key={g.groupId} style={{ background: 'var(--vf-surface)', border: '1px solid var(--vf-border-subtle)', borderRadius: 12, overflow: 'hidden' }}>
            <div style={{ padding: '10px 16px', background: 'rgba(255,255,255,0.03)', borderBottom: '1px solid var(--vf-border-subtle)', fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'var(--vf-text-muted)' }}>
              {g.label || g.groupId}
            </div>
            {order.filter((k) => bySub.has(k)).map((k) => (
              <div key={k}>
                {k !== NO_SUB && (
                  <div style={{ padding: '8px 16px 2px', fontSize: 12, fontWeight: 700, color: 'var(--vf-text-secondary)' }}>{k}</div>
                )}
                <SectionTable groupId={g.groupId} params={bySub.get(k) ?? []} values={values} />
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}
