import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ScrollText } from 'lucide-react';
import { useState } from 'react';
import { auditApi } from '@/api/resources';
import { Badge, EmptyState, PageHeader, Pagination, Table, TableSkeleton, Td, Th } from '@/components/ui/Display';
import { FilterSelect, SearchInput } from '@/components/ui/Form';
import { useDebounce } from '@/hooks/useCommon';
import { formatDateTime } from '@/lib/utils';

const ACTIONS = [
  ['auth.', 'Authentication'],
  ['auth.login', 'Logins'],
  ['user.', 'Account changes'],
  ['admin.', 'Admin actions'],
  ['website.', 'Websites'],
  ['member.', 'Team members'],
  ['invitation.', 'Invitations'],
  ['project.', 'Projects'],
  ['task.', 'Tasks'],
] as const;

/**
 * Security audit trail. Super admins see the whole platform (no websiteId); website owners
 * and admins see their website's entries (websiteId).
 */
export const AuditLogView = ({ websiteId }: { websiteId?: string }) => {
  const [page, setPage] = useState(1);
  const [action, setAction] = useState('');
  const [outcome, setOutcome] = useState('');
  const [search, setSearch] = useState('');
  const q = useDebounce(search);
  const { data, isLoading } = useQuery({
    queryKey: ['audit', { websiteId, page, action, outcome, q }],
    queryFn: () => auditApi.list({ websiteId, page, pageSize: 25, action: action || undefined, outcome: outcome || undefined, q: q || undefined }),
    placeholderData: keepPreviousData,
  });

  return (
    <div className="card">
      <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 p-4">
        <SearchInput value={search} onChange={(v) => { setSearch(v); setPage(1); }} placeholder="Email, IP or action…" className="w-full sm:w-64" />
        <FilterSelect ariaLabel="Action" value={action} onChange={(v) => { setAction(v); setPage(1); }} placeholder="All actions" options={ACTIONS.map(([value, label]) => ({ value, label }))} />
        <FilterSelect
          ariaLabel="Outcome"
          value={outcome}
          onChange={(v) => { setOutcome(v); setPage(1); }}
          placeholder="Any outcome"
          options={[
            { value: 'success', label: 'Success' },
            { value: 'failure', label: 'Failure' },
            { value: 'denied', label: 'Denied' },
          ]}
        />
      </div>
      {isLoading ? (
        <TableSkeleton cols={6} />
      ) : !data?.items.length ? (
        <EmptyState icon={ScrollText} title="No audit entries" description="Security-relevant actions will appear here." />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>When</Th>
              <Th>Action</Th>
              <Th>Outcome</Th>
              <Th>Who</Th>
              <Th>Target</Th>
              <Th>From</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100" data-testid="audit-rows">
            {data.items.map((e) => (
              <tr key={e.id}>
                <Td className="whitespace-nowrap text-xs text-slate-500">{formatDateTime(e.createdAt)}</Td>
                <Td className="font-mono text-xs">{e.action}</Td>
                <Td>
                  <Badge tone={e.outcome === 'success' ? 'green' : e.outcome === 'failure' ? 'red' : 'amber'}>{e.outcome}</Badge>
                </Td>
                <Td className="max-w-[16rem] truncate text-sm">{e.actorEmail ?? '—'}</Td>
                <Td className="text-xs text-slate-500">
                  {e.targetType ? `${e.targetType} ${e.targetId?.slice(0, 8) ?? ''}` : '—'}
                  {e.metadata && (
                    <div className="max-w-xs truncate font-mono text-[11px] text-slate-400" title={JSON.stringify(e.metadata)}>
                      {JSON.stringify(e.metadata)}
                    </div>
                  )}
                </Td>
                <Td className="text-xs text-slate-500"><span title={e.userAgent ?? undefined}>{e.ipAddress ?? "—"}</span></Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {data && <Pagination {...data.pagination} onPageChange={setPage} />}
    </div>
  );
};

export const AuditLogPage = () => (
  <div>
    <PageHeader title="Audit Log" description="Logins, failed attempts, permission changes and deletions across the platform." />
    <AuditLogView />
  </div>
);
