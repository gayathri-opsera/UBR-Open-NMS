/**
 * StatusBadge — reusable color-coded badge for ICMP and SNMP status fields.
 *
 * Maps type-safe status values from the discovery API to Badge variants.
 * Used by DiscoveryResultsTable for at-a-glance status understanding.
 */
import { Badge } from '../common/Badge';
import type { BadgeVariant } from '../common/Badge';
import type { IcmpStatus, SnmpStatus, ClassificationStatus } from '../../../api/discovery.api';

// ── ICMP ──────────────────────────────────────────────────────────────────────

const ICMP_VARIANT: Record<IcmpStatus, BadgeVariant> = {
  reachable:   'success',
  unreachable: 'danger',
  timeout:     'warning',
};

const ICMP_LABEL: Record<IcmpStatus, string> = {
  reachable:   'Reachable',
  unreachable: 'Unreachable',
  timeout:     'Timeout',
};

export function IcmpStatusBadge({ status }: { status: IcmpStatus }) {
  return (
    <Badge variant={ICMP_VARIANT[status] ?? 'default'} dot>
      {ICMP_LABEL[status] ?? status}
    </Badge>
  );
}

// ── SNMP ──────────────────────────────────────────────────────────────────────

const SNMP_VARIANT: Record<SnmpStatus, BadgeVariant> = {
  success:       'success',
  auth_failed:   'danger',
  timeout:       'warning',
  not_attempted: 'default',
  partial:       'warning',
};

const SNMP_LABEL: Record<SnmpStatus, string> = {
  success:       'Success',
  auth_failed:   'Auth Failed',
  timeout:       'Timeout',
  not_attempted: 'Not Attempted',
  partial:       'Partial',
};

export function SnmpStatusBadge({ status }: { status: SnmpStatus }) {
  return (
    <Badge variant={SNMP_VARIANT[status] ?? 'default'} dot>
      {SNMP_LABEL[status] ?? status}
    </Badge>
  );
}

// ── Classification ────────────────────────────────────────────────────────────

const CLASS_VARIANT: Record<ClassificationStatus, BadgeVariant> = {
  RECOGNISED:              'success',
  DEFERRED_UNSUPPORTED:    'warning',
  CLASSIFICATION_ERROR:    'danger',
};

const CLASS_LABEL: Record<ClassificationStatus, string> = {
  RECOGNISED:              'Recognised',
  DEFERRED_UNSUPPORTED:    'Deferred',
  CLASSIFICATION_ERROR:    'Error',
};

export function ClassificationBadge({ status }: { status: ClassificationStatus }) {
  return (
    <Badge variant={CLASS_VARIANT[status] ?? 'default'}>
      {CLASS_LABEL[status] ?? status}
    </Badge>
  );
}
