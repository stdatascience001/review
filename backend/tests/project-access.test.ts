import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { API, PASSWORD, makeApp, prisma, request, resetDb, signUp, type TestUser } from './helpers';

/**
 * Projects (websites) per user:
 *  1. The admin creates projects; people who sign in through a project's widget join it
 *     automatically and show under that project's users — never under another project.
 *  2. One user works in several projects; each project's tasks are saved and listed separately.
 *  3. Users with the User role create tasks in the projects they are assigned to.
 */
const app = makeApp();
const MOZ = 'https://moz.com';
const DEEP = 'https://deep.com';

let admin: TestUser;
let gur: TestUser; // uses MOZ and DEEP
let sam: TestUser; // uses MOZ only
let other: TestUser; // owns an unrelated website
let moz: { id: string; siteId: string };
let deep: { id: string; siteId: string };
let otherSite: { id: string; projectId: string };

const widgetSession = async (email: string, siteId: string, origin: string) => {
  const res = await request(app).post(`${API}/widget/auth/login`).set('Origin', origin).send({ siteId, email, password: PASSWORD });
  expect(res.status).toBe(200);
  const token = res.body.data.session.accessToken as string;
  return {
    get: (p: string) => request(app).get(`${API}/widget${p}`).set('Origin', origin).set('Authorization', `Bearer ${token}`),
    post: (p: string) => request(app).post(`${API}/widget${p}`).set('Origin', origin).set('Authorization', `Bearer ${token}`),
  };
};
const titles = (res: request.Response) => res.body.data.items.map((t: { title: string }) => t.title).sort();

beforeAll(async () => {
  await resetDb();
  [admin, gur, sam, other] = await Promise.all([
    signUp(app, { name: 'Admin' }),
    signUp(app, { name: 'Gur' }),
    signUp(app, { name: 'Sam' }),
    signUp(app, { name: 'Other Owner' }),
  ]);
  await prisma.user.update({ where: { id: admin.id }, data: { role: 'SUPER_ADMIN' } });
  moz = (await admin.agent.post(`${API}/websites`).send({ name: 'MOZ', url: MOZ })).body.data;
  deep = (await admin.agent.post(`${API}/websites`).send({ name: 'DEEP', url: DEEP })).body.data;
  const o = (await other.agent.post(`${API}/websites`).send({ name: 'Elsewhere', url: 'https://elsewhere.dev' })).body.data;
  const op = (await other.agent.post(`${API}/websites/${o.id}/projects`).send({ name: 'Elsewhere QA' })).body.data;
  otherSite = { id: o.id, projectId: op.id };
});
afterAll(() => prisma.$disconnect());

describe('1. project users: signing in through a project joins only that project', () => {
  it('Gur signs in on MOZ → becomes a Website User of MOZ (not of DEEP)', async () => {
    const w = await widgetSession(gur.email, moz.siteId, MOZ);
    const me = (await w.get('/me')).body.data;
    expect(me.access).toMatchObject({ role: 'WEBSITE_USER', canCreate: true });
    expect(me.access.projects).toHaveLength(1);
    expect(me.access.projects[0].name).toBe('Website Feedback');

    const memberships = await prisma.websiteMember.findMany({ where: { userId: gur.id }, select: { websiteId: true, role: true } });
    expect(memberships).toEqual([{ websiteId: moz.id, role: 'WEBSITE_USER' }]);
    const audit = await prisma.auditLog.findFirst({ where: { action: 'member.auto_joined', actorId: gur.id } });
    expect(audit?.websiteId).toBe(moz.id);
  });

  it('an unverified account does not join', async () => {
    const unverified = await signUp(app, { name: 'Unverified', verify: false });
    const w = await widgetSession(unverified.email, moz.siteId, MOZ);
    expect((await w.get('/me')).body.data.access).toBeNull();
    expect(await prisma.websiteMember.count({ where: { userId: unverified.id } })).toBe(0);
  });

  it('with auto-join switched off the project stays invite-only', async () => {
    await admin.agent.patch(`${API}/websites/${deep.id}/settings`).send({ widgetAutoJoin: false }).expect(200);
    const w = await widgetSession(sam.email, deep.siteId, DEEP);
    expect((await w.get('/me')).body.data.access).toBeNull();
    expect((await w.get('/tasks')).status).toBe(403);
    await admin.agent.patch(`${API}/websites/${deep.id}/settings`).send({ widgetAutoJoin: true }).expect(200);
  });
});

describe('2. one user, several projects, tasks kept separately', () => {
  it('Gur creates 10 tasks on MOZ and 10 on DEEP; Sam creates 2 on MOZ', async () => {
    const onMoz = await widgetSession(gur.email, moz.siteId, MOZ);
    const onDeep = await widgetSession(gur.email, deep.siteId, DEEP);
    for (let i = 1; i <= 10; i++) {
      await onMoz.post('/tasks').send({ title: `MOZ testing ${i}`, pageUrl: `${MOZ}/page-${i}` }).expect(201);
      await onDeep.post('/tasks').send({ title: `DEEP testing ${i}`, pageUrl: `${DEEP}/page-${i}` }).expect(201);
    }
    const samMoz = await widgetSession(sam.email, moz.siteId, MOZ);
    for (let i = 1; i <= 2; i++) await samMoz.post('/tasks').send({ title: `Sam MOZ ${i}`, pageUrl: MOZ }).expect(201);

    expect(await prisma.task.count({ where: { websiteId: moz.id, creatorId: gur.id } })).toBe(10);
    expect(await prisma.task.count({ where: { websiteId: deep.id, creatorId: gur.id } })).toBe(10);
    // each widget shows only its own project's tasks
    expect((await onMoz.get('/tasks?pageSize=50')).body.data.items.every((t: { title: string }) => t.title.startsWith('MOZ'))).toBe(true);
    expect((await onDeep.get('/tasks?pageSize=50')).body.data.counts.all).toBe(10);
  });

  it('Gur’s dashboard lists both projects; selecting one shows only its tasks', async () => {
    const list = (await gur.agent.get(`${API}/dashboard/websites`)).body.data;
    expect(list.map((w: { name: string }) => w.name)).toEqual(['MOZ', 'DEEP']);
    expect(list.map((w: { tasks: { total: number } }) => w.tasks.total)).toEqual([10, 10]); // Sam's tasks are not counted
    expect(list.every((w: { users: number | null; role: string }) => w.users === null && w.role === 'WEBSITE_USER')).toBe(true);

    const mozTasks = await gur.agent.get(`${API}/tasks`).query({ websiteId: moz.id, pageSize: 50 });
    expect(mozTasks.body.data.items).toHaveLength(10);
    expect(titles(mozTasks).every((t: string) => t.startsWith('MOZ testing'))).toBe(true);
    const deepTasks = await gur.agent.get(`${API}/tasks`).query({ websiteId: deep.id, pageSize: 50 });
    expect(deepTasks.body.data.items).toHaveLength(10);
    expect(titles(deepTasks).every((t: string) => t.startsWith('DEEP testing'))).toBe(true);

    const mozStats = (await gur.agent.get(`${API}/dashboard`).query({ websiteId: moz.id })).body.data;
    expect(mozStats.totals).toMatchObject({ websites: 1, tasks: 10, openTasks: 10, users: 1 });
    expect((await gur.agent.get(`${API}/dashboard`)).body.data.totals).toMatchObject({ websites: 2, tasks: 20, users: 1 });
  });

  it('Sam only sees MOZ and only his own tasks; other projects and users stay hidden', async () => {
    const list = (await sam.agent.get(`${API}/dashboard/websites`)).body.data;
    expect(list.map((w: { name: string }) => w.name)).toEqual(['MOZ']);
    expect(list[0].tasks.total).toBe(2);
    expect(titles(await sam.agent.get(`${API}/tasks`))).toEqual(['Sam MOZ 1', 'Sam MOZ 2']);
    await sam.agent.get(`${API}/websites/${deep.id}`).expect(404);
    await sam.agent.get(`${API}/dashboard`).query({ websiteId: deep.id }).expect(404);
    const users = await sam.agent.get(`${API}/dashboard/websites/${moz.id}/users`);
    expect([users.status, users.body.error.code]).toEqual([403, 'TEAM_ONLY']);
    expect((await sam.agent.get(`${API}/dashboard`)).body.data.totals.users).toBe(1);
  });
});

describe('admin: all projects, their users and tasks', () => {
  it('the admin dashboard lists every project with users and task counts', async () => {
    const list = (await admin.agent.get(`${API}/dashboard/websites`)).body.data;
    const byName = Object.fromEntries(list.map((w: { name: string }) => [w.name, w]));
    expect(Object.keys(byName).sort()).toEqual(['DEEP', 'Elsewhere', 'MOZ']);
    expect(byName.MOZ).toMatchObject({ users: 3, tasks: { total: 12, open: 12 } }); // admin, Gur, Sam
    expect(byName.DEEP).toMatchObject({ users: 2, tasks: { total: 10 } }); // admin, Gur
    expect(byName.Elsewhere).toMatchObject({ member: false, users: 1, tasks: { total: 0 } });
  });

  it('selecting a project shows only its users, with their task counts', async () => {
    const moZUsers = (await admin.agent.get(`${API}/dashboard/websites/${moz.id}/users`)).body.data;
    const row = (email: string) => moZUsers.find((m: { user: { email: string } }) => m.user.email === email);
    expect(moZUsers).toHaveLength(3);
    expect(row(gur.email)).toMatchObject({ role: 'WEBSITE_USER', tasks: { reported: 10, open: 10 } });
    expect(row(gur.email).projects.map((p: { name: string }) => p.name)).toEqual(['Website Feedback']);
    expect(row(sam.email)).toMatchObject({ tasks: { reported: 2 } });

    const deepUsers = (await admin.agent.get(`${API}/dashboard/websites/${deep.id}/users`)).body.data;
    expect(deepUsers.map((m: { user: { email: string } }) => m.user.email)).not.toContain(sam.email); // Sam isn't on DEEP
    const stats = (await admin.agent.get(`${API}/dashboard`).query({ websiteId: moz.id })).body.data;
    expect(stats.totals).toMatchObject({ users: 3, tasks: 12 });
    expect((await admin.agent.get(`${API}/tasks`).query({ websiteId: deep.id, pageSize: 50 })).body.data.items).toHaveLength(10);
  });

  it('a project owner cannot see another owner’s project or users', async () => {
    expect((await other.agent.get(`${API}/dashboard/websites`)).body.data.map((w: { name: string }) => w.name)).toEqual(['Elsewhere']);
    await other.agent.get(`${API}/dashboard/websites/${moz.id}/users`).expect(404);
  });
});

describe('3. users with the User role create tasks in their assigned projects', () => {
  it('Gur creates a task from the dashboard; it is saved under the selected project', async () => {
    const mozProject = await prisma.project.findFirstOrThrow({ where: { websiteId: moz.id } });
    const res = await gur.agent.post(`${API}/tasks`).send({ projectId: mozProject.id, title: 'Dashboard task on MOZ', type: 'BUG', status: 'OPEN' });
    expect(res.status).toBe(201);
    const t = await prisma.task.findUniqueOrThrow({ where: { id: res.body.data.id } });
    expect([t.websiteId, t.projectId, t.creatorId]).toEqual([moz.id, mozProject.id, gur.id]);
    // view and update their own task
    await gur.agent.get(`${API}/tasks/${t.id}`).expect(200);
    await gur.agent.patch(`${API}/tasks/${t.id}`).send({ title: 'Dashboard task on MOZ (edited)' }).expect(200);
    // workflow fields stay with the team
    const wf = await gur.agent.post(`${API}/tasks`).send({ projectId: mozProject.id, title: 'x', status: 'COMPLETED' });
    expect([wf.status, wf.body.error.code]).toEqual([403, 'WORKFLOW_FORBIDDEN']);
  });

  it('cannot create tasks in a project they are not assigned to', async () => {
    const res = await gur.agent.post(`${API}/tasks`).send({ projectId: otherSite.projectId, title: 'Sneaky' });
    expect(res.status).toBe(404);
    expect(await prisma.task.count({ where: { websiteId: otherSite.id } })).toBe(0);
  });
});
