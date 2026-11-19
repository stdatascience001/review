import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BarChart3, Clock, FolderKanban, Mail, RotateCw, Trash2, UserPlus, Users, X } from 'lucide-react';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { teamApi } from '@/api/resources';
import { Button } from '@/components/ui/Button';
import { Badge, EmptyState, PageHeader, ProgressBar, Table, TableSkeleton, Td, Th, UserCell } from '@/components/ui/Display';
import { FilterSelect, Input, SearchInput } from '@/components/ui/Form';
import { Modal, useConfirm } from '@/components/ui/Modal';
import { useAuth } from '@/hooks/useAuth';
import { useProjectOptions, useWebsiteOptions } from '@/hooks/useCommon';
import { getErrorMessage } from '@/lib/api';
import { ASSIGNABLE_ROLES, PROJECT_ROLE_LABEL, WEBSITE_ROLE_LABEL, WEBSITE_ROLE_TONE } from '@/lib/labels';
import { cn, formatDate, timeAgo } from '@/lib/utils';
import type { AssignableRole, TeamMember, WebsiteRole } from '@/types/api';

const canManageTeam = (role?: WebsiteRole | null) => role === 'OWNER' || role === 'ADMIN';
const canSeePerformance = (role?: WebsiteRole | null) => role === 'OWNER' || role === 'ADMIN' || role === 'PROJECT_MANAGER';

// ───────────── Invite modal ─────────────
const InviteModal = ({
  open,
  onClose,
  websiteId,
  myRole,
  presetRole,
}: {
  open: boolean;
  onClose: () => void;
  websiteId: string;
  myRole: WebsiteRole;
  presetRole?: AssignableRole;
}) => {
  const qc = useQueryClient();
  const projects = useProjectOptions(websiteId);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<AssignableRole>('DEVELOPER');
  const [projectIds, setProjectIds] = useState<string[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    if (open) {
      setEmail('');
      setRole(presetRole ?? 'DEVELOPER');
      setProjectIds([]);
      setError('');
    }
  }, [open, presetRole]);

  const mutation = useMutation({
    mutationFn: () => teamApi.invite(websiteId, { email, role, projectIds }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['team', websiteId] });
      qc.invalidateQueries({ queryKey: ['projects'] });
      toast.success(r.status === 'added' ? `${email} already had an account and was added to the team` : `Invitation sent to ${email}`);
      onClose();
    },
    onError: (err) => setError(getErrorMessage(err)),
  });

  const roles = ASSIGNABLE_ROLES.filter((r) => r.value !== 'ADMIN' || myRole === 'OWNER');

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={presetRole === 'DEVELOPER' ? 'Add developer' : 'Invite team member'}
      description="Existing users are added immediately; new people receive an email invitation."
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" form="invite-form" loading={mutation.isPending} icon={<Mail className="h-4 w-4" />}>Send invite</Button>
        </>
      }
    >
      <form
        id="invite-form"
        className="space-y-5"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          setError('');
          mutation.mutate();
        }}
      >
        <Input label="Email address" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="teammate@company.com" />
        <fieldset>
          <legend className="label">Role</legend>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {roles.map((r) => (
              <label
                key={r.value}
                className={cn(
                  'flex cursor-pointer gap-3 rounded-lg border p-3 transition',
                  role === r.value ? 'border-brand-500 bg-brand-50 ring-1 ring-brand-500' : 'border-slate-200 hover:border-slate-300',
                )}
              >
                <input type="radio" name="role" className="mt-0.5" checked={role === r.value} onChange={() => setRole(r.value)} />
                <span>
                  <span className="block text-sm font-medium">{r.label}</span>
                  <span className="block text-xs text-slate-500">{r.description}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset>
          <legend className="label">Assign to projects (optional)</legend>
          {projects.data?.length ? (
            <div className="max-h-40 space-y-1 overflow-y-auto rounded-lg border border-slate-200 p-2">
              {projects.data.map((p) => (
                <label key={p.id} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-slate-50">
                  <input
                    type="checkbox"
                    className="rounded border-slate-300"
                    checked={projectIds.includes(p.id)}
                    onChange={() => setProjectIds((ids) => (ids.includes(p.id) ? ids.filter((i) => i !== p.id) : [...ids, p.id]))}
                  />
                  {p.name}
                </label>
              ))}
            </div>
          ) : (
            <p className="text-sm text-slate-400">No projects in this website yet.</p>
          )}
        </fieldset>
        {error && <p role="alert" className="whitespace-pre-line rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      </form>
    </Modal>
  );
};

// ───────────── Assign projects modal ─────────────
const AssignProjectsModal = ({ member, websiteId, onClose }: { member: TeamMember | null; websiteId: string; onClose: () => void }) => {
  const qc = useQueryClient();
  const projects = useProjectOptions(websiteId);
  const [selected, setSelected] = useState<string[]>([]);
  useEffect(() => setSelected(member?.projects.map((p) => p.id) ?? []), [member]);

  const mutation = useMutation({
    mutationFn: () =>
      teamApi.setProjects(
        websiteId,
        member!.user.id,
        selected.map((projectId) => ({ projectId, role: member!.projects.find((p) => p.id === projectId)?.role })),
      ),
    onSuccess: () => {
      ['team', 'projects'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
      toast.success('Project assignments updated');
      onClose();
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  });

  return (
    <Modal
      open={Boolean(member)}
      onClose={onClose}
      title={`Assign projects · ${member?.user.name ?? ''}`}
      description={member && `Team role: ${WEBSITE_ROLE_LABEL[member.role]}. New assignments use the default project role for this team role.`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button loading={mutation.isPending} onClick={() => mutation.mutate()}>Save assignments</Button>
        </>
      }
    >
      {!projects.data?.length ? (
        <p className="text-sm text-slate-500">This website has no projects yet.</p>
      ) : (
        <div className="space-y-1">
          {projects.data.map((p) => {
            const current = member?.projects.find((mp) => mp.id === p.id);
            return (
              <label key={p.id} className="flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 hover:bg-slate-50">
                <input
                  type="checkbox"
                  className="rounded border-slate-300"
                  checked={selected.includes(p.id)}
                  onChange={() => setSelected((s) => (s.includes(p.id) ? s.filter((i) => i !== p.id) : [...s, p.id]))}
                />
                <span className="flex-1 text-sm">{p.name}</span>
                {current && <Badge>{PROJECT_ROLE_LABEL[current.role]}</Badge>}
              </label>
            );
          })}
        </div>
      )}
    </Modal>
  );
};

// ───────────── Members tab ─────────────
const MembersTab = ({ websiteId, myRole }: { websiteId: string; myRole: WebsiteRole }) => {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { user } = useAuth();
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [assigning, setAssigning] = useState<TeamMember | null>(null);
  const manage = canManageTeam(myRole);

  const members = useQuery({ queryKey: ['team', websiteId, 'members'], queryFn: () => teamApi.members(websiteId) });
  const invitations = useQuery({ queryKey: ['team', websiteId, 'invitations'], queryFn: () => teamApi.invitations(websiteId), enabled: manage });

  const refresh = () => qc.invalidateQueries({ queryKey: ['team', websiteId] });
  const updateRole = useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: AssignableRole }) => teamApi.updateRole(websiteId, userId, role),
    onSuccess: () => { refresh(); qc.invalidateQueries({ queryKey: ['projects'] }); toast.success('Role updated'); },
    onError: (err) => toast.error(getErrorMessage(err)),
  });
  const removeMember = useMutation({
    mutationFn: (userId: string) => teamApi.remove(websiteId, userId),
    onSuccess: () => { refresh(); qc.invalidateQueries({ queryKey: ['dashboard'] }); toast.success('Member removed'); },
    onError: (err) => toast.error(getErrorMessage(err)),
  });
  const resend = useMutation({
    mutationFn: (id: string) => teamApi.resendInvitation(websiteId, id),
    onSuccess: () => { refresh(); toast.success('Invitation re-sent'); },
    onError: (err) => toast.error(getErrorMessage(err)),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => teamApi.revokeInvitation(websiteId, id),
    onSuccess: () => { refresh(); toast.success('Invitation revoked'); },
    onError: (err) => toast.error(getErrorMessage(err)),
  });

  const filtered = useMemo(
    () =>
      (members.data ?? []).filter(
        (m) =>
          (!roleFilter || m.role === roleFilter) &&
          (!search || `${m.user.name} ${m.user.email}`.toLowerCase().includes(search.toLowerCase())),
      ),
    [members.data, search, roleFilter],
  );

  const canEditMember = (m: TeamMember) => manage && m.role !== 'OWNER' && m.user.id !== user?.id && (m.role !== 'ADMIN' || myRole === 'OWNER');

  return (
    <div className="space-y-6">
      <div className="card">
        <div className="flex flex-col gap-3 border-b border-slate-100 p-4 sm:flex-row">
          <SearchInput value={search} onChange={setSearch} placeholder="Search members…" className="sm:w-64" />
          <FilterSelect value={roleFilter} onChange={setRoleFilter} placeholder="All roles" options={Object.entries(WEBSITE_ROLE_LABEL).map(([value, label]) => ({ value, label }))} />
        </div>
        {members.isLoading ? (
          <TableSkeleton cols={5} />
        ) : filtered.length === 0 ? (
          <EmptyState icon={Users} title="No members match" />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Member</Th>
                <Th>Role</Th>
                <Th>Projects</Th>
                <Th>Last active</Th>
                <Th className="text-right">Actions</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filtered.map((m) => (
                <tr key={m.id} data-testid="member-row">
                  <Td><UserCell user={m.user} /></Td>
                  <Td>
                    {canEditMember(m) ? (
                      <select
                        className="input w-auto py-1 text-xs"
                        aria-label={`Role for ${m.user.name}`}
                        value={m.role}
                        onChange={(e) => updateRole.mutate({ userId: m.user.id, role: e.target.value as AssignableRole })}
                      >
                        {ASSIGNABLE_ROLES.filter((r) => r.value !== 'ADMIN' || myRole === 'OWNER').map((r) => (
                          <option key={r.value} value={r.value}>{r.label}</option>
                        ))}
                      </select>
                    ) : (
                      <Badge tone={WEBSITE_ROLE_TONE[m.role]}>{WEBSITE_ROLE_LABEL[m.role]}</Badge>
                    )}
                  </Td>
                  <Td>
                    {m.role === 'OWNER' || m.role === 'ADMIN' ? (
                      <span className="text-xs text-slate-500">All projects</span>
                    ) : m.projects.length ? (
                      <div className="flex max-w-xs flex-wrap gap-1">
                        {m.projects.map((p) => <Badge key={p.id} tone="indigo">{p.name}</Badge>)}
                      </div>
                    ) : (
                      <span className="text-xs text-slate-400">None</span>
                    )}
                  </Td>
                  <Td className="text-xs text-slate-500">{m.user.lastLoginAt ? timeAgo(m.user.lastLoginAt) : 'Never'}</Td>
                  <Td>
                    <div className="flex justify-end gap-1">
                      {manage && m.role !== 'OWNER' && m.role !== 'ADMIN' && (
                        <Button variant="ghost" size="sm" icon={<FolderKanban className="h-3.5 w-3.5" />} onClick={() => setAssigning(m)}>
                          Projects
                        </Button>
                      )}
                      {canEditMember(m) && (
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Remove ${m.user.name}`}
                          onClick={async () =>
                            (await confirm({ title: 'Remove team member?', message: `${m.user.name} will lose access to this website and all its projects.`, confirmLabel: 'Remove', danger: true })) &&
                            removeMember.mutate(m.user.id)
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
      </div>

      {manage && (
        <div className="card">
          <div className="border-b border-slate-100 px-5 py-4">
            <h2 className="font-semibold">Pending invitations</h2>
          </div>
          {!invitations.data?.length ? (
            <p className="px-5 py-6 text-center text-sm text-slate-500">No pending invitations</p>
          ) : (
            <ul className="divide-y divide-slate-100" data-testid="pending-invitations">
              {invitations.data.map((inv) => (
                <li key={inv.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
                  <Mail className="h-4 w-4 text-slate-400" />
                  <span className="flex-1 text-sm font-medium">{inv.email}</span>
                  <Badge tone={WEBSITE_ROLE_TONE[inv.role]}>{WEBSITE_ROLE_LABEL[inv.role]}</Badge>
                  <span className="flex items-center gap-1 text-xs text-slate-500"><Clock className="h-3 w-3" /> expires {formatDate(inv.expiresAt)}</span>
                  <Button variant="ghost" size="sm" icon={<RotateCw className="h-3.5 w-3.5" />} onClick={() => resend.mutate(inv.id)}>Resend</Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={<X className="h-3.5 w-3.5" />}
                    onClick={async () =>
                      (await confirm({ title: 'Revoke invitation?', message: `The invitation link sent to ${inv.email} will stop working.`, confirmLabel: 'Revoke', danger: true })) &&
                      revoke.mutate(inv.id)
                    }
                  >
                    Revoke
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <AssignProjectsModal member={assigning} websiteId={websiteId} onClose={() => setAssigning(null)} />
    </div>
  );
};

// ───────────── Performance tab ─────────────
const PerformanceTab = ({ websiteId }: { websiteId: string }) => {
  const { data, isLoading, isError, error } = useQuery({ queryKey: ['team', websiteId, 'performance'], queryFn: () => teamApi.performance(websiteId) });
  if (isError) return <div className="card"><EmptyState icon={BarChart3} title="Unavailable" description={getErrorMessage(error)} /></div>;
  return (
    <div className="card">
      {isLoading ? (
        <TableSkeleton cols={7} />
      ) : !data?.some((r) => r.assigned > 0) ? (
        <EmptyState icon={BarChart3} title="No assigned tasks yet" description="Performance appears once tasks are assigned to team members." />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Member</Th>
              <Th>Assigned</Th>
              <Th>Open</Th>
              <Th>In progress</Th>
              <Th>Completed</Th>
              <Th>Overdue</Th>
              <Th>Done (30d)</Th>
              <Th className="w-40">Completion rate</Th>
              <Th>Avg. resolution</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {data.map((r) => (
              <tr key={r.user.id} data-testid="performance-row">
                <Td><UserCell user={r.user} subtitle={WEBSITE_ROLE_LABEL[r.role]} /></Td>
                <Td className="tabular-nums">{r.assigned}</Td>
                <Td className="tabular-nums">{r.open}</Td>
                <Td className="tabular-nums">{r.inProgress}</Td>
                <Td className="tabular-nums font-medium text-emerald-700">{r.completed}</Td>
                <Td className={cn('tabular-nums', r.overdue && 'font-medium text-red-600')}>{r.overdue}</Td>
                <Td className="tabular-nums">{r.completedLast30Days}</Td>
                <Td>
                  <div className="flex items-center gap-2">
                    <ProgressBar percent={r.completionRate} />
                    <span className="w-10 text-right text-xs tabular-nums">{r.completionRate}%</span>
                  </div>
                </Td>
                <Td className="text-xs text-slate-600">
                  {r.avgResolutionHours === null ? '—' : r.avgResolutionHours < 24 ? `${r.avgResolutionHours} h` : `${(r.avgResolutionHours / 24).toFixed(1)} d`}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
};

export const TeamPage = () => {
  const websites = useWebsiteOptions();
  const [params, setParams] = useSearchParams();
  const websiteId = params.get('websiteId') ?? websites.data?.[0]?.id ?? '';
  const tab = params.get('tab') ?? 'members';
  const [inviteRole, setInviteRole] = useState<AssignableRole | undefined>();
  const [inviteOpen, setInviteOpen] = useState(false);
  const website = websites.data?.find((w) => w.id === websiteId);
  const myRole = website?.role ?? 'WEBSITE_USER';

  const setParam = (patch: Record<string, string>) => setParams({ websiteId, tab, ...patch }, { replace: true });

  return (
    <div>
      <PageHeader
        title="Team Members"
        description="Invite people, assign roles and projects, and track delivery."
        actions={
          <>
            <FilterSelect
              value={websiteId}
              onChange={(v) => setParam({ websiteId: v })}
              placeholder={websites.isLoading ? 'Loading…' : 'Select website'}
              ariaLabel="Select website"
              options={(websites.data ?? []).map((w) => ({ value: w.id, label: w.name }))}
            />
            {canManageTeam(myRole) && website && (
              <>
                <Button variant="secondary" icon={<UserPlus className="h-4 w-4" />} onClick={() => { setInviteRole('DEVELOPER'); setInviteOpen(true); }}>
                  Add developer
                </Button>
                <Button icon={<Mail className="h-4 w-4" />} onClick={() => { setInviteRole(undefined); setInviteOpen(true); }}>
                  Invite member
                </Button>
              </>
            )}
          </>
        }
      />

      {!websites.isLoading && !websites.data?.length ? (
        <div className="card"><EmptyState icon={Users} title="No websites yet" description="Create a website first, then invite your team to it." /></div>
      ) : !website ? (
        <TableSkeleton />
      ) : (
        <>
          <div className="mb-6 flex gap-1 border-b border-slate-200" role="tablist">
            {[
              { key: 'members', label: 'Members', icon: Users, show: true },
              { key: 'performance', label: 'Performance', icon: BarChart3, show: canSeePerformance(myRole) },
            ]
              .filter((t) => t.show)
              .map((t) => (
                <button
                  key={t.key}
                  type="button"
                  role="tab"
                  aria-selected={tab === t.key}
                  onClick={() => setParam({ tab: t.key })}
                  className={cn(
                    '-mb-px flex items-center gap-2 border-b-2 px-4 py-2.5 text-sm font-medium',
                    tab === t.key ? 'border-brand-600 text-brand-700' : 'border-transparent text-slate-500 hover:text-slate-800',
                  )}
                >
                  <t.icon className="h-4 w-4" /> {t.label}
                </button>
              ))}
          </div>
          {tab === 'performance' && canSeePerformance(myRole) ? <PerformanceTab websiteId={websiteId} /> : <MembersTab websiteId={websiteId} myRole={myRole} />}
          <InviteModal open={inviteOpen} onClose={() => setInviteOpen(false)} websiteId={websiteId} myRole={myRole} presetRole={inviteRole} />
        </>
      )}
    </div>
  );
};
