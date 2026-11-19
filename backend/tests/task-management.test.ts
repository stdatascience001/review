import fs from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { API, PASSWORD, makeApp, prisma, request, resetDb, signUp, type TestUser } from './helpers';

/**
 * Task 4: the complete task workflow through the real API —
 * reporter creates a task in the widget → admin assigns a developer → developer starts,
 * reviews and completes it → reopen/archive/restore, with comments, replies, unread
 * indicators, attachments and the activity log.
 */
const app = makeApp();
const W = `${API}/widget`;
const ORIGIN = 'https://shop.example.com';
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n');

let owner: TestUser; // website OWNER (admin)
let dev: TestUser; // DEVELOPER → project CONTRIBUTOR
let dev2: TestUser;
let client: TestUser; // WEBSITE_USER → project REVIEWER (reporter)
let websiteId: string;
let siteId: string;
let projectId: string;
let clientToken: string;
let devToken: string;
let taskId: string;
let taskNumber: number;

const widget = (token: string) => ({
  get: (p: string) => request(app).get(`${W}${p}`).set('Origin', ORIGIN).set('Authorization', `Bearer ${token}`),
  post: (p: string) => request(app).post(`${W}${p}`).set('Origin', ORIGIN).set('Authorization', `Bearer ${token}`),
  patch: (p: string) => request(app).patch(`${W}${p}`).set('Origin', ORIGIN).set('Authorization', `Bearer ${token}`),
  del: (p: string) => request(app).delete(`${W}${p}`).set('Origin', ORIGIN).set('Authorization', `Bearer ${token}`),
});
const widgetLogin = async (email: string) =>
  (await request(app).post(`${W}/auth/login`).set('Origin', ORIGIN).send({ siteId, email, password: PASSWORD })).body.data.session
    .accessToken as string;

beforeAll(async () => {
  await resetDb();
  [owner, dev, dev2, client] = await Promise.all([
    signUp(app, { name: 'Olivia Owner' }),
    signUp(app, { name: 'Dev One' }),
    signUp(app, { name: 'Dev Two' }),
    signUp(app, { name: 'Clara Client' }),
  ]);
  const w = await owner.agent.post(`${API}/websites`).send({ name: 'Shop', url: ORIGIN });
  ({ id: websiteId, siteId } = w.body.data);
  projectId = (await owner.agent.post(`${API}/websites/${websiteId}/projects`).send({ name: 'Launch' })).body.data.id;
  for (const [u, role] of [
    [dev, 'DEVELOPER'],
    [dev2, 'DEVELOPER'],
    [client, 'WEBSITE_USER'],
  ] as const) {
    await owner.agent.post(`${API}/websites/${websiteId}/members`).send({ email: u.email, role }).expect(201);
    await owner.agent.put(`${API}/websites/${websiteId}/members/${u.id}/projects`).send({ projects: [{ projectId }] }).expect(200);
  }
  clientToken = await widgetLogin(client.email);
  devToken = await widgetLogin(dev.email);
});
afterAll(() => prisma.$disconnect());

describe('1–2. create task from the widget', () => {
  it('saves the task with a unique Task ID and auto-captured context', async () => {
    const before = await widget(clientToken).get('/me');
    expect(before.body.data.counts.open).toBe(0);

    const res = await widget(clientToken)
      .post('/tasks')
      .send({
        title: 'Checkout button hidden behind footer',
        description: 'On 1366×768 the Pay button is under the cookie bar.',
        type: 'UI_ISSUE',
        priority: 'HIGH',
        pageUrl: `${ORIGIN}/checkout?step=2`,
        pageTitle: 'Checkout — Shop',
        context: { viewport: { width: 1366, height: 768 } },
      });
    expect(res.status).toBe(201);
    taskId = res.body.data.id;
    taskNumber = res.body.data.number;
    expect(res.body.data).toMatchObject({
      key: `TASK-${taskNumber}`,
      status: 'OPEN',
      type: 'UI_ISSUE',
      priority: 'HIGH',
      pageTitle: 'Checkout — Shop',
      creator: { id: client.id },
      project: { id: projectId },
    });

    // What was stored: website, reporter, time, page URL + title
    const row = await prisma.task.findUniqueOrThrow({ where: { id: taskId } });
    expect(row).toMatchObject({ websiteId, creatorId: client.id, pageUrl: `${ORIGIN}/checkout?step=2` });
    expect(row.metadata).toMatchObject({ source: 'widget', pageTitle: 'Checkout — Shop' });
    expect(Date.now() - row.createdAt.getTime()).toBeLessThan(60_000);

    // Task IDs are unique and sequential
    const second = await widget(clientToken).post('/tasks').send({ title: 'Logo slightly blurry', type: 'IMPROVEMENT', priority: 'LOW', pageUrl: `${ORIGIN}/` });
    expect(second.body.data.number).toBe(taskNumber + 1);

    // Open-task count in the widget updates
    expect((await widget(clientToken).get('/me')).body.data.counts.open).toBe(2);
  });

  it('validates task type and priority', async () => {
    const bad = await widget(clientToken).post('/tasks').send({ title: 'x', type: 'FEEDBACK', pageUrl: `${ORIGIN}/` });
    expect(bad.status).toBe(400);
    const badP = await widget(clientToken).post('/tasks').send({ title: 'x', priority: 'CRITICAL', pageUrl: `${ORIGIN}/` });
    expect(badP.status).toBe(400);
  });

  it('uploads the screenshot and additional files to storage; rejects unsafe files', async () => {
    const shot = await widget(clientToken)
      .post(`/tasks/${taskId}/attachments?kind=screenshot`)
      .set('Content-Type', 'image/png')
      .set('X-File-Name', encodeURIComponent('checkout screen.png'))
      .send(PNG);
    expect(shot.status).toBe(201);
    expect(shot.body.data).toMatchObject({ kind: 'SCREENSHOT', fileName: 'checkout screen.png', mimeType: 'image/png' });

    const pdf = await widget(clientToken)
      .post(`/tasks/${taskId}/attachments?kind=file`)
      .set('Content-Type', 'application/pdf')
      .set('X-File-Name', 'steps.pdf')
      .send(PDF);
    expect(pdf.status).toBe(201);
    expect(pdf.body.data).toMatchObject({ kind: 'FILE', mimeType: 'application/pdf' });
    // Non-images download instead of rendering inline
    const u = new URL(pdf.body.data.url);
    const dl = await request(app).get(u.pathname + u.search);
    expect(dl.headers['content-disposition']).toMatch(/^attachment;/);

    const html = await widget(clientToken)
      .post(`/tasks/${taskId}/attachments?kind=file`)
      .set('Content-Type', 'text/html')
      .set('X-File-Name', 'evil.html')
      .send(Buffer.from('<script>alert(1)</script>'));
    expect(html.body.error.code).toBe('INVALID_FILE');
    const pdfAsShot = await widget(clientToken)
      .post(`/tasks/${taskId}/attachments?kind=screenshot`)
      .set('Content-Type', 'application/pdf')
      .send(PDF);
    expect(pdfAsShot.body.error.code).toBe('INVALID_IMAGE');

    const detail = await widget(clientToken).get(`/tasks/${taskId}`);
    expect(detail.body.data.screenshotUrl).toContain('/api/v1/files/');
    expect(detail.body.data.attachments.map((a: { kind: string }) => a.kind)).toEqual(['SCREENSHOT', 'FILE']);
    const stored = await prisma.taskAttachment.findMany({ where: { taskId } });
    for (const a of stored) expect(fs.existsSync(`${process.env.UPLOAD_DIR}/${a.storageKey}`)).toBe(true);
  });

  it('shows up in the admin dashboard with its Task ID (also searchable by ID)', async () => {
    const list = await owner.agent.get(`${API}/tasks`).query({ websiteId });
    const row = list.body.data.items.find((t: { id: string }) => t.id === taskId);
    expect(row).toMatchObject({ key: `TASK-${taskNumber}`, status: 'OPEN', priority: 'HIGH', creator: { id: client.id } });
    const byKey = await owner.agent.get(`${API}/tasks`).query({ q: `TASK-${taskNumber}` });
    expect(byKey.body.data.items.map((t: { id: string }) => t.id)).toEqual([taskId]);
  });
});

describe('3. statuses & who can change them', () => {
  it('the reporter can edit their task but not run the workflow', async () => {
    const edit = await widget(clientToken).patch(`/tasks/${taskId}`).send({ title: 'Checkout Pay button hidden behind footer' });
    expect(edit.status).toBe(200);
    for (const body of [{ status: 'IN_PROGRESS' }, { priority: 'URGENT' }, { assigneeId: dev.id }, { status: 'ARCHIVED' }]) {
      const res = await widget(clientToken).patch(`/tasks/${taskId}`).send(body);
      expect([res.status, res.body.error.code]).toEqual([403, 'WORKFLOW_FORBIDDEN']);
    }
  });

  it('only developers/managers of the project can be assigned', async () => {
    const res = await owner.agent.get(`${API}/tasks/${taskId}/assignees`);
    expect(res.body.data.map((a: { user: { name: string } }) => a.user.name)).toEqual(['Dev One', 'Dev Two', 'Olivia Owner']);
    const bad = await owner.agent.patch(`${API}/tasks/${taskId}`).send({ assigneeId: client.id });
    expect(bad.body.error.code).toBe('INVALID_ASSIGNEE');
  });

  it('admin assigns a developer and raises priority; the developer is notified', async () => {
    const res = await owner.agent.patch(`${API}/tasks/${taskId}`).send({ assigneeId: dev.id, priority: 'URGENT' });
    expect(res.body.data).toMatchObject({ assignee: { id: dev.id }, priority: 'URGENT' });
    const n = await prisma.notification.findFirst({ where: { userId: dev.id, type: 'TASK_ASSIGNED', taskId } });
    expect(n).not.toBeNull();
  });

  it('developer starts → under review → completes (widget); reporter sees progress and is notified', async () => {
    const started = await widget(devToken).patch(`/tasks/${taskId}`).send({ status: 'IN_PROGRESS' });
    expect(started.body.data.status).toBe('IN_PROGRESS');
    await dev.agent.patch(`${API}/tasks/${taskId}`).send({ status: 'IN_REVIEW' }).expect(200);
    const done = await dev.agent.patch(`${API}/tasks/${taskId}`).send({ status: 'COMPLETED' });
    expect(done.body.data.status).toBe('COMPLETED');
    expect(done.body.data.completedAt).not.toBeNull();

    const seen = await widget(clientToken).get(`/tasks/${taskId}`);
    expect(seen.body.data).toMatchObject({ status: 'COMPLETED', assignee: { name: 'Dev One' } });
    const done1 = await widget(clientToken).get('/tasks?tab=done');
    expect(done1.body.data.items.map((t: { id: string }) => t.id)).toEqual([taskId]);
    const notes = await prisma.notification.count({ where: { userId: client.id, type: 'TASK_STATUS_CHANGED', taskId } });
    expect(notes).toBe(3);
  });

  it('reopen (only completed/archived tasks), archive and restore', async () => {
    await widget(clientToken).patch(`/tasks/${taskId}`).send({ status: 'REOPENED' }).expect(403);
    const reopened = await dev.agent.patch(`${API}/tasks/${taskId}`).send({ status: 'REOPENED' });
    expect(reopened.body.data).toMatchObject({ status: 'REOPENED', completedAt: null });
    expect((await widget(clientToken).get('/tasks?tab=open')).body.data.counts.open).toBe(2);

    await owner.agent.patch(`${API}/tasks/${taskId}`).send({ status: 'ARCHIVED' }).expect(200);
    const hidden = await owner.agent.get(`${API}/tasks`).query({ websiteId });
    expect(hidden.body.data.items.some((t: { id: string }) => t.id === taskId)).toBe(false); // archived hidden by default
    const shown = await owner.agent.get(`${API}/tasks`).query({ websiteId, status: 'ARCHIVED' });
    expect(shown.body.data.items.map((t: { id: string }) => t.id)).toEqual([taskId]);
    const restored = await owner.agent.post(`${API}/tasks/${taskId}/restore`);
    expect(restored.body.data.status).toBe('REOPENED');
    await owner.agent.post(`${API}/tasks/${taskId}/restore`).expect(400);
  });
});

describe('4. comments & replies', () => {
  let devComment: string;
  let clientReply: string;

  it('developer reply shows as unread for the reporter until opened', async () => {
    const c = await widget(devToken).post(`/tasks/${taskId}/comments`).send({ body: 'Fixed on staging, can you check?' });
    expect(c.status).toBe(201);
    devComment = c.body.data.id;

    const list = await widget(clientToken).get('/tasks?tab=open');
    expect(list.body.data.items.find((t: { id: string }) => t.id === taskId).unreadCount).toBe(1);
    const comments = await widget(clientToken).get(`/tasks/${taskId}/comments`);
    expect(comments.body.data.items[0]).toMatchObject({ body: 'Fixed on staging, can you check?', isNew: true, author: { name: 'Dev One' } });

    await widget(clientToken).post(`/tasks/${taskId}/read`).expect(204);
    expect((await widget(clientToken).get(`/tasks/${taskId}`)).body.data.unreadCount).toBe(0);
    expect((await widget(clientToken).get(`/tasks/${taskId}/comments`)).body.data.items[0].isNew).toBe(false);
    // The author never sees their own comment as unread
    expect((await widget(devToken).get(`/tasks/${taskId}`)).body.data.unreadCount).toBe(0);
  });

  it('reporter replies with a screenshot attached to the reply', async () => {
    const r = await widget(clientToken).post(`/tasks/${taskId}/comments`).send({ body: 'Still broken on Safari', parentId: devComment });
    expect(r.body.data.parentId).toBe(devComment);
    clientReply = r.body.data.id;
    const att = await widget(clientToken)
      .post(`/tasks/${taskId}/attachments?kind=screenshot&commentId=${clientReply}`)
      .set('Content-Type', 'image/png')
      .set('X-File-Name', 'safari.png')
      .send(PNG);
    expect(att.status).toBe(201);
    // Only the comment's author can attach to it
    await widget(devToken)
      .post(`/tasks/${taskId}/attachments?kind=screenshot&commentId=${clientReply}`)
      .set('Content-Type', 'image/png')
      .send(PNG)
      .expect(403);

    const list = await dev.agent.get(`${API}/tasks/${taskId}/comments`);
    expect(list.body.data.items.map((c: { body: string }) => c.body)).toEqual(['Fixed on staging, can you check?', 'Still broken on Safari']); // chronological
    expect(list.body.data.items[1].attachments).toHaveLength(1);
    expect(list.body.data.items[1].attachments[0].url).toContain('/api/v1/files/');
    expect(list.body.data.items[1]).toMatchObject({ isNew: true, author: { name: 'Clara Client' } });
    // Unread indicator in the dashboard list for the developer
    const devList = await dev.agent.get(`${API}/tasks`).query({ scope: 'mine' });
    expect(devList.body.data.items.find((t: { id: string }) => t.id === taskId).unreadCount).toBe(1);
  });

  it('users edit and delete only their own comments; deleting removes its files', async () => {
    await widget(clientToken).patch(`/comments/${devComment}`).send({ body: 'hijack' }).expect(403);
    await widget(clientToken).del(`/comments/${devComment}`).expect(403);

    const edit = await widget(clientToken).patch(`/comments/${clientReply}`).send({ body: 'Still broken on Safari 17' });
    expect(edit.body.data.editedAt).not.toBeNull();

    const file = await prisma.taskAttachment.findFirstOrThrow({ where: { commentId: clientReply } });
    await widget(clientToken).del(`/comments/${clientReply}`).expect(204);
    expect(await prisma.taskAttachment.count({ where: { id: file.id } })).toBe(0);
    expect(fs.existsSync(`${process.env.UPLOAD_DIR}/${file.storageKey}`)).toBe(false);
    expect((await widget(clientToken).get(`/tasks/${taskId}/comments`)).body.data.items).toHaveLength(1);
  });
});

describe('5–6. task detail & activity log', () => {
  it('admin task detail has everything, including permissions', async () => {
    const d = (await owner.agent.get(`${API}/tasks/${taskId}`)).body.data;
    expect(d).toMatchObject({
      key: `TASK-${taskNumber}`,
      website: { id: websiteId, name: 'Shop' },
      project: { id: projectId, name: 'Launch' },
      title: 'Checkout Pay button hidden behind footer',
      creator: { id: client.id },
      assignee: { id: dev.id },
      priority: 'URGENT',
      status: 'REOPENED',
      permissions: { update: true, manage: true, delete: true, comment: true, upload: true },
    });
    expect(d.attachments.filter((a: { kind: string }) => a.kind === 'SCREENSHOT')).toHaveLength(1);
  });

  it('records actor, action, previous and new value, and time for every important action', async () => {
    const res = await owner.agent.get(`${API}/tasks/${taskId}/activity`).query({ pageSize: 100 });
    const rows = [...res.body.data.items].reverse() as {
      type: string;
      field: string | null;
      previousValue: string | null;
      newValue: string | null;
      actor: { name: string };
      createdAt: string;
    }[];
    const summary = rows.map((a) => [a.type, a.actor.name, a.field, a.previousValue, a.newValue]);
    expect(summary).toEqual([
      ['CREATED', 'Clara Client', 'task', null, `TASK-${taskNumber}`],
      ['ATTACHMENT_ADDED', 'Clara Client', 'screenshot', null, 'checkout screen.png'],
      ['ATTACHMENT_ADDED', 'Clara Client', 'file', null, 'steps.pdf'],
      ['UPDATED', 'Clara Client', 'title', 'Checkout button hidden behind footer', 'Checkout Pay button hidden behind footer'],
      ['PRIORITY_CHANGED', 'Olivia Owner', 'priority', 'HIGH', 'URGENT'],
      ['ASSIGNED', 'Olivia Owner', 'assignee', null, dev.id],
      ['STARTED', 'Dev One', 'status', 'OPEN', 'IN_PROGRESS'],
      ['STATUS_CHANGED', 'Dev One', 'status', 'IN_PROGRESS', 'IN_REVIEW'],
      ['COMPLETED', 'Dev One', 'status', 'IN_REVIEW', 'COMPLETED'],
      ['REOPENED', 'Dev One', 'status', 'COMPLETED', 'REOPENED'],
      ['ARCHIVED', 'Olivia Owner', 'status', 'REOPENED', 'ARCHIVED'],
      ['RESTORED', 'Olivia Owner', 'status', 'ARCHIVED', 'REOPENED'],
      ['COMMENTED', 'Dev One', 'comment', null, 'Fixed on staging, can you check?'],
      ['COMMENTED', 'Clara Client', 'comment', null, 'Still broken on Safari'],
      ['ATTACHMENT_ADDED', 'Clara Client', 'screenshot', null, 'safari.png'],
      ['COMMENT_EDITED', 'Clara Client', 'comment', 'Still broken on Safari', 'Still broken on Safari 17'],
      ['COMMENT_DELETED', 'Clara Client', 'comment', 'Still broken on Safari 17', null],
    ]);
    expect(rows.every((a) => !Number.isNaN(Date.parse(a.createdAt)))).toBe(true);
    const assigned = rows.find((a) => a.type === 'ASSIGNED') as unknown as { changes: { assignee: { to: string } } };
    expect(assigned.changes.assignee.to).toBe('Dev One');
    // The reporter can view the history in the widget too
    expect((await widget(clientToken).get(`/tasks/${taskId}/activity`)).body.data.items).toHaveLength(rows.length);
  });

  it('dashboard statistics follow the new statuses', async () => {
    const d = (await owner.agent.get(`${API}/dashboard`).query({ websiteId })).body.data.totals;
    expect(d.openTasks).toBe(2); // OPEN + REOPENED
    expect(d.completedTasks).toBe(0);
    await dev.agent.patch(`${API}/tasks/${taskId}`).send({ status: 'COMPLETED' }).expect(200);
    expect((await owner.agent.get(`${API}/dashboard`).query({ websiteId })).body.data.totals).toMatchObject({ openTasks: 1, completedTasks: 1 });
  });

  it('attachments are removed only by their uploader (or a manager)', async () => {
    const pdf = await prisma.taskAttachment.findFirstOrThrow({ where: { taskId, kind: 'FILE' } });
    await dev2.agent.delete(`${API}/tasks/${taskId}/attachments/${pdf.id}`).expect(403);
    await widget(clientToken).del(`/tasks/${taskId}/attachments/${pdf.id}`).expect(204);
    expect(await prisma.taskAttachment.count({ where: { id: pdf.id } })).toBe(0);
  });
});
