/**
 * NodeViewParameters — Wireless-tab-style renderer for the definition-driven Node View
 * =================================================================================
 *
 * Renders exactly what the uploaded product definition declares, in its own hierarchy:
 *
 *   Group            → accent-underline tab          (definition group order)
 *     Sub-group      → Card with a title             (order of first appearance)
 *       Parameter    → labelled Select / Input       (definition parameter order)
 *
 * Look and behaviour follow WirelessConfigTab: tab bar with Apply on the right, `Card`s, a
 * 2-column grid, dropdowns for enumerated parameters, inputs for the rest. Nothing that is
 * not in the definition is shown.
 *
 * A parameter that the device reports once per radio / VLAN / port has several SNMP
 * instances. They stay inside that one parameter's field, one control per instance,
 * labelled by SNMP index (#1, #2, …) — no extra level is invented.
 *
 * Editing: a changed control is marked; Apply sends only the changed ones to the gateway,
 * which validates against the definition and writes to the device.
 */

import { useMemo, useState } from 'react';

import type {
  NodeViewChange, NodeViewChangeResult, NodeViewValues, ParameterValueRecord,
  WireframeGroup, WireframeParameter,
} from '../../api/nodeView.types';
import { valueKey } from '../../api/nodeView.types';
import { applyNodeViewChanges } from '../../api/nodeView.api';

import { Badge }   from './common/Badge';
import { Button }  from './common/Button';
import { Card }    from './common/Card';
import { Input }   from './common/Input';
import { Select }  from './common/Select';
import { Spinner } from './common/Spinner';
import { useToast } from './common/Toast';

// ── helpers ───────────────────────────────────────────────────────────────────

/** Parameters without a sub-group sit in an untitled leading card. */
const NO_SUB = '\u0000none';

/** Presentation only: acronyms that appear as sub-group slugs are upper-cased. */
const ACRONYMS = new Set(['ip', 'ipv4', 'ipv6', 'vlan', 'dhcp', 'dcs', 'ddrs', 'atpc', 'mtu', 'snr', 'rtx', 'qos', 'gps', 'ofdma', 'eirp']);
function humanize(slug: string): string {
  return slug
    .replace(/[-_]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((w) => (ACRONYMS.has(w.toLowerCase()) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}

const editKey = (groupId: string, parameterId: string, instance: string) => `${groupId}::${parameterId}::${instance}`;

interface InstanceView {
  index: string;
  value: string | null;
  display: string | null;
}

function instancesOf(record: ParameterValueRecord | undefined): InstanceView[] {
  if (!record) return [];
  if (record.instances?.length) {
    return record.instances.map((i) => ({ index: i.index, value: i.value, display: i.display }));
  }
  return record.value != null ? [{ index: '', value: record.value, display: record.display }] : [];
}

/** Client-side check mirroring the gateway's rules, so obvious mistakes are caught before sending. */
function validate(param: WireframeParameter, value: string): string | null {
  const dt = (param.dataType || '').toUpperCase();
  const options = param.options ?? [];
  if (options.length && (dt === 'ENUM' || param.effectiveWidget === 'dropdown')) {
    return options.some((o) => o.value === value) ? null : 'Choose one of the listed values.';
  }
  if (dt === 'IPADDRESS') {
    return /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(value) ? null : 'Enter an IPv4 address (a.b.c.d).';
  }
  if (dt === 'INTEGER') {
    if (!/^-?\d+$/.test(value)) return 'Enter a whole number.';
    const n = Number(value);
    if (param.minValue != null && n < param.minValue) return `Must be at least ${param.minValue}.`;
    if (param.maxValue != null && n > param.maxValue) return `Must be at most ${param.maxValue}.`;
    return null;
  }
  if (param.minValue != null && value.length < param.minValue) return `Must be at least ${param.minValue} characters.`;
  if (param.maxValue != null && value.length > param.maxValue) return `Must be at most ${param.maxValue} characters.`;
  return null;
}

// ── status strip ──────────────────────────────────────────────────────────────

function StatusBar({
  deviceStatus, productDefinitionId, registryVersion, collectedAt, pollStatus, loading, refreshing, onRefresh,
}: {
  deviceStatus: string; productDefinitionId: string; registryVersion: string;
  collectedAt?: string | null; pollStatus?: string; loading: boolean; refreshing: boolean; onRefresh: () => void;
}) {
  const pollOk = pollStatus === 'OK';
  const strip = { fontSize: 11, color: 'var(--vf-text-muted)' } as const;
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', padding: '8px 14px',
      background: 'var(--vf-surface)', border: '1px solid var(--vf-border-subtle)', borderRadius: 8, marginBottom: 16,
    }}>
      <span style={strip}>Status: <strong style={{ color: 'var(--vf-text-primary)' }}>{deviceStatus || '—'}</strong></span>
      <span style={{ ...strip, fontFamily: 'var(--vf-font-mono)' }}>def: {productDefinitionId}{registryVersion ? ` · rv${registryVersion}` : ''}</span>
      <span style={strip}>
        Last polled: <strong style={{ color: 'var(--vf-text-primary)' }}>{collectedAt ? new Date(collectedAt).toLocaleString() : '—'}</strong>
      </span>
      {pollStatus && (
        <span style={strip}>
          Poll: <Badge variant={pollOk ? 'success' : pollStatus === 'NOT_POLLED' ? 'default' : 'danger'}>{pollStatus}</Badge>
        </span>
      )}
      {loading && <Spinner />}
      <span style={{ marginLeft: 'auto' }}>
        <Button variant="ghost" onClick={onRefresh} loading={refreshing}>↻ Refresh</Button>
      </span>
    </div>
  );
}

// ── one control (Select or Input) ─────────────────────────────────────────────

interface ControlProps {
  id:        string;
  param:     WireframeParameter;
  /** value the device currently reports (null = none) */
  original:  string | null;
  /** shown text for a read-only enumerated value */
  edited:    string | undefined;
  editable:  boolean;
  error?:    string;
  label?:    string;
  hint?:     string;
  onChange:  (v: string) => void;
}

function Control({ id, param, original, edited, editable, error, label, hint, onChange }: ControlProps) {
  const [reveal, setReveal] = useState(false);
  const current = edited !== undefined ? edited : (original ?? '');
  const changed = edited !== undefined && edited !== (original ?? '');
  const paramOptions = param.options ?? [];
  const isEnum = paramOptions.length > 0 && ((param.dataType || '').toUpperCase() === 'ENUM' || param.effectiveWidget === 'dropdown');
  const mark = changed ? { boxShadow: '0 0 0 2px var(--vf-accent)', borderRadius: 'var(--vf-radius-md)' } : undefined;

  if (isEnum) {
    // The device may report a value the definition does not list — keep it selectable and
    // visible instead of silently showing the first option.
    const known = paramOptions.some((o) => o.value === current);
    const options = [
      ...(!known && current !== '' ? [{ value: current, label: `${current} (current)` }] : []),
      ...paramOptions.map((o) => ({ value: o.value, label: o.label === o.value ? o.label : `${o.label} (${o.value})` })),
    ];
    return (
      <div style={mark}>
        <Select
          id={id} label={label} options={options} value={current} placeholder={current === '' ? '—' : undefined}
          disabled={!editable} error={error} hint={hint} onChange={(e) => onChange(e.target.value)}
        />
      </div>
    );
  }

  const numeric = (param.dataType || '').toUpperCase() === 'INTEGER';
  return (
    <div style={{ position: 'relative', ...mark }}>
      <Input
        id={id} label={label}
        type={param.sensitive && !reveal ? 'password' : numeric ? 'number' : 'text'}
        value={current} placeholder={original == null ? '—' : undefined}
        min={numeric && param.minValue != null ? param.minValue : undefined}
        max={numeric && param.maxValue != null ? param.maxValue : undefined}
        disabled={!editable} error={error} hint={hint} autoComplete="off"
        onChange={(e) => onChange(e.target.value)}
      />
      {param.sensitive && (
        <button
          type="button" onClick={() => setReveal((v) => !v)}
          aria-label={reveal ? 'Hide value' : 'Show value'}
          style={{ position: 'absolute', right: 10, top: label ? 30 : 8, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--vf-text-muted)', fontSize: 12 }}
        >
          {reveal ? '🙈 Hide' : '👁 Show'}
        </button>
      )}
    </div>
  );
}

// ── one parameter (label + one control per instance) ──────────────────────────

function ParameterField({ groupId, param, record, canEdit, edits, errors, onEdit }: {
  groupId: string; param: WireframeParameter; record: ParameterValueRecord | undefined; canEdit: boolean;
  edits: Record<string, string>; errors: Record<string, string>;
  onEdit: (key: string, value: string, original: string | null) => void;
}) {
  const instances = instancesOf(record);
  const writableParam = canEdit && !param.readOnly && !!param.snmpOid;
  const title = param.unit ? `${param.displayName || param.parameterId} (${param.unit})` : (param.displayName || param.parameterId);
  const baseId = `nv-${groupId}-${param.parameterId}`;

  // No value from the device: say why, never fake one.
  if (instances.length === 0) {
    const why = record?.readStatus === 'UNMAPPED' ? 'No OID in the definition'
      : record?.readStatus === 'NO_SUCH_OBJECT' ? 'Not reported by the device'
      : record?.readStatus === 'UNREACHABLE' ? 'Device unreachable' : 'No value yet';
    return <Input id={baseId} label={title} value="" placeholder="—" disabled hint={why} readOnly />;
  }

  const stale = record && (record.freshnessState === 'STALE' || record.freshnessState === 'FAILED');
  const staleHint = stale ? (record?.failureReason || 'Value may be out of date') : undefined;

  if (instances.length === 1 && instances[0].index === '') {
    const inst = instances[0];
    const k = editKey(groupId, param.parameterId, '');
    return (
      <Control
        id={baseId} param={param} label={title} original={inst.value} edited={edits[k]} editable={writableParam}
        error={errors[k]} hint={staleHint} onChange={(v) => onEdit(k, v, inst.value)}
      />
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: 'var(--vf-type-caption-size)', fontWeight: 600, color: 'var(--vf-text-secondary)', letterSpacing: '0.03em' }}>
        {title}
      </span>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {instances.map((inst) => {
          const k = editKey(groupId, param.parameterId, inst.index);
          return (
            <div key={inst.index} style={{ display: 'grid', gridTemplateColumns: '34px 1fr', gap: 8, alignItems: 'start' }}>
              <span
                title={`SNMP instance ${inst.index}`}
                style={{ fontSize: 11, fontFamily: 'var(--vf-font-mono)', color: 'var(--vf-text-muted)', paddingTop: 9 }}
              >
                #{inst.index}
              </span>
              <Control
                id={`${baseId}-${inst.index}`} param={param} original={inst.value} edited={edits[k]}
                editable={writableParam} error={errors[k]} hint={staleHint} onChange={(v) => onEdit(k, v, inst.value)}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── props ─────────────────────────────────────────────────────────────────────

interface Props {
  deviceId:            string;
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
  /** The signed-in user may change configuration (role check; the gateway enforces it too). */
  canEdit:             boolean;
  /** The gateway can write to this device (a write community is configured). */
  deviceWritable:      boolean;
}

// ── main ──────────────────────────────────────────────────────────────────────

export function NodeViewParameters({
  deviceId, wireframe, values, loading, refreshing, onRefresh, deviceStatus,
  productDefinitionId, registryVersion, collectedAt, pollStatus, canEdit, deviceWritable,
}: Props) {
  const { addToast } = useToast();
  const [activeGroupId, setActiveGroupId] = useState<string>('');
  const [edits, setEdits]       = useState<Record<string, string>>({});
  const [originals, setOriginals] = useState<Record<string, string | null>>({});
  const [errors, setErrors]     = useState<Record<string, string>>({});
  const [applying, setApplying] = useState(false);

  const groups = useMemo(() => wireframe.filter((g) => g.parameters.some((p) => !p.hidden)), [wireframe]);
  const activeGroup = groups.find((g) => g.groupId === activeGroupId) ?? groups[0];

  // sub-group → parameters, kept in the definition's order
  const cards = useMemo(() => {
    if (!activeGroup) return [] as Array<{ key: string; title: string; params: WireframeParameter[] }>;
    const bySub = new Map<string, WireframeParameter[]>();
    for (const p of activeGroup.parameters) {
      if (p.hidden) continue;
      const k = p.subGroup ?? NO_SUB;
      bySub.set(k, [...(bySub.get(k) ?? []), p]);
    }
    const order = [NO_SUB, ...activeGroup.subGroups];
    for (const k of bySub.keys()) if (!order.includes(k)) order.push(k);
    return order.filter((k) => bySub.has(k)).map((k) => ({
      key: k, title: k === NO_SUB ? '' : humanize(k), params: bySub.get(k) ?? [],
    }));
  }, [activeGroup]);

  // the notices below only matter for groups that have something to edit
  const groupHasWritable = !!activeGroup && activeGroup.parameters.some((p) => !p.hidden && !p.readOnly && !!p.snmpOid);

  const pending = Object.entries(edits).filter(([k, v]) => v !== (originals[k] ?? ''));
  const editingAllowed = canEdit && deviceWritable;

  const onEdit = (key: string, value: string, original: string | null) => {
    setOriginals((o) => ({ ...o, [key]: original }));
    setEdits((e) => ({ ...e, [key]: value }));
    setErrors((er) => { if (!(key in er)) return er; const { [key]: _drop, ...rest } = er; return rest; });
  };

  const reset = () => { setEdits({}); setOriginals({}); setErrors({}); };

  // locate a parameter by its edit key
  const paramFor = (key: string): { groupId: string; param: WireframeParameter; instance: string } | null => {
    const [groupId, parameterId, instance] = key.split('::');
    const param = wireframe.find((g) => g.groupId === groupId)?.parameters.find((p) => p.parameterId === parameterId);
    return param ? { groupId, param, instance: instance ?? '' } : null;
  };

  async function apply() {
    const nextErrors: Record<string, string> = {};
    const changes: NodeViewChange[] = [];
    for (const [key, value] of pending) {
      const hit = paramFor(key);
      if (!hit) continue;
      const msg = validate(hit.param, value);
      if (msg) nextErrors[key] = msg;
      else changes.push({ groupId: hit.groupId, parameterId: hit.param.parameterId, instance: hit.instance, value });
    }
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length || changes.length === 0) {
      if (Object.keys(nextErrors).length) addToast('Fix the highlighted fields before applying.', 'error');
      return;
    }

    setApplying(true);
    try {
      const resp = await applyNodeViewChanges(deviceId, changes);
      if (resp.error && !resp.results) {
        addToast(resp.error.message, 'error');
        return;
      }
      const results: NodeViewChangeResult[] = resp.results ?? [];
      const failed = results.filter((r) => !r.ok);
      const okKeys = new Set(results.filter((r) => r.ok).map((r) => editKey(r.groupId, r.parameterId, r.instance)));
      setEdits((e) => Object.fromEntries(Object.entries(e).filter(([k]) => !okKeys.has(k))));
      setOriginals((o) => Object.fromEntries(Object.entries(o).filter(([k]) => !okKeys.has(k))));
      setErrors(Object.fromEntries(failed.map((r) => [editKey(r.groupId, r.parameterId, r.instance), r.error ?? 'Rejected'])));
      if (failed.length === 0) addToast(`Applied ${results.length} change${results.length === 1 ? '' : 's'} to the device.`, 'success');
      else addToast(`${results.length - failed.length} applied, ${failed.length} failed — see the highlighted fields.`, 'error');
      if (okKeys.size) onRefresh();
    } catch (e) {
      addToast(e instanceof Error ? e.message : 'Failed to apply changes.', 'error');
    } finally {
      setApplying(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', paddingTop: 16 }}>
      <StatusBar
        deviceStatus={deviceStatus} productDefinitionId={productDefinitionId} registryVersion={registryVersion}
        collectedAt={collectedAt} pollStatus={pollStatus} loading={loading} refreshing={refreshing} onRefresh={onRefresh}
      />

      {loading && Object.keys(values).length === 0 && (
        <div style={{ padding: 32, textAlign: 'center' }}><Spinner /></div>
      )}

      {/* Group tabs + Apply (same bar as the Wireless tab) */}
      {groups.length > 0 && (
        <div style={{ display: 'flex', gap: 4, marginBottom: 20, borderBottom: '1px solid var(--vf-border-subtle)', overflowX: 'auto' }}>
          {groups.map((g) => {
            const active = g.groupId === activeGroup?.groupId;
            return (
              <button
                key={g.groupId} onClick={() => setActiveGroupId(g.groupId)} aria-selected={active}
                style={{
                  padding: '8px 16px', background: 'none', border: 'none',
                  borderBottom: active ? '2px solid var(--vf-accent)' : '2px solid transparent',
                  color: active ? 'var(--vf-accent)' : 'var(--vf-text-secondary)',
                  fontFamily: 'var(--vf-font-sans)', fontSize: 13, fontWeight: active ? 600 : 400,
                  cursor: 'pointer', marginBottom: -1, whiteSpace: 'nowrap',
                }}
              >
                {g.label || humanize(g.groupId)}
              </button>
            );
          })}
          {editingAllowed && (
            <div style={{ marginLeft: 'auto', paddingBottom: 4, display: 'flex', gap: 8, alignItems: 'center' }}>
              {pending.length > 0 && <Button variant="ghost" size="sm" onClick={reset} disabled={applying}>Reset</Button>}
              <Button size="sm" onClick={() => void apply()} disabled={applying || pending.length === 0} loading={applying}>
                {pending.length > 0 ? `Apply (${pending.length})` : 'Apply'}
              </Button>
            </div>
          )}
        </div>
      )}

      {canEdit && !deviceWritable && groupHasWritable && (
        <div style={{
          padding: '8px 12px', marginBottom: 12, background: 'var(--vf-warning-subtle)',
          border: '1px solid var(--vf-warning)', borderRadius: 6, fontSize: 12, color: 'var(--vf-warning)',
        }}>
          Read-only — no SNMP write community is configured for this device, so changes cannot be applied.
        </div>
      )}
      {!canEdit && groupHasWritable && (
        <div style={{
          padding: '8px 12px', marginBottom: 12, background: 'var(--vf-warning-subtle)',
          border: '1px solid var(--vf-warning)', borderRadius: 6, fontSize: 12, color: 'var(--vf-warning)',
        }}>
          Read-only mode — you do not have permission to modify device configuration.
        </div>
      )}

      {/* One Card per sub-group, parameters in definition order */}
      {cards.map((c) => (
        <Card key={c.key} title={c.title || undefined} style={{ marginBottom: 16 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, alignItems: 'start' }}>
            {c.params.map((p) => (
              <ParameterField
                key={p.parameterId} groupId={activeGroup.groupId} param={p}
                record={values[valueKey(activeGroup.groupId, p.parameterId)]}
                canEdit={editingAllowed} edits={edits} errors={errors} onEdit={onEdit}
              />
            ))}
          </div>
        </Card>
      ))}

      {groups.length === 0 && !loading && (
        <div style={{ padding: 24, textAlign: 'center', color: 'var(--vf-text-muted)', fontSize: 13 }}>
          No parameters defined in this definition.
        </div>
      )}
    </div>
  );
}
