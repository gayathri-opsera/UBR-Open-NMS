// discovery-audit.api.ts — API client for discovery audit events (WO-019).
//
// Fetches audit entries from the audit-service API, filtered to
// discovery-related actions (action prefix: "discovery.").

import { apiClient } from './client';

// ── Types ─────────────────────────────────────────────────────────────────────

/** A single discovery audit event as returned by the audit-service. */
export interface DiscoveryAuditEvent {
  /** UUID event identifier. */
  eventId: string;
  /** ISO-8601 UTC timestamp. */
  producedAt: string;
  /** Service that produced the event (always "discovery-service" for these). */
  service: string;
  /** Correlation ID (= run ID for discovery events). */
  correlationId?: string;
  /** Action verb, e.g. "discovery.run.created" | "discovery.run.completed" | "discovery.run.failed". */
  action: string;
  /** Resource type, always "DiscoveryRun" for run-level events. */
  resourceType: string;
  /** Run ID (resource being acted upon). */
  resourceId: string;
  /** "success" or "failure". */
  outcome: 'success' | 'failure';
  /** Optional human-readable detail string. */
  detail?: string;
}

/** Query parameters for listing discovery audit events. */
export interface DiscoveryAuditQuery {
  /** Filter by action type, e.g. "discovery.run.failed". */
  action?: string;
  /** ISO date string — only events at or after this time. */
  from?: string;
  /** ISO date string — only events at or before this time. */
  to?: string;
  /** Filter by run ID (correlationId / resourceId). */
  runId?: string;
  /** Zero-based page index. */
  page?: number;
  /** Page size (1–100). */
  limit?: number;
}

/** Paginated response envelope from the audit-service. */
export interface DiscoveryAuditPage {
  data: DiscoveryAuditEvent[];
  totalElements: number;
  totalPages: number;
  currentPage: number;
  pageSize: number;
}

// ── API ───────────────────────────────────────────────────────────────────────

/**
 * Fetches a paginated list of discovery audit events.
 *
 * The audit-service endpoint is `/audit/logs`; we add `service=discovery-service`
 * to filter to discovery events only and optionally further refine by action or run ID.
 */
export async function listDiscoveryAuditEvents(
  query: DiscoveryAuditQuery = {},
): Promise<DiscoveryAuditPage> {
  const params: Record<string, string | number> = {
    service: 'discovery-service',
    page:    query.page  ?? 0,
    limit:   query.limit ?? 20,
  };
  if (query.action)  params['action']  = query.action;
  if (query.from)    params['from']    = query.from;
  if (query.to)      params['to']      = query.to;
  if (query.runId)   params['resourceId'] = query.runId;

  const res = await apiClient.get<DiscoveryAuditPage>('/audit/logs', { params });
  return res.data;
}
