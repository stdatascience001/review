import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ListTodo, MessageSquare, Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { tasksApi, type TaskListParams } from '@/api/resources';
import { Button } from '@/components/ui/Button';
import { Avatar, Badge, EmptyState, Pagination, Table, TableSkeleton, Td, Th } from '@/components/ui/Display';
import { FilterSelect, SearchInput } from '@/components/ui/Form';
import { useDebounce, useProjectOptions, useWebsiteOptions } from '@/hooks/useCommon';
import { TASK_PRIORITY, TASK_STATUS, TASK_TYPE, options } from '@/lib/labels';
import { cn, formatDate, isOverdue } from '@/lib/utils';
import { TaskDetailModal } from './TaskDetailModal';
import { TaskFormModal } from './TaskFormModal';

/**
 * Searchable/filterable/paginated task table backed by GET /tasks.
 * `fixed` filters (scope, websiteId, projectId) are applied by the parent page and hidden from the UI.
 * Filters are kept in the URL so dashboard cards can deep-link (e.g. ?status=OPEN, ?overdue=true).
 */
export const TaskTable = ({
  fixed = {},
  showCreate = true,
  emptyTitle = 'No tasks yet',
}: {
  fixed?: Pick<TaskListParams, 'scope' | 'websiteId' | 'projectId'>;
  showCreate?: boolean;
  emptyTitle?: string;
}) => {
  const [params, setParams] = useSearchParams();
  const get = (k: string) => params.get(k) ?? '';
  const set = (patch: Record<string, string>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) (v ? next.set(k, v) : next.delete(k));
    if (!('page' in patch)) next.delete('page');
    setParams(next, { replace: true });
  };

  const [search, setSearch] = useState(get('q'));
  const q = useDebounce(search);
  useEffect(() => {
    if (q !== get('q')) set({ q });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const [createOpen, setCreateOpen] = useState(false);
  const openTaskId = get('task') || null;
  const page = Number(get('page')) || 1;

  const websites = useWebsiteOptions();
  const projects = useProjectOptions(fixed.websiteId ?? (get('websiteId') || undefined));

  const query: TaskListParams = {
    ...fixed,
    websiteId: fixed.websiteId ?? (get('websiteId') || undefined),
    projectId: fixed.projectId ?? (get('projectId') || undefined),
    q: get('q') || undefined,
    status: get('status') || undefined,
    priority: get('priority') || undefined,
    type: get('type') || undefined,
    overdue: get('overdue') === 'true',
    sort: get('sort') || 'createdAt',
    order: (get('order') as 'asc' | 'desc') || 'desc',
    page,
    pageSize: 15,
  };

  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['tasks', 'list', query],
    queryFn: () => tasksApi.list(query),
    placeholderData: keepPreviousData,
  });

  const hasFilters = ['q', 'status', 'priority', 'type', 'overdue', 'websiteId', 'projectId'].some((k) => get(k));
  const statusOptions = [
    ...options(TASK_STATUS),
    { value: 'OPEN,REOPENED', label: 'Open + reopened' },
    { value: 'OPEN,IN_PROGRESS,IN_REVIEW,REOPENED', label: 'Not completed' },
    { value: 'IN_PROGRESS,IN_REVIEW', label: 'In progress + under review' },
  ];

  return (
    <div className="card">
      <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 p-4">
        <SearchInput value={search} onChange={setSearch} placeholder="Search tasks…" className="w-full sm:w-64" />
        {!fixed.websiteId && (
          <FilterSelect value={get('websiteId')} onChange={(v) => set({ websiteId: v, projectId: '' })} placeholder="All websites" options={(websites.data ?? []).map((w) => ({ value: w.id, label: w.name }))} />
        )}
        {!fixed.projectId && (
          <FilterSelect value={get('projectId')} onChange={(v) => set({ projectId: v })} placeholder="All projects" options={(projects.data ?? []).map((p) => ({ value: p.id, label: p.name }))} />
        )}
        <FilterSelect value={get('status')} onChange={(v) => set({ status: v })} placeholder="Any status" ariaLabel="Filter by status" options={statusOptions} />
        <FilterSelect value={get('priority')} onChange={(v) => set({ priority: v })} placeholder="Any priority" ariaLabel="Filter by priority" options={options(TASK_PRIORITY)} />
        <FilterSelect value={get('type')} onChange={(v) => set({ type: v })} placeholder="Any type" ariaLabel="Filter by type" options={options(TASK_TYPE)} />
        <label className="flex items-center gap-2 text-sm text-slate-600">
          <input type="checkbox" className="rounded border-slate-300" checked={get('overdue') === 'true'} onChange={(e) => set({ overdue: e.target.checked ? 'true' : '' })} />
          Overdue only
        </label>
        <FilterSelect
          value={`${query.sort}:${query.order}`}
          onChange={(v) => {
            const [sort, order] = (v || 'createdAt:desc').split(':');
            set({ sort: sort!, order: order! });
          }}
          placeholder="Sort"
          ariaLabel="Sort tasks"
          options={[
            { value: 'createdAt:desc', label: 'Newest first' },
            { value: 'createdAt:asc', label: 'Oldest first' },
            { value: 'dueDate:asc', label: 'Due date' },
            { value: 'priority:desc', label: 'Priority' },
            { value: 'updatedAt:desc', label: 'Recently updated' },
            { value: 'number:desc', label: 'Task ID' },
          ]}
        />
        {hasFilters && (
          <Button variant="ghost" size="sm" onClick={() => { setSearch(''); const keep = params.get('tab'); setParams(keep ? { tab: keep } : {}, { replace: true }); }}>
            Clear filters
          </Button>
        )}
        <div className="flex-1" />
        {isFetching && !isLoading && <span className="text-xs text-slate-400">Updating…</span>}
        {showCreate && (
          <Button icon={<Plus className="h-4 w-4" />} onClick={() => setCreateOpen(true)}>
            New task
          </Button>
        )}
      </div>

      {isLoading ? (
        <TableSkeleton cols={6} />
      ) : !data?.items.length ? (
        <EmptyState
          icon={ListTodo}
          title={hasFilters ? 'No tasks match your filters' : emptyTitle}
          description={hasFilters ? 'Try clearing some filters.' : 'Tasks created from feedback will show up here.'}
          action={!hasFilters && showCreate && <Button icon={<Plus className="h-4 w-4" />} onClick={() => setCreateOpen(true)}>New task</Button>}
        />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Task</Th>
              <Th>Status</Th>
              <Th>Priority</Th>
              <Th>Assignee</Th>
              <Th>Due</Th>
              <Th>Project</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {data.items.map((t) => (
              <tr key={t.id} className="cursor-pointer hover:bg-slate-50/60" data-testid="task-row" onClick={() => set({ task: t.id, page: String(page) })}>
                <Td className="max-w-md">
                  <div className="flex items-center gap-2">
                    {t.unreadCount > 0 && (
                      <span className="h-2 w-2 shrink-0 rounded-full bg-brand-600" title={`${t.unreadCount} unread comment${t.unreadCount > 1 ? 's' : ''}`} aria-label="Unread comments" />
                    )}
                    <span className={cn('truncate text-slate-900', t.unreadCount > 0 ? 'font-semibold' : 'font-medium')}>{t.title}</span>
                  </div>
                  <div className="mt-0.5 flex items-center gap-2 text-xs text-slate-500">
                    <span className="font-mono text-slate-400" data-testid="task-key">{t.key}</span>
                    <span>{TASK_TYPE[t.type]}</span>
                    {t._count.comments > 0 && (
                      <span className={cn('flex items-center gap-0.5', t.unreadCount > 0 && 'font-medium text-brand-700')}>
                        <MessageSquare className="h-3 w-3" /> {t._count.comments}
                        {t.unreadCount > 0 && ` (${t.unreadCount} new)`}
                      </span>
                    )}
                  </div>
                </Td>
                <Td><Badge tone={TASK_STATUS[t.status].tone} dot>{TASK_STATUS[t.status].label}</Badge></Td>
                <Td><Badge tone={TASK_PRIORITY[t.priority].tone}>{TASK_PRIORITY[t.priority].label}</Badge></Td>
                <Td>
                  {t.assignee ? (
                    <span className="flex items-center gap-2"><Avatar user={t.assignee} size="xs" /> <span className="truncate">{t.assignee.name}</span></span>
                  ) : (
                    <span className="text-slate-400">Unassigned</span>
                  )}
                </Td>
                <Td className={cn('whitespace-nowrap', isOverdue(t.dueDate, t.status) ? 'font-medium text-red-600' : 'text-slate-500')}>
                  {formatDate(t.dueDate)}
                </Td>
                <Td className="text-xs text-slate-500">
                  <div className="truncate">{t.project.name}</div>
                  <div className="truncate text-slate-400">{t.website.name}</div>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {data && <Pagination {...data.pagination} onPageChange={(p) => set({ page: String(p) })} />}

      <TaskFormModal open={createOpen} onClose={() => setCreateOpen(false)} defaultProjectId={fixed.projectId} websiteId={fixed.websiteId} />
      <TaskDetailModal taskId={openTaskId} onClose={() => set({ task: '', page: String(page) })} />
    </div>
  );
};
