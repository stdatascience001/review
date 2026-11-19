// Types mirroring the backend API responses.

export type UserRole = 'USER' | 'SUPER_ADMIN';
export type UserStatus = 'ACTIVE' | 'SUSPENDED';
export type WebsiteRole = 'OWNER' | 'ADMIN' | 'PROJECT_MANAGER' | 'DEVELOPER' | 'WEBSITE_USER';
export type AssignableRole = Exclude<WebsiteRole, 'OWNER'>;
export type WebsiteStatus = 'ACTIVE' | 'INACTIVE';
export type ProjectRole = 'MANAGER' | 'CONTRIBUTOR' | 'REVIEWER' | 'VIEWER';
export type ProjectStatus = 'ACTIVE' | 'ON_HOLD' | 'COMPLETED' | 'ARCHIVED';
export type TaskStatus = 'OPEN' | 'IN_PROGRESS' | 'IN_REVIEW' | 'COMPLETED' | 'REOPENED' | 'ARCHIVED';
export type TaskPriority = 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';
export type TaskType = 'BUG' | 'UI_ISSUE' | 'FEATURE' | 'IMPROVEMENT' | 'OTHER';

export interface Paginated<T> {
  items: T[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
}

export interface PublicUser {
  id: string;
  name: string;
  email: string;
  avatarUrl: string | null;
}

export interface Me extends PublicUser {
  role: UserRole;
  status: UserStatus;
  emailVerified: boolean;
  emailVerifiedAt: string | null;
  hasPassword: boolean;
  googleLinked: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

export interface Session {
  id: string;
  userAgent: string | null;
  ipAddress: string | null;
  authMethod: string;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
  current: boolean;
}

export interface Website {
  id: string;
  name: string;
  slug: string;
  url: string;
  description: string | null;
  logoUrl: string | null;
  status: WebsiteStatus;
  siteId: string;
  domainVerifiedAt: string | null;
  ownerId: string;
  createdAt: string;
  updatedAt: string;
  role: WebsiteRole | null;
  _count?: { members: number; projects: number; tasks: number };
}

export interface WebsiteSettings {
  id: string;
  websiteId: string;
  timezone: string;
  defaultTaskPriority: TaskPriority;
  clientsCanCreateTasks: boolean;
  emailNotifications: boolean;
  allowedDomains: string[];
  brandColor: string | null;
  widgetEnabled: boolean;
  widgetProjectId: string | null;
  widgetAutoJoin: boolean;
}

export interface WebsiteDetail extends Website {
  embedScript: string;
  settings: WebsiteSettings | null;
  verification: { metaTag: string; token: string } | null;
}

export interface VerifyDomainResult {
  verified: boolean;
  method: 'meta_tag' | 'embed_script' | null;
  checkedUrl: string;
  error: string | null;
  domainVerifiedAt: string | null;
}

export interface TeamMember {
  id: string;
  role: WebsiteRole;
  createdAt: string;
  user: PublicUser & { status: UserStatus; lastLoginAt: string | null };
  projects: { id: string; name: string; role: ProjectRole }[];
}

export interface Invitation {
  id: string;
  email: string;
  role: AssignableRole;
  projectIds: string[];
  expiresAt: string;
  createdAt: string;
  invitedBy: PublicUser | null;
}

export interface InvitationPreview {
  email: string;
  role: AssignableRole;
  website: { id: string; name: string; logoUrl: string | null };
  invitedBy: string | null;
  expiresAt: string;
  accountExists: boolean;
}

export interface MemberPerformance {
  user: PublicUser;
  role: WebsiteRole;
  assigned: number;
  open: number;
  inProgress: number;
  completed: number;
  overdue: number;
  completedLast30Days: number;
  completionRate: number;
  avgResolutionHours: number | null;
}

export interface Progress {
  total: number;
  completed: number;
  percent: number;
}

export interface Project {
  id: string;
  websiteId: string;
  name: string;
  description: string | null;
  status: ProjectStatus;
  startDate: string | null;
  dueDate: string | null;
  createdAt: string;
  updatedAt: string;
  website?: { id: string; name: string; logoUrl: string | null };
  members?: { role: ProjectRole; user: PublicUser }[];
  _count?: { tasks: number; members: number };
  progress?: Progress;
}

export interface ProjectDetail extends Project {
  role: ProjectRole;
  websiteRole: WebsiteRole;
  website: { id: string; name: string; logoUrl: string | null };
  overdueTasks: number;
  progress: Progress;
  taskCountsByStatus: Partial<Record<TaskStatus, number>>;
}

export interface ProjectMember {
  id: string;
  role: ProjectRole;
  createdAt: string;
  user: PublicUser;
}

export interface Task {
  id: string;
  /** Sequential Task ID number; `key` is its display form ("TASK-42"). */
  number: number;
  key: string;
  /** Comments by others since the current user last opened the task. */
  unreadCount: number;
  websiteId: string;
  projectId: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  type: TaskType;
  pageUrl: string | null;
  metadata: Record<string, unknown> | null;
  dueDate: string | null;
  completedAt: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  creator: PublicUser | null;
  assignee: PublicUser | null;
  project: { id: string; name: string };
  website: { id: string; name: string };
  _count: { comments: number; attachments: number };
}

export interface TaskAttachment {
  id: string;
  kind: 'SCREENSHOT' | 'FILE';
  commentId: string | null;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  /** Signed, expiring URL. */
  url: string;
  createdAt: string;
  uploader: PublicUser | null;
}

export interface TaskDetail extends Task {
  attachments: TaskAttachment[];
  /** update = edit content; manage = workflow (status, priority, assignee, archive); upload = add files. */
  permissions: { update: boolean; manage: boolean; delete: boolean; comment: boolean; upload: boolean };
}

export interface Comment {
  id: string;
  taskId: string;
  parentId: string | null;
  body: string;
  editedAt: string | null;
  createdAt: string;
  author: PublicUser | null;
  attachments?: TaskAttachment[];
  /** Posted by someone else since the user last opened the task. */
  isNew?: boolean;
  task?: { id: string; number?: number; title: string; status: TaskStatus; project: { id: string; name: string }; website: { id: string; name: string } };
}

export interface TaskActivity {
  id: string;
  type: string;
  field?: string | null;
  previousValue?: string | null;
  newValue?: string | null;
  changes: Record<string, unknown> | null;
  createdAt: string;
  actor: PublicUser | null;
  task?: { id: string; title: string; project: { id: string; name: string } };
}

export interface Notification {
  id: string;
  type: string;
  title: string;
  body: string | null;
  data: Record<string, unknown> | null;
  taskId: string | null;
  websiteId: string | null;
  readAt: string | null;
  createdAt: string;
  actor: PublicUser | null;
}

export interface AdminUser {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  role: UserRole;
  status: UserStatus;
  emailVerifiedAt: string | null;
  lastLoginAt: string | null;
  createdAt: string;
  _count: { websiteMemberships: number };
}

/** Dashboard → Projects: a website the user can open, with live counts. */
export interface DashboardWebsite {
  id: string;
  name: string;
  url: string;
  status: WebsiteStatus;
  createdAt: string;
  role: WebsiteRole;
  member: boolean;
  /** null for Website Users (other people stay private) */
  users: number | null;
  projects: number;
  tasks: { total: number; open: number; inProgress: number; completed: number };
}

export interface DashboardWebsiteUser {
  user: PublicUser & { status: UserStatus; lastLoginAt: string | null };
  role: WebsiteRole;
  joinedAt: string;
  projects: { id: string; name: string; role: ProjectRole }[];
  tasks: { reported: number; open: number; assignedOpen: number };
}

export interface DashboardStats {
  scope: 'platform' | 'workspace' | 'website';
  totals: {
    websites: number;
    activeWebsites: number;
    projects: number;
    users: number;
    tasks: number;
    openTasks: number;
    inProgressTasks: number;
    completedTasks: number;
    overdueTasks: number;
    myOpenTasks: number;
  };
  tasksByStatus: { status: TaskStatus; count: number }[];
  openTasksByPriority: { priority: TaskPriority; count: number }[];
  completionRate: number;
  trend: { date: string; created: number; completed: number }[];
  recentActivity: TaskActivity[];
}

// ───────────── Task 5: analytics & audit ─────────────
export interface AnalyticsReport {
  range: { from: string; to: string; interval: 'day' | 'week' | 'month' };
  scope: { websites: number; websiteId: string | null; projectId: string | null };
  totals: {
    websites: number;
    projects: number;
    users: number;
    tasks: number;
    openTasks: number;
    inProgressTasks: number;
    completedTasks: number;
    archivedTasks: number;
    overdueTasks: number;
    createdInRange: number;
    completedInRange: number;
    reopenedInRange: number;
    avgResolutionHours: number | null;
  };
  timeline: { date: string; created: number; completed: number }[];
  byWebsite: {
    website: { id: string; name: string };
    total: number;
    open: number;
    inProgress: number;
    completed: number;
    archived: number;
    overdue: number;
    createdInRange: number;
    completedInRange: number;
    completionRate: number;
    avgResolutionHours: number | null;
  }[];
  byDeveloper: {
    user: PublicUser;
    assigned: number;
    open: number;
    inProgress: number;
    completed: number;
    completedInRange: number;
    overdue: number;
    completionRate: number;
    avgResolutionHours: number | null;
  }[];
  byType: { type: TaskType; count: number }[];
  byPriority: { priority: TaskPriority; count: number }[];
  byStatus: { status: TaskStatus; count: number }[];
}

export interface AuditLogEntry {
  id: string;
  action: string;
  outcome: 'success' | 'failure' | 'denied';
  actorId: string | null;
  actorEmail: string | null;
  websiteId: string | null;
  targetType: string | null;
  targetId: string | null;
  statusCode: number | null;
  ipAddress: string | null;
  userAgent: string | null;
  requestId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}
