import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, ExternalLink, FolderKanban, Users } from 'lucide-react';
import { Link } from 'react-router';
import { dashboardApi } from '@/api/resources';
import { TaskTable } from '@/components/tasks/TaskTable';
import { Button } from '@/components/ui/Button';
import { Badge, EmptyState, Skeleton, Table, Td, Th, UserCell } from '@/components/ui/Display';
import { WEBSITE_ROLE_LABEL, WEBSITE_ROLE_TONE } from '@/lib/labels';
import { timeAgo } from '@/lib/utils';

/**
 * Dashboard → Projects.
 *  - Nothing selected: every project (website) the user can open, with their role and task
 *    counts — admins see all of them with user counts; users see only their assigned ones.
 *  - A project selected: its users (team only) and only that project's tasks, with "New task"
 *    saving straight into that project.
 */
export const ProjectsPanel = ({ websiteId, onSelect }: { websiteId: string; onSelect: (id: string) => void }) => {
  const list = useQuery({ queryKey: ['dashboard', 'websites'], queryFn: dashboardApi.websites });
  const selected = list.data?.find((w) => w.id === websiteId);

  if (websiteId) {
    return (
      <div className="mt-6 space-y-6" data-testid="project-panel">
        <section className="card">
          <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 px-5 py-4">
            <Button variant="ghost" size="sm" icon={<ArrowLeft className="h-4 w-4" />} onClick={() => onSelect('')}>
              All projects
            </Button>
            <div className="min-w-0 flex-1">
              <h2 className="truncate text-sm font-semibold text-slate-900">{selected?.name ?? 'Project'}</h2>
              {selected && <p className="truncate text-xs text-slate-500">{selected.url}</p>}
            </div>
            {selected && <Badge tone={WEBSITE_ROLE_TONE[selected.role]}>{selected.member ? WEBSITE_ROLE_LABEL[selected.role] : 'Super Admin'}</Badge>}
            {selected?.users !== null && (
              <Link to={`/websites/${websiteId}`} className="inline-flex items-center gap-1 text-sm font-medium text-brand-700 hover:underline">
                Open project <ExternalLink className="h-3.5 w-3.5" />
              </Link>
            )}
          </div>
          {selected && selected.users !== null && <ProjectUsers websiteId={websiteId} />}
        </section>
        <section>
          <h2 className="mb-3 text-sm font-semibold text-slate-900">Tasks in {selected?.name ?? 'this project'}</h2>
          <TaskTable key={websiteId} fixed={{ websiteId }} emptyTitle="No tasks in this project yet" />
        </section>
      </div>
    );
  }

  return (
    <section className="card mt-6" data-testid="projects-panel">
      <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
        <h2 className="text-sm font-semibold text-slate-900">Projects</h2>
        <FolderKanban className="h-4 w-4 text-slate-400" />
      </div>
      {list.isLoading ? (
        <div className="space-y-3 p-5">{Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-8" />)}</div>
      ) : !list.data?.length ? (
        <EmptyState icon={FolderKanban} title="No projects yet" description="Projects you create or are added to will appear here." />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Project</Th>
              <Th>Your role</Th>
              <Th className="text-right">Users</Th>
              <Th className="text-right">Tasks</Th>
              <Th className="text-right">Open</Th>
              <Th className="text-right">In progress</Th>
              <Th className="text-right">Completed</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {list.data.map((w) => (
              <tr
                key={w.id}
                className="cursor-pointer hover:bg-slate-50"
                data-testid="project-row"
                tabIndex={0}
                onClick={() => onSelect(w.id)}
                onKeyDown={(e) => e.key === 'Enter' && onSelect(w.id)}
              >
                <Td>
                  <p className="font-medium text-slate-900">{w.name}</p>
                  <p className="text-xs text-slate-500">{w.url}</p>
                </Td>
                <Td>
                  <Badge tone={WEBSITE_ROLE_TONE[w.role]}>{w.member ? WEBSITE_ROLE_LABEL[w.role] : 'Super Admin'}</Badge>
                </Td>
                <Td className="text-right tabular-nums">{w.users ?? '—'}</Td>
                <Td className="text-right tabular-nums font-medium">{w.tasks.total}</Td>
                <Td className="text-right tabular-nums">{w.tasks.open}</Td>
                <Td className="text-right tabular-nums">{w.tasks.inProgress}</Td>
                <Td className="text-right tabular-nums">{w.tasks.completed}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </section>
  );
};

const ProjectUsers = ({ websiteId }: { websiteId: string }) => {
  const users = useQuery({ queryKey: ['dashboard', 'websites', websiteId, 'users'], queryFn: () => dashboardApi.websiteUsers(websiteId) });
  return (
    <div data-testid="project-users">
      <div className="flex items-center gap-2 px-5 pt-4 text-xs font-semibold uppercase tracking-wide text-slate-500">
        <Users className="h-4 w-4" /> Users in this project
      </div>
      {users.isLoading ? (
        <div className="space-y-3 p-5">{Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-8" />)}</div>
      ) : !users.data?.length ? (
        <EmptyState icon={Users} title="No users yet" description="People who sign in through this website's review widget join automatically." />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>User</Th>
              <Th>Role</Th>
              <Th>Assigned projects</Th>
              <Th className="text-right">Tasks reported</Th>
              <Th className="text-right">Open</Th>
              <Th>Last login</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {users.data.map((m) => (
              <tr key={m.user.id}>
                <Td>
                  <UserCell user={m.user} subtitle={m.user.email} />
                </Td>
                <Td>
                  <Badge tone={WEBSITE_ROLE_TONE[m.role]}>{WEBSITE_ROLE_LABEL[m.role]}</Badge>
                </Td>
                <Td className="text-xs text-slate-600">{m.projects.map((p) => p.name).join(', ') || '—'}</Td>
                <Td className="text-right tabular-nums">{m.tasks.reported}</Td>
                <Td className="text-right tabular-nums">{m.tasks.open}</Td>
                <Td className="text-xs text-slate-500">{m.user.lastLoginAt ? timeAgo(m.user.lastLoginAt) : 'Never'}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
};
