import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, CheckCheck, Laptop, MessageSquare, ShieldCheck, Trash2, UserCog } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { toast } from 'sonner';
import { authApi } from '@/api/auth';
import { commentsApi, notificationsApi, usersApi } from '@/api/resources';
import { RequireRole } from '@/components/auth/Guards';
import { TaskTable } from '@/components/tasks/TaskTable';
import { Button } from '@/components/ui/Button';
import { Avatar, Badge, EmptyState, PageHeader, Pagination, Skeleton, Table, TableSkeleton, Td, Th, UserCell } from '@/components/ui/Display';
import { FilterSelect, Input, SearchInput } from '@/components/ui/Form';
import { useConfirm } from '@/components/ui/Modal';
import { ME_KEY, useAuth } from '@/hooks/useAuth';
import { useDebounce, usePagedFilters, useWebsiteOptions } from '@/hooks/useCommon';
import { getErrorMessage } from '@/lib/api';
import { TASK_STATUS } from '@/lib/labels';
import { cn, formatDate, formatDateTime, timeAgo } from '@/lib/utils';
import type { UserRole, UserStatus } from '@/types/api';

// ───────────── Tasks ─────────────
export const AllTasksPage = () => (
  <div>
    <PageHeader title="All Tasks" description="Every task across the websites and projects you can access." />
    <TaskTable fixed={{ scope: 'all' }} />
  </div>
);

export const MyTasksPage = () => (
  <div>
    <PageHeader title="My Tasks" description="Tasks assigned to you." />
    <TaskTable fixed={{ scope: 'mine' }} emptyTitle="Nothing assigned to you" />
  </div>
);

// ───────────── Users (super admin) ─────────────
const UsersTable = () => {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { user: me } = useAuth();
  const { filters, update, page, setPage } = usePagedFilters({ q: '', role: '', status: '' });
  const q = useDebounce(filters.q);
  const { data, isLoading } = useQuery({
    queryKey: ['users', { ...filters, q, page }],
    queryFn: () =>
      usersApi.list({ q, role: (filters.role || undefined) as UserRole, status: (filters.status || undefined) as UserStatus, page, pageSize: 15 }),
    placeholderData: keepPreviousData,
  });
  const mutation = useMutation({
    mutationFn: ({ id, body }: { id: string; body: { role?: UserRole; status?: UserStatus } }) => usersApi.update(id, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['users'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
      toast.success('User updated');
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  });

  return (
    <div className="card">
      <div className="flex flex-col gap-3 border-b border-slate-100 p-4 sm:flex-row">
        <SearchInput value={filters.q} onChange={(v) => update({ q: v })} placeholder="Search name or email…" className="sm:w-72" />
        <FilterSelect value={filters.role} onChange={(v) => update({ role: v })} placeholder="All platform roles" options={[{ value: 'USER', label: 'User' }, { value: 'SUPER_ADMIN', label: 'Super Admin' }]} />
        <FilterSelect value={filters.status} onChange={(v) => update({ status: v })} placeholder="All statuses" options={[{ value: 'ACTIVE', label: 'Active' }, { value: 'SUSPENDED', label: 'Suspended' }]} />
      </div>
      {isLoading ? (
        <TableSkeleton cols={6} />
      ) : !data?.items.length ? (
        <EmptyState icon={UserCog} title="No users found" />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>User</Th>
              <Th>Platform role</Th>
              <Th>Status</Th>
              <Th>Websites</Th>
              <Th>Last login</Th>
              <Th>Joined</Th>
              <Th className="text-right">Actions</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {data.items.map((u) => {
              const self = u.id === me?.id;
              return (
                <tr key={u.id} data-testid="user-row">
                  <Td>
                    <UserCell user={u} />
                    {!u.emailVerifiedAt && <Badge tone="amber" className="mt-1">Unverified</Badge>}
                  </Td>
                  <Td>
                    <select
                      className="input w-auto py-1 text-xs"
                      aria-label={`Platform role for ${u.name}`}
                      disabled={self}
                      value={u.role}
                      onChange={async (e) => {
                        const role = e.target.value as UserRole;
                        if (await confirm({ title: 'Change platform role?', message: `${u.name} will become ${role === 'SUPER_ADMIN' ? 'a Super Admin with access to every website' : 'a regular user'}.`, confirmLabel: 'Change role', danger: role === 'SUPER_ADMIN' }))
                          mutation.mutate({ id: u.id, body: { role } });
                      }}
                    >
                      <option value="USER">User</option>
                      <option value="SUPER_ADMIN">Super Admin</option>
                    </select>
                  </Td>
                  <Td><Badge tone={u.status === 'ACTIVE' ? 'green' : 'red'} dot>{u.status === 'ACTIVE' ? 'Active' : 'Suspended'}</Badge></Td>
                  <Td className="tabular-nums">{u._count.websiteMemberships}</Td>
                  <Td className="text-xs text-slate-500">{u.lastLoginAt ? timeAgo(u.lastLoginAt) : 'Never'}</Td>
                  <Td className="text-xs text-slate-500">{formatDate(u.createdAt)}</Td>
                  <Td className="text-right">
                    {!self && (
                      <Button
                        variant={u.status === 'ACTIVE' ? 'ghost' : 'outline'}
                        size="sm"
                        className={u.status === 'ACTIVE' ? 'text-red-600 hover:bg-red-50' : ''}
                        onClick={async () => {
                          const suspend = u.status === 'ACTIVE';
                          if (await confirm({ title: suspend ? 'Suspend user?' : 'Reactivate user?', message: suspend ? `${u.name} will be signed out everywhere and cannot sign in.` : `${u.name} will be able to sign in again.`, confirmLabel: suspend ? 'Suspend' : 'Reactivate', danger: suspend }))
                            mutation.mutate({ id: u.id, body: { status: suspend ? 'SUSPENDED' : 'ACTIVE' } });
                        }}
                      >
                        {u.status === 'ACTIVE' ? 'Suspend' : 'Reactivate'}
                      </Button>
                    )}
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}
      {data && <Pagination {...data.pagination} onPageChange={setPage} />}
    </div>
  );
};

export const UsersPage = () => (
  <div>
    <PageHeader title="Users" description="All registered users on the platform (Super Admin only)." />
    <RequireRole roles={['SUPER_ADMIN']}>
      <UsersTable />
    </RequireRole>
  </div>
);

// ───────────── Comments ─────────────
export const CommentsPage = () => {
  const navigate = useNavigate();
  const websites = useWebsiteOptions();
  const { filters, update, page, setPage } = usePagedFilters({ q: '', websiteId: '', mine: false });
  const q = useDebounce(filters.q);
  const { data, isLoading } = useQuery({
    queryKey: ['comments', { ...filters, q, page }],
    queryFn: () => commentsApi.list({ q, websiteId: filters.websiteId || undefined, mine: filters.mine, page, pageSize: 20 }),
    placeholderData: keepPreviousData,
  });

  return (
    <div>
      <PageHeader title="Comments" description="Latest discussion across all tasks you can access." />
      <div className="card">
        <div className="flex flex-col gap-3 border-b border-slate-100 p-4 sm:flex-row sm:items-center">
          <SearchInput value={filters.q} onChange={(v) => update({ q: v })} placeholder="Search comments…" className="sm:w-72" />
          <FilterSelect value={filters.websiteId} onChange={(v) => update({ websiteId: v })} placeholder="All websites" options={(websites.data ?? []).map((w) => ({ value: w.id, label: w.name }))} />
          <label className="flex items-center gap-2 text-sm text-slate-600">
            <input type="checkbox" className="rounded border-slate-300" checked={filters.mine} onChange={(e) => update({ mine: e.target.checked })} /> Only mine
          </label>
        </div>
        {isLoading ? (
          <div className="space-y-4 p-5">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-14" />)}</div>
        ) : !data?.items.length ? (
          <EmptyState icon={MessageSquare} title="No comments found" description="Comments on tasks will appear here." />
        ) : (
          <ul className="divide-y divide-slate-100" data-testid="comments-feed">
            {data.items.map((c) => (
              <li key={c.id}>
                <button type="button" onClick={() => navigate(`/tasks?task=${c.task!.id}`)} className="flex w-full gap-3 px-5 py-4 text-left hover:bg-slate-50">
                  <Avatar user={c.author} size="sm" />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 text-xs text-slate-500">
                      <span className="font-medium text-slate-800">{c.author?.name ?? 'Deleted user'}</span>
                      <span>on</span>
                      <span className="font-medium text-brand-700">{c.task!.title}</span>
                      <Badge tone={TASK_STATUS[c.task!.status].tone}>{TASK_STATUS[c.task!.status].label}</Badge>
                      <span className="ml-auto">{timeAgo(c.createdAt)}</span>
                    </div>
                    <p className="mt-1 line-clamp-2 whitespace-pre-wrap text-sm text-slate-700">{c.body}</p>
                    <p className="mt-1 text-xs text-slate-400">{c.task!.website.name} · {c.task!.project.name}</p>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
        {data && <Pagination {...data.pagination} onPageChange={setPage} />}
      </div>
    </div>
  );
};

// ───────────── Notifications ─────────────
export const NotificationsPage = () => {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [page, setPage] = useState(1);
  const { data, isLoading } = useQuery({
    queryKey: ['notifications', 'list', { unreadOnly, page }],
    queryFn: () => notificationsApi.list({ unreadOnly, page, pageSize: 20 }),
    placeholderData: keepPreviousData,
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['notifications'] });
  const markRead = useMutation({ mutationFn: notificationsApi.markRead, onSuccess: refresh });
  const markAll = useMutation({
    mutationFn: notificationsApi.markAllRead,
    onSuccess: () => { refresh(); toast.success('All notifications marked as read'); },
  });
  const remove = useMutation({ mutationFn: notificationsApi.remove, onSuccess: () => { refresh(); toast.success('Notification deleted'); } });

  return (
    <div>
      <PageHeader
        title="Notifications"
        actions={<Button variant="secondary" icon={<CheckCheck className="h-4 w-4" />} loading={markAll.isPending} onClick={() => markAll.mutate()}>Mark all as read</Button>}
      />
      <div className="card">
        <div className="flex gap-2 border-b border-slate-100 p-3">
          {[false, true].map((u) => (
            <button
              key={String(u)}
              type="button"
              onClick={() => { setUnreadOnly(u); setPage(1); }}
              className={cn('rounded-lg px-3 py-1.5 text-sm font-medium', unreadOnly === u ? 'bg-brand-50 text-brand-700' : 'text-slate-500 hover:bg-slate-50')}
            >
              {u ? 'Unread' : 'All'}
            </button>
          ))}
        </div>
        {isLoading ? (
          <div className="space-y-3 p-5">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-12" />)}</div>
        ) : !data?.items.length ? (
          <EmptyState icon={Bell} title={unreadOnly ? "You're all caught up" : 'No notifications yet'} />
        ) : (
          <ul className="divide-y divide-slate-100" data-testid="notification-list">
            {data.items.map((n) => (
              <li key={n.id} className={cn('flex items-start gap-3 px-5 py-4', !n.readAt && 'bg-brand-50/40')}>
                <Avatar user={n.actor} size="sm" />
                <button
                  type="button"
                  className="min-w-0 flex-1 text-left"
                  onClick={() => {
                    if (!n.readAt) markRead.mutate(n.id);
                    if (n.taskId) navigate(`/tasks?task=${n.taskId}`);
                    else if (n.websiteId) navigate(`/websites/${n.websiteId}`);
                  }}
                >
                  <p className={cn('text-sm', !n.readAt ? 'font-semibold text-slate-900' : 'text-slate-700')}>{n.title}</p>
                  {n.body && <p className="mt-0.5 line-clamp-2 text-sm text-slate-500">{n.body}</p>}
                  <p className="mt-1 text-xs text-slate-400">{timeAgo(n.createdAt)}</p>
                </button>
                {!n.readAt && (
                  <Button variant="ghost" size="sm" onClick={() => markRead.mutate(n.id)}>Mark read</Button>
                )}
                <button type="button" aria-label="Delete notification" className="rounded p-1 text-slate-400 hover:text-red-600" onClick={() => remove.mutate(n.id)}>
                  <Trash2 className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>
        )}
        {data && <Pagination {...data.pagination} onPageChange={setPage} />}
      </div>
    </div>
  );
};

// ───────────── Settings (profile, password, sessions) ─────────────
export const SettingsPage = () => {
  const { user, setUser, logout } = useAuth();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const [profile, setProfile] = useState({ name: '', avatarUrl: '' });
  const [pw, setPw] = useState({ currentPassword: '', newPassword: '', confirm: '' });
  useEffect(() => setProfile({ name: user?.name ?? '', avatarUrl: user?.avatarUrl ?? '' }), [user]);

  const saveProfile = useMutation({
    mutationFn: () => authApi.updateMe({ name: profile.name, avatarUrl: profile.avatarUrl.trim() || null }),
    onSuccess: (u) => { setUser(u); toast.success('Profile updated'); },
    onError: (err) => toast.error(getErrorMessage(err)),
  });
  const changePw = useMutation({
    mutationFn: () => authApi.changePassword({ currentPassword: pw.currentPassword || undefined, newPassword: pw.newPassword }),
    onSuccess: () => {
      setPw({ currentPassword: '', newPassword: '', confirm: '' });
      qc.invalidateQueries({ queryKey: ['sessions'] });
      qc.invalidateQueries({ queryKey: ME_KEY });
      toast.success('Password updated. Other sessions were signed out.');
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  });
  const sessions = useQuery({ queryKey: ['sessions'], queryFn: authApi.sessions });
  const revoke = useMutation({
    mutationFn: authApi.revokeSession,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['sessions'] }); toast.success('Session signed out'); },
  });

  if (!user) return null;
  return (
    <div>
      <PageHeader title="Settings" description="Manage your profile, password and active sessions." />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <section className="card p-5">
          <h2 className="mb-4 font-semibold">Profile</h2>
          <div className="mb-5 flex items-center gap-4">
            <Avatar user={{ name: profile.name || user.name, avatarUrl: profile.avatarUrl.startsWith('https://') ? profile.avatarUrl : null }} size="lg" />
            <div className="text-sm">
              <p className="font-medium">{user.email}</p>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {user.role === 'SUPER_ADMIN' && <Badge tone="violet">Super Admin</Badge>}
                {user.googleLinked && <Badge tone="blue">Google linked</Badge>}
                <Badge tone="green"><ShieldCheck className="h-3 w-3" /> Email verified</Badge>
              </div>
            </div>
          </div>
          <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); saveProfile.mutate(); }}>
            <Input label="Full name" required value={profile.name} onChange={(e) => setProfile({ ...profile, name: e.target.value })} />
            <Input label="Avatar URL" type="url" placeholder="https://…" value={profile.avatarUrl} onChange={(e) => setProfile({ ...profile, avatarUrl: e.target.value })} hint="https:// image URL" />
            <Button type="submit" loading={saveProfile.isPending}>Save profile</Button>
          </form>
        </section>

        <section className="card p-5">
          <h2 className="mb-4 font-semibold">{user.hasPassword ? 'Change password' : 'Set a password'}</h2>
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (pw.newPassword !== pw.confirm) return toast.error('Passwords do not match');
              changePw.mutate();
            }}
          >
            {user.hasPassword && (
              <Input label="Current password" type="password" autoComplete="current-password" required value={pw.currentPassword} onChange={(e) => setPw({ ...pw, currentPassword: e.target.value })} />
            )}
            <Input label="New password" type="password" autoComplete="new-password" required hint="At least 8 characters, including a letter and a number" value={pw.newPassword} onChange={(e) => setPw({ ...pw, newPassword: e.target.value })} />
            <Input label="Confirm new password" type="password" autoComplete="new-password" required value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} />
            <Button type="submit" loading={changePw.isPending}>Update password</Button>
          </form>
        </section>

        <section className="card lg:col-span-2">
          <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
            <h2 className="font-semibold">Active sessions</h2>
            <Button
              variant="ghost"
              size="sm"
              className="text-red-600 hover:bg-red-50"
              onClick={async () => {
                if (await confirm({ title: 'Sign out everywhere?', message: 'All sessions, including this one, will be signed out.', confirmLabel: 'Sign out everywhere', danger: true })) {
                  await authApi.logoutAll();
                  await logout();
                  navigate('/login', { replace: true });
                }
              }}
            >
              Sign out everywhere
            </Button>
          </div>
          {sessions.isLoading ? (
            <TableSkeleton rows={2} cols={4} />
          ) : (
            <Table>
              <thead>
                <tr><Th>Device</Th><Th>Method</Th><Th>IP address</Th><Th>Last active</Th><Th /></tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {sessions.data?.map((s) => (
                  <tr key={s.id} data-testid="session-row">
                    <Td>
                      <div className="flex items-center gap-2">
                        <Laptop className="h-4 w-4 text-slate-400" />
                        <span className="max-w-sm truncate text-xs">{s.userAgent ?? 'Unknown device'}</span>
                        {s.current && <Badge tone="green">This device</Badge>}
                      </div>
                    </Td>
                    <Td className="text-xs capitalize">{s.authMethod}</Td>
                    <Td className="font-mono text-xs">{s.ipAddress ?? '—'}</Td>
                    <Td className="text-xs text-slate-500">{formatDateTime(s.lastUsedAt)}</Td>
                    <Td className="text-right">
                      {!s.current && <Button variant="ghost" size="sm" onClick={() => revoke.mutate(s.id)}>Sign out</Button>}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </section>
      </div>
      <p className="mt-6 text-sm text-slate-500">
        Website-specific settings (allowed domains, task defaults) are on each <Link to="/websites" className="text-brand-700 hover:underline">website's settings tab</Link>.
      </p>
    </div>
  );
};
