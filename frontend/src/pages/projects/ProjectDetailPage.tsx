import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowLeft, CalendarDays, Pencil, Trash2, UserPlus, X } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import { projectsApi, teamApi } from '@/api/resources';
import { TaskTable } from '@/components/tasks/TaskTable';
import { Button } from '@/components/ui/Button';
import { Badge, EmptyState, ProgressBar, Skeleton, UserCell } from '@/components/ui/Display';
import { useConfirm } from '@/components/ui/Modal';
import { useAuth } from '@/hooks/useAuth';
import { getErrorMessage } from '@/lib/api';
import { PROJECT_ROLE_LABEL, PROJECT_STATUS, TASK_STATUS, WEBSITE_ROLE_LABEL } from '@/lib/labels';
import { formatDate } from '@/lib/utils';
import type { ProjectDetail, ProjectRole, TaskStatus, WebsiteRole } from '@/types/api';
import { ProjectFormModal } from './ProjectFormModal';

const ALLOWED: Record<WebsiteRole, ProjectRole[]> = {
  OWNER: ['MANAGER', 'CONTRIBUTOR', 'REVIEWER', 'VIEWER'],
  ADMIN: ['MANAGER', 'CONTRIBUTOR', 'REVIEWER', 'VIEWER'],
  PROJECT_MANAGER: ['MANAGER', 'CONTRIBUTOR', 'REVIEWER', 'VIEWER'],
  DEVELOPER: ['CONTRIBUTOR', 'REVIEWER', 'VIEWER'],
  WEBSITE_USER: ['REVIEWER', 'VIEWER'],
};

const MembersCard = ({ project }: { project: ProjectDetail }) => {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { user } = useAuth();
  const canManage = project.role === 'MANAGER';
  const [adding, setAdding] = useState('');

  const members = useQuery({ queryKey: ['projects', project.id, 'members'], queryFn: () => projectsApi.members(project.id) });
  const team = useQuery({ queryKey: ['team', project.websiteId, 'members'], queryFn: () => teamApi.members(project.websiteId), enabled: canManage });
  const teamRole = (userId: string) => team.data?.find((m) => m.user.id === userId)?.role;
  const candidates = (team.data ?? []).filter((m) => !members.data?.some((pm) => pm.user.id === m.user.id));

  const refresh = () => ['projects', 'team', 'dashboard'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
  const add = useMutation({
    mutationFn: (userId: string) => projectsApi.addMember(project.id, userId),
    onSuccess: () => { setAdding(''); refresh(); toast.success('Member added'); },
    onError: (err) => toast.error(getErrorMessage(err)),
  });
  const changeRole = useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: ProjectRole }) => projectsApi.updateMember(project.id, userId, role),
    onSuccess: () => { refresh(); toast.success('Role updated'); },
    onError: (err) => toast.error(getErrorMessage(err)),
  });
  const remove = useMutation({
    mutationFn: (userId: string) => projectsApi.removeMember(project.id, userId),
    onSuccess: () => { refresh(); toast.success('Member removed'); },
    onError: (err) => toast.error(getErrorMessage(err)),
  });

  return (
    <section className="card">
      <div className="border-b border-slate-100 px-5 py-4">
        <h2 className="font-semibold">Team ({members.data?.length ?? 0})</h2>
        <p className="text-xs text-slate-500">Website admins also have full access to every project.</p>
      </div>
      {canManage && (
        <div className="flex gap-2 border-b border-slate-100 p-4">
          <select className="input" aria-label="Add team member to project" value={adding} onChange={(e) => setAdding(e.target.value)}>
            <option value="">{candidates.length ? 'Add a team member…' : 'Everyone is already in this project'}</option>
            {candidates.map((m) => (
              <option key={m.user.id} value={m.user.id}>{m.user.name} — {WEBSITE_ROLE_LABEL[m.role]}</option>
            ))}
          </select>
          <Button icon={<UserPlus className="h-4 w-4" />} disabled={!adding} loading={add.isPending} onClick={() => add.mutate(adding)}>
            Add
          </Button>
        </div>
      )}
      {members.isLoading ? (
        <div className="space-y-3 p-5"><Skeleton className="h-8" /><Skeleton className="h-8" /></div>
      ) : (
        <ul className="divide-y divide-slate-100" data-testid="project-members">
          {members.data?.map((m) => {
            const allowed = ALLOWED[teamRole(m.user.id) ?? 'DEVELOPER'];
            return (
              <li key={m.id} className="flex items-center gap-3 px-5 py-3">
                <div className="min-w-0 flex-1"><UserCell user={m.user} /></div>
                {canManage ? (
                  <select
                    className="input w-auto py-1 text-xs"
                    aria-label={`Project role for ${m.user.name}`}
                    value={m.role}
                    onChange={(e) => changeRole.mutate({ userId: m.user.id, role: e.target.value as ProjectRole })}
                  >
                    {(allowed.includes(m.role) ? allowed : [m.role, ...allowed]).map((r) => (
                      <option key={r} value={r}>{PROJECT_ROLE_LABEL[r]}</option>
                    ))}
                  </select>
                ) : (
                  <Badge>{PROJECT_ROLE_LABEL[m.role]}</Badge>
                )}
                {canManage && m.user.id !== user?.id && (
                  <button
                    type="button"
                    aria-label={`Remove ${m.user.name}`}
                    className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600"
                    onClick={async () =>
                      (await confirm({ title: 'Remove from project?', message: `${m.user.name} will lose access to this project.`, confirmLabel: 'Remove', danger: true })) &&
                      remove.mutate(m.user.id)
                    }
                  >
                    <X className="h-4 w-4" />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
};

export const ProjectDetailPage = () => {
  const { projectId = '' } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [editOpen, setEditOpen] = useState(false);
  const { data: p, isLoading, isError, error } = useQuery({ queryKey: ['projects', 'detail', projectId], queryFn: () => projectsApi.get(projectId) });

  const remove = useMutation({
    mutationFn: () => projectsApi.remove(projectId),
    onSuccess: () => {
      qc.invalidateQueries();
      toast.success('Project deleted');
      navigate('/projects', { replace: true });
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  });

  if (isLoading) return <div className="space-y-4"><Skeleton className="h-16 w-1/2" /><Skeleton className="h-48" /></div>;
  if (isError || !p)
    return <div className="card"><EmptyState icon={AlertTriangle} title="Project not found" description={getErrorMessage(error)} action={<Link to="/projects"><Button>Back to projects</Button></Link>} /></div>;

  const canDelete = p.websiteRole === 'OWNER' || p.websiteRole === 'ADMIN';

  return (
    <div className="space-y-6">
      <div>
        <Link to="/projects" className="mb-4 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800">
          <ArrowLeft className="h-4 w-4" /> Projects
        </Link>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-semibold tracking-tight">{p.name}</h1>
              <Badge tone={PROJECT_STATUS[p.status].tone}>{PROJECT_STATUS[p.status].label}</Badge>
            </div>
            <p className="mt-1 text-sm text-slate-500">
              <Link to={`/websites/${p.website.id}`} className="hover:text-brand-700">{p.website.name}</Link>
              <span className="mx-2">·</span>
              <CalendarDays className="mr-1 inline h-3.5 w-3.5" />
              {formatDate(p.startDate)} → {formatDate(p.dueDate)}
            </p>
            {p.description && <p className="mt-2 max-w-2xl text-sm text-slate-600">{p.description}</p>}
          </div>
          <div className="flex gap-2">
            {p.role === 'MANAGER' && <Button variant="secondary" icon={<Pencil className="h-4 w-4" />} onClick={() => setEditOpen(true)}>Edit</Button>}
            {canDelete && (
              <Button
                variant="danger"
                icon={<Trash2 className="h-4 w-4" />}
                onClick={async () =>
                  (await confirm({ title: 'Delete project?', message: `${p.name} and all its tasks will be permanently deleted.`, confirmLabel: 'Delete project', danger: true })) && remove.mutate()
                }
              >
                Delete
              </Button>
            )}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <section className="card p-5 lg:col-span-2">
          <div className="flex items-end justify-between">
            <div>
              <h2 className="font-semibold">Progress</h2>
              <p className="text-sm text-slate-500">{p.progress.completed} of {p.progress.total} tasks completed</p>
            </div>
            <span className="text-3xl font-semibold" data-testid="project-progress">{p.progress.percent}%</span>
          </div>
          <ProgressBar percent={p.progress.percent} className="mt-3 h-2.5" />
          <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-6">
            {(Object.keys(TASK_STATUS) as TaskStatus[]).map((s) => (
              <div key={s} className="rounded-lg bg-slate-50 p-3">
                <p className="text-xs text-slate-500">{TASK_STATUS[s].label}</p>
                <p className="text-lg font-semibold">{p.taskCountsByStatus[s] ?? 0}</p>
              </div>
            ))}
            <div className="rounded-lg bg-red-50 p-3">
              <p className="text-xs text-red-600">Overdue</p>
              <p className="text-lg font-semibold text-red-700">{p.overdueTasks}</p>
            </div>
          </div>
        </section>
        <MembersCard project={p} />
      </div>

      <div>
        <h2 className="mb-3 font-semibold">Tasks</h2>
        <TaskTable fixed={{ projectId: p.id, websiteId: p.websiteId }} showCreate={p.role !== 'VIEWER'} emptyTitle="No tasks in this project yet" />
      </div>

      <ProjectFormModal open={editOpen} onClose={() => setEditOpen(false)} project={p} />
    </div>
  );
};
