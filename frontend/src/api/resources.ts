import { api, unwrap } from '@/lib/api';
import type {
  AdminUser,
  AnalyticsReport,
  AssignableRole,
  AuditLogEntry,
  Comment,
  DashboardStats,
  DashboardWebsite,
  DashboardWebsiteUser,
  Invitation,
  InvitationPreview,
  MemberPerformance,
  Notification,
  Paginated,
  Project,
  ProjectDetail,
  ProjectMember,
  ProjectRole,
  ProjectStatus,
  PublicUser,
  Task,
  TaskActivity,
  TaskAttachment,
  TaskDetail,
  TaskPriority,
  TaskStatus,
  TaskType,
  TeamMember,
  UserRole,
  UserStatus,
  VerifyDomainResult,
  Website,
  WebsiteDetail,
  WebsiteSettings,
  WebsiteStatus,
} from '@/types/api';

/** Drops undefined/empty values so they are not sent as query params. */
const clean = <T extends object>(params: T) =>
  Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== '' && v !== null));

export interface ListParams {
  page?: number;
  pageSize?: number;
  q?: string;
}

// ───────────── Dashboard ─────────────
export const dashboardApi = {
  stats: (websiteId?: string) => unwrap<DashboardStats>(api.get('/dashboard', { params: clean({ websiteId }) })),
  websites: () => unwrap<DashboardWebsite[]>(api.get('/dashboard/websites')),
  websiteUsers: (websiteId: string) => unwrap<DashboardWebsiteUser[]>(api.get(`/dashboard/websites/${websiteId}/users`)),
};

// ───────────── Websites ─────────────
export interface WebsiteInput {
  name: string;
  url: string;
  description?: string | null;
  logoUrl?: string | null;
  status?: WebsiteStatus;
}

export const websitesApi = {
  list: (params: ListParams & { status?: WebsiteStatus } = {}) =>
    unwrap<Paginated<Website>>(api.get('/websites', { params: clean(params) })),
  get: (id: string) => unwrap<WebsiteDetail>(api.get(`/websites/${id}`)),
  create: (body: WebsiteInput) => unwrap<WebsiteDetail>(api.post('/websites', body)),
  update: (id: string, body: Partial<WebsiteInput>) => unwrap<Website>(api.patch(`/websites/${id}`, body)),
  remove: (id: string) => api.delete(`/websites/${id}`),
  regenerateSiteId: (id: string) => unwrap<Website & { embedScript: string }>(api.post(`/websites/${id}/regenerate-site-id`)),
  verifyDomain: (id: string) => unwrap<VerifyDomainResult>(api.post(`/websites/${id}/verify-domain`)),
  settings: (id: string) => unwrap<WebsiteSettings>(api.get(`/websites/${id}/settings`)),
  updateSettings: (id: string, body: Partial<Omit<WebsiteSettings, 'id' | 'websiteId'>>) =>
    unwrap<WebsiteSettings>(api.patch(`/websites/${id}/settings`, body)),
};

// ───────────── Team ─────────────
export const teamApi = {
  members: (websiteId: string) => unwrap<TeamMember[]>(api.get(`/websites/${websiteId}/members`)),
  invite: (websiteId: string, body: { email: string; role: AssignableRole; projectIds: string[] }) =>
    unwrap<{ status: 'added' | 'invited' }>(api.post(`/websites/${websiteId}/invitations`, body)),
  invitations: (websiteId: string) => unwrap<Invitation[]>(api.get(`/websites/${websiteId}/invitations`)),
  resendInvitation: (websiteId: string, id: string) => api.post(`/websites/${websiteId}/invitations/${id}/resend`),
  revokeInvitation: (websiteId: string, id: string) => api.delete(`/websites/${websiteId}/invitations/${id}`),
  updateRole: (websiteId: string, userId: string, role: AssignableRole) =>
    api.patch(`/websites/${websiteId}/members/${userId}`, { role }),
  setProjects: (websiteId: string, userId: string, projects: { projectId: string; role?: ProjectRole }[]) =>
    api.put(`/websites/${websiteId}/members/${userId}/projects`, { projects }),
  remove: (websiteId: string, userId: string) => api.delete(`/websites/${websiteId}/members/${userId}`),
  performance: (websiteId: string) => unwrap<MemberPerformance[]>(api.get(`/websites/${websiteId}/performance`)),
  previewInvitation: (token: string) => unwrap<InvitationPreview>(api.get(`/invitations/${token}`)),
  acceptInvitation: (token: string) =>
    unwrap<{ websiteId: string; websiteName: string; role: AssignableRole }>(api.post('/invitations/accept', { token })),
};

// ───────────── Projects ─────────────
export interface ProjectInput {
  name: string;
  description?: string | null;
  status?: ProjectStatus;
  startDate?: string | null;
  dueDate?: string | null;
}

export const projectsApi = {
  list: (params: ListParams & { websiteId?: string; status?: ProjectStatus } = {}) =>
    unwrap<Paginated<Project>>(api.get('/projects', { params: clean(params) })),
  get: (id: string) => unwrap<ProjectDetail>(api.get(`/projects/${id}`)),
  create: (body: ProjectInput & { websiteId: string; memberIds?: string[] }) =>
    unwrap<Project>(api.post('/projects', clean(body))),
  update: (id: string, body: Partial<ProjectInput>) => unwrap<Project>(api.patch(`/projects/${id}`, body)),
  remove: (id: string) => api.delete(`/projects/${id}`),
  members: (id: string) => unwrap<ProjectMember[]>(api.get(`/projects/${id}/members`)),
  addMember: (id: string, userId: string, role?: ProjectRole) =>
    api.post(`/projects/${id}/members`, clean({ userId, role })),
  updateMember: (id: string, userId: string, role: ProjectRole) => api.patch(`/projects/${id}/members/${userId}`, { role }),
  removeMember: (id: string, userId: string) => api.delete(`/projects/${id}/members/${userId}`),
};

// ───────────── Tasks ─────────────
export interface TaskListParams extends ListParams {
  scope?: 'all' | 'mine' | 'created';
  websiteId?: string;
  projectId?: string;
  status?: string;
  priority?: string;
  type?: string;
  assigneeId?: string;
  overdue?: boolean;
  sort?: string;
  order?: 'asc' | 'desc';
}

export interface TaskInput {
  title: string;
  description?: string | null;
  status?: TaskStatus;
  priority?: TaskPriority;
  type?: TaskType;
  pageUrl?: string | null;
  assigneeId?: string | null;
  dueDate?: string | null;
}

export const tasksApi = {
  list: (params: TaskListParams = {}) =>
    unwrap<Paginated<Task>>(
      api.get('/tasks', { params: clean({ ...params, overdue: params.overdue ? 'true' : undefined }) }),
    ),
  get: (id: string) => unwrap<TaskDetail>(api.get(`/tasks/${id}`)),
  create: (body: TaskInput & { projectId: string }) => unwrap<Task>(api.post('/tasks', clean(body))),
  update: (id: string, body: Partial<TaskInput>) => unwrap<Task>(api.patch(`/tasks/${id}`, body)),
  remove: (id: string) => api.delete(`/tasks/${id}`),
  activity: (id: string) => unwrap<Paginated<TaskActivity>>(api.get(`/tasks/${id}/activity`)),
  comments: (id: string) =>
    unwrap<Paginated<Comment> & { lastReadAt: string | null }>(api.get(`/tasks/${id}/comments`, { params: { pageSize: 100 } })),
  addComment: (id: string, body: string, parentId?: string) =>
    unwrap<Comment>(api.post(`/tasks/${id}/comments`, clean({ body, parentId }))),
  assignees: (id: string) => unwrap<{ role: string; user: PublicUser }[]>(api.get(`/tasks/${id}/assignees`)),
  restore: (id: string) => unwrap<Task>(api.post(`/tasks/${id}/restore`)),
  markRead: (id: string) => api.post(`/tasks/${id}/read`),
  /** Raw upload (the API sniffs the real type); kind=screenshot requires an image. */
  upload: (id: string, file: Blob & { name?: string }, kind: 'screenshot' | 'file', commentId?: string) =>
    unwrap<TaskAttachment>(
      api.post(`/tasks/${id}/attachments`, file, {
        params: clean({ kind, commentId }),
        headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name ?? 'file') },
      }),
    ),
  removeAttachment: (id: string, attachmentId: string) => api.delete(`/tasks/${id}/attachments/${attachmentId}`),
};

// ───────────── Comments ─────────────
export const commentsApi = {
  list: (params: ListParams & { websiteId?: string; projectId?: string; mine?: boolean } = {}) =>
    unwrap<Paginated<Comment>>(
      api.get('/comments', { params: clean({ ...params, mine: params.mine ? 'true' : undefined }) }),
    ),
  update: (id: string, body: string) => unwrap<Comment>(api.patch(`/comments/${id}`, { body })),
  remove: (id: string) => api.delete(`/comments/${id}`),
};

// ───────────── Notifications ─────────────
export const notificationsApi = {
  list: (params: ListParams & { unreadOnly?: boolean } = {}) =>
    unwrap<Paginated<Notification>>(
      api.get('/notifications', { params: clean({ ...params, unreadOnly: params.unreadOnly ? 'true' : undefined }) }),
    ),
  unreadCount: () => unwrap<{ count: number }>(api.get('/notifications/unread-count')),
  markRead: (id: string) => api.patch(`/notifications/${id}/read`),
  markAllRead: () => api.post('/notifications/read-all'),
  remove: (id: string) => api.delete(`/notifications/${id}`),
};

// ───────────── Users (super admin) ─────────────
export const usersApi = {
  list: (params: ListParams & { role?: UserRole; status?: UserStatus } = {}) =>
    unwrap<Paginated<AdminUser>>(api.get('/users', { params: clean(params) })),
  update: (id: string, body: { role?: UserRole; status?: UserStatus }) => unwrap<AdminUser>(api.patch(`/users/${id}`, body)),
};

// ───────────── Analytics & audit (Task 5) ─────────────
export interface AnalyticsParams {
  from?: string;
  to?: string;
  interval?: 'day' | 'week' | 'month';
  websiteId?: string;
  projectId?: string;
}
export const analyticsApi = {
  report: (params: AnalyticsParams) => unwrap<AnalyticsReport>(api.get('/analytics', { params: clean(params) })),
  /** Same-origin download link (the session cookie authenticates it). */
  csvUrl: (params: AnalyticsParams) =>
    `${api.defaults.baseURL ?? ''}/analytics/tasks.csv?${new URLSearchParams(clean(params) as Record<string, string>)}`,
};

export const auditApi = {
  list: (params: ListParams & { action?: string; outcome?: string; websiteId?: string; q?: string }) =>
    unwrap<Paginated<AuditLogEntry>>(api.get('/audit-logs', { params: clean(params) })),
};
