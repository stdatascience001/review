import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { API, PASSWORD, makeApp, prisma, request, resetDb, signUp, type TestUser } from './helpers';

const app = makeApp();

let owner: TestUser;
let admin: TestUser;
let member: TestUser;
let client: TestUser;
let outsider: TestUser;
let websiteId: string;
let projectId: string;
let otherWebsiteId: string;

beforeAll(async () => {
  await resetDb();
  [owner, admin, member, client, outsider] = await Promise.all([
    signUp(app, { name: 'Owner' }),
    signUp(app, { name: 'Admin' }),
    signUp(app, { name: 'Member' }),
    signUp(app, { name: 'Client' }),
    signUp(app, { name: 'Outsider' }),
  ]);

  const w = await owner.agent.post(`${API}/websites`).send({ name: 'Acme Marketing Site', url: 'https://acme.example' });
  websiteId = w.body.data.id;
  const p = await owner.agent.post(`${API}/websites/${websiteId}/projects`).send({ name: 'Homepage redesign' });
  projectId = p.body.data.id;
  const o = await outsider.agent.post(`${API}/websites`).send({ name: 'Outsider Site', url: 'https://other.example' });
  otherWebsiteId = o.body.data.id;
});
afterAll(() => prisma.$disconnect());

describe('websites', () => {
  it('creator becomes OWNER, gets default settings and a unique slug', async () => {
    const res = await owner.agent.get(`${API}/websites/${websiteId}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ role: 'OWNER', slug: 'acme-marketing-site', settings: { timezone: 'UTC' } });

    const dup = await owner.agent.post(`${API}/websites`).send({ name: 'Acme Marketing Site', url: 'https://acme2.example' });
    expect(dup.status).toBe(201);
    expect(dup.body.data.slug).toMatch(/^acme-marketing-site-[a-z0-9]+$/);
  });

  it('validates website input', async () => {
    const res = await owner.agent.post(`${API}/websites`).send({ name: '', url: 'ftp://nope' });
    expect(res.status).toBe(400);
  });
});

describe('tenant isolation', () => {
  it('outsiders cannot see or touch another tenant’s website (404, not 403)', async () => {
    await outsider.agent.get(`${API}/websites/${websiteId}`).expect(404);
    await outsider.agent.patch(`${API}/websites/${websiteId}`).send({ name: 'pwned' }).expect(404);
    await outsider.agent.delete(`${API}/websites/${websiteId}`).expect(404);
    await outsider.agent.get(`${API}/websites/${websiteId}/members`).expect(404);
    await outsider.agent.get(`${API}/websites/${websiteId}/projects`).expect(404);
    await outsider.agent.get(`${API}/projects/${projectId}`).expect(404);
    await outsider.agent.get(`${API}/projects/${projectId}/tasks`).expect(404);
    await outsider.agent.post(`${API}/projects/${projectId}/tasks`).send({ title: 'x' }).expect(404);
  });

  it('website lists only include the user’s own tenants', async () => {
    const res = await outsider.agent.get(`${API}/websites`);
    expect(res.body.data.items.map((w: { id: string }) => w.id)).toEqual([otherWebsiteId]);
  });

  it('cannot add users from outside the website to a project, or assign tasks to them', async () => {
    const res = await owner.agent.post(`${API}/projects/${projectId}/members`).send({ userId: outsider.id, role: 'VIEWER' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('NOT_WEBSITE_MEMBER');

    const task = await owner.agent.post(`${API}/projects/${projectId}/tasks`).send({ title: 'T', assigneeId: outsider.id });
    expect(task.status).toBe(400);
    expect(task.body.error.code).toBe('INVALID_ASSIGNEE');
  });

  it('a task id from another tenant is invisible, including its comments', async () => {
    const p = await outsider.agent.post(`${API}/websites/${otherWebsiteId}/projects`).send({ name: 'Secret' });
    const t = await outsider.agent.post(`${API}/projects/${p.body.data.id}/tasks`).send({ title: 'Secret task' });
    const taskId = t.body.data.id;
    await owner.agent.get(`${API}/tasks/${taskId}`).expect(404);
    await owner.agent.patch(`${API}/tasks/${taskId}`).send({ title: 'x' }).expect(404);
    await owner.agent.get(`${API}/tasks/${taskId}/comments`).expect(404);
    await owner.agent.post(`${API}/tasks/${taskId}/comments`).send({ body: 'hi' }).expect(404);
    const c = await outsider.agent.post(`${API}/tasks/${taskId}/comments`).send({ body: 'private' });
    await owner.agent.patch(`${API}/comments/${c.body.data.id}`).send({ body: 'x' }).expect(404);
    await owner.agent.delete(`${API}/comments/${c.body.data.id}`).expect(404);
  });
});

describe('website roles', () => {
  it('owner adds members; only the owner can grant ADMIN', async () => {
    await owner.agent.post(`${API}/websites/${websiteId}/members`).send({ email: admin.email, role: 'ADMIN' }).expect(201);
    await admin.agent.post(`${API}/websites/${websiteId}/members`).send({ email: member.email, role: 'DEVELOPER' }).expect(201);
    await admin.agent.post(`${API}/websites/${websiteId}/members`).send({ email: client.email, role: 'WEBSITE_USER' }).expect(201);

    const promote = await admin.agent.patch(`${API}/websites/${websiteId}/members/${member.id}`).send({ role: 'ADMIN' });
    expect(promote.status).toBe(403);
    // OWNER can never be assigned through the API
    await owner.agent.patch(`${API}/websites/${websiteId}/members/${member.id}`).send({ role: 'OWNER' }).expect(400);
    // duplicates and unknown users
    await owner.agent.post(`${API}/websites/${websiteId}/members`).send({ email: member.email }).expect(409);
    await owner.agent.post(`${API}/websites/${websiteId}/members`).send({ email: 'nobody@example.com' }).expect(404);
  });

  it('members and clients cannot manage the website', async () => {
    await member.agent.patch(`${API}/websites/${websiteId}`).send({ name: 'x' }).expect(403);
    await member.agent.patch(`${API}/websites/${websiteId}/settings`).send({ timezone: 'UTC' }).expect(403);
    await member.agent.post(`${API}/websites/${websiteId}/members`).send({ email: outsider.email }).expect(403);
    await member.agent.post(`${API}/websites/${websiteId}/projects`).send({ name: 'nope' }).expect(403);
    await client.agent.delete(`${API}/websites/${websiteId}`).expect(403);
    // but they can read it
    const res = await member.agent.get(`${API}/websites/${websiteId}`);
    expect(res.body.data.role).toBe('DEVELOPER');
  });

  it('admins can update settings but cannot delete the website or remove the owner', async () => {
    const s = await admin.agent
      .patch(`${API}/websites/${websiteId}/settings`)
      .send({ timezone: 'Asia/Kolkata', brandColor: '#1A2B3C', defaultTaskPriority: 'HIGH' });
    expect(s.status).toBe(200);
    expect(s.body.data).toMatchObject({ timezone: 'Asia/Kolkata', brandColor: '#1A2B3C' });
    await admin.agent.patch(`${API}/websites/${websiteId}/settings`).send({ timezone: 'Mars/Base' }).expect(400);
    await admin.agent.delete(`${API}/websites/${websiteId}`).expect(403);
    await admin.agent.delete(`${API}/websites/${websiteId}/members/${owner.id}`).expect(403);
  });

  it('members only see projects they belong to; admins see all', async () => {
    const forMember = await member.agent.get(`${API}/websites/${websiteId}/projects`);
    expect(forMember.body.data.items).toHaveLength(0);
    await member.agent.get(`${API}/projects/${projectId}`).expect(404);

    const forAdmin = await admin.agent.get(`${API}/websites/${websiteId}/projects`);
    expect(forAdmin.body.data.items).toHaveLength(1);
    const p = await admin.agent.get(`${API}/projects/${projectId}`);
    expect(p.body.data.role).toBe('MANAGER');
  });
});

describe('project roles', () => {
  let reviewerTaskId: string;
  let contributorTaskId: string;

  it('clients may only be REVIEWER or VIEWER', async () => {
    const bad = await owner.agent.post(`${API}/projects/${projectId}/members`).send({ userId: client.id, role: 'CONTRIBUTOR' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('INVALID_PROJECT_ROLE');
    await owner.agent.post(`${API}/projects/${projectId}/members`).send({ userId: client.id, role: 'REVIEWER' }).expect(201);
    await owner.agent.post(`${API}/projects/${projectId}/members`).send({ userId: member.id, role: 'CONTRIBUTOR' }).expect(201);
  });

  it('REVIEWER can create tasks and edit only their own', async () => {
    const own = await client.agent.post(`${API}/projects/${projectId}/tasks`).send({
      title: 'Logo is blurry',
      type: 'UI_ISSUE',
      pageUrl: 'https://acme.example/',
      metadata: { viewport: { w: 1440, h: 900 }, pin: { x: 120, y: 48 } },
    });
    expect(own.status).toBe(201);
    expect(own.body.data.priority).toBe('HIGH'); // website default from settings
    reviewerTaskId = own.body.data.id;

    const other = await member.agent.post(`${API}/projects/${projectId}/tasks`).send({ title: 'Fix nav' });
    contributorTaskId = other.body.data.id;

    await client.agent.patch(`${API}/tasks/${reviewerTaskId}`).send({ title: 'Logo is blurry on retina' }).expect(200);
    // Workflow fields (status/priority/assignee) belong to admins and developers.
    const wf = await client.agent.patch(`${API}/tasks/${reviewerTaskId}`).send({ priority: 'URGENT' });
    expect([wf.status, wf.body.error.code]).toEqual([403, 'WORKFLOW_FORBIDDEN']);
    await client.agent.patch(`${API}/tasks/${reviewerTaskId}`).send({ status: 'COMPLETED' }).expect(403);
    // Other people's tasks are invisible to a client (404, not just 403)
    await client.agent.patch(`${API}/tasks/${contributorTaskId}`).send({ title: 'hijack' }).expect(404);
    await client.agent.delete(`${API}/tasks/${contributorTaskId}`).expect(404);
    await client.agent.get(`${API}/tasks/${contributorTaskId}`).expect(404);
    const list = await client.agent.get(`${API}/projects/${projectId}/tasks`);
    expect(list.body.data.items.map((t: { id: string }) => t.id)).toEqual([reviewerTaskId]);
  });

  it('CONTRIBUTOR can edit any task but delete only their own; cannot manage members', async () => {
    await member.agent.patch(`${API}/tasks/${reviewerTaskId}`).send({ status: 'IN_PROGRESS' }).expect(200);
    await member.agent.delete(`${API}/tasks/${reviewerTaskId}`).expect(403);
    await member.agent.post(`${API}/projects/${projectId}/members`).send({ userId: admin.id }).expect(403);
    await member.agent.patch(`${API}/projects/${projectId}`).send({ name: 'x' }).expect(403);
  });

  it('VIEWER is read-only', async () => {
    await owner.agent.patch(`${API}/projects/${projectId}/members/${client.id}`).send({ role: 'VIEWER' }).expect(200);
    await client.agent.get(`${API}/projects/${projectId}/tasks`).expect(200);
    await client.agent.post(`${API}/projects/${projectId}/tasks`).send({ title: 'x' }).expect(403);
    await client.agent.post(`${API}/tasks/${reviewerTaskId}/comments`).send({ body: 'hi' }).expect(403);
    await client.agent.patch(`${API}/tasks/${reviewerTaskId}`).send({ title: 'own but viewer' }).expect(403);
    const t = await client.agent.get(`${API}/tasks/${reviewerTaskId}`);
    expect(t.body.data.permissions).toEqual({ update: false, manage: false, delete: false, comment: false, upload: false });
    await client.agent.get(`${API}/tasks/${contributorTaskId}`).expect(404);
    await owner.agent.patch(`${API}/projects/${projectId}/members/${client.id}`).send({ role: 'REVIEWER' }).expect(200);
  });

  it('website setting can stop clients creating tasks', async () => {
    await owner.agent.patch(`${API}/websites/${websiteId}/settings`).send({ clientsCanCreateTasks: false }).expect(200);
    const res = await client.agent.post(`${API}/projects/${projectId}/tasks`).send({ title: 'blocked' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CLIENT_TASKS_DISABLED');
    await owner.agent.patch(`${API}/websites/${websiteId}/settings`).send({ clientsCanCreateTasks: true }).expect(200);
  });

  it('removing a website member also removes their project access', async () => {
    await owner.agent.delete(`${API}/websites/${websiteId}/members/${member.id}`).expect(204);
    await member.agent.get(`${API}/projects/${projectId}`).expect(404);
    expect(await prisma.projectMember.count({ where: { userId: member.id } })).toBe(0);
  });

  it('only website OWNER/ADMIN can delete projects', async () => {
    const p = await owner.agent.post(`${API}/websites/${websiteId}/projects`).send({ name: 'Temp' });
    await owner.agent.post(`${API}/projects/${p.body.data.id}/members`).send({ userId: client.id, role: 'REVIEWER' });
    await client.agent.delete(`${API}/projects/${p.body.data.id}`).expect(403);
    await admin.agent.delete(`${API}/projects/${p.body.data.id}`).expect(204);
  });
});

describe('platform roles (SUPER_ADMIN)', () => {
  it('regular users cannot use admin endpoints', async () => {
    await owner.agent.get(`${API}/users`).expect(403);
    await owner.agent.patch(`${API}/users/${outsider.id}`).send({ status: 'SUSPENDED' }).expect(403);
  });

  it('super admin can list users and suspend one, which ends their sessions', async () => {
    await prisma.user.update({ where: { id: admin.id }, data: { role: 'SUPER_ADMIN' } });
    const list = await admin.agent.get(`${API}/users`).query({ q: 'outsider' });
    expect(list.status).toBe(200);
    expect(list.body.data.items.map((u: { id: string }) => u.id)).toEqual([outsider.id]);
    expect(list.body.data.items[0].passwordHash).toBeUndefined();

    await admin.agent.patch(`${API}/users/${admin.id}`).send({ role: 'USER' }).expect(400); // not on self
    await admin.agent.patch(`${API}/users/${outsider.id}`).send({ status: 'SUSPENDED' }).expect(200);
    await outsider.agent.get(`${API}/users/me`).expect(401);
    await request(app).post(`${API}/auth/login`).send({ email: outsider.email, password: PASSWORD }).expect(403);
  });
});
