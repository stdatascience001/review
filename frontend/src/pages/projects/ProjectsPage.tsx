import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarDays, FolderKanban, Pencil, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { projectsApi } from '@/api/resources';
import { Button } from '@/components/ui/Button';
import { Avatar, Badge, EmptyState, PageHeader, Pagination, ProgressBar, Table, TableSkeleton, Td, Th } from '@/components/ui/Display';
import { FilterSelect, SearchInput } from '@/components/ui/Form';
import { useConfirm } from '@/components/ui/Modal';
import { useDebounce, usePagedFilters, useWebsiteOptions } from '@/hooks/useCommon';
import { getErrorMessage } from '@/lib/api';
import { PROJECT_STATUS, options } from '@/lib/labels';
import { formatDate } from '@/lib/utils';
import type { Project, ProjectStatus } from '@/types/api';
import { ProjectFormModal } from './ProjectFormModal';

export const ProjectsPage = () => {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [params, setParams] = useSearchParams();
  const websites = useWebsiteOptions();
  const { filters, update, page, setPage } = usePagedFilters({ q: '', status: '', websiteId: params.get('websiteId') ?? '' });
  const q = useDebounce(filters.q);
  const [editing, setEditing] = useState<Project | null>(null);
  const [formOpen, setFormOpen] = useState(false);

  // Deep link: /projects?new=1&websiteId=…
  useEffect(() => {
    if (params.get('new') === '1') {
      setEditing(null);
      setFormOpen(true);
      params.delete('new');
      setParams(params, { replace: true });
    }
  }, [params, setParams]);

  const { data, isLoading } = useQuery({
    queryKey: ['projects', 'list', { ...filters, q, page }],
    queryFn: () =>
      projectsApi.list({ q, status: (filters.status || undefined) as ProjectStatus | undefined, websiteId: filters.websiteId || undefined, page, pageSize: 10 }),
    placeholderData: keepPreviousData,
  });

  const remove = useMutation({
    mutationFn: (p: Project) => projectsApi.remove(p.id),
    onSuccess: () => {
      ['projects', 'dashboard', 'tasks', 'websites'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
      toast.success('Project deleted');
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  });

  const roleOf = (p: Project) => websites.data?.find((w) => w.id === p.websiteId)?.role;
  const canDelete = (p: Project) => ['OWNER', 'ADMIN'].includes(roleOf(p) ?? '');

  const items = data?.items ?? [];
  const hasFilters = Boolean(filters.q || filters.status || filters.websiteId);

  return (
    <div>
      <PageHeader
        title="Projects"
        description="Group tasks by initiative, assign your team and track progress."
        actions={<Button icon={<Plus className="h-4 w-4" />} onClick={() => { setEditing(null); setFormOpen(true); }}>Create project</Button>}
      />
      <div className="card">
        <div className="flex flex-col gap-3 border-b border-slate-100 p-4 sm:flex-row sm:flex-wrap">
          <SearchInput value={filters.q} onChange={(v) => update({ q: v })} placeholder="Search projects…" className="sm:w-64" />
          <FilterSelect value={filters.websiteId} onChange={(v) => update({ websiteId: v })} placeholder="All websites" options={(websites.data ?? []).map((w) => ({ value: w.id, label: w.name }))} />
          <FilterSelect value={filters.status} onChange={(v) => update({ status: v })} placeholder="All statuses" options={options(PROJECT_STATUS)} />
        </div>
        {isLoading ? (
          <TableSkeleton cols={6} />
        ) : items.length === 0 ? (
          <EmptyState
            icon={FolderKanban}
            title={hasFilters ? 'No projects match your filters' : 'No projects yet'}
            description={hasFilters ? 'Try a different search or filter.' : 'Create a project to start organising tasks.'}
            action={!hasFilters && <Button icon={<Plus className="h-4 w-4" />} onClick={() => setFormOpen(true)}>Create project</Button>}
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Project</Th>
                <Th>Website</Th>
                <Th>Status</Th>
                <Th className="w-48">Progress</Th>
                <Th>Team</Th>
                <Th>Timeline</Th>
                <Th className="text-right">Actions</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {items.map((p) => (
                <tr key={p.id} className="hover:bg-slate-50/60" data-testid="project-row">
                  <Td>
                    <Link to={`/projects/${p.id}`} className="font-medium text-slate-900 hover:text-brand-700">{p.name}</Link>
                    {p.description && <p className="max-w-xs truncate text-xs text-slate-500">{p.description}</p>}
                  </Td>
                  <Td className="text-slate-600">{p.website?.name}</Td>
                  <Td><Badge tone={PROJECT_STATUS[p.status].tone}>{PROJECT_STATUS[p.status].label}</Badge></Td>
                  <Td>
                    <div className="flex items-center justify-between text-xs text-slate-500">
                      <span>{p.progress?.completed}/{p.progress?.total} tasks</span>
                      <span className="font-medium text-slate-700">{p.progress?.percent}%</span>
                    </div>
                    <ProgressBar percent={p.progress?.percent ?? 0} className="mt-1" />
                  </Td>
                  <Td>
                    <div className="flex -space-x-2">
                      {p.members?.slice(0, 4).map((m) => (
                        <span key={m.user.id} className="rounded-full ring-2 ring-white"><Avatar user={m.user} size="xs" /></span>
                      ))}
                      {(p._count?.members ?? 0) > 4 && (
                        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-slate-100 text-[10px] font-medium text-slate-600 ring-2 ring-white">
                          +{(p._count?.members ?? 0) - 4}
                        </span>
                      )}
                    </div>
                  </Td>
                  <Td className="whitespace-nowrap text-xs text-slate-500">
                    <span className="flex items-center gap-1"><CalendarDays className="h-3.5 w-3.5" />{formatDate(p.startDate)} → {formatDate(p.dueDate)}</span>
                  </Td>
                  <Td>
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="icon" aria-label={`Edit ${p.name}`} onClick={() => { setEditing(p); setFormOpen(true); }}>
                        <Pencil className="h-4 w-4" />
                      </Button>
                      {canDelete(p) && (
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Delete ${p.name}`}
                          onClick={async () =>
                            (await confirm({ title: 'Delete project?', message: <><strong>{p.name}</strong> and all its tasks will be permanently deleted.</>, confirmLabel: 'Delete project', danger: true })) &&
                            remove.mutate(p)
                          }
                        >
                          <Trash2 className="h-4 w-4 text-red-500" />
                        </Button>
                      )}
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        {data && <Pagination {...data.pagination} onPageChange={setPage} />}
      </div>
      <ProjectFormModal open={formOpen} onClose={() => setFormOpen(false)} project={editing} defaultWebsiteId={filters.websiteId || params.get('websiteId') || undefined} />
    </div>
  );
};
