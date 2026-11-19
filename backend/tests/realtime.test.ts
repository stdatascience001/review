import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { io as connectClient, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeRealtime, initRealtime, type TaskEventPayload } from '../src/lib/realtime';
import { API, PASSWORD, makeApp, prisma, request, resetDb, signUp, type TestUser } from './helpers';

/**
 * Real-time notifications over a real Socket.IO server: authentication, origin policy,
 * per-user authorization (only people who can see the task get its events), widget sockets
 * bound to one website, every event type of the task workflow, and disconnect on logout.
 */
const app = makeApp();
const server = http.createServer(app);
let base = '';
const ORIGIN_A = 'https://shop-a.example.com';
const ORIGIN_B = 'https://shop-b.example.com';

let ownerA: TestUser;
let devA: TestUser; // project member (contributor)
let devA2: TestUser; // website developer, NOT in the project
let clientA: TestUser; // reporter
let ownerB: TestUser; // another tenant
let siteA: string;
let siteB: string;
let websiteA: string;
let projectA: string;
const sockets: Socket[] = [];

const cookieFor = async (email: string) => {
  const res = await request(app).post(`${API}/auth/login`).send({ email, password: PASSWORD });
  const raw = res.headers['set-cookie'] as unknown as string[];
  return raw.map((c) => c.split(';')[0]).join('; ');
};
const widgetToken = async (email: string, siteId: string, origin: string) =>
  (await request(app).post(`${API}/widget/auth/login`).set('Origin', origin).send({ siteId, email, password: PASSWORD })).body.data.session
    .accessToken as string;

const open = (path: string, opts: Parameters<typeof connectClient>[1]) =>
  new Promise<{ socket: Socket; events: TaskEventPayload[] }>((resolve, reject) => {
    const socket = connectClient(`${base}${path}`, { transports: ['websocket'], reconnection: false, forceNew: true, ...opts });
    sockets.push(socket);
    const events: TaskEventPayload[] = [];
    socket.on('task:event', (e: TaskEventPayload) => events.push(e));
    socket.on('ready', () => resolve({ socket, events }));
    socket.on('connect_error', (err) => reject(err));
  });
const dashboard = async (email: string) => open('/', { extraHeaders: { cookie: await cookieFor(email) } });
const widgetSocket = async (email: string, siteId: string, origin: string) =>
  open('/widget', { auth: { token: await widgetToken(email, siteId, origin) }, extraHeaders: { origin } });

const waitFor = async (check: () => boolean, ms = 4000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting for real-time event');
    await new Promise((r) => setTimeout(r, 25));
  }
};
const settle = () => new Promise((r) => setTimeout(r, 300));
const types = (events: TaskEventPayload[]): string[] => events.map((e) => e.type);

beforeAll(async () => {
  await resetDb();
  initRealtime(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  [ownerA, devA, devA2, clientA, ownerB] = await Promise.all([
    signUp(app, { name: 'Owner A' }),
    signUp(app, { name: 'Dev A' }),
    signUp(app, { name: 'Dev A2' }),
    signUp(app, { name: 'Client A' }),
    signUp(app, { name: 'Owner B' }),
  ]);
  const a = (await ownerA.agent.post(`${API}/websites`).send({ name: 'Shop A', url: ORIGIN_A })).body.data;
  const b = (await ownerB.agent.post(`${API}/websites`).send({ name: 'Shop B', url: ORIGIN_B })).body.data;
  [websiteA, siteA, siteB] = [a.id, a.siteId, b.siteId];
  projectA = (await ownerA.agent.post(`${API}/websites/${websiteA}/projects`).send({ name: 'QA' })).body.data.id;
  for (const [u, role] of [
    [devA, 'DEVELOPER'],
    [devA2, 'DEVELOPER'],
    [clientA, 'WEBSITE_USER'],
  ] as const) {
    await ownerA.agent.post(`${API}/websites/${websiteA}/members`).send({ email: u.email, role }).expect(201);
  }
  for (const u of [devA, clientA]) {
    await ownerA.agent.put(`${API}/websites/${websiteA}/members/${u.id}/projects`).send({ projects: [{ projectId: projectA }] }).expect(200);
  }
});

afterAll(async () => {
  sockets.forEach((s) => s.close());
  await closeRealtime();
  await new Promise((r) => server.close(r));
  await prisma.$disconnect();
});

describe('socket authentication', () => {
  it('rejects anonymous, forged and foreign-origin dashboard sockets', async () => {
    await expect(open('/', {})).rejects.toThrow(/UNAUTHORIZED/);
    await expect(open('/', { extraHeaders: { cookie: 'wrtm_at=not-a-jwt' } })).rejects.toThrow(/TOKEN_INVALID/);
    const cookie = await cookieFor(ownerA.email);
    await expect(open('/', { extraHeaders: { cookie, origin: 'https://evil.example.net' } })).rejects.toThrow(/ORIGIN_NOT_ALLOWED/);
  });

  it('rejects widget sockets with a bad token, a dashboard token, or from another site', async () => {
    await expect(open('/widget', { auth: { token: 'nope' }, extraHeaders: { origin: ORIGIN_A } })).rejects.toThrow(/TOKEN_INVALID/);
    const dashboardToken = (await cookieFor(ownerA.email)).match(/wrtm_at=([^;]+)/)![1];
    await expect(open('/widget', { auth: { token: dashboardToken }, extraHeaders: { origin: ORIGIN_A } })).rejects.toThrow(/TOKEN_INVALID/);
    const token = await widgetToken(clientA.email, siteA, ORIGIN_A);
    await expect(open('/widget', { auth: { token }, extraHeaders: { origin: ORIGIN_B } })).rejects.toThrow(/DOMAIN_NOT_ALLOWED/);
  });
});

describe('task events reach exactly the authorized users', () => {
  let owner: Awaited<ReturnType<typeof dashboard>>;
  let dev: Awaited<ReturnType<typeof dashboard>>;
  let otherDev: Awaited<ReturnType<typeof dashboard>>;
  let outsider: Awaited<ReturnType<typeof dashboard>>;
  let reporterWidget: Awaited<ReturnType<typeof widgetSocket>>;
  let reporterDash: Awaited<ReturnType<typeof dashboard>>;
  let outsiderWidget: Awaited<ReturnType<typeof widgetSocket>>;
  let taskId: string;
  let rootCommentId: string;

  beforeAll(async () => {
    [owner, dev, otherDev, outsider, reporterWidget, reporterDash, outsiderWidget] = await Promise.all([
      dashboard(ownerA.email),
      dashboard(devA.email),
      dashboard(devA2.email),
      dashboard(ownerB.email),
      widgetSocket(clientA.email, siteA, ORIGIN_A),
      dashboard(clientA.email),
      widgetSocket(ownerB.email, siteB, ORIGIN_B),
    ]);
  });

  it('New Task Created → owner, project members and the reporter (widget); nobody else', async () => {
    const res = await request(app)
      .post(`${API}/widget/tasks`)
      .set('Origin', ORIGIN_A)
      .set('Authorization', `Bearer ${await widgetToken(clientA.email, siteA, ORIGIN_A)}`)
      .send({ title: 'Footer overlaps', type: 'BUG', priority: 'HIGH', pageUrl: `${ORIGIN_A}/` });
    expect(res.status).toBe(201);
    taskId = res.body.data.id;

    await waitFor(() => owner.events.length > 0 && dev.events.length > 0 && reporterWidget.events.length > 0);
    const e = owner.events[0]!;
    expect(e).toMatchObject({
      type: 'task.created',
      personal: false,
      task: { id: taskId, key: res.body.data.key, title: 'Footer overlaps', status: 'OPEN', websiteId: websiteA },
      actor: { name: 'Client A' },
    });
    expect(e.message).toBe(`Client A created ${res.body.data.key}: Footer overlaps`);
    await settle();
    expect(otherDev.events).toEqual([]); // website developer without access to this project
    expect(outsider.events).toEqual([]); // other tenant
    expect(outsiderWidget.events).toEqual([]);
  });

  it('Task Assigned → personal for the developer', async () => {
    await ownerA.agent.patch(`${API}/tasks/${taskId}`).send({ assigneeId: devA.id }).expect(200);
    await waitFor(() => types(dev.events).includes('task.assigned'));
    const e = dev.events.find((x) => x.type === 'task.assigned')!;
    expect(e).toMatchObject({ personal: true, task: { assigneeId: devA.id }, message: expect.stringContaining('assigned') });
    expect(e.message).toContain('to Dev A');
    await waitFor(() => types(owner.events).includes('task.assigned'));
    expect(owner.events.find((x) => x.type === 'task.assigned')!.personal).toBe(false); // owner is the actor
  });

  it('Task Started / Status Updated / Completed / Reopened → the reporter sees each live', async () => {
    await devA.agent.patch(`${API}/tasks/${taskId}`).send({ status: 'IN_PROGRESS' }).expect(200);
    await devA.agent.patch(`${API}/tasks/${taskId}`).send({ status: 'IN_REVIEW' }).expect(200);
    await devA.agent.patch(`${API}/tasks/${taskId}`).send({ status: 'COMPLETED' }).expect(200);
    await ownerA.agent.patch(`${API}/tasks/${taskId}`).send({ status: 'REOPENED' }).expect(200);
    const want = ['task.started', 'task.status_updated', 'task.completed', 'task.reopened'];
    await waitFor(() => want.every((t) => types(reporterWidget.events).includes(t)));
    const seen = reporterWidget.events.filter((e) => want.includes(e.type));
    expect(seen.map((e) => [e.type, e.task.status, e.personal])).toEqual([
      ['task.started', 'IN_PROGRESS', true],
      ['task.status_updated', 'IN_REVIEW', true],
      ['task.completed', 'COMPLETED', true],
      ['task.reopened', 'REOPENED', true],
    ]);
    expect(seen[0]!.message).toMatch(/^Dev A started TASK-\d+$/);
    expect(seen[1]!.message).toMatch(/moved TASK-\d+ to under review$/);
    // Same events on the reporter's dashboard socket
    await waitFor(() => want.every((t) => types(reporterDash.events).includes(t)));
    await settle();
    expect(outsider.events).toEqual([]);
    expect(otherDev.events).toEqual([]);
  });

  it('New Comment and New Reply (personal for the replied-to author)', async () => {
    const c = await devA.agent.post(`${API}/tasks/${taskId}/comments`).send({ body: 'Please re-test' });
    rootCommentId = c.body.data.id;
    await waitFor(() => types(reporterWidget.events).includes('comment.created'));
    expect(reporterWidget.events.find((e) => e.type === 'comment.created')).toMatchObject({ personal: true, commentId: rootCommentId });

    await request(app)
      .post(`${API}/widget/tasks/${taskId}/comments`)
      .set('Origin', ORIGIN_A)
      .set('Authorization', `Bearer ${await widgetToken(clientA.email, siteA, ORIGIN_A)}`)
      .send({ body: 'Still broken on Safari', parentId: rootCommentId })
      .expect(201);
    await waitFor(() => types(dev.events).includes('comment.reply'));
    const reply = dev.events.find((e) => e.type === 'comment.reply')!;
    expect(reply.personal).toBe(true); // dev wrote the parent comment (and is the assignee)
    expect(reply.message).toContain('replied on');
    await settle();
    expect(outsider.events).toEqual([]);
    expect(outsiderWidget.events).toEqual([]);
  });

  it('access changes apply immediately: removing someone from the project stops their events', async () => {
    await ownerA.agent.put(`${API}/websites/${websiteA}/members/${devA.id}/projects`).send({ projects: [] }).expect(200);
    const before = dev.events.length;
    await ownerA.agent.patch(`${API}/tasks/${taskId}`).send({ priority: 'LOW' }).expect(200);
    await waitFor(() => types(owner.events).includes('task.updated'));
    await settle();
    expect(dev.events.length).toBe(before);
    await ownerA.agent.put(`${API}/websites/${websiteA}/members/${devA.id}/projects`).send({ projects: [{ projectId: projectA }] }).expect(200);
  });

  it('logging out disconnects that session’s socket', async () => {
    const cookie = await cookieFor(ownerA.email);
    const { socket } = await open('/', { extraHeaders: { cookie } });
    const closed = new Promise<string>((r) => socket.on('disconnect', (reason) => r(reason)));
    await request(app).post(`${API}/auth/logout`).set('Cookie', cookie).expect(204);
    expect(await closed).toBe('io server disconnect');
    await expect(open('/', { extraHeaders: { cookie } })).rejects.toThrow(/SESSION_EXPIRED/);
  });
});
