import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  CircleDot,
  FolderKanban,
  Globe,
  ListTodo,
  Loader,
  RefreshCw,
  Users,
} from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { dashboardApi } from '@/api/resources';
import { ProjectsPanel } from '@/components/dashboard/ProjectsPanel';
import { Button } from '@/components/ui/Button';
import { Avatar, EmptyState, PageHeader, Skeleton, StatCard } from '@/components/ui/Display';
import { FilterSelect } from '@/components/ui/Form';
import { useAuth } from '@/hooks/useAuth';
import { useWebsiteOptions } from '@/hooks/useCommon';
import { getErrorMessage } from '@/lib/api';
import { TASK_PRIORITY, TASK_STATUS } from '@/lib/labels';
import { timeAgo } from '@/lib/utils';
import type { DashboardStats, TaskActivity } from '@/types/api';

const describeActivity = (a: TaskActivity): string => {
  const c = (a.changes ?? {}) as Record<string, { from?: unknown; to?: unknown }>;
  switch (a.type) {
    case 'CREATED':
      return 'created';
    case 'STATUS_CHANGED':
      return `moved to ${TASK_STATUS[c.status?.to as keyof typeof TASK_STATUS]?.label ?? c.status?.to}`;
    case 'PRIORITY_CHANGED':
      return `set priority ${TASK_PRIORITY[c.priority?.to as keyof typeof TASK_PRIORITY]?.label ?? c.priority?.to}`;
    case 'ASSIGNED': {
      const to = (a.changes as { assignee?: { to?: string } } | null)?.assignee?.to;
      return to ? `assigned ${to} to` : 'assigned';
    }
    case 'UNASSIGNED':
      return 'unassigned';
    case 'STARTED':
      return 'started';
    case 'COMPLETED':
      return 'completed';
    case 'REOPENED':
      return 'reopened';
    case 'ARCHIVED':
      return 'archived';
    case 'RESTORED':
      return 'restored';
    case 'COMMENTED':
      return 'commented on';
    case 'COMMENT_EDITED':
      return 'edited a comment on';
    case 'COMMENT_DELETED':
      return 'deleted a comment on';
    case 'ATTACHMENT_ADDED':
      return a.field === 'screenshot' ? 'added a screenshot to' : 'added a file to';
    case 'ATTACHMENT_REMOVED':
      return 'removed a file from';
    default:
      return 'updated';
  }
};

const TrendChart = ({ trend }: { trend: DashboardStats['trend'] }) => {
  const max = Math.max(1, ...trend.flatMap((t) => [t.created, t.completed]));
  return (
    <div>
      <div className="flex h-44 items-end gap-1.5" role="img" aria-label="Tasks created and completed over the last 14 days">
        {trend.map((d) => (
          <div key={d.date} className="group relative flex h-full flex-1 items-end justify-center gap-0.5">
            <div className="w-1/2 max-w-3 rounded-t bg-brand-500" style={{ height: `${(d.created / max) * 100}%`, minHeight: d.created ? 3 : 0 }} />
            <div className="w-1/2 max-w-3 rounded-t bg-emerald-400" style={{ height: `${(d.completed / max) * 100}%`, minHeight: d.completed ? 3 : 0 }} />
            <div className="pointer-events-none absolute -top-14 z-10 hidden whitespace-nowrap rounded-md bg-slate-900 px-2 py-1 text-xs text-white group-hover:block">
              {new Date(d.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
              <br />
              {d.created} created · {d.completed} completed
            </div>
          </div>
        ))}
      </div>
      <div className="mt-2 flex justify-between text-[11px] text-slate-400">
        <span>{new Date(trend[0]!.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>
        <span>Today</span>
      </div>
      <div className="mt-3 flex gap-4 text-xs text-slate-600">
        <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-brand-500" /> Created</span>
        <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-emerald-400" /> Completed</span>
      </div>
    </div>
  );
};

const BreakdownList = ({ rows }: { rows: { label: string; count: number; color: string }[] }) => {
  const total = rows.reduce((s, r) => s + r.count, 0);
  return (
    <ul className="space-y-3">
      {rows.map((r) => (
        <li key={r.label}>
          <div className="mb-1 flex justify-between text-sm">
            <span className="text-slate-600">{r.label}</span>
            <span className="font-medium tabular-nums text-slate-900">{r.count}</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-slate-100">
            <div className="h-full rounded-full" style={{ width: `${total ? (r.count / total) * 100 : 0}%`, background: r.color }} />
          </div>
        </li>
      ))}
    </ul>
  );
};

export const DashboardPage = () => {
  const { user, isSuperAdmin } = useAuth();
  const navigate = useNavigate();
  const [websiteId, setWebsiteId] = useState('');
  const websites = useWebsiteOptions();
  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: ['dashboard', websiteId],
    queryFn: () => dashboardApi.stats(websiteId || undefined),
  });
  const t = data?.totals;
  const goTasks = (qs: string) => navigate(`/tasks?${qs}${websiteId ? `&websiteId=${websiteId}` : ''}`);

  return (
    <div>
      <PageHeader
        title={`Hello, ${user?.name.split(' ')[0] ?? ''} 👋`}
        description={
          data?.scope === 'platform'
            ? 'Platform-wide overview across all websites.'
            : data?.scope === 'website'
              ? 'Overview for the selected website.'
              : 'Overview of the websites and projects you work on.'
        }
        actions={
          <>
            <FilterSelect
              value={websiteId}
              onChange={setWebsiteId}
              placeholder={isSuperAdmin ? 'All websites (platform)' : 'All my projects'}
              ariaLabel="Filter dashboard by website"
              options={(websites.data ?? []).map((w) => ({ value: w.id, label: w.name }))}
            />
            <Button variant="secondary" size="icon" aria-label="Refresh" onClick={() => refetch()}>
              <RefreshCw className={isFetching ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
            </Button>
          </>
        }
      />

      {isError ? (
        <div className="card">
          <EmptyState icon={AlertTriangle} title="Could not load dashboard" description={getErrorMessage(error)} action={<Button onClick={() => refetch()}>Retry</Button>} />
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard label="Total Websites" value={t?.websites ?? 0} icon={Globe} loading={isLoading} hint={t && `${t.activeWebsites} active`} onClick={() => navigate('/websites')} />
            <StatCard label="Total Projects" value={t?.projects ?? 0} icon={FolderKanban} tone="blue" loading={isLoading} onClick={() => navigate('/projects')} />
            <StatCard
              label="Total Users"
              value={t?.users ?? 0}
              icon={Users}
              tone="violet"
              loading={isLoading}
              hint={data?.scope === 'platform' ? 'All registered users' : 'Across your teams'}
              onClick={() => navigate(isSuperAdmin ? '/users' : '/team')}
            />
            <StatCard label="Total Tasks" value={t?.tasks ?? 0} icon={ListTodo} tone="teal" loading={isLoading} hint={t && `${data!.completionRate}% completed`} onClick={() => goTasks('')} />
            <StatCard label="Open Tasks" value={t?.openTasks ?? 0} icon={CircleDot} tone="gray" loading={isLoading} hint="Open + reopened" onClick={() => goTasks('status=OPEN,REOPENED')} />
            <StatCard label="In Progress Tasks" value={t?.inProgressTasks ?? 0} icon={Loader} tone="blue" loading={isLoading} hint="In progress + under review" onClick={() => goTasks('status=IN_PROGRESS,IN_REVIEW')} />
            <StatCard label="Completed Tasks" value={t?.completedTasks ?? 0} icon={CheckCircle2} tone="green" loading={isLoading} onClick={() => goTasks('status=COMPLETED')} />
            <StatCard label="Overdue Tasks" value={t?.overdueTasks ?? 0} icon={AlertTriangle} tone="red" loading={isLoading} onClick={() => goTasks('overdue=true')} />
          </div>

          <ProjectsPanel websiteId={websiteId} onSelect={setWebsiteId} />

          <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-3">
            <section className="card p-5 lg:col-span-2">
              <h2 className="mb-4 text-sm font-semibold text-slate-900">Task activity · last 14 days</h2>
              {isLoading ? <Skeleton className="h-52 w-full" /> : <TrendChart trend={data!.trend} />}
            </section>
            <section className="card p-5">
              <h2 className="mb-4 text-sm font-semibold text-slate-900">Tasks by status</h2>
              {isLoading ? (
                <div className="space-y-4">{Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-6" />)}</div>
              ) : (
                <BreakdownList rows={data!.tasksByStatus.map((s) => ({ label: TASK_STATUS[s.status].label, count: s.count, color: TASK_STATUS[s.status].color }))} />
              )}
            </section>
          </div>

          <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-3">
            <section className="card lg:col-span-2">
              <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
                <h2 className="text-sm font-semibold text-slate-900">Recent activity</h2>
                <Activity className="h-4 w-4 text-slate-400" />
              </div>
              {isLoading ? (
                <div className="space-y-4 p-5">{Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-8" />)}</div>
              ) : data!.recentActivity.length === 0 ? (
                <EmptyState icon={Activity} title="No activity yet" description="Task updates from your team will appear here." />
              ) : (
                <ul className="divide-y divide-slate-100" data-testid="recent-activity">
                  {data!.recentActivity.map((a) => (
                    <li key={a.id} className="flex items-start gap-3 px-5 py-3">
                      <Avatar user={a.actor} size="sm" />
                      <div className="min-w-0 flex-1 text-sm">
                        <p className="text-slate-700">
                          <span className="font-medium text-slate-900">{a.actor?.name ?? 'Someone'}</span> {describeActivity(a)}{' '}
                          <Link to={`/tasks?task=${a.task!.id}`} className="font-medium text-brand-700 hover:underline">
                            {a.task!.title}
                          </Link>
                        </p>
                        <p className="text-xs text-slate-500">
                          {a.task!.project.name} · {timeAgo(a.createdAt)}
                        </p>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section className="card p-5">
              <h2 className="mb-4 text-sm font-semibold text-slate-900">Open tasks by priority</h2>
              {isLoading ? (
                <div className="space-y-4">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-6" />)}</div>
              ) : (
                <BreakdownList rows={data!.openTasksByPriority.map((p) => ({ label: TASK_PRIORITY[p.priority].label, count: p.count, color: TASK_PRIORITY[p.priority].color }))} />
              )}
              {t && (
                <Link to="/tasks/mine" className="mt-6 flex items-center justify-between rounded-lg bg-brand-50 px-4 py-3 text-sm text-brand-700 hover:bg-brand-100">
                  <span>Assigned to you & open</span>
                  <span className="text-lg font-semibold">{t.myOpenTasks}</span>
                </Link>
              )}
            </section>
          </div>
        </>
      )}
    </div>
  );
};
