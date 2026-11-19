import crypto from 'node:crypto';
import type { Server as HttpServer } from 'node:http';
import { WebsiteRole } from '@prisma/client';
import { parse as parseCookies } from 'cookie';
import { Server, type Socket } from 'socket.io';
import { env } from '../config/env';
import { authContextFromToken } from '../middleware/authenticate';
import { ACCESS_COOKIE } from './cookies';
import { logger } from './logger';
import { prisma } from './prisma';

/**
 * Real-time task events over Socket.IO.
 *
 *  - Namespace "/"        → admin dashboard. Authenticated with the HTTP-only access cookie
 *                           (same session checks as the REST API); origin must be a dashboard origin.
 *  - Namespace "/widget"  → review widget. Authenticated with the site-bound widget token;
 *                           origin must be an allowed domain of that website.
 *
 * Authorization: every event is computed for one task and sent only to users who can see
 * that task (website owners/admins, members of the task's project, platform super admins),
 * each in their own room. Widget sockets only get events of the website they're bound to.
 */

export type TaskEventType =
  | 'task.created'
  | 'task.assigned'
  | 'task.started'
  | 'task.status_updated'
  | 'task.completed'
  | 'task.reopened'
  | 'task.updated'
  | 'task.deleted'
  | 'comment.created'
  | 'comment.reply';

export interface TaskEventPayload {
  id: string;
  type: TaskEventType;
  message: string;
  /** True for the people the event is about (reporter, assignee, replied-to author). */
  personal: boolean;
  task: {
    id: string;
    key: string;
    title: string;
    status: string;
    priority: string;
    websiteId: string;
    projectId: string;
    assigneeId: string | null;
    creatorId: string | null;
  };
  actor: { id: string; name: string } | null;
  commentId?: string;
  at: string;
}

let io: Server | null = null;
export const realtimeEnabled = () => io !== null;

const userRoom = (userId: string) => `user:${userId}`;
const widgetRoom = (websiteId: string, userId: string) => `wsite:${websiteId}:user:${userId}`;
const sessionRoom = (sessionId: string) => `session:${sessionId}`;

const dashboardOriginAllowed = (origin: string | undefined) =>
  !origin || [...env.corsOrigins, new URL(env.API_URL).origin].includes(origin.replace(/\/$/, ''));

export const initRealtime = (server: HttpServer) => {
  io = new Server(server, {
    path: '/socket.io',
    // Engine-level CORS is open (the widget runs on customer domains); each namespace below
    // enforces its own origin policy and authentication.
    cors: { origin: (_origin, cb) => cb(null, true), credentials: true },
    serveClient: false,
    pingInterval: 25_000,
    pingTimeout: 20_000,
  });

  io.use(async (socket, next) => {
    try {
      if (!dashboardOriginAllowed(socket.handshake.headers.origin)) throw new Error('ORIGIN_NOT_ALLOWED');
      const cookies = parseCookies(socket.handshake.headers.cookie ?? '');
      const auth = await authContextFromToken(cookies[ACCESS_COOKIE] ?? (socket.handshake.auth?.token as string | undefined));
      if (env.REQUIRE_EMAIL_VERIFICATION && !auth.emailVerified) throw new Error('EMAIL_NOT_VERIFIED');
      socket.data.userId = auth.userId;
      await socket.join([userRoom(auth.userId), sessionRoom(auth.sessionId)]);
      next();
    } catch (err) {
      next(new Error((err as { code?: string }).code ?? (err as Error).message ?? 'UNAUTHORIZED'));
    }
  });

  io.of('/widget').use(async (socket, next) => {
    try {
      // Imported lazily: the widget module depends on services that import this file.
      const { widgetAuthFromToken } = await import('../modules/widget/widget.auth');
      const { auth, site } = await widgetAuthFromToken(socket.handshake.auth?.token as string | undefined, socket.handshake.headers.origin);
      if (env.REQUIRE_EMAIL_VERIFICATION && !auth.emailVerified) throw new Error('EMAIL_NOT_VERIFIED');
      socket.data.userId = auth.userId;
      socket.data.websiteId = site.id;
      await socket.join([widgetRoom(site.id, auth.userId), sessionRoom(auth.sessionId)]);
      next();
    } catch (err) {
      next(new Error((err as { code?: string }).code ?? (err as Error).message ?? 'UNAUTHORIZED'));
    }
  });

  const onConnect = (socket: Socket) => socket.emit('ready', { userId: socket.data.userId });
  io.on('connection', onConnect);
  io.of('/widget').on('connection', onConnect);
  logger.info('real-time (Socket.IO) enabled at /socket.io');
  return io;
};

export const closeRealtime = async () => {
  if (!io) return;
  await new Promise<void>((resolve) => io!.close(() => resolve()));
  io = null;
};

/** Ends live connections when a session is revoked (logout, password reset, suspension). */
export const disconnectSession = (sessionId: string) => {
  if (!io) return;
  io.in(sessionRoom(sessionId)).disconnectSockets(true);
  io.of('/widget').in(sessionRoom(sessionId)).disconnectSockets(true);
};
export const disconnectUser = (userId: string) => {
  if (!io) return;
  io.in(userRoom(userId)).disconnectSockets(true);
  // widget rooms are per website; find this user's widget sockets
  for (const [, s] of io.of('/widget').sockets) if (s.data.userId === userId) s.disconnect(true);
};

// ───────────────────────────── Publishing ─────────────────────────────

/** Everyone who can see this task (Website Users only for their own tasks). */
const recipientsOf = async (websiteId: string, projectId: string, creatorId: string | null): Promise<string[]> => {
  const [managers, members, reporters, superAdmins] = await Promise.all([
    prisma.websiteMember.findMany({
      where: { websiteId, role: { in: [WebsiteRole.OWNER, WebsiteRole.ADMIN] }, user: { status: 'ACTIVE' } },
      select: { userId: true },
    }),
    prisma.projectMember.findMany({ where: { projectId, user: { status: 'ACTIVE' } }, select: { userId: true } }),
    prisma.websiteMember.findMany({ where: { websiteId, role: WebsiteRole.WEBSITE_USER }, select: { userId: true } }),
    prisma.user.findMany({ where: { role: 'SUPER_ADMIN', status: 'ACTIVE' }, select: { id: true } }),
  ]);
  const privateReporters = new Set(reporters.map((r) => r.userId).filter((id) => id !== creatorId));
  return [
    ...new Set([
      ...managers.map((m) => m.userId),
      ...members.map((m) => m.userId).filter((id) => !privateReporters.has(id)),
      ...superAdmins.map((u) => u.id),
    ]),
  ];
};

interface PublishInput {
  type: TaskEventType;
  taskId: string;
  actorId: string;
  message: (ctx: { actor: string; key: string; title: string; assignee: string | null }) => string;
  /** Users this is personally about (in addition to reporter + assignee). */
  alsoPersonal?: (string | null | undefined)[];
  commentId?: string;
  /** For deletions: the task snapshot taken before it was deleted. */
  snapshot?: TaskEventPayload['task'];
}

const send = async (input: PublishInput) => {
  if (!io) return;
  const task =
    input.snapshot ??
    (await prisma.task.findUnique({
      where: { id: input.taskId },
      select: {
        id: true,
        number: true,
        title: true,
        status: true,
        priority: true,
        websiteId: true,
        projectId: true,
        assigneeId: true,
        creatorId: true,
      },
    }).then((t) => t && { ...t, key: `TASK-${t.number}` }));
  if (!task) return;
  const [actor, assignee, recipients] = await Promise.all([
    prisma.user.findUnique({ where: { id: input.actorId }, select: { id: true, name: true } }),
    task.assigneeId ? prisma.user.findUnique({ where: { id: task.assigneeId }, select: { name: true } }) : null,
    recipientsOf(task.websiteId, task.projectId, task.creatorId),
  ]);
  const message = input.message({ actor: actor?.name ?? 'Someone', key: task.key, title: task.title, assignee: assignee?.name ?? null });
  const personal = new Set([task.creatorId, task.assigneeId, ...(input.alsoPersonal ?? [])].filter(Boolean) as string[]);
  const base = {
    id: crypto.randomUUID(),
    type: input.type,
    message,
    task: {
      id: task.id,
      key: task.key,
      title: task.title,
      status: task.status,
      priority: task.priority,
      websiteId: task.websiteId,
      projectId: task.projectId,
      assigneeId: task.assigneeId,
      creatorId: task.creatorId,
    },
    actor: actor ? { id: actor.id, name: actor.name } : null,
    commentId: input.commentId,
    at: new Date().toISOString(),
  };
  for (const userId of recipients) {
    const payload: TaskEventPayload = { ...base, personal: personal.has(userId) && userId !== input.actorId };
    io.to(userRoom(userId)).emit('task:event', payload);
    io.of('/widget').to(widgetRoom(task.websiteId, userId)).emit('task:event', payload);
  }
};

/** Fire-and-forget: call after the database transaction has committed. */
export const publishTaskEvent = (input: PublishInput) => {
  if (!io) return;
  void send(input).catch((err) => logger.error({ err, type: input.type, taskId: input.taskId }, 'real-time publish failed'));
};

/** Recipients must be computed before a task is deleted. */
export const taskSnapshot = async (taskId: string): Promise<TaskEventPayload['task'] | undefined> => {
  if (!io) return undefined;
  const t = await prisma.task.findUnique({
    where: { id: taskId },
    select: { id: true, number: true, title: true, status: true, priority: true, websiteId: true, projectId: true, assigneeId: true, creatorId: true },
  });
  return t ? { ...t, key: `TASK-${t.number}` } : undefined;
};
