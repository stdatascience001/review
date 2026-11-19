import { TaskActivityType, TaskStatus } from '@prisma/client';

/**
 * Task workflow (single source of truth for every module):
 *
 *   OPEN ──start──▶ IN_PROGRESS ──▶ IN_REVIEW ("Under review") ──complete──▶ COMPLETED
 *     ▲                                                                       │
 *     └───────────── REOPENED ◀──────────────reopen──────────────────────────┘
 *   Any status ──archive──▶ ARCHIVED ──restore──▶ the status it had before
 */

/** Waiting to be picked up ("Open" tab, open-task badge). */
export const OPEN_STATUSES: TaskStatus[] = [TaskStatus.OPEN, TaskStatus.REOPENED];
/** Being worked on. */
export const ACTIVE_STATUSES: TaskStatus[] = [TaskStatus.IN_PROGRESS, TaskStatus.IN_REVIEW];
export const DONE_STATUSES: TaskStatus[] = [TaskStatus.COMPLETED];
/** No longer needs work: excluded from overdue counts and "open" workloads. */
export const CLOSED_STATUSES: TaskStatus[] = [TaskStatus.COMPLETED, TaskStatus.ARCHIVED];

/** Which activity a status change is recorded as. */
export const activityForTransition = (from: TaskStatus, to: TaskStatus): TaskActivityType => {
  if (to === TaskStatus.ARCHIVED) return TaskActivityType.ARCHIVED;
  if (from === TaskStatus.ARCHIVED) return TaskActivityType.RESTORED;
  if (to === TaskStatus.COMPLETED) return TaskActivityType.COMPLETED;
  if (to === TaskStatus.REOPENED) return TaskActivityType.REOPENED;
  if (to === TaskStatus.IN_PROGRESS && OPEN_STATUSES.includes(from)) return TaskActivityType.STARTED;
  return TaskActivityType.STATUS_CHANGED;
};

/** REOPENED only makes sense for work that was finished (or archived). */
export const isValidTransition = (from: TaskStatus, to: TaskStatus) =>
  to !== TaskStatus.REOPENED || from === TaskStatus.COMPLETED || from === TaskStatus.ARCHIVED;
