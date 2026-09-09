/**
 * DiscoverySchedules — admin UI for rediscovery schedule CRUD (WO-028).
 *
 * Backend schedules reference a baseline scope run (scopeRunId) and a cron expression.
 */
import { useCallback, useEffect, useState } from 'react';

import { AdvancedTable } from '../common/AdvancedTable';
import type { ColumnDef } from '../common/AdvancedTable';
import { Badge } from '../common/Badge';
import { Button } from '../common/Button';
import { Input } from '../common/Input';
import { Modal } from '../common/Modal';
import { Select } from '../common/Select';
import { EmptyState, LoadingState } from '../common/States';
import { useToast } from '../common/Toast';
import {
  createSchedule,
  deleteSchedule,
  listDiscoveryRuns,
  listDiscoverySchedules,
  triggerSchedule,
} from '../../../api/discovery.api';
import type { CreateScheduleRequest, DiscoveryRunSummary, DiscoverySchedule } from '../../../api/discovery.api';
import { logger } from '../../utils/logger';

const CRON_PRESETS = [
  { value: '0 2 * * *', label: 'Daily at 02:00 UTC' },
  { value: '0 2 * * 1', label: 'Weekly (Mon 02:00 UTC)' },
  { value: '0 */6 * * *', label: 'Every 6 hours' },
];

interface ScheduleFormState {
  scopeRunId: string;
  cronExpression: string;
  name: string;
  notifyOnChange: boolean;
}

const INITIAL_FORM: ScheduleFormState = {
  scopeRunId: '',
  cronExpression: '0 2 * * *',
  name: '',
  notifyOnChange: true,
};

function formatDate(iso?: string): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return iso;
  }
}

/** Simple cron sanity check — five space-separated fields. */
export function isValidCron(expr: string): boolean {
  const parts = expr.trim().split(/\s+/);
  return parts.length === 5 && parts.every((p) => p.length > 0);
}

export function ScheduleForm({
  baselineRuns,
  initial,
  onSubmit,
  onCancel,
  submitting,
}: {
  baselineRuns: DiscoveryRunSummary[];
  initial?: ScheduleFormState;
  onSubmit: (req: CreateScheduleRequest) => Promise<void>;
  onCancel: () => void;
  submitting: boolean;
}) {
  const [form, setForm] = useState<ScheduleFormState>(initial ?? INITIAL_FORM);
  const [cronError, setCronError] = useState<string | null>(null);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.scopeRunId) {
      setCronError('Select a baseline discovery run.');
      return;
    }
    if (!isValidCron(form.cronExpression)) {
      setCronError('Cron expression must have five fields (minute hour day month weekday).');
      return;
    }
    setCronError(null);
    void onSubmit({
      scopeRunId: form.scopeRunId,
      cronExpression: form.cronExpression.trim(),
      name: form.name.trim() || undefined,
      notifyOnChange: form.notifyOnChange,
    });
  }

  const runOptions = baselineRuns.map((r) => ({
    value: r.runId,
    label: `${r.scopeSummary ?? r.runId.slice(0, 8)} (${r.status})`,
  }));

  return (
    <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div>
        <label style={{ fontSize: 12, fontWeight: 600, display: 'block', marginBottom: 4 }}>
          Schedule name
        </label>
        <Input
          value={form.name}
          onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          placeholder="e.g. Nightly core network rescan"
        />
      </div>

      <div>
        <label style={{ fontSize: 12, fontWeight: 600, display: 'block', marginBottom: 4 }}>
          Baseline scope run
        </label>
        <Select
          label="Baseline scope run"
          value={form.scopeRunId}
          onChange={(e) => setForm((f) => ({ ...f, scopeRunId: e.target.value }))}
          options={[{ value: '', label: 'Select a completed run…' }, ...runOptions]}
        />
      </div>

      <div>
        <label style={{ fontSize: 12, fontWeight: 600, display: 'block', marginBottom: 4 }}>
          Cron expression
        </label>
        <Select
          value={form.cronExpression}
          onChange={(e) => setForm((f) => ({ ...f, cronExpression: e.target.value }))}
          options={CRON_PRESETS}
        />
        <Input
          value={form.cronExpression}
          onChange={(e) => setForm((f) => ({ ...f, cronExpression: e.target.value }))}
          style={{ marginTop: 8 }}
          aria-label="Custom cron expression"
        />
        {cronError && (
          <p role="alert" style={{ color: 'var(--vf-danger)', fontSize: 12, marginTop: 6 }}>
            {cronError}
          </p>
        )}
      </div>

      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
        <input
          type="checkbox"
          checked={form.notifyOnChange}
          onChange={(e) => setForm((f) => ({ ...f, notifyOnChange: e.target.checked }))}
        />
        Notify on device changes
      </label>

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 8 }}>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" size="sm" disabled={submitting}>
          {submitting ? 'Saving…' : 'Save schedule'}
        </Button>
      </div>
    </form>
  );
}

export function DiscoverySchedules() {
  const { addToast } = useToast();
  const [schedules, setSchedules] = useState<DiscoverySchedule[]>([]);
  const [baselineRuns, setBaselineRuns] = useState<DiscoveryRunSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [runningId, setRunningId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [schedList, runsPage] = await Promise.all([
        listDiscoverySchedules(),
        listDiscoveryRuns(1, 50, 'COMPLETED'),
      ]);
      setSchedules(schedList ?? []);
      setBaselineRuns(runsPage?.data ?? []);
    } catch (err) {
      logger.error('DiscoverySchedules: load failed', err);
      addToast('Failed to load schedules', 'error');
    } finally {
      setLoading(false);
    }
  }, [addToast]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleCreate(req: CreateScheduleRequest) {
    setSubmitting(true);
    try {
      await createSchedule(req);
      addToast('Schedule created', 'success');
      setModalOpen(false);
      await load();
    } catch (err) {
      logger.error('DiscoverySchedules: create failed', err);
      addToast('Failed to create schedule', 'error');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete(scheduleId: string) {
    try {
      await deleteSchedule(scheduleId);
      addToast('Schedule deleted', 'success');
      setDeleteConfirm(null);
      await load();
    } catch (err) {
      logger.error('DiscoverySchedules: delete failed', err);
      addToast('Failed to delete schedule', 'error');
    }
  }

  async function handleRunNow(scheduleId: string) {
    setRunningId(scheduleId);
    try {
      await triggerSchedule(scheduleId);
      addToast('Rediscovery run triggered', 'success');
      await load();
    } catch (err) {
      logger.error('DiscoverySchedules: trigger failed', err);
      addToast('Failed to trigger schedule run', 'error');
    } finally {
      setRunningId(null);
    }
  }

  const columns: ColumnDef<DiscoverySchedule>[] = [
    { key: 'name', header: 'Name', sortable: true, render: (r) => r.name },
    {
      key: 'cronExpression',
      header: 'Cron',
      sortable: true,
      render: (r) => (
        <span style={{ fontFamily: 'var(--vf-font-mono)', fontSize: 12 }}>{r.cronExpression}</span>
      ),
    },
    {
      key: 'scopeRunId',
      header: 'Baseline run',
      render: (r) => (
        <span style={{ fontFamily: 'var(--vf-font-mono)', fontSize: 11 }} title={r.scopeRunId}>
          {r.scopeRunId.slice(0, 8)}…
        </span>
      ),
    },
    {
      key: 'enabled',
      header: 'Status',
      render: (r) => (
        <Badge variant={r.enabled ? 'success' : 'default'}>{r.enabled ? 'Enabled' : 'Disabled'}</Badge>
      ),
    },
    {
      key: 'nextRunAt',
      header: 'Next run',
      render: (r) => formatDate(r.nextRunAt),
    },
    {
      key: 'actions',
      header: '',
      render: (r) => (
        <div style={{ display: 'flex', gap: 8 }}>
          <Button
            variant="ghost"
            size="sm"
            disabled={runningId === r.scheduleId}
            onClick={() => void handleRunNow(r.scheduleId)}
          >
            {runningId === r.scheduleId ? 'Running…' : 'Run Now'}
          </Button>
          {deleteConfirm === r.scheduleId ? (
            <>
              <Button variant="danger" size="sm" onClick={() => void handleDelete(r.scheduleId)}>
                Confirm
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setDeleteConfirm(null)}>
                Cancel
              </Button>
            </>
          ) : (
            <Button variant="ghost" size="sm" onClick={() => setDeleteConfirm(r.scheduleId)}>
              Delete
            </Button>
          )}
        </div>
      ),
    },
  ];

  if (loading) return <LoadingState label="Loading discovery schedules…" />;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h2 style={{ fontSize: 16, fontWeight: 700, margin: 0 }}>Discovery Schedules</h2>
          <p style={{ fontSize: 13, color: 'var(--vf-text-muted)', margin: '4px 0 0' }}>
            Automate recurring rediscovery against approved scope runs.
          </p>
        </div>
        <Button variant="primary" size="sm" onClick={() => setModalOpen(true)}>
          Add schedule
        </Button>
      </div>

      {schedules.length === 0 ? (
        <EmptyState
          icon="📅"
          title="No schedules configured"
          description="Create a schedule to automatically re-scan a baseline discovery scope on a cron cadence."
        />
      ) : (
        <AdvancedTable columns={columns} data={schedules} rowKey={(r) => r.scheduleId} stickyHeader />
      )}

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title="New discovery schedule">
        <ScheduleForm
          baselineRuns={baselineRuns}
          onSubmit={handleCreate}
          onCancel={() => setModalOpen(false)}
          submitting={submitting}
        />
      </Modal>
    </div>
  );
}
