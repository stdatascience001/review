import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { io as connectClient, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeRealtime, initRealtime, type TaskEventPayload } from '../src/lib/realtime';
import { API, PASSWORD, makeApp, prisma, request, resetDb, signUp, type TestUser } from './helpers';

/**
 * Private reporting: Website Users (clients) see only the tasks they created — on the
 * dashboard, in task lists, task details, comments, history, the review widget and in
 * real-time events — enforced by the API. The team (owner, developer) still sees everything.
 */
const app = makeApp();
const server = http.createServer(app);
const ORIGIN = 'https://shop.example.com';
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

let owner: TestUser;
let dev: TestUser;
let alice: TestUser; // client A
let bob: TestUser; // client B (same website, same project)
let websiteId: string;
let siteId: string;
let projectId: string;
let aliceTask: string;
let bobTask: string;
let base = '';
const sockets: Socket[] = [];

const widgetToken = async (email: string) =>
  (await request(app).post(`${API}/widget/auth/login`).set('Origin', ORIGIN).send({ siteId, email, password: PASSWORD })).body.data.session
    .accessToken as string;
const widget = (token: string) => ({
  get: (p: string) => request(app).get(`${API}/widget${p}`).set('Origin', ORIGIN).set('Authorization', `Bearer ${token}`),
  post: (p: string) => request(app).post(`${API}/widget${p}`).set('Origin', ORIGIN).set('Authorization', `Bearer ${token}`),
});
const ids = (res: request.Response) => res.body.data.items.map((t: { id: string }) => t.id).sort();

beforeAll(async () => {
  await resetDb();
  initRealtime(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  [owner, dev, alice, bob] = await Promise.all([
    signUp(app, { name: 'Owner' }),
    signUp(app, { name: 'Dev' }),
    signUp(app, { name: 'Alice Client' }),
    signUp(app, { name: 'Bob Client' }),
  ]);
  const w = (await owner.agent.post(`${API}/websites`).send({ name: 'Shop', url: ORIGIN })).body.data;
  ({ id: websiteId, siteId } = w);
  projectId = (await owner.agent.post(`${API}/websites/${websiteId}/projects`).send({ name: 'Feedback' })).body.data.id;
  for (const [u, role] of [
    [dev, 'DEVELOPER'],
    [alice, 'WEBSITE_USER'],
    [bob, 'WEBSITE_USER'],
  ] as const) {
    await owner.agent.post(`${API}/websites/${websiteId}/members`).send({ email: u.email, role }).expect(201);
    await owner.agent.put(`${API}/websites/${websiteId}/members/${u.id}/projects`).send({ projects: [{ projectId }] }).expect(200);
  }
  aliceTask = (await widget(await widgetToken(alice.email)).post('/tasks').send({ title: 'Alice: checkout bug', pageUrl: `${ORIGIN}/checkout` })).body.data.id;
  bobTask = (await widget(await widgetToken(bob.email)).post('/tasks').send({ title: 'Bob: typo on about', pageUrl: `${ORIGIN}/about` })).body.data.id;
  await dev.agent.post(`${API}/tasks/${aliceTask}/comments`).send({ body: 'Reply for Alice' }).expect(201);
  await dev.agent.post(`${API}/tasks/${bobTask}/comments`).send({ body: 'Reply for Bob' }).expect(201);
});
afterAll(async () => {
  sockets.forEach((s) => s.close());
  await closeRealtime();
  await new Promise((r) => server.close(r));
  await prisma.$disconnect();
});

describe('1 & 3. dashboard and task pages show only the client’s own tasks', () => {
  it('All Tasks / My Tasks / project task list', async () => {
    expect(ids(await alice.agent.get(`${API}/tasks`))).toEqual([aliceTask]);
    expect(ids(await bob.agent.get(`${API}/tasks`))).toEqual([bobTask]);
    expect(ids(await alice.agent.get(`${API}/tasks`).query({ scope: 'created' }))).toEqual([aliceTask]);
    expect(ids(await alice.agent.get(`${API}/projects/${projectId}/tasks`))).toEqual([aliceTask]);
    expect(ids(await alice.agent.get(`${API}/tasks`).query({ q: 'typo' }))).toEqual([]); // search can't find Bob's
  });

  it('dashboard numbers and recent activity are the client’s own', async () => {
    const d = (await alice.agent.get(`${API}/dashboard`)).body.data;
    expect(d.totals.tasks).toBe(1);
    expect(d.totals.openTasks).toBe(1);
    expect(d.recentActivity.every((a: { task: { id: string } }) => a.task.id === aliceTask)).toBe(true);
    expect(JSON.stringify(d)).not.toContain('Bob: typo');
  });

  it('comments feed contains only comments on own tasks', async () => {
    const feed = await alice.agent.get(`${API}/comments`);
    expect(feed.body.data.items.map((c: { body: string }) => c.body)).toEqual(['Reply for Alice']);
  });
});

describe('2 & 5. another client’s task is unreachable through the API', () => {
  it('every task endpoint answers 404 for Bob’s task', async () => {
    const a = alice.agent;
    for (const [name, req] of [
      ['get', a.get(`${API}/tasks/${bobTask}`)],
      ['patch', a.patch(`${API}/tasks/${bobTask}`).send({ title: 'x' })],
      ['delete', a.delete(`${API}/tasks/${bobTask}`)],
      ['comments', a.get(`${API}/tasks/${bobTask}/comments`)],
      ['comment', a.post(`${API}/tasks/${bobTask}/comments`).send({ body: 'hi' })],
      ['activity', a.get(`${API}/tasks/${bobTask}/activity`)],
      ['assignees', a.get(`${API}/tasks/${bobTask}/assignees`)],
      ['read', a.post(`${API}/tasks/${bobTask}/read`)],
      ['upload', a.post(`${API}/tasks/${bobTask}/attachments`).set('Content-Type', 'image/png').send(PNG)],
    ] as const) {
      const res = await req;
      expect([name, res.status]).toEqual([name, 404]);
    }
    const bobComment = await prisma.taskComment.findFirstOrThrow({ where: { taskId: bobTask } });
    await alice.agent.patch(`${API}/comments/${bobComment.id}`).send({ body: 'x' }).expect(404);
    await alice.agent.delete(`${API}/comments/${bobComment.id}`).expect(404);
    expect(await prisma.taskComment.count({ where: { taskId: bobTask } })).toBe(1); // untouched
  });

  it('the client still has full access to their own task', async () => {
    const t = await alice.agent.get(`${API}/tasks/${aliceTask}`);
    expect(t.status).toBe(200);
    expect(t.body.data.permissions).toMatchObject({ update: true, comment: true, upload: true, manage: false });
    await alice.agent.post(`${API}/tasks/${aliceTask}/comments`).send({ body: 'Thanks!' }).expect(201);
    expect((await alice.agent.get(`${API}/tasks/${aliceTask}/comments`)).body.data.items).toHaveLength(2);
  });
});

describe('4. review widget popup shows only the client’s data', () => {
  it('list, counts, badge, details and comments', async () => {
    const w = widget(await widgetToken(alice.email));
    const list = await w.get('/tasks');
    expect(ids(list)).toEqual([aliceTask]);
    expect(list.body.data.counts).toEqual({ all: 1, open: 1, in_progress: 0, done: 0, archived: 0 });
    expect((await w.get('/me')).body.data.counts.open).toBe(1);
    await w.get(`/tasks/${bobTask}`).expect(404);
    await w.get(`/tasks/${bobTask}/comments`).expect(404);
    await w.get(`/tasks/${bobTask}/activity`).expect(404);
    await w.post(`/tasks/${bobTask}/comments`).send({ body: 'x' }).expect(404);
    expect((await w.get(`/tasks?pageUrl=${encodeURIComponent(`${ORIGIN}/about`)}`)).body.data.items).toEqual([]);
  });
});

describe('the team keeps its full view (nothing else changed)', () => {
  it('owner and developer still see and work on every task', async () => {
    expect(ids(await owner.agent.get(`${API}/tasks`))).toEqual([aliceTask, bobTask].sort());
    expect(ids(await dev.agent.get(`${API}/tasks`))).toEqual([aliceTask, bobTask].sort());
    await dev.agent.patch(`${API}/tasks/${bobTask}`).send({ status: 'IN_PROGRESS' }).expect(200);
    expect((await owner.agent.get(`${API}/dashboard`)).body.data.totals.tasks).toBe(2);
    const w = widget(await widgetToken(owner.email));
    expect(ids(await w.get('/tasks'))).toEqual([aliceTask, bobTask].sort());
  });
});

describe('real-time events respect the same rule', () => {
  const cookieFor = async (email: string) => {
    const res = await request(app).post(`${API}/auth/login`).send({ email, password: PASSWORD });
    return (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
  };
  const open = (path: string, opts: Parameters<typeof connectClient>[1]) =>
    new Promise<TaskEventPayload[]>((resolve, reject) => {
      const s = connectClient(`${base}${path}`, { transports: ['websocket'], reconnection: false, forceNew: true, ...opts });
      sockets.push(s);
      const events: TaskEventPayload[] = [];
      s.on('task:event', (e: TaskEventPayload) => events.push(e));
      s.on('ready', () => resolve(events));
      s.on('connect_error', reject);
    });

  it('a client only receives events about their own tasks', async () => {
    const aliceDash = await open('/', { extraHeaders: { cookie: await cookieFor(alice.email) } });
    const aliceWidget = await open('/widget', { auth: { token: await widgetToken(alice.email) }, extraHeaders: { origin: ORIGIN } });
    const ownerDash = await open('/', { extraHeaders: { cookie: await cookieFor(owner.email) } });

    await dev.agent.patch(`${API}/tasks/${bobTask}`).send({ status: 'COMPLETED' }).expect(200); // Bob's task
    await dev.agent.patch(`${API}/tasks/${aliceTask}`).send({ status: 'IN_PROGRESS' }).expect(200); // Alice's task
    const deadline = Date.now() + 4000;
    while (!(ownerDash.length >= 2 && aliceDash.length >= 1 && aliceWidget.length >= 1) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    await new Promise((r) => setTimeout(r, 300));
    expect(ownerDash.map((e) => e.task.id).sort()).toEqual([aliceTask, bobTask].sort());
    expect(aliceDash.map((e) => e.task.id)).toEqual([aliceTask]);
    expect(aliceWidget.map((e) => e.task.id)).toEqual([aliceTask]);
    expect(JSON.stringify([...aliceDash, ...aliceWidget])).not.toContain('Bob: typo');
  });
});
