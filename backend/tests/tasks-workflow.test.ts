import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { API, makeApp, prisma, resetDb, signUp, type TestUser } from './helpers';

const app = makeApp();

let pm: TestUser; // website owner / project manager
let dev: TestUser; // contributor
let reviewer: TestUser; // client reviewer
let websiteId: string;
let projectId: string;
let taskId: string;

beforeAll(async () => {
  await resetDb();
  [pm, dev, reviewer] = await Promise.all([
    signUp(app, { name: 'PM' }),
    signUp(app, { name: 'Dev' }),
    signUp(app, { name: 'Reviewer' }),
  ]);
  websiteId = (await pm.agent.post(`${API}/websites`).send({ name: 'Shop', url: 'https://shop.example' })).body.data.id;
  await pm.agent.post(`${API}/websites/${websiteId}/members`).send({ email: dev.email, role: 'DEVELOPER' });
  await pm.agent.post(`${API}/websites/${websiteId}/members`).send({ email: reviewer.email, role: 'WEBSITE_USER' });
  projectId = (
    await pm.agent
      .post(`${API}/websites/${websiteId}/projects`)
      .send({ name: 'Launch QA', startDate: '2026-11-01', dueDate: '2026-12-01' })
  ).body.data.id;
  await pm.agent.post(`${API}/projects/${projectId}/members`).send({ userId: dev.id, role: 'CONTRIBUTOR' });
  await pm.agent.post(`${API}/projects/${projectId}/members`).send({ userId: reviewer.id, role: 'REVIEWER' });
});
afterAll(() => prisma.$disconnect());

describe('projects', () => {
  it('validates dates and unique names per website', async () => {
    const bad = await pm.agent
      .post(`${API}/websites/${websiteId}/projects`)
      .send({ name: 'Bad dates', startDate: '2026-12-01', dueDate: '2026-11-01' });
    expect(bad.status).toBe(400);
    const dup = await pm.agent.post(`${API}/websites/${websiteId}/projects`).send({ name: 'Launch QA' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('PROJECT_NAME_TAKEN');
    const patch = await pm.agent.patch(`${API}/projects/${projectId}`).send({ dueDate: '2026-10-01' });
    expect(patch.status).toBe(400);
  });
});

describe('task lifecycle', () => {
  it('reviewer files feedback (cannot assign); the manager assigns it → assignee is notified', async () => {
    const body = {
      title: 'Checkout button overlaps footer on mobile',
      description: 'Seen on iPhone 15',
      type: 'BUG',
      priority: 'HIGH',
      pageUrl: 'https://shop.example/checkout',
    };
    const denied = await reviewer.agent.post(`${API}/projects/${projectId}/tasks`).send({ ...body, assigneeId: dev.id });
    expect([denied.status, denied.body.error.code]).toEqual([403, 'WORKFLOW_FORBIDDEN']);
    const res = await reviewer.agent.post(`${API}/projects/${projectId}/tasks`).send(body);
    expect(res.status).toBe(201);
    taskId = res.body.data.id;
    expect(res.body.data).toMatchObject({ status: 'OPEN', websiteId, priority: 'HIGH', assignee: null, creator: { id: reviewer.id } });
    expect(res.body.data.key).toMatch(/^TASK-\d+$/);

    await pm.agent.patch(`${API}/tasks/${taskId}`).send({ assigneeId: dev.id }).expect(200);
    const n = await dev.agent.get(`${API}/notifications`);
    expect(n.body.data.items[0]).toMatchObject({ type: 'TASK_ASSIGNED', taskId, actor: { id: pm.id } });
  });

  it('lists with filters, search and sorting', async () => {
    await dev.agent.post(`${API}/projects/${projectId}/tasks`).send({ title: 'Typo on about page', type: 'IMPROVEMENT', priority: 'LOW' });
    const all = await dev.agent.get(`${API}/projects/${projectId}/tasks`);
    expect(all.body.data.pagination.total).toBe(2);

    const bugs = await dev.agent.get(`${API}/projects/${projectId}/tasks`).query({ type: 'BUG' });
    expect(bugs.body.data.items).toHaveLength(1);
    const mine = await dev.agent.get(`${API}/projects/${projectId}/tasks`).query({ assigneeId: 'me' });
    expect(mine.body.data.items.map((t: { id: string }) => t.id)).toEqual([taskId]);
    const multi = await dev.agent.get(`${API}/projects/${projectId}/tasks`).query({ priority: 'LOW,HIGH', sort: 'priority', order: 'desc' });
    expect(multi.body.data.items.map((t: { priority: string }) => t.priority)).toEqual(['HIGH', 'LOW']);
    const search = await dev.agent.get(`${API}/projects/${projectId}/tasks`).query({ q: 'TYPO' });
    expect(search.body.data.items).toHaveLength(1);
    await dev.agent.get(`${API}/projects/${projectId}/tasks`).query({ status: 'NOPE' }).expect(400);
    const paged = await dev.agent.get(`${API}/projects/${projectId}/tasks`).query({ pageSize: 1, page: 2 });
    expect(paged.body.data).toMatchObject({ pagination: { page: 2, pageSize: 1, total: 2, totalPages: 2 } });
  });

  it('status changes record activity, set completedAt, and notify creator', async () => {
    await dev.agent.patch(`${API}/tasks/${taskId}`).send({ status: 'IN_PROGRESS' }).expect(200);
    const done = await dev.agent.patch(`${API}/tasks/${taskId}`).send({ status: 'COMPLETED', title: 'Checkout button overlaps footer' });
    expect(done.status).toBe(200);
    expect(done.body.data.completedAt).not.toBeNull();

    const activity = await pm.agent.get(`${API}/tasks/${taskId}/activity`);
    const types = activity.body.data.items.map((a: { type: string }) => a.type);
    expect(types).toEqual(expect.arrayContaining(['CREATED', 'STARTED', 'COMPLETED', 'UPDATED']));
    const completed = activity.body.data.items.find((a: { type: string }) => a.type === 'COMPLETED');
    expect(completed).toMatchObject({ field: 'status', previousValue: 'IN_PROGRESS', newValue: 'COMPLETED', actor: { id: dev.id } });

    const n = await reviewer.agent.get(`${API}/notifications`).query({ unreadOnly: 'true' });
    expect(n.body.data.items.filter((x: { type: string }) => x.type === 'TASK_STATUS_CHANGED')).toHaveLength(2);

    const reopened = await dev.agent.patch(`${API}/tasks/${taskId}`).send({ status: 'REOPENED' });
    expect(reopened.body.data).toMatchObject({ status: 'REOPENED', completedAt: null });
    const again = await dev.agent.patch(`${API}/tasks/${taskId}`).send({ status: 'REOPENED' });
    expect(again.status).toBe(200); // no-op
    await dev.agent.patch(`${API}/tasks/${taskId}`).send({ status: 'OPEN' }).expect(200);
    const invalid = await dev.agent.patch(`${API}/tasks/${taskId}`).send({ status: 'REOPENED' });
    expect([invalid.status, invalid.body.error.code]).toEqual([400, 'INVALID_TRANSITION']);
  });

  it('reassignment and unassignment are logged', async () => {
    await pm.agent.patch(`${API}/tasks/${taskId}`).send({ assigneeId: pm.id }).expect(200);
    await pm.agent.patch(`${API}/tasks/${taskId}`).send({ assigneeId: null }).expect(200);
    const activity = await pm.agent.get(`${API}/tasks/${taskId}/activity`);
    const types = activity.body.data.items.map((a: { type: string }) => a.type);
    expect(types).toEqual(expect.arrayContaining(['ASSIGNED', 'UNASSIGNED']));
  });
});

describe('comments', () => {
  let rootId: string;

  it('threads replies one level deep and notifies participants', async () => {
    const root = await dev.agent.post(`${API}/tasks/${taskId}/comments`).send({ body: 'Can you share a screenshot?' });
    expect(root.status).toBe(201);
    rootId = root.body.data.id;
    const reply = await reviewer.agent.post(`${API}/tasks/${taskId}/comments`).send({ body: 'Attached!', parentId: rootId });
    const nested = await dev.agent.post(`${API}/tasks/${taskId}/comments`).send({ body: 'Thanks', parentId: reply.body.data.id });
    expect(nested.body.data.parentId).toBe(rootId); // flattened to the root

    const list = await pm.agent.get(`${API}/tasks/${taskId}/comments`);
    expect(list.body.data.items.map((c: { body: string }) => c.body)).toEqual(['Can you share a screenshot?', 'Attached!', 'Thanks']);

    // dev's root comment → reviewer (task creator) notified; reviewer's reply → dev (parent author) notified
    const rn = await reviewer.agent.get(`${API}/notifications`);
    expect(rn.body.data.items.some((n: { type: string; body: string }) => n.type === 'TASK_COMMENTED' && n.body === 'Can you share a screenshot?')).toBe(true);
    const dn = await dev.agent.get(`${API}/notifications`);
    expect(dn.body.data.items.some((n: { type: string; body: string }) => n.type === 'TASK_COMMENTED' && n.body === 'Attached!')).toBe(true);
  });

  it('rejects parents from another task, and empty bodies', async () => {
    const other = await dev.agent.post(`${API}/projects/${projectId}/tasks`).send({ title: 'Other' });
    const res = await dev.agent.post(`${API}/tasks/${other.body.data.id}/comments`).send({ body: 'x', parentId: rootId });
    expect(res.status).toBe(400);
    await dev.agent.post(`${API}/tasks/${taskId}/comments`).send({ body: '   ' }).expect(400);
  });

  it('only the author edits; author or manager deletes', async () => {
    await reviewer.agent.patch(`${API}/comments/${rootId}`).send({ body: 'edited by someone else' }).expect(403);
    const edit = await dev.agent.patch(`${API}/comments/${rootId}`).send({ body: 'Could you share a screenshot?' });
    expect(edit.status).toBe(200);
    expect(edit.body.data.editedAt).not.toBeNull();

    await reviewer.agent.delete(`${API}/comments/${rootId}`).expect(403);
    await pm.agent.delete(`${API}/comments/${rootId}`).expect(204);
    // Replies cascade with the root comment
    const list = await pm.agent.get(`${API}/tasks/${taskId}/comments`);
    expect(list.body.data.items).toHaveLength(0);
  });
});

describe('notifications', () => {
  it('counts, marks read, marks all read, deletes — only the owner’s own', async () => {
    const count = await dev.agent.get(`${API}/notifications/unread-count`);
    expect(count.body.data.count).toBeGreaterThan(0);

    const list = await dev.agent.get(`${API}/notifications`);
    const first = list.body.data.items[0].id;
    // Another user cannot touch it
    await reviewer.agent.patch(`${API}/notifications/${first}/read`).expect(404);
    await reviewer.agent.delete(`${API}/notifications/${first}`).expect(404);

    await dev.agent.patch(`${API}/notifications/${first}/read`).expect(204);
    const after = await dev.agent.get(`${API}/notifications/unread-count`);
    expect(after.body.data.count).toBe(count.body.data.count - 1);

    await dev.agent.post(`${API}/notifications/read-all`).expect(200);
    expect((await dev.agent.get(`${API}/notifications/unread-count`)).body.data.count).toBe(0);
    await dev.agent.delete(`${API}/notifications/${first}`).expect(204);
  });

  it('actors are not notified about their own actions', async () => {
    const before = await prisma.notification.count({ where: { userId: pm.id } });
    await pm.agent.post(`${API}/projects/${projectId}/tasks`).send({ title: 'Self-assigned', assigneeId: pm.id });
    expect(await prisma.notification.count({ where: { userId: pm.id } })).toBe(before);
  });
});

describe('cascade deletes', () => {
  it('deleting a task removes its comments and activity; deleting the website removes everything', async () => {
    await dev.agent.post(`${API}/tasks/${taskId}/comments`).send({ body: 'bye' });
    await reviewer.agent.delete(`${API}/tasks/${taskId}`).expect(204); // creator may delete own
    expect(await prisma.taskComment.count({ where: { taskId } })).toBe(0);
    expect(await prisma.taskActivity.count({ where: { taskId } })).toBe(0);

    await pm.agent.delete(`${API}/websites/${websiteId}`).expect(204);
    expect(await prisma.project.count({ where: { websiteId } })).toBe(0);
    expect(await prisma.task.count({ where: { websiteId } })).toBe(0);
    expect(await prisma.websiteMember.count({ where: { websiteId } })).toBe(0);
    expect(await prisma.websiteSettings.count({ where: { websiteId } })).toBe(0);
  });
});
