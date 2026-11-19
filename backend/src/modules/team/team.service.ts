import { Prisma, ProjectRole, TaskStatus, WebsiteRole } from '@prisma/client';
import { env } from '../../config/env';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors';
import { generateToken, sha256 } from '../../lib/crypto';
import { addedToWebsiteEmail, invitationEmail, queueMail } from '../../lib/mailer';
import { prisma, type Tx } from '../../lib/prisma';
import {
  ALLOWED_PROJECT_ROLES,
  DEFAULT_PROJECT_ROLE,
  getWebsiteAccess,
  requireWebsitePermission,
} from '../access/access.service';
import { notify } from '../notifications/notifications.service';
import { publicUserSelect } from '../users/user.serializer';

type AssignableRole = Exclude<WebsiteRole, 'OWNER'>;
import { ACTIVE_STATUSES, CLOSED_STATUSES, DONE_STATUSES as DONE } from '../tasks/task-status';

/** Only the OWNER (or a super admin acting as owner) may grant, change or revoke ADMIN. */
const assertCanManageRole = (actorRole: WebsiteRole, targetRole: WebsiteRole) => {
  if (targetRole === WebsiteRole.OWNER) throw forbidden('The website owner cannot be modified');
  if (targetRole === WebsiteRole.ADMIN && actorRole !== WebsiteRole.OWNER) {
    throw forbidden('Only the owner can manage admins');
  }
};

const assertProjectRoleAllowed = (websiteRole: WebsiteRole, role: ProjectRole) => {
  if (!ALLOWED_PROJECT_ROLES[websiteRole].includes(role)) {
    throw badRequest(
      `A ${websiteRole.replace('_', ' ').toLowerCase()} can only be ${ALLOWED_PROJECT_ROLES[websiteRole].join(' or ')} on a project`,
      'INVALID_PROJECT_ROLE',
    );
  }
};

/** Validates that all project ids belong to the website. */
const assertProjectsInWebsite = async (db: Tx | typeof prisma, websiteId: string, projectIds: string[]) => {
  if (projectIds.length === 0) return;
  const count = await db.project.count({ where: { id: { in: projectIds }, websiteId } });
  if (count !== new Set(projectIds).size) throw badRequest('One or more projects do not belong to this website', 'INVALID_PROJECTS');
};

// ───────────────────────────── Members ─────────────────────────────

export const listMembers = async (userId: string, websiteId: string) => {
  await getWebsiteAccess(userId, websiteId);
  const members = await prisma.websiteMember.findMany({
    where: { websiteId },
    select: {
      id: true,
      role: true,
      createdAt: true,
      user: { select: { ...publicUserSelect, status: true, lastLoginAt: true } },
    },
    orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
  });
  const projectMemberships = await prisma.projectMember.findMany({
    where: { project: { websiteId }, userId: { in: members.map((m) => m.user.id) } },
    select: { userId: true, role: true, project: { select: { id: true, name: true } } },
  });
  return members.map((m) => ({
    ...m,
    projects: projectMemberships
      .filter((pm) => pm.userId === m.user.id)
      .map((pm) => ({ id: pm.project.id, name: pm.project.name, role: pm.role })),
  }));
};

const addProjectMemberships = async (
  tx: Tx,
  userId: string,
  websiteRole: WebsiteRole,
  projectIds: string[],
) => {
  for (const projectId of new Set(projectIds)) {
    await tx.projectMember.upsert({
      where: { projectId_userId: { projectId, userId } },
      create: { projectId, userId, role: DEFAULT_PROJECT_ROLE[websiteRole] },
      update: {},
    });
  }
};

/** Adds an existing user directly to the website. */
const addExistingUser = async (
  actorId: string,
  websiteId: string,
  user: { id: string; email: string; name: string },
  role: AssignableRole,
  projectIds: string[],
) => {
  const member = await prisma.$transaction(async (tx) => {
    const existing = await tx.websiteMember.findUnique({ where: { websiteId_userId: { websiteId, userId: user.id } } });
    if (existing) throw conflict('User is already a member of this website', 'ALREADY_MEMBER');
    const m = await tx.websiteMember.create({
      data: { websiteId, userId: user.id, role, invitedById: actorId },
      select: { id: true, role: true, createdAt: true, user: { select: publicUserSelect }, website: { select: { name: true } } },
    });
    await addProjectMemberships(tx, user.id, role, projectIds);
    await notify(tx, [user.id], {
      type: 'WEBSITE_MEMBER_ADDED',
      title: `You were added to ${m.website.name}`,
      actorId,
      websiteId,
      data: { role },
    });
    return m;
  });
  queueMail(addedToWebsiteEmail(user.email, user.name, member.website.name, role));
  const { website: _w, ...rest } = member;
  return rest;
};

/** Legacy direct add (existing users only). */
export const addMember = async (actorId: string, websiteId: string, input: { email: string; role: AssignableRole }) => {
  const { role: actorRole } = await requireWebsitePermission(actorId, websiteId, 'website:members:manage');
  assertCanManageRole(actorRole, input.role);
  const user = await prisma.user.findUnique({ where: { email: input.email }, select: { id: true, email: true, name: true, status: true } });
  if (!user || user.status !== 'ACTIVE') {
    throw notFound('No active user with that email address. Send an invitation instead.', 'USER_NOT_FOUND');
  }
  return addExistingUser(actorId, websiteId, user, input.role, []);
};

/**
 * Invite a team member by email. Existing users are added immediately; anyone else receives
 * an invitation email with a single-use link.
 */
export const invite = async (
  actorId: string,
  websiteId: string,
  input: { email: string; role: AssignableRole; projectIds: string[] },
) => {
  const { role: actorRole } = await requireWebsitePermission(actorId, websiteId, 'website:members:manage');
  assertCanManageRole(actorRole, input.role);
  await assertProjectsInWebsite(prisma, websiteId, input.projectIds);

  const user = await prisma.user.findUnique({
    where: { email: input.email },
    select: { id: true, email: true, name: true, status: true },
  });
  if (user) {
    if (user.status !== 'ACTIVE') throw badRequest('This user account is suspended', 'USER_SUSPENDED');
    return { status: 'added' as const, member: await addExistingUser(actorId, websiteId, user, input.role, input.projectIds) };
  }

  const token = generateToken(32);
  const [website, inviter] = await Promise.all([
    prisma.website.findUniqueOrThrow({ where: { id: websiteId }, select: { name: true } }),
    prisma.user.findUniqueOrThrow({ where: { id: actorId }, select: { name: true } }),
  ]);
  const invitation = await prisma.$transaction(async (tx) => {
    // A new invitation replaces any pending one for the same email.
    await tx.websiteInvitation.updateMany({
      where: { websiteId, email: input.email, acceptedAt: null, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return tx.websiteInvitation.create({
      data: {
        websiteId,
        email: input.email,
        role: input.role,
        projectIds: [...new Set(input.projectIds)],
        tokenHash: sha256(token),
        invitedById: actorId,
        expiresAt: new Date(Date.now() + env.INVITATION_TTL_DAYS * 86_400_000),
      },
      select: invitationSelect,
    });
  });
  queueMail(invitationEmail(input.email, inviter.name, website.name, input.role, token));
  return { status: 'invited' as const, invitation };
};

const invitationSelect = {
  id: true,
  email: true,
  role: true,
  projectIds: true,
  expiresAt: true,
  createdAt: true,
  invitedBy: { select: publicUserSelect },
} satisfies Prisma.WebsiteInvitationSelect;

export const listInvitations = async (userId: string, websiteId: string) => {
  await requireWebsitePermission(userId, websiteId, 'website:members:manage');
  return prisma.websiteInvitation.findMany({
    where: { websiteId, acceptedAt: null, revokedAt: null },
    select: invitationSelect,
    orderBy: { createdAt: 'desc' },
  });
};

export const revokeInvitation = async (userId: string, websiteId: string, invitationId: string) => {
  await requireWebsitePermission(userId, websiteId, 'website:members:manage');
  const result = await prisma.websiteInvitation.updateMany({
    where: { id: invitationId, websiteId, acceptedAt: null, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  if (result.count === 0) throw notFound('Invitation not found');
};

export const resendInvitation = async (userId: string, websiteId: string, invitationId: string) => {
  const { role: actorRole } = await requireWebsitePermission(userId, websiteId, 'website:members:manage');
  const inv = await prisma.websiteInvitation.findFirst({
    where: { id: invitationId, websiteId, acceptedAt: null, revokedAt: null },
  });
  if (!inv) throw notFound('Invitation not found');
  assertCanManageRole(actorRole, inv.role);
  const token = generateToken(32);
  const updated = await prisma.websiteInvitation.update({
    where: { id: inv.id },
    data: { tokenHash: sha256(token), expiresAt: new Date(Date.now() + env.INVITATION_TTL_DAYS * 86_400_000) },
    select: { ...invitationSelect, website: { select: { name: true } } },
  });
  const inviter = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { name: true } });
  queueMail(invitationEmail(inv.email, inviter.name, updated.website.name, inv.role, token));
  const { website: _w, ...rest } = updated;
  return rest;
};

const findPendingByToken = async (token: string) => {
  const inv = await prisma.websiteInvitation.findUnique({
    where: { tokenHash: sha256(token) },
    include: { website: { select: { id: true, name: true, logoUrl: true } }, invitedBy: { select: { name: true } } },
  });
  if (!inv || inv.revokedAt || inv.acceptedAt || inv.expiresAt <= new Date()) {
    throw badRequest('This invitation is invalid or has expired', 'INVALID_INVITATION');
  }
  return inv;
};

/** Public: shows what an invitation is for (used by the accept-invite page). */
export const previewInvitation = async (token: string) => {
  const inv = await findPendingByToken(token);
  const accountExists = Boolean(await prisma.user.findUnique({ where: { email: inv.email }, select: { id: true } }));
  return {
    email: inv.email,
    role: inv.role,
    website: inv.website,
    invitedBy: inv.invitedBy?.name ?? null,
    expiresAt: inv.expiresAt,
    accountExists,
  };
};

export const acceptInvitation = async (userId: string, token: string) => {
  const inv = await findPendingByToken(token);
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (user.email !== inv.email) {
    throw forbidden(`This invitation was sent to ${inv.email}. Sign in with that email to accept it.`, 'INVITATION_EMAIL_MISMATCH');
  }
  await prisma.$transaction(async (tx) => {
    const claimed = await tx.websiteInvitation.updateMany({
      where: { id: inv.id, acceptedAt: null, revokedAt: null },
      data: { acceptedAt: new Date() },
    });
    if (claimed.count !== 1) throw badRequest('This invitation is invalid or has expired', 'INVALID_INVITATION');
    await tx.websiteMember.upsert({
      where: { websiteId_userId: { websiteId: inv.websiteId, userId } },
      create: { websiteId: inv.websiteId, userId, role: inv.role, invitedById: inv.invitedById },
      update: {},
    });
    const validProjects = await tx.project.findMany({
      where: { id: { in: inv.projectIds }, websiteId: inv.websiteId },
      select: { id: true },
    });
    await addProjectMemberships(tx, userId, inv.role, validProjects.map((p) => p.id));
    // The invitation link was delivered to this mailbox, which proves ownership.
    if (!user.emailVerifiedAt) await tx.user.update({ where: { id: userId }, data: { emailVerifiedAt: new Date() } });
    await notify(tx, [inv.invitedById], {
      type: 'WEBSITE_MEMBER_ADDED',
      title: `${user.name} joined ${inv.website.name}`,
      actorId: userId,
      websiteId: inv.websiteId,
      data: { role: inv.role },
    });
  });
  return { websiteId: inv.websiteId, websiteName: inv.website.name, role: inv.role };
};

// ───────────────────────────── Roles & project assignment ─────────────────────────────

export const updateMemberRole = async (actorId: string, websiteId: string, targetUserId: string, role: AssignableRole) => {
  const { role: actorRole } = await requireWebsitePermission(actorId, websiteId, 'website:members:manage');
  const target = await prisma.websiteMember.findUnique({ where: { websiteId_userId: { websiteId, userId: targetUserId } } });
  if (!target) throw notFound('Member not found');
  assertCanManageRole(actorRole, target.role);
  assertCanManageRole(actorRole, role);
  if (actorId === targetUserId) throw badRequest('You cannot change your own role', 'SELF_MODIFICATION');

  return prisma.$transaction(async (tx) => {
    // Downgrade project roles the new team role is not allowed to hold.
    const allowed = ALLOWED_PROJECT_ROLES[role];
    await tx.projectMember.updateMany({
      where: { userId: targetUserId, project: { websiteId }, role: { notIn: [...allowed] } },
      data: { role: DEFAULT_PROJECT_ROLE[role] },
    });
    return tx.websiteMember.update({
      where: { id: target.id },
      data: { role },
      select: { id: true, role: true, createdAt: true, user: { select: publicUserSelect } },
    });
  });
};

/** Replaces the set of projects (within this website) a member belongs to. */
export const setMemberProjects = async (
  actorId: string,
  websiteId: string,
  targetUserId: string,
  projects: { projectId: string; role?: ProjectRole }[],
) => {
  await requireWebsitePermission(actorId, websiteId, 'website:members:manage');
  const target = await prisma.websiteMember.findUnique({ where: { websiteId_userId: { websiteId, userId: targetUserId } } });
  if (!target) throw notFound('Member not found');
  const ids = projects.map((p) => p.projectId);
  await assertProjectsInWebsite(prisma, websiteId, ids);
  for (const p of projects) if (p.role) assertProjectRoleAllowed(target.role, p.role);

  await prisma.$transaction(async (tx) => {
    await tx.projectMember.deleteMany({ where: { userId: targetUserId, project: { websiteId }, projectId: { notIn: ids } } });
    for (const p of projects) {
      await tx.projectMember.upsert({
        where: { projectId_userId: { projectId: p.projectId, userId: targetUserId } },
        create: { projectId: p.projectId, userId: targetUserId, role: p.role ?? DEFAULT_PROJECT_ROLE[target.role] },
        update: p.role ? { role: p.role } : {},
      });
    }
  });
  return prisma.projectMember.findMany({
    where: { userId: targetUserId, project: { websiteId } },
    select: { role: true, project: { select: { id: true, name: true } } },
  });
};

/** Admins remove members; any non-owner member may remove themself (leave the website). */
export const removeMember = async (actorId: string, websiteId: string, targetUserId: string) => {
  const actor = await getWebsiteAccess(actorId, websiteId);
  const target = await prisma.websiteMember.findUnique({ where: { websiteId_userId: { websiteId, userId: targetUserId } } });
  if (!target) throw notFound('Member not found');
  if (target.role === WebsiteRole.OWNER) throw forbidden('The website owner cannot be removed');
  if (actorId !== targetUserId) {
    await requireWebsitePermission(actorId, websiteId, 'website:members:manage');
    assertCanManageRole(actor.role, target.role);
  }
  await prisma.$transaction([
    prisma.projectMember.deleteMany({ where: { userId: targetUserId, project: { websiteId } } }),
    prisma.websiteMember.delete({ where: { id: target.id } }),
  ]);
};

// ───────────────────────────── Performance ─────────────────────────────

/**
 * Per-member delivery metrics for tasks in this website: assigned, open, completed,
 * overdue, completed in the last 30 days, completion rate and average resolution time.
 */
export const performance = async (userId: string, websiteId: string) => {
  const { role } = await getWebsiteAccess(userId, websiteId);
  if (!['OWNER', 'ADMIN', 'PROJECT_MANAGER'].includes(role)) throw forbidden();

  const members = await prisma.websiteMember.findMany({
    where: { websiteId },
    select: { role: true, user: { select: publicUserSelect } },
  });
  const ids = members.map((m) => m.user.id);
  const now = new Date();
  const monthAgo = new Date(Date.now() - 30 * 86_400_000);

  const [byStatus, overdue, recent, resolution] = await Promise.all([
    prisma.task.groupBy({
      by: ['assigneeId', 'status'],
      where: { websiteId, assigneeId: { in: ids }, status: { not: 'ARCHIVED' } },
      _count: true,
    }),
    prisma.task.groupBy({
      by: ['assigneeId'],
      where: { websiteId, assigneeId: { in: ids }, status: { notIn: CLOSED_STATUSES }, dueDate: { lt: now } },
      _count: true,
    }),
    prisma.task.groupBy({
      by: ['assigneeId'],
      where: { websiteId, assigneeId: { in: ids }, completedAt: { gte: monthAgo } },
      _count: true,
    }),
    prisma.$queryRaw<{ assignee_id: string; avg_hours: number | null }[]>`
      SELECT assignee_id, AVG(EXTRACT(EPOCH FROM (completed_at - created_at)) / 3600)::float AS avg_hours
      FROM tasks
      WHERE website_id = ${websiteId}::uuid AND completed_at IS NOT NULL
        AND assignee_id = ANY(${ids}::uuid[])
      GROUP BY assignee_id`,
  ]);

  return members
    .map((m) => {
      const mine = byStatus.filter((r) => r.assigneeId === m.user.id);
      const assigned = mine.reduce((s, r) => s + r._count, 0);
      const completed = mine.filter((r) => DONE.includes(r.status)).reduce((s, r) => s + r._count, 0);
      const inProgress = mine.filter((r) => ACTIVE_STATUSES.includes(r.status)).reduce((s, r) => s + r._count, 0);
      const avg = resolution.find((r) => r.assignee_id === m.user.id)?.avg_hours ?? null;
      return {
        user: m.user,
        role: m.role,
        assigned,
        open: assigned - completed,
        inProgress,
        completed,
        overdue: overdue.find((r) => r.assigneeId === m.user.id)?._count ?? 0,
        completedLast30Days: recent.find((r) => r.assigneeId === m.user.id)?._count ?? 0,
        completionRate: assigned ? Math.round((completed / assigned) * 100) : 0,
        avgResolutionHours: avg === null ? null : Math.round(avg * 10) / 10,
      };
    })
    .sort((a, b) => b.completed - a.completed || b.assigned - a.assigned);
};
