import { keepPreviousData, useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  CheckCircle2,
  CircleDot,
  Download,
  FolderKanban,
  Globe,
  ListTodo,
  Loader,
  ShieldAlert,
  Users,
} from 'lucide-react';
import { useMemo } from 'react';
import { useSearchParams } from 'react-router';
import axios from 'axios';
import { analyticsApi, type AnalyticsParams } from '@/api/resources';
import { Avatar, EmptyState, PageHeader, Skeleton, StatCard, Table, TableSkeleton, Td, Th } from '@/components/ui/Display';
import { FilterSelect } from '@/components/ui/Form';
import { useProjectOptions, useWebsiteOptions } from '@/hooks/useCommon';
import { getErrorMessage } from '@/lib/api';
import { TASK_PRIORITY, TASK_TYPE } from '@/lib/labels';
import type { AnalyticsReport } from '@/types/api';

const iso = (d: Date) => d.toISOString().slice(0, 10);
const daysAgo = (n: number) => iso(new Date(Date.now() - n * 86_400_000));

const PRESETS: Record<string, () => { from: string; to: string }> = {
  '7d': () => ({ from: daysAgo(6), to: iso(new Date()) }),
  '30d': () => ({ from: daysAgo(29), to: iso(new Date()) }),
  '90d': () => ({ from: daysAgo(89), to: iso(new Date()) }),
  month: () => {
    const n = new Date();
    return { from: iso(new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), 1))), to: iso(n) };
  },
  lastMonth: () => {
    const n = new Date();
    return {
      from: iso(new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth() - 1, 1))),
      to: iso(new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), 0))),
    };
  },
  year: () => ({ from: daysAgo(364), to: iso(new Date()) }),
};

const hrs = (h: number | null) => (h === null ? '—' : h < 1 ? '< 1 h' : h < 48 ? `${h} h` : `${Math.round((h / 24) * 10) / 10} d`);

/** Created vs completed per day/week/month. */
const Timeline = ({ data, interval }: { data: AnalyticsReport['timeline']; interval: string }) => {
  const max = Math.max(1, ...data.flatMap((d) => [d.created, d.completed]));
  const label = (date: string) =>
    interval === 'month'
      ? new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', year: '2-digit', timeZone: 'UTC' })
      : new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' });
  const every = Math.ceil(data.length / 12);
  return (
    <div>
      <div className="flex h-48 items-end gap-1 overflow-x-auto" role="img" aria-label="Tasks created and completed over time" data-testid="timeline">
        {data.map((d) => (
          <div key={d.date} className="flex h-full min-w-[10px] flex-1 items-end justify-center gap-0.5" title={`${label(d.date)}: ${d.created} created, ${d.completed} completed`}>
            <div className="w-1/2 rounded-t bg-brand-500" style={{ height: `${(d.created / max) * 100}%`, minHeight: d.created ? 2 : 0 }} />
            <div className="w-1/2 rounded-t bg-emerald-400" style={{ height: `${(d.completed / max) * 100}%`, minHeight: d.completed ? 2 : 0 }} />
          </div>
        ))}
      </div>
      <div className="mt-2 flex gap-1 text-[10px] text-slate-400">
        {data.map((d, i) => (
          <div key={d.date} className="min-w-[10px] flex-1 overflow-visible whitespace-nowrap">
            {i % every === 0 ? label(d.date) : ''}
          </div>
        ))}
      </div>
      <div className="mt-3 flex gap-4 text-xs text-slate-500">
        <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-brand-500" /> Created</span>
        <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-emerald-400" /> Completed</span>
      </div>
    </div>
  );
};

const Breakdown = ({ title, rows }: { title: string; rows: { label: string; count: number; color?: string }[] }) => {
  const total = rows.reduce((s, r) => s + r.count, 0);
  return (
    <section className="card p-5">
      <h2 className="mb-4 font-semibold">{title}</h2>
      {total === 0 ? (
        <p className="text-sm text-slate-400">No tasks in this period.</p>
      ) : (
        <ul className="space-y-3">
          {rows.map((r) => (
            <li key={r.label}>
              <div className="mb-1 flex justify-between text-sm">
                <span className="text-slate-600">{r.label}</span>
                <span className="font-medium">{r.count}</span>
              </div>
              <div className="h-2 rounded-full bg-slate-100">
                <div className="h-2 rounded-full" style={{ width: `${(r.count / total) * 100}%`, background: r.color ?? '#6366f1' }} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};

/**
 * Admin analytics: live totals, website-wise and developer-wise statistics, and date-wise
 * reports (daily/weekly/monthly) with filters and CSV export. All numbers come from the API.
 */
export const AnalyticsPage = () => {
  const [params, setParams] = useSearchParams();
  const get = (k: string) => params.get(k) ?? '';
  const set = (patch: Record<string, string>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) (v ? next.set(k, v) : next.delete(k));
    setParams(next, { replace: true });
  };

  const preset = get('range') || '30d';
  const range = preset === 'custom' ? { from: get('from') || daysAgo(29), to: get('to') || iso(new Date()) } : PRESETS[preset]!();
  const query: AnalyticsParams = useMemo(
    () => ({
      ...range,
      interval: (get('interval') as AnalyticsParams['interval']) || (preset === 'year' ? 'week' : 'day'),
      websiteId: get('websiteId') || undefined,
      projectId: get('projectId') || undefined,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [params],
  );

  const websites = useWebsiteOptions();
  const projects = useProjectOptions(query.websiteId);
  const report = useQuery({
    queryKey: ['analytics', query],
    queryFn: () => analyticsApi.report(query),
    placeholderData: keepPreviousData,
    retry: false,
  });
  const d = report.data;
  const loading = report.isLoading;

  if (report.isError && axios.isAxiosError(report.error) && report.error.response?.status === 403) {
    return (
      <div className="card">
        <EmptyState icon={ShieldAlert} title="Access restricted" description="Analytics are available to website owners and admins." />
      </div>
    );
  }

  const manageable = (websites.data ?? []).filter((w) => !w.role || w.role === 'OWNER' || w.role === 'ADMIN');

  return (
    <div className="space-y-6">
      <PageHeader
        title="Analytics"
        description={d ? `${d.range.from.slice(0, 10)} – ${d.range.to.slice(0, 10)} · ${d.scope.websites} website${d.scope.websites === 1 ? '' : 's'}` : 'Task statistics and reports'}
        actions={
          <a
            href={analyticsApi.csvUrl(query)}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            download
          >
            <Download className="h-4 w-4" /> Export CSV
          </a>
        }
      />

      <div className="card flex flex-wrap items-center gap-3 p-4" data-testid="analytics-filters">
        <FilterSelect
          ariaLabel="Website"
          value={get('websiteId')}
          onChange={(v) => set({ websiteId: v, projectId: '' })}
          placeholder="All websites"
          options={manageable.map((w) => ({ value: w.id, label: w.name }))}
        />
        <FilterSelect
          ariaLabel="Project"
          value={get('projectId')}
          onChange={(v) => set({ projectId: v })}
          placeholder="All projects"
          options={(projects.data ?? []).map((p) => ({ value: p.id, label: p.name }))}
        />
        <FilterSelect
          ariaLabel="Date range"
          value={preset}
          onChange={(v) => set({ range: v || '30d' })}
          placeholder="Last 30 days"
          options={[
            { value: '7d', label: 'Last 7 days' },
            { value: '30d', label: 'Last 30 days' },
            { value: '90d', label: 'Last 90 days' },
            { value: 'month', label: 'This month' },
            { value: 'lastMonth', label: 'Last month' },
            { value: 'year', label: 'Last 12 months' },
            { value: 'custom', label: 'Custom range' },
          ]}
        />
        {preset === 'custom' && (
          <>
            <label className="flex items-center gap-2 text-sm text-slate-600">
              From <input type="date" className="input w-auto" aria-label="From date" value={range.from} max={range.to} onChange={(e) => set({ from: e.target.value })} />
            </label>
            <label className="flex items-center gap-2 text-sm text-slate-600">
              To <input type="date" className="input w-auto" aria-label="To date" value={range.to} min={range.from} onChange={(e) => set({ to: e.target.value })} />
            </label>
          </>
        )}
        <FilterSelect
          ariaLabel="Group by"
          value={query.interval ?? 'day'}
          onChange={(v) => set({ interval: v })}
          placeholder="Daily"
          options={[
            { value: 'day', label: 'Daily' },
            { value: 'week', label: 'Weekly' },
            { value: 'month', label: 'Monthly' },
          ]}
        />
        {report.isFetching && !loading && <span className="text-xs text-slate-400">Updating…</span>}
      </div>

      {report.isError && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{getErrorMessage(report.error)}</p>}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4" data-testid="analytics-totals">
        <StatCard label="Total Websites" value={d?.totals.websites ?? 0} icon={Globe} loading={loading} />
        <StatCard label="Total Projects" value={d?.totals.projects ?? 0} icon={FolderKanban} tone="violet" loading={loading} />
        <StatCard label="Total Users" value={d?.totals.users ?? 0} icon={Users} tone="teal" loading={loading} />
        <StatCard label="Total Tasks" value={d?.totals.tasks ?? 0} icon={ListTodo} loading={loading} />
        <StatCard label="Open Tasks" value={d?.totals.openTasks ?? 0} icon={CircleDot} tone="gray" loading={loading} hint="Open + reopened" />
        <StatCard label="In Progress Tasks" value={d?.totals.inProgressTasks ?? 0} icon={Loader} tone="blue" loading={loading} hint="Incl. under review" />
        <StatCard label="Completed Tasks" value={d?.totals.completedTasks ?? 0} icon={CheckCircle2} tone="green" loading={loading} />
        <StatCard label="Overdue Tasks" value={d?.totals.overdueTasks ?? 0} icon={AlertTriangle} tone="red" loading={loading} />
      </div>

      <section className="card p-5">
        <div className="mb-4 flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="font-semibold">Created vs completed</h2>
          {d && (
            <dl className="flex flex-wrap gap-x-6 gap-y-1 text-sm" data-testid="range-totals">
              <div><dt className="inline text-slate-500">Created </dt><dd className="inline font-semibold">{d.totals.createdInRange}</dd></div>
              <div><dt className="inline text-slate-500">Completed </dt><dd className="inline font-semibold">{d.totals.completedInRange}</dd></div>
              <div><dt className="inline text-slate-500">Reopened </dt><dd className="inline font-semibold">{d.totals.reopenedInRange}</dd></div>
              <div><dt className="inline text-slate-500">Avg. resolution </dt><dd className="inline font-semibold">{hrs(d.totals.avgResolutionHours)}</dd></div>
            </dl>
          )}
        </div>
        {loading || !d ? <Skeleton className="h-48" /> : <Timeline data={d.timeline} interval={d.range.interval} />}
      </section>

      <section className="card overflow-hidden">
        <h2 className="border-b border-slate-100 px-5 py-4 font-semibold">Website-wise task statistics</h2>
        {loading ? (
          <TableSkeleton cols={8} />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Website</Th>
                <Th>Total</Th>
                <Th>Open</Th>
                <Th>In progress</Th>
                <Th>Completed</Th>
                <Th>Overdue</Th>
                <Th>Created / completed in period</Th>
                <Th>Completion</Th>
                <Th>Avg. resolution</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100" data-testid="by-website">
              {d?.byWebsite.map((w) => (
                <tr key={w.website.id}>
                  <Td className="font-medium">{w.website.name}</Td>
                  <Td>{w.total}</Td>
                  <Td>{w.open}</Td>
                  <Td>{w.inProgress}</Td>
                  <Td>{w.completed}</Td>
                  <Td className={w.overdue ? 'font-medium text-red-600' : ''}>{w.overdue}</Td>
                  <Td>{w.createdInRange} / {w.completedInRange}</Td>
                  <Td>
                    <div className="flex items-center gap-2">
                      <div className="h-1.5 w-16 rounded-full bg-slate-100"><div className="h-1.5 rounded-full bg-emerald-500" style={{ width: `${w.completionRate}%` }} /></div>
                      {w.completionRate}%
                    </div>
                  </Td>
                  <Td>{hrs(w.avgResolutionHours)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </section>

      <section className="card overflow-hidden">
        <h2 className="border-b border-slate-100 px-5 py-4 font-semibold">Developer performance</h2>
        {loading ? (
          <TableSkeleton cols={7} />
        ) : !d?.byDeveloper.length ? (
          <EmptyState icon={Users} title="No assigned tasks yet" description="Assign tasks to developers to see their performance." />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Developer</Th>
                <Th>Assigned</Th>
                <Th>Open</Th>
                <Th>In progress</Th>
                <Th>Completed</Th>
                <Th>Completed in period</Th>
                <Th>Overdue</Th>
                <Th>Completion</Th>
                <Th>Avg. resolution</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100" data-testid="by-developer">
              {d.byDeveloper.map((r) => (
                <tr key={r.user.id}>
                  <Td>
                    <span className="flex items-center gap-2"><Avatar user={r.user} size="xs" /> {r.user.name}</span>
                  </Td>
                  <Td>{r.assigned}</Td>
                  <Td>{r.open}</Td>
                  <Td>{r.inProgress}</Td>
                  <Td>{r.completed}</Td>
                  <Td>{r.completedInRange}</Td>
                  <Td className={r.overdue ? 'font-medium text-red-600' : ''}>{r.overdue}</Td>
                  <Td>{r.completionRate}%</Td>
                  <Td>{hrs(r.avgResolutionHours)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </section>

      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        <Breakdown title="Created by type" rows={(d?.byType ?? []).map((r) => ({ label: TASK_TYPE[r.type], count: r.count }))} />
        <Breakdown
          title="Created by priority"
          rows={(['URGENT', 'HIGH', 'MEDIUM', 'LOW'] as const).map((p) => ({
            label: TASK_PRIORITY[p].label,
            color: TASK_PRIORITY[p].color,
            count: d?.byPriority.find((r) => r.priority === p)?.count ?? 0,
          }))}
        />
      </div>
    </div>
  );
};
