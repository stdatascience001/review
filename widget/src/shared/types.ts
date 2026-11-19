import type { WidgetApi } from './api';

export interface WidgetConfig {
  site: { siteId: string; name: string; logoUrl: string | null; brandColor: string | null };
  auth: { password: boolean; registration: boolean; google: boolean };
}

export interface User {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
}

export interface SelfUser extends User {
  emailVerified: boolean;
}

export interface Counts {
  all: number;
  open: number;
  in_progress: number;
  done: number;
  archived: number;
}

export interface Me {
  user: SelfUser;
  access: {
    role: 'OWNER' | 'ADMIN' | 'PROJECT_MANAGER' | 'DEVELOPER' | 'WEBSITE_USER';
    canCreate: boolean;
    projects: { id: string; name: string }[];
    defaultProjectId: string | null;
  } | null;
  counts: Counts | null;
}

/** The page element a comment is about (mirrors backend widget.schemas elementAnchor). */
export interface ElementAnchor {
  selector: string;
  tag: string;
  text?: string;
  /** Position in the document when it was picked. */
  rect?: { x: number; y: number; width: number; height: number };
  viewportWidth?: number;
}

export type TaskStatus = 'OPEN' | 'IN_PROGRESS' | 'IN_REVIEW' | 'COMPLETED' | 'REOPENED' | 'ARCHIVED';
export type TaskType = 'BUG' | 'UI_ISSUE' | 'FEATURE' | 'IMPROVEMENT' | 'OTHER';
export type TaskPriority = 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';

export interface Attachment {
  id: string;
  kind: 'SCREENSHOT' | 'FILE';
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  url: string;
  commentId: string | null;
  createdAt: string;
  uploader: User | null;
}

export interface TaskPermissions {
  /** Workflow: status, priority, assignee, archive (admins + developers). */
  manage: boolean;
  /** Edit title/description (reporter: own task). */
  update: boolean;
  comment: boolean;
  /** Add screenshots/files to the task. */
  upload: boolean;
  archive: boolean;
}

export interface Task {
  id: string;
  number: number;
  /** Task ID shown to people, e.g. "TASK-42". */
  key: string;
  projectId: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  type: TaskType;
  priority: TaskPriority;
  pageUrl: string | null;
  pageTitle: string | null;
  /** Element the comment points at; null for whole-page comments and older tasks. */
  element: ElementAnchor | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  archivedAt: string | null;
  creator: User | null;
  assignee: User | null;
  project: { id: string; name: string };
  screenshotUrl: string | null;
  commentCount: number;
  attachmentCount: number;
  /** Comments by others since the user last opened the task. */
  unreadCount: number;
  permissions: TaskPermissions;
}

export interface TaskDetail extends Task {
  dueDate: string | null;
  attachments: Attachment[];
}

export interface Activity {
  id: string;
  type: string;
  field: string | null;
  previousValue: string | null;
  newValue: string | null;
  changes: Record<string, unknown> | null;
  createdAt: string;
  actor: User | null;
}

export interface TaskPage {
  items: Task[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
  counts: Counts;
}

export interface Comment {
  id: string;
  parentId: string | null;
  body: string;
  createdAt: string;
  editedAt: string | null;
  author: User | null;
  attachments: Attachment[];
  /** Posted by someone else since the user last opened the task. */
  isNew: boolean;
}

export interface PageInfo {
  url: string;
  title: string;
}

/** What the loader hands to the lazily loaded panel. */
export interface MountContext {
  shadow: ShadowRoot;
  host: HTMLElement;
  api: WidgetApi;
  config: WidgetConfig;
  /** /me result already fetched by the loader (null when signed out). */
  me: Me | null;
  getPage: () => PageInfo;
  onPageChange: (fn: (page: PageInfo) => void) => () => void;
  isOpen: () => boolean;
  onOpenChange: (fn: (open: boolean) => void) => () => void;
  setOpen: (open: boolean) => void;
  setBadge: (count: number | null) => void;
  /** Short live notification above the Review button (ignored while the popup is open). */
  notify: (text: string) => void;
}

/** Real-time event (mirrors backend/src/lib/realtime.ts TaskEventPayload). */
export interface LiveEvent {
  id: string;
  type: string;
  message: string;
  personal: boolean;
  task: { id: string; key: string; title: string; status: TaskStatus; websiteId: string; assigneeId: string | null; creatorId: string | null };
  actor: { id: string; name: string } | null;
  at: string;
}

export interface MountedWidget {
  unmount: () => void;
}
