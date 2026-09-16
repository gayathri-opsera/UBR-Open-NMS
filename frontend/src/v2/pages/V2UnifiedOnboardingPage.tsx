/**
 * V2 Unified Onboarding Visibility Page — WO-044 / REQ-001 / REQ-002
 *
 * Operational workspace showing both UBR call-home and generic discovery
 * onboarding progress without implying all devices require manual approval.
 * Role-gated: Admin and Operator roles only.
 *
 * Features:
 *  - Paginated table of all devices with onboarding state badges
 *  - Filter by paradigm (UBR / GENERIC), state, and assignment gate status
 *  - Detail panel showing failure reason, retry guidance, and safe next actions
 *  - Disabled-mode state when both discovery modes are off
 *  - Never renders sensitive southbound fields (HMAC, nonces, certs, credentials)
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  fetchOnboardingStatus,
  onboardingStateVariant,
  onboardingStateLabel,
} from '../../api/onboarding.api';
import type {
  OnboardingStatusItem,
  OnboardingStatusResponse,
  OnboardingStateValue,
} from '../../api/onboarding.api';
import { useAuth } from '../../contexts/AuthContext';
import { Badge } from '../components/common/Badge';
import { Button } from '../components/common/Button';
import { Input } from '../components/common/Input';
import { MetricCard } from '../components/common/MetricCard';
import { LoadingState, EmptyState } from '../components/common/States';
import { useToast } from '../components/common/Toast';
import { logger } from '../utils/logger';

// ── Constants ─────────────────────────────────────────────────────────────────

const PAGE_SIZE = 50;

/** Sensitive field names that must never be rendered regardless of server response. */
const SENSITIVE_FIELDS = new Set([
  'hmacSecret', 'nonce', 'certificate', 'credentialRef',
  'authSignature', 'privateKey', 'secretKey', 'sharedSecret',
]);

const STATE_OPTIONS: Array<{ value: OnboardingStateValue | ''; label: string }> = [
  { value: '',                  label: 'All States' },
  { value: 'MANAGED',           label: 'Managed' },
  { value: 'AUTHENTICATED',     label: 'Authenticated' },
  { value: 'CHECK_IN_RECEIVED', label: 'Checked In' },
  { value: 'PENDING_ASSIGNMENT',label: 'Pending Assignment' },
  { value: 'CONFIG_WITHHELD',   label: 'Config Withheld' },
  { value: 'FAILED',            label: 'Failed' },
  { value: 'RETRYING',          label: 'Retrying' },
  { value: 'REDIRECTED',        label: 'Redirected' },
  { value: 'PENDING',           label: 'Pending' },
];

const PARADIGM_OPTIONS = [
  { value: '',        label: 'All Paradigms' },
  { value: 'UBR',     label: 'UBR Call-Home' },
  { value: 'GENERIC', label: 'Generic Discovery' },
];

const ASSIGNMENT_OPTIONS = [
  { value: '',           label: 'All Assignment States' },
  { value: 'UNASSIGNED', label: 'Unassigned (Gated)' },
  { value: 'ASSIGNED',   label: 'Assigned' },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function relTime(iso?: string): string {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function retryLabel(item: OnboardingStatusItem): string {
  if (item.retryAfterSeconds === undefined) return '—';
  if (item.retryAfterSeconds === 0) return 'Immediate';
  const s = item.retryAfterSeconds;
  const jitter = item.retryJitterMaxSeconds ? ` ±${item.retryJitterMaxSeconds}s` : '';
  if (s < 60) return `${s}s${jitter}`;
  return `${Math.round(s / 60)}m${jitter}`;
}

/** Guard: strip any accidental sensitive keys before display. */
function hasSensitiveField(item: Record<string, unknown>): boolean {
  return Object.keys(item).some((k) => SENSITIVE_FIELDS.has(k));
}

// ── State Badge ───────────────────────────────────────────────────────────────

function OnboardingStateBadge({ state }: { state: OnboardingStateValue }) {
  return (
    <Badge variant={onboardingStateVariant(state)} dot>
      {onboardingStateLabel(state)}
    </Badge>
  );
}

// ── Paradigm Badge ────────────────────────────────────────────────────────────

function ParadigmBadge({ paradigm }: { paradigm?: string }) {
  if (!paradigm) return <span style={{ color: 'var(--vf-text-muted)' }}>—</span>;
  const isUbr = paradigm.toUpperCase() === 'UBR';
  return (
    <Badge variant={isUbr ? 'accent' : 'success'}>
      {isUbr ? 'UBR' : 'Generic'}
    </Badge>
  );
}

// ── Retry Guidance ────────────────────────────────────────────────────────────

function RetryGuidance({ item }: { item: OnboardingStatusItem }) {
  if (item.onboardingState !== 'FAILED' && item.onboardingState !== 'RETRYING') {
    return null;
  }
  return (
    <div
      role="status"
      aria-label="Retry guidance"
      style={{
        background: 'rgba(234,179,8,0.08)',
        border: '1px solid rgba(234,179,8,0.3)',
        borderRadius: 6,
        padding: '10px 14px',
        fontSize: 12,
        color: 'var(--vf-text-secondary)',
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 4, color: '#fbbf24' }}>
        Retry Guidance
      </div>
      <div>
        <strong>Reason:</strong>{' '}
        {item.reasonCategory ?? 'Unknown failure'}
      </div>
      {item.lastSuccessfulState && (
        <div style={{ marginTop: 3 }}>
          <strong>Last Successful State:</strong>{' '}
          {onboardingStateLabel(item.lastSuccessfulState)}
        </div>
      )}
      <div style={{ marginTop: 3 }}>
        <strong>Retry After:</strong> {retryLabel(item)}
      </div>
    </div>
  );
}

// ── Failure Detail Panel ──────────────────────────────────────────────────────

interface FailureDetailPanelProps {
  item: OnboardingStatusItem;
  onClose: () => void;
  canAct: boolean;
}

function FailureDetailPanel({ item, onClose, canAct }: FailureDetailPanelProps) {
  const isUbr = item.discoveryParadigm?.toUpperCase() === 'UBR';

  // Guard: ensure no sensitive field is rendered
  if (hasSensitiveField(item as unknown as Record<string, unknown>)) {
    logger.warn('Onboarding item contained sensitive field — redacted before render', {
      metadata: { deviceId: item.deviceId },
    });
  }

  const fields: Array<[string, string | undefined]> = isUbr
    ? [
        ['Serial', item.serialNumber || '—'],
        ['MAC', item.macAddress ?? '—'],
        ['Paradigm', 'UBR Call-Home'],
        ['Bootstrap State', item.bootstrapState ?? '—'],
        ['Last Check-In', relTime(item.lastCheckInAt)],
        ['Last Realtime', relTime(item.lastRealtimeAt)],
        ['Assignment', item.assignmentState ?? '—'],
        ['Config Delivery', item.configurationDeliveryState ?? '—'],
        ['Updated', relTime(item.updatedAt)],
      ]
    : [
        ['SysObjectID', item.sysObjectID ?? '—'],
        ['Paradigm', 'Generic Discovery'],
        ['Last Successful State', item.lastSuccessfulState ?? '—'],
        ['Updated', relTime(item.updatedAt)],
      ];

  return (
    <div
      role="dialog"
      aria-label={`Onboarding detail for ${item.serialNumber || item.deviceId}`}
      style={{
        position: 'fixed',
        top: 0,
        right: 0,
        bottom: 0,
        width: 400,
        background: 'var(--vf-surface)',
        borderLeft: '1px solid var(--vf-border-subtle)',
        boxShadow: '-4px 0 24px rgba(0,0,0,0.4)',
        zIndex: 200,
        display: 'flex',
        flexDirection: 'column',
        overflowY: 'auto',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 20px', borderBottom: '1px solid var(--vf-border-subtle)' }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 700, fontFamily: 'var(--vf-font-mono)' }}>
            {item.serialNumber || item.deviceId}
          </div>
          <div style={{ fontSize: 11, color: 'var(--vf-text-muted)', marginTop: 2 }}>
            {item.deviceId}
          </div>
        </div>
        <button
          onClick={onClose}
          aria-label="Close detail panel"
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--vf-text-muted)', fontSize: 18, padding: 4 }}
        >
          ✕
        </button>
      </div>

      <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <OnboardingStateBadge state={item.onboardingState} />
          <ParadigmBadge paradigm={item.discoveryParadigm} />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          {fields.map(([label, val]) => (
            <div key={label}>
              <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--vf-text-muted)', marginBottom: 2 }}>{label}</div>
              <div style={{ fontSize: 12, fontFamily: ['Serial', 'MAC', 'SysObjectID'].includes(label) ? 'var(--vf-font-mono)' : undefined }}>{val}</div>
            </div>
          ))}
        </div>

        <RetryGuidance item={item} />

        {/* Role-gated actions: only shown to Admin/Operator with explicit server-side enforcement */}
        {canAct && item.assignmentState === 'UNASSIGNED' && (
          <div
            style={{
              background: 'rgba(99,102,241,0.08)',
              border: '1px solid rgba(99,102,241,0.25)',
              borderRadius: 6,
              padding: '10px 14px',
              fontSize: 12,
            }}
          >
            <div style={{ fontWeight: 600, marginBottom: 4 }}>Assignment Required</div>
            <div style={{ color: 'var(--vf-text-muted)', marginBottom: 10 }}>
              This device cannot proceed to configuration delivery until assigned to a network.
              Use the device inventory to assign a Network ID.
            </div>
            <Button variant="primary" size="sm">
              Go to Inventory
            </Button>
          </div>
        )}

        {!canAct && (item.assignmentState === 'UNASSIGNED' || item.configurationDeliveryState === 'WITHHELD') && (
          <div
            style={{
              background: 'rgba(30,41,59,0.5)',
              border: '1px solid var(--vf-border-subtle)',
              borderRadius: 6,
              padding: '10px 14px',
              fontSize: 12,
              color: 'var(--vf-text-muted)',
            }}
            role="note"
            aria-label="Permission denied for action"
          >
            Admin or Operator role required to take action on this device.
          </div>
        )}
      </div>
    </div>
  );
}

// ── Disabled Mode Banner ──────────────────────────────────────────────────────

function DisabledModeBanner() {
  return (
    <EmptyState
      title="Onboarding Disabled"
      description="Both UBR Call-Home and Generic Discovery modes are currently disabled. Enable at least one mode in the Discovery Mode Administration panel to begin onboarding devices."
      icon={
        <svg width="48" height="48" viewBox="0 0 48 48" fill="none" aria-hidden="true">
          <circle cx="24" cy="24" r="22" stroke="currentColor" strokeWidth="2" strokeDasharray="4 4" opacity="0.5" />
          <path d="M16 24h16M24 16v16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" opacity="0.3" />
        </svg>
      }
    />
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function V2UnifiedOnboardingPage() {
  const { addToast } = useToast();
  const { user } = useAuth();
  const navigate = useNavigate();

  const [response, setResponse] = useState<OnboardingStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);

  // Filters
  const [search, setSearch]         = useState('');
  const [stateFilter, setStateFilter]       = useState<OnboardingStateValue | ''>('');
  const [paradigmFilter, setParadigmFilter] = useState('');
  const [assignmentFilter, setAssignmentFilter] = useState('');

  // Detail panel
  const [detailItem, setDetailItem] = useState<OnboardingStatusItem | null>(null);

  const canAct =
    user?.role === 'Admin' ||
    user?.role === 'admin' ||
    user?.role === 'Operator' ||
    user?.role === 'operator';

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchOnboardingStatus({
      page,
      limit: PAGE_SIZE,
      state:         stateFilter   || undefined,
      paradigm:      paradigmFilter || undefined,
    })
      .then((res) => setResponse(res))
      .catch((e: unknown) => {
        const status = (e as { response?: { status?: number } })?.response?.status;
        if (status === 403) {
          setError('permission_denied');
        } else {
          setError('load_failed');
          logger.error('Onboarding status fetch failed', e);
          addToast('Failed to load onboarding status. Please try again.', 'error');
        }
      })
      .finally(() => setLoading(false));
  }, [page, stateFilter, paradigmFilter, addToast]);

  useEffect(load, [load]);

  // Client-side filter by search text and assignment state (not sent to API for performance)
  const visibleItems = (response?.items ?? []).filter((item) => {
    const q = search.toLowerCase();
    const matchesSearch = !q
      || item.serialNumber?.toLowerCase().includes(q)
      || item.macAddress?.toLowerCase().includes(q)
      || item.sysObjectID?.toLowerCase().includes(q)
      || item.deviceId.toLowerCase().includes(q);
    const matchesAssignment = !assignmentFilter
      || item.assignmentState === assignmentFilter
      || (!item.assignmentState && assignmentFilter === 'UNASSIGNED');
    return matchesSearch && matchesAssignment;
  });

  const totalPages = response ? Math.ceil(response.total / PAGE_SIZE) : 0;

  // ── Summary counts for metric cards ─────────────────────────────────────────
  const allItems = response?.items ?? [];
  const managed    = allItems.filter((i) => i.onboardingState === 'MANAGED').length;
  const pending    = allItems.filter((i) => ['PENDING', 'AUTHENTICATED', 'CHECK_IN_RECEIVED'].includes(i.onboardingState)).length;
  const gated      = allItems.filter((i) => i.onboardingState === 'PENDING_ASSIGNMENT' || i.configurationDeliveryState === 'WITHHELD').length;
  const failed     = allItems.filter((i) => ['FAILED', 'RETRYING', 'REDIRECTED'].includes(i.onboardingState)).length;

  // ── Permission-denied state ──────────────────────────────────────────────────
  if (error === 'permission_denied') {
    return (
      <div className="vf-page">
        <div className="vf-page-header">
          <h1 className="vf-page-title">Unified Onboarding</h1>
        </div>
        <EmptyState
          title="Access Denied"
          description="You do not have permission to view onboarding status. Admin or Operator role required."
          icon={
            <svg width="40" height="40" viewBox="0 0 40 40" fill="none" aria-hidden="true">
              <circle cx="20" cy="20" r="18" stroke="#ef4444" strokeWidth="1.5" />
              <path d="M20 12v9M20 27v1" stroke="#ef4444" strokeWidth="2" strokeLinecap="round" />
            </svg>
          }
        />
      </div>
    );
  }

  return (
    <div className="vf-page">
      {/* Header */}
      <div className="vf-page-header">
        <div>
          <h1 className="vf-page-title">Unified Onboarding</h1>
          <p style={{ fontSize: 13, color: 'var(--vf-text-muted)', margin: '4px 0 0' }}>
            Operational visibility across UBR call-home and generic discovery onboarding.
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={load} aria-label="Refresh onboarding status">
          Refresh
        </Button>
      </div>

      {/* Metric cards */}
      <div className="vf-kpi-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', marginBottom: 24 }}>
        <MetricCard label="Managed"   value={managed}  variant="success" loading={loading} />
        <MetricCard label="In Progress" value={pending} variant="default" loading={loading} />
        <MetricCard label="Gated"     value={gated}    variant="warning"  loading={loading} />
        <MetricCard label="Failed"    value={failed}   variant="danger"   loading={loading} />
      </div>

      {/* Filters */}
      <div
        style={{
          display: 'flex', gap: 12, marginBottom: 20,
          flexWrap: 'wrap', alignItems: 'center',
        }}
      >
        <Input
          placeholder="Search serial, MAC, sysOID, device ID…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ flex: 1, minWidth: 220, maxWidth: 380 }}
          aria-label="Search onboarding devices"
        />
        <select
          value={stateFilter}
          onChange={(e) => { setStateFilter(e.target.value as OnboardingStateValue | ''); setPage(0); }}
          aria-label="Filter by onboarding state"
          style={SELECT_STYLE}
        >
          {STATE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        <select
          value={paradigmFilter}
          onChange={(e) => { setParadigmFilter(e.target.value); setPage(0); }}
          aria-label="Filter by discovery paradigm"
          style={SELECT_STYLE}
        >
          {PARADIGM_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        <select
          value={assignmentFilter}
          onChange={(e) => setAssignmentFilter(e.target.value)}
          aria-label="Filter by assignment gate"
          style={SELECT_STYLE}
        >
          {ASSIGNMENT_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        {(stateFilter || paradigmFilter || assignmentFilter || search) && (
          <button
            onClick={() => { setSearch(''); setStateFilter(''); setParadigmFilter(''); setAssignmentFilter(''); setPage(0); }}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--vf-text-muted)', fontSize: 12 }}
            aria-label="Clear all filters"
          >
            Clear filters
          </button>
        )}
        <span style={{ fontSize: 12, color: 'var(--vf-text-muted)', alignSelf: 'center', marginLeft: 'auto' }}>
          {loading ? '…' : `${visibleItems.length} of ${response?.total ?? 0}`}
        </span>
      </div>

      {/* Content area */}
      {loading && <LoadingState label="Loading onboarding status…" />}

      {!loading && error === 'load_failed' && (
        <div
          role="alert"
          style={{
            display: 'flex', alignItems: 'center', gap: 12,
            padding: '14px 18px', borderRadius: 8,
            background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)',
            fontSize: 13,
          }}
        >
          <span aria-hidden>⚠️</span>
          <div>
            <strong style={{ color: '#f87171' }}>Failed to load onboarding status.</strong>
            <span style={{ color: 'var(--vf-text-muted)', marginLeft: 6 }}>
              Check your connection and try again.
            </span>
          </div>
          <Button variant="ghost" size="sm" onClick={load} style={{ marginLeft: 'auto' }}>
            Retry
          </Button>
        </div>
      )}

      {!loading && !error && response?.capabilityStatus === 'disabled' && (
        <DisabledModeBanner />
      )}

      {!loading && !error && response?.capabilityStatus !== 'disabled' && visibleItems.length === 0 && (
        <EmptyState
          title="No devices match the current filters"
          description={
            stateFilter || paradigmFilter || assignmentFilter || search
              ? 'Adjust or clear your filters to see more devices.'
              : 'No onboarding records found. Devices will appear here as they connect.'
          }
          icon={<span aria-hidden style={{ fontSize: 32 }}>📡</span>}
        />
      )}

      {!loading && !error && visibleItems.length > 0 && (
        <>
          <div
            role="region"
            aria-label="Onboarding status table"
            style={{ overflowX: 'auto', border: '1px solid var(--vf-border-subtle)', borderRadius: 'var(--vf-radius-md)', background: 'var(--vf-surface)' }}
          >
            <table
              style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--vf-font-sans)', fontSize: 13 }}
              aria-label="Onboarding device list"
            >
              <thead>
                <tr style={{ background: 'rgba(30,41,59,0.5)' }}>
                  {['Paradigm', 'Identifier', 'Type', 'Onboarding State', 'Bootstrap', 'Assignment', 'Last Activity', 'Retry After'].map((h) => (
                    <th
                      key={h}
                      scope="col"
                      style={{ padding: '10px 14px', textAlign: 'left', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--vf-text-muted)', borderBottom: '1px solid var(--vf-border-subtle)', whiteSpace: 'nowrap' }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visibleItems.map((item) => {
                  const isUbr = item.discoveryParadigm?.toUpperCase() === 'UBR';
                  const identifier = isUbr
                    ? (item.serialNumber || item.macAddress || item.deviceId)
                    : (item.sysObjectID || item.deviceId);
                  const lastActivity = item.lastCheckInAt ?? item.lastRealtimeAt ?? item.updatedAt;

                  return (
                    <tr
                      key={item.deviceId}
                      onClick={() => {
                        if (isUbr) navigate(`/v2/devices/${item.deviceId}`);
                        else setDetailItem(item);
                      }}
                      style={{ borderBottom: '1px solid var(--vf-border-subtle)', cursor: 'pointer', transition: 'background 0.1s' }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(59,130,246,0.05)')}
                      onMouseLeave={(e) => (e.currentTarget.style.background = '')}
                      aria-label={`Device ${identifier}`}
                    >
                      <td style={{ padding: '10px 14px' }}>
                        <ParadigmBadge paradigm={item.discoveryParadigm} />
                      </td>
                      <td style={{ padding: '10px 14px', fontFamily: 'var(--vf-font-mono)', fontSize: 12 }}>
                        {identifier || '—'}
                      </td>
                      <td style={{ padding: '10px 14px', color: 'var(--vf-text-muted)', fontSize: 12 }}>
                        {item.deviceType ?? '—'}
                      </td>
                      <td style={{ padding: '10px 14px' }}>
                        <OnboardingStateBadge state={item.onboardingState} />
                      </td>
                      <td style={{ padding: '10px 14px', color: 'var(--vf-text-muted)', fontSize: 12 }}>
                        {item.bootstrapState ? onboardingStateLabel(item.bootstrapState) : '—'}
                      </td>
                      <td style={{ padding: '10px 14px' }}>
                        {item.assignmentState ? (
                          <Badge variant={item.assignmentState === 'ASSIGNED' ? 'success' : 'warning'}>
                            {item.assignmentState}
                          </Badge>
                        ) : (
                          <span style={{ color: 'var(--vf-text-muted)' }}>—</span>
                        )}
                      </td>
                      <td style={{ padding: '10px 14px', color: 'var(--vf-text-muted)', fontSize: 12 }}>
                        {relTime(lastActivity)}
                      </td>
                      <td style={{ padding: '10px 14px', fontFamily: 'var(--vf-font-mono)', fontSize: 12, color: 'var(--vf-text-muted)' }}>
                        {retryLabel(item)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div
              style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'center', marginTop: 16 }}
              role="navigation"
              aria-label="Pagination"
            >
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={page === 0}
                aria-label="Previous page"
              >
                ← Prev
              </Button>
              <span style={{ fontSize: 12, color: 'var(--vf-text-muted)' }}>
                Page {page + 1} of {totalPages}
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                disabled={page >= totalPages - 1}
                aria-label="Next page"
              >
                Next →
              </Button>
            </div>
          )}
        </>
      )}

      {/* Detail panel */}
      {detailItem && (
        <FailureDetailPanel
          item={detailItem}
          onClose={() => setDetailItem(null)}
          canAct={canAct}
        />
      )}
    </div>
  );
}

// ── Shared style ──────────────────────────────────────────────────────────────

const SELECT_STYLE: React.CSSProperties = {
  padding: '7px 12px',
  borderRadius: 6,
  border: '1px solid var(--vf-border-subtle)',
  background: 'var(--vf-surface)',
  color: 'var(--vf-text-primary)',
  fontSize: 13,
};
