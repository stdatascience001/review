import type {
  AssignableRole,
  ProjectRole,
  ProjectStatus,
  TaskPriority,
  TaskStatus,
  TaskType,
  WebsiteRole,
} from '@/types/api';

export type Tone = 'gray' | 'blue' | 'indigo' | 'amber' | 'green' | 'red' | 'violet' | 'teal';

export const WEBSITE_ROLE_LABEL: Record<WebsiteRole, string> = {
  OWNER: 'Owner',
  ADMIN: 'Admin',
  PROJECT_MANAGER: 'Project Manager',
  DEVELOPER: 'Developer',
  WEBSITE_USER: 'Website User',
};

export const WEBSITE_ROLE_TONE: Record<WebsiteRole, Tone> = {
  OWNER: 'violet',
  ADMIN: 'indigo',
  PROJECT_MANAGER: 'blue',
  DEVELOPER: 'teal',
  WEBSITE_USER: 'gray',
};

export const ASSIGNABLE_ROLES: { value: AssignableRole; label: string; description: string }[] = [
  { value: 'ADMIN', label: 'Admin', description: 'Manage the website, team and all projects' },
  { value: 'PROJECT_MANAGER', label: 'Project Manager', description: 'Create projects and manage their own projects' },
  { value: 'DEVELOPER', label: 'Developer', description: 'Work on tasks in assigned projects' },
  { value: 'WEBSITE_USER', label: 'Website User', description: 'Client reviewer: reports and discusses issues' },
];

export const PROJECT_ROLE_LABEL: Record<ProjectRole, string> = {
  MANAGER: 'Manager',
  CONTRIBUTOR: 'Contributor',
  REVIEWER: 'Reviewer',
  VIEWER: 'Viewer',
};

export const PROJECT_STATUS: Record<ProjectStatus, { label: string; tone: Tone }> = {
  ACTIVE: { label: 'Active', tone: 'green' },
  ON_HOLD: { label: 'On hold', tone: 'amber' },
  COMPLETED: { label: 'Completed', tone: 'blue' },
  ARCHIVED: { label: 'Archived', tone: 'gray' },
};

export const TASK_STATUS: Record<TaskStatus, { label: string; tone: Tone; color: string }> = {
  OPEN: { label: 'Open', tone: 'gray', color: '#94a3b8' },
  IN_PROGRESS: { label: 'In progress', tone: 'blue', color: '#3b82f6' },
  IN_REVIEW: { label: 'Under review', tone: 'violet', color: '#8b5cf6' },
  COMPLETED: { label: 'Completed', tone: 'green', color: '#22c55e' },
  REOPENED: { label: 'Reopened', tone: 'amber', color: '#f59e0b' },
  ARCHIVED: { label: 'Archived', tone: 'gray', color: '#cbd5e1' },
};

export const TASK_PRIORITY: Record<TaskPriority, { label: string; tone: Tone; color: string }> = {
  LOW: { label: 'Low', tone: 'gray', color: '#94a3b8' },
  MEDIUM: { label: 'Medium', tone: 'blue', color: '#3b82f6' },
  HIGH: { label: 'High', tone: 'amber', color: '#f59e0b' },
  URGENT: { label: 'Urgent', tone: 'red', color: '#ef4444' },
};

export const TASK_TYPE: Record<TaskType, string> = {
  BUG: 'Bug',
  UI_ISSUE: 'UI issue',
  FEATURE: 'Feature request',
  IMPROVEMENT: 'Improvement',
  OTHER: 'Other',
};

export const options = <K extends string>(map: Record<K, { label: string } | string>) =>
  (Object.keys(map) as K[]).map((value) => {
    const v = map[value];
    return { value, label: typeof v === 'string' ? v : v.label };
  });
