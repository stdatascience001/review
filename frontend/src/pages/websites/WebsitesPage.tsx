import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BadgeCheck, Copy, ExternalLink, Globe, Pencil, Plus, Power, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { websitesApi } from '@/api/resources';
import { Button } from '@/components/ui/Button';
import { Badge, EmptyState, PageHeader, Pagination, Table, TableSkeleton, Td, Th } from '@/components/ui/Display';
import { FilterSelect, SearchInput } from '@/components/ui/Form';
import { useConfirm } from '@/components/ui/Modal';
import { useDebounce, usePagedFilters } from '@/hooks/useCommon';
import { getErrorMessage } from '@/lib/api';
import { WEBSITE_ROLE_LABEL } from '@/lib/labels';
import { copyToClipboard, formatDate } from '@/lib/utils';
import type { Website, WebsiteStatus } from '@/types/api';
import { WebsiteFormModal } from './WebsiteFormModal';

export const WebsiteLogo = ({ website, size = 'md' }: { website: Pick<Website, 'name' | 'logoUrl'>; size?: 'md' | 'lg' }) => {
  const dims = size === 'lg' ? 'h-14 w-14 text-lg' : 'h-9 w-9 text-sm';
  return website.logoUrl ? (
    <img src={website.logoUrl} alt="" className={`${dims} shrink-0 rounded-lg border border-slate-200 bg-white object-contain`} />
  ) : (
    <span className={`${dims} flex shrink-0 items-center justify-center rounded-lg bg-brand-50 font-semibold text-brand-700`}>
      {website.name[0]?.toUpperCase()}
    </span>
  );
};

export const canManageWebsite = (w: Pick<Website, 'role'>) => w.role === 'OWNER' || w.role === 'ADMIN';

export const WebsitesPage = () => {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { filters, update, page, setPage } = usePagedFilters({ q: '', status: '' });
  const q = useDebounce(filters.q);
  const [editing, setEditing] = useState<Website | null>(null);
  const [formOpen, setFormOpen] = useState(false);

  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['websites', 'list', { q, status: filters.status, page }],
    queryFn: () => websitesApi.list({ q, status: (filters.status || undefined) as WebsiteStatus | undefined, page, pageSize: 10 }),
    placeholderData: keepPreviousData,
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['websites'] });
    qc.invalidateQueries({ queryKey: ['dashboard'] });
  };

  const toggleStatus = useMutation({
    mutationFn: (w: Website) => websitesApi.update(w.id, { status: w.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE' }),
    onSuccess: (w) => {
      invalidate();
      toast.success(`${w.name} ${w.status === 'ACTIVE' ? 'activated' : 'deactivated'}`);
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  });

  const remove = useMutation({
    mutationFn: (w: Website) => websitesApi.remove(w.id),
    onSuccess: () => {
      invalidate();
      qc.invalidateQueries({ queryKey: ['projects'] });
      qc.invalidateQueries({ queryKey: ['tasks'] });
      toast.success('Website deleted');
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  });

  const onDelete = async (w: Website) => {
    if (
      await confirm({
        title: 'Delete website?',
        message: (
          <>
            <strong>{w.name}</strong> and all of its projects, tasks, comments and team access will be permanently deleted. This cannot be undone.
          </>
        ),
        confirmLabel: 'Delete website',
        danger: true,
      })
    )
      remove.mutate(w);
  };

  const onToggle = async (w: Website) => {
    const deactivate = w.status === 'ACTIVE';
    if (
      await confirm({
        title: deactivate ? 'Deactivate website?' : 'Activate website?',
        message: deactivate
          ? 'While inactive, no new tasks can be created for this website and the embed widget is disabled.'
          : 'The website will accept new tasks again.',
        confirmLabel: deactivate ? 'Deactivate' : 'Activate',
        danger: deactivate,
      })
    )
      toggleStatus.mutate(w);
  };

  const items = data?.items ?? [];
  const hasFilters = Boolean(filters.q || filters.status);

  return (
    <div>
      <PageHeader
        title="Websites"
        description="Client websites you collect feedback for. Each has its own Site ID and embed script."
        actions={
          <Button icon={<Plus className="h-4 w-4" />} onClick={() => { setEditing(null); setFormOpen(true); }}>
            Add website
          </Button>
        }
      />

      <div className="card">
        <div className="flex flex-col gap-3 border-b border-slate-100 p-4 sm:flex-row">
          <SearchInput value={filters.q} onChange={(v) => update({ q: v })} placeholder="Search by name, URL or Site ID…" className="sm:max-w-xs sm:flex-1" />
          <FilterSelect
            value={filters.status}
            onChange={(v) => update({ status: v })}
            placeholder="All statuses"
            options={[{ value: 'ACTIVE', label: 'Active' }, { value: 'INACTIVE', label: 'Inactive' }]}
          />
          {isFetching && !isLoading && <span className="self-center text-xs text-slate-400">Updating…</span>}
        </div>

        {isLoading ? (
          <TableSkeleton cols={6} />
        ) : items.length === 0 ? (
          <EmptyState
            icon={Globe}
            title={hasFilters ? 'No websites match your filters' : 'No websites yet'}
            description={hasFilters ? 'Try a different search or status.' : 'Add your first website to generate an embed script and start collecting feedback.'}
            action={!hasFilters && <Button icon={<Plus className="h-4 w-4" />} onClick={() => { setEditing(null); setFormOpen(true); }}>Add website</Button>}
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Website</Th>
                <Th>Site ID</Th>
                <Th>Status</Th>
                <Th>Projects / Tasks</Th>
                <Th>Your role</Th>
                <Th>Created</Th>
                <Th className="text-right">Actions</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {items.map((w) => (
                <tr key={w.id} className="hover:bg-slate-50/60" data-testid="website-row">
                  <Td>
                    <div className="flex items-center gap-3">
                      <WebsiteLogo website={w} />
                      <div className="min-w-0">
                        <Link to={`/websites/${w.id}`} className="font-medium text-slate-900 hover:text-brand-700">{w.name}</Link>
                        <a href={w.url} target="_blank" rel="noreferrer" className="flex items-center gap-1 truncate text-xs text-slate-500 hover:text-brand-600">
                          {w.url.replace(/^https?:\/\//, '')} <ExternalLink className="h-3 w-3" />
                        </a>
                      </div>
                    </div>
                  </Td>
                  <Td>
                    <button
                      type="button"
                      className="group flex items-center gap-1.5 font-mono text-xs text-slate-600 hover:text-brand-700"
                      onClick={async () => (await copyToClipboard(w.siteId)) && toast.success('Site ID copied')}
                      title="Copy Site ID"
                    >
                      {w.siteId} <Copy className="h-3 w-3 opacity-0 group-hover:opacity-100" />
                    </button>
                  </Td>
                  <Td>
                    <div className="flex items-center gap-1.5">
                      <Badge tone={w.status === 'ACTIVE' ? 'green' : 'gray'} dot>{w.status === 'ACTIVE' ? 'Active' : 'Inactive'}</Badge>
                      {w.domainVerifiedAt && <BadgeCheck className="h-4 w-4 text-brand-600" aria-label="Domain verified" />}
                    </div>
                  </Td>
                  <Td className="tabular-nums">{w._count?.projects ?? 0} / {w._count?.tasks ?? 0}</Td>
                  <Td>{w.role ? <span className="text-xs text-slate-600">{WEBSITE_ROLE_LABEL[w.role]}</span> : '—'}</Td>
                  <Td className="whitespace-nowrap text-slate-500">{formatDate(w.createdAt)}</Td>
                  <Td>
                    <div className="flex justify-end gap-1">
                      {canManageWebsite(w) && (
                        <>
                          <Button variant="ghost" size="icon" aria-label={`Edit ${w.name}`} onClick={() => { setEditing(w); setFormOpen(true); }}>
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={`${w.status === 'ACTIVE' ? 'Deactivate' : 'Activate'} ${w.name}`}
                            onClick={() => onToggle(w)}
                          >
                            <Power className={w.status === 'ACTIVE' ? 'h-4 w-4 text-emerald-600' : 'h-4 w-4 text-slate-400'} />
                          </Button>
                        </>
                      )}
                      {w.role === 'OWNER' && (
                        <Button variant="ghost" size="icon" aria-label={`Delete ${w.name}`} onClick={() => onDelete(w)}>
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

      <WebsiteFormModal open={formOpen} onClose={() => setFormOpen(false)} website={editing} />
    </div>
  );
};
