import fs from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { API, PASSWORD, makeApp, prisma, request, resetDb, signUp, tokenFromOutbox, uniqueEmail, type TestUser } from './helpers';

const app = makeApp();
const W = `${API}/widget`;
const ORIGIN = 'https://shop.example.com';
const OTHER_ORIGIN = 'https://other.example.org';

// 1×1 transparent PNG
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

let owner: TestUser;
let client: TestUser; // WEBSITE_USER (reviewer)
let dev: TestUser; // DEVELOPER (contributor)
let outsider: TestUser;
let websiteId: string;
let siteId: string;
let otherSiteId: string;
let projectId: string;

interface WidgetSession {
  accessToken: string;
  refreshToken: string;
}

const widgetLogin = async (email: string, sid = siteId, origin = ORIGIN): Promise<WidgetSession> => {
  const res = await request(app).post(`${W}/auth/login`).set('Origin', origin).send({ siteId: sid, email, password: PASSWORD });
  if (res.status !== 200) throw new Error(`widget login failed ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data.session;
};

const as = (s: WidgetSession, origin = ORIGIN) => ({
  get: (path: string) => request(app).get(`${W}${path}`).set('Origin', origin).set('Authorization', `Bearer ${s.accessToken}`),
  post: (path: string) => request(app).post(`${W}${path}`).set('Origin', origin).set('Authorization', `Bearer ${s.accessToken}`),
  del: (path: string) => request(app).delete(`${W}${path}`).set('Origin', origin).set('Authorization', `Bearer ${s.accessToken}`),
});

let ownerS: WidgetSession;
let clientS: WidgetSession;
let devS: WidgetSession;

beforeAll(async () => {
  await resetDb();
  [owner, client, dev, outsider] = await Promise.all([
    signUp(app, { name: 'Owner' }),
    signUp(app, { name: 'Client' }),
    signUp(app, { name: 'Dev' }),
    signUp(app, { name: 'Outsider' }),
  ]);
  const w = await owner.agent.post(`${API}/websites`).send({ name: 'Shop', url: `${ORIGIN}/home` });
  websiteId = w.body.data.id;
  siteId = w.body.data.siteId;
  const other = await outsider.agent.post(`${API}/websites`).send({ name: 'Other', url: OTHER_ORIGIN });
  otherSiteId = other.body.data.siteId;

  await owner.agent.post(`${API}/websites/${websiteId}/members`).send({ email: client.email, role: 'WEBSITE_USER' }).expect(201);
  await owner.agent.post(`${API}/websites/${websiteId}/members`).send({ email: dev.email, role: 'DEVELOPER' }).expect(201);
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe('widget config: Site ID + allowed domain', () => {
  it('returns public config for a valid Site ID on its own domain, with CORS for that origin', async () => {
    const res = await request(app).get(`${W}/config`).query({ siteId }).set('Origin', ORIGIN);
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe(ORIGIN);
    expect(res.headers['access-control-allow-credentials']).toBeUndefined(); // no cookies, ever
    expect(res.body.data).toEqual({
      site: { siteId, name: 'Shop', logoUrl: null, brandColor: null },
      auth: { password: true, registration: true, google: true },
    });
    // Nothing internal leaks
    expect(JSON.stringify(res.body)).not.toContain(websiteId);
  });

  it('accepts the www. variant of the website host', async () => {
    await request(app).get(`${W}/config`).query({ siteId }).set('Origin', 'https://www.shop.example.com').expect(200);
  });

  it('rejects unknown Site IDs, malformed IDs, missing Origin and other domains', async () => {
    const unknown = await request(app).get(`${W}/config`).query({ siteId: 'site_00000000000000000000' }).set('Origin', ORIGIN);
    expect([unknown.status, unknown.body.error.code]).toEqual([404, 'SITE_NOT_FOUND']);
    await request(app).get(`${W}/config`).query({ siteId: 'nope' }).set('Origin', ORIGIN).expect(400);
    const noOrigin = await request(app).get(`${W}/config`).query({ siteId });
    expect([noOrigin.status, noOrigin.body.error.code]).toEqual([403, 'DOMAIN_NOT_ALLOWED']);
    const evil = await request(app).get(`${W}/config`).query({ siteId }).set('Origin', 'https://evil.example.net');
    expect(evil.status).toBe(403);
    expect(evil.body.error.message).toContain('evil.example.net');
    // look-alike suffix is not a subdomain
    await request(app).get(`${W}/config`).query({ siteId }).set('Origin', 'https://notshop.example.com').expect(403);
  });

  it('honours Allowed domains (exact and wildcard) from website settings', async () => {
    await owner.agent.patch(`${API}/websites/${websiteId}/settings`).send({ allowedDomains: ['*.staging.dev', 'localhost'] }).expect(200);
    await request(app).get(`${W}/config`).query({ siteId }).set('Origin', 'https://pr-12.staging.dev').expect(200);
    await request(app).get(`${W}/config`).query({ siteId }).set('Origin', 'http://localhost:5173').expect(200);
    await request(app).get(`${W}/config`).query({ siteId }).set('Origin', 'https://staging.dev').expect(403);
  });

  it('answers CORS preflight for any origin (the real check happens on the request)', async () => {
    const res = await request(app)
      .options(`${W}/tasks`)
      .set('Origin', ORIGIN)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'authorization,content-type');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(ORIGIN);
    expect(res.headers['access-control-allow-headers']).toContain('Authorization');
  });

  it('is unavailable when the widget is turned off or the website is inactive', async () => {
    await owner.agent.patch(`${API}/websites/${websiteId}/settings`).send({ widgetEnabled: false }).expect(200);
    const off = await request(app).get(`${W}/config`).query({ siteId }).set('Origin', ORIGIN);
    expect([off.status, off.body.error.code]).toEqual([403, 'WIDGET_DISABLED']);
    await owner.agent.patch(`${API}/websites/${websiteId}/settings`).send({ widgetEnabled: true }).expect(200);

    await owner.agent.patch(`${API}/websites/${websiteId}`).send({ status: 'INACTIVE' }).expect(200);
    const inactive = await request(app).get(`${W}/config`).query({ siteId }).set('Origin', ORIGIN);
    expect(inactive.body.error.code).toBe('WEBSITE_INACTIVE');
    await owner.agent.patch(`${API}/websites/${websiteId}`).send({ status: 'ACTIVE' }).expect(200);
  });
});

describe('widget authentication (Task 1 auth, site-bound sessions)', () => {
  it('logs in with email/password, returning tokens and setting no cookies', async () => {
    const res = await request(app).post(`${W}/auth/login`).set('Origin', ORIGIN).send({ siteId, email: owner.email, password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(res.body.data.user.email).toBe(owner.email);
    expect(res.body.data.session.accessToken).toBeTruthy();
    ownerS = res.body.data.session;
    const session = await prisma.userSession.findFirstOrThrow({ where: { userId: owner.id, websiteId } });
    expect(session.authMethod).toBe('widget-password');
    clientS = await widgetLogin(client.email);
    devS = await widgetLogin(dev.email);
  });

  it('rejects bad credentials and logins from a domain that is not allowed', async () => {
    const bad = await request(app).post(`${W}/auth/login`).set('Origin', ORIGIN).send({ siteId, email: owner.email, password: 'wrong-password' });
    expect([bad.status, bad.body.error.code]).toEqual([401, 'INVALID_CREDENTIALS']);
    const wrongDomain = await request(app)
      .post(`${W}/auth/login`)
      .set('Origin', OTHER_ORIGIN)
      .send({ siteId, email: owner.email, password: PASSWORD });
    expect(wrongDomain.status).toBe(403);
  });

  it('widget tokens do not work on the dashboard API, and vice versa', async () => {
    await request(app).get(`${API}/users/me`).set('Authorization', `Bearer ${ownerS.accessToken}`).expect(401);
    const dashboardLogin = await request(app).post(`${API}/auth/login`).send({ email: owner.email, password: PASSWORD });
    const cookie = (dashboardLogin.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('wrtm_at='))!;
    const dashboardToken = cookie.split(';')[0]!.slice('wrtm_at='.length);
    await request(app).get(`${W}/me`).set('Origin', ORIGIN).set('Authorization', `Bearer ${dashboardToken}`).expect(401);
  });

  it('a widget refresh token cannot be turned into a dashboard session', async () => {
    const s = await widgetLogin(owner.email);
    const res = await request(app).post(`${API}/auth/refresh`).set('Cookie', `wrtm_rt=${s.refreshToken}`);
    expect([res.status, res.body.error.code]).toEqual([401, 'SESSION_EXPIRED']);
  });

  it('a token is bound to its website: it fails from another site domain', async () => {
    const res = await as(ownerS, OTHER_ORIGIN).get('/me');
    expect([res.status, res.body.error.code]).toEqual([403, 'DOMAIN_NOT_ALLOWED']);
  });

  it('refresh rotates the refresh token and needs the matching Site ID', async () => {
    const s = await widgetLogin(dev.email);
    const wrongSite = await request(app)
      .post(`${W}/auth/refresh`)
      .set('Origin', OTHER_ORIGIN)
      .send({ siteId: otherSiteId, refreshToken: s.refreshToken });
    expect(wrongSite.status).toBe(401);
    const ok = await request(app).post(`${W}/auth/refresh`).set('Origin', ORIGIN).send({ siteId, refreshToken: s.refreshToken });
    expect(ok.status).toBe(200);
    expect(ok.body.data.session.refreshToken).not.toBe(s.refreshToken);
    await as(ok.body.data.session).get('/me').expect(200);
    // old refresh token is dead
    await request(app).post(`${W}/auth/refresh`).set('Origin', ORIGIN).send({ siteId, refreshToken: s.refreshToken }).expect(401);
  });

  it('registers a new account from the widget; email must be verified before reading tasks', async () => {
    const email = uniqueEmail('visitor');
    const res = await request(app)
      .post(`${W}/auth/register`)
      .set('Origin', ORIGIN)
      .send({ siteId, name: 'Visitor', email, password: PASSWORD });
    expect(res.status).toBe(201);
    const s: WidgetSession = res.body.data.session;
    const me = await as(s).get('/me');
    expect(me.body.data.user.emailVerified).toBe(false);
    expect(me.body.data.access).toBeNull(); // registering never grants access to the website
    const blocked = await as(s).get('/tasks');
    expect(blocked.body.error.code).toBe('EMAIL_NOT_VERIFIED');
    // Right after registering, resend is on cooldown (the first email may still be on its way)
    expect((await as(s).post('/auth/resend-verification')).body.error.code).toBe('RESEND_TOO_SOON');
    const u = await prisma.user.findUniqueOrThrow({ where: { email } });
    await prisma.authToken.updateMany({ where: { userId: u.id }, data: { createdAt: new Date(Date.now() - 120_000) } });
    await as(s).post('/auth/resend-verification').expect(200);
    tokenFromOutbox(email, '/verify-email'); // email really sent
  });

  it('forgot password sends a reset email (same answer for unknown emails)', async () => {
    const res = await request(app).post(`${W}/auth/forgot-password`).set('Origin', ORIGIN).send({ siteId, email: client.email });
    expect(res.status).toBe(200);
    expect(tokenFromOutbox(client.email, '/reset-password')).toBeTruthy();
    const unknown = await request(app).post(`${W}/auth/forgot-password`).set('Origin', ORIGIN).send({ siteId, email: 'nobody@example.com' });
    expect(unknown.body).toEqual(res.body);
  });

  it('Google sign-in starts in a popup for allowed origins only', async () => {
    const res = await request(app).get(`${W}/auth/google`).query({ siteId, origin: `${ORIGIN}/some/page` });
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('https://accounts.google.com/o/oauth2/v2/auth');
    expect(res.headers['cross-origin-opener-policy']).toBe('unsafe-none');
    const stateCookie = (res.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('wrtm_oauth='))!;
    const state = JSON.parse(Buffer.from(decodeURIComponent(stateCookie.split(';')[0]!.slice(11)), 'base64url').toString());
    expect(state.widget).toEqual({ websiteId, origin: ORIGIN });

    // Denied consent → the popup posts the failure back to the widget's origin only.
    const cb = await request(app)
      .get(`${API}/auth/google/callback`)
      .query({ error: 'access_denied', state: state.state })
      .set('Cookie', stateCookie.split(';')[0]!);
    expect(cb.status).toBe(200);
    expect(cb.headers['content-type']).toContain('text/html');
    expect(cb.text).toContain(`postMessage(data, "${ORIGIN}")`);
    expect(cb.text).toContain('"error":"google_denied"');
    expect(cb.headers['content-security-policy']).toMatch(/script-src 'nonce-/);

    await request(app).get(`${W}/auth/google`).query({ siteId, origin: 'https://evil.example.net' }).expect(403);
  });

  it('logout revokes the widget session', async () => {
    const s = await widgetLogin(dev.email);
    await as(s).post('/auth/logout').expect(204);
    const res = await as(s).get('/me');
    expect([res.status, res.body.error.code]).toEqual([401, 'SESSION_EXPIRED']);
  });
});

describe('widget tasks', () => {
  const page = `${ORIGIN}/products/shoes`;
  let ownerTaskId: string;
  let clientTaskId: string;

  it('users without access to the website see no tasks', async () => {
    // These tests cover the invite-only mode: auto-join is switched off for this website.
    await owner.agent.patch(`${API}/websites/${websiteId}/settings`).send({ widgetAutoJoin: false }).expect(200);
    const s = await widgetLogin(outsider.email);
    const me = await as(s).get('/me');
    expect(me.body.data.access).toBeNull();
    const res = await as(s).get('/tasks');
    expect([res.status, res.body.error.code]).toEqual([403, 'NO_SITE_ACCESS']);
  });

  it('an owner with no projects can still report: a "Website Feedback" project is created', async () => {
    const me = await as(ownerS).get('/me');
    expect(me.body.data.access).toMatchObject({ role: 'OWNER', canCreate: true, projects: [], defaultProjectId: null });

    const res = await as(ownerS)
      .post('/tasks')
      .send({ title: 'Hero image is blurry', description: 'On retina', type: 'BUG', pageUrl: `${page}?color=red#top`, pageTitle: 'Shoes', context: { viewport: { width: 1440, height: 900 } } });
    expect(res.status).toBe(201);
    ownerTaskId = res.body.data.id;
    expect(res.body.data).toMatchObject({
      title: 'Hero image is blurry',
      status: 'OPEN',
      type: 'BUG',
      pageTitle: 'Shoes',
      screenshotUrl: null,
      commentCount: 0,
      archivedAt: null,
      unreadCount: 0,
      creator: { id: owner.id, name: 'Owner' },
      project: { name: 'Website Feedback' },
      permissions: { manage: true, archive: true, comment: true },
    });
    expect(res.body.data.key).toMatch(/^TASK-\d+$/);
    projectId = res.body.data.project.id;
    const settings = await prisma.websiteSettings.findUniqueOrThrow({ where: { websiteId } });
    expect(settings.widgetProjectId).toBe(projectId);
    const task = await prisma.task.findUniqueOrThrow({ where: { id: ownerTaskId } });
    expect(task.metadata).toMatchObject({ source: 'widget', pageTitle: 'Shoes', viewport: { width: 1440, height: 900 } });
  });

  it('a website user needs a project; then files feedback in the default widget project', async () => {
    const before = await as(clientS).post('/tasks').send({ title: 'Typo', pageUrl: page });
    expect([before.status, before.body.error.code]).toEqual([403, 'NO_PROJECT']);

    await owner.agent.put(`${API}/websites/${websiteId}/members/${client.id}/projects`).send({ projects: [{ projectId }] }).expect(200);
    await owner.agent.put(`${API}/websites/${websiteId}/members/${dev.id}/projects`).send({ projects: [{ projectId }] }).expect(200);

    const me = await as(clientS).get('/me');
    expect(me.body.data.access).toMatchObject({ role: 'WEBSITE_USER', canCreate: true, defaultProjectId: projectId });
    const res = await as(clientS).post('/tasks').send({ title: 'Typo in footer', pageUrl: `${ORIGIN}/about/`, type: 'IMPROVEMENT' });
    expect(res.status).toBe(201);
    clientTaskId = res.body.data.id;
    // Reporter: edit own task, comment, add screenshots — but no workflow (status/assign/archive).
    expect(res.body.data.permissions).toEqual({ manage: false, update: true, comment: true, upload: true, archive: false });
  });

  it('rejects a page URL outside the website and a project from elsewhere', async () => {
    const res = await as(clientS).post('/tasks').send({ title: 'x', pageUrl: 'https://evil.example.net/' });
    expect(res.body.error.code).toBe('INVALID_PAGE_URL');
    await as(clientS).post('/tasks').send({ title: 'x', pageUrl: page, projectId: '00000000-0000-4000-8000-000000000000' }).expect(404);
  });

  it('respects "clients can create tasks" = off', async () => {
    await owner.agent.patch(`${API}/websites/${websiteId}/settings`).send({ clientsCanCreateTasks: false }).expect(200);
    const me = await as(clientS).get('/me');
    expect(me.body.data.access.canCreate).toBe(false);
    const res = await as(clientS).post('/tasks').send({ title: 'x', pageUrl: page });
    expect(res.body.error.code).toBe('CLIENT_TASKS_DISABLED');
    await owner.agent.patch(`${API}/websites/${websiteId}/settings`).send({ clientsCanCreateTasks: true }).expect(200);
  });

  it('lists tasks with tab counts, page filter, mine filter and search', async () => {
    // move the owner task to in progress via the dashboard API
    await owner.agent.patch(`${API}/tasks/${ownerTaskId}`).send({ status: 'IN_PROGRESS' }).expect(200);

    // The team (owner) sees every task of the website
    const all = await as(ownerS).get('/tasks');
    expect(all.status).toBe(200);
    expect(all.body.data.items.map((t: { id: string }) => t.id)).toEqual([clientTaskId, ownerTaskId]);
    expect(all.body.data.counts).toEqual({ all: 2, open: 1, in_progress: 1, done: 0, archived: 0 });
    expect(all.body.data.pagination.total).toBe(2);

    const open = await as(ownerS).get('/tasks?tab=open');
    expect(open.body.data.items.map((t: { id: string }) => t.id)).toEqual([clientTaskId]);

    // Page filter ignores query string, hash and trailing slash
    const thisPage = await as(ownerS).get(`/tasks?pageUrl=${encodeURIComponent(`${page}/`)}`);
    expect(thisPage.body.data.items.map((t: { id: string }) => t.id)).toEqual([ownerTaskId]);
    expect(thisPage.body.data.counts.all).toBe(1);

    const mine = await as(ownerS).get('/tasks?mine=true');
    expect(mine.body.data.items.map((t: { id: string }) => t.id)).toEqual([ownerTaskId]);

    const search = await as(ownerS).get('/tasks?q=blurry');
    expect(search.body.data.items.map((t: { id: string }) => t.id)).toEqual([ownerTaskId]);

    // A Website User (client) only ever sees their own tasks — lists, counts, search, page filter
    const clientAll = await as(clientS).get('/tasks');
    expect(clientAll.body.data.items.map((t: { id: string }) => t.id)).toEqual([clientTaskId]);
    expect(clientAll.body.data.counts).toEqual({ all: 1, open: 1, in_progress: 0, done: 0, archived: 0 });
    expect((await as(clientS).get('/tasks?q=blurry')).body.data.items).toEqual([]);
    expect((await as(clientS).get(`/tasks?pageUrl=${encodeURIComponent(page)}`)).body.data.items).toEqual([]);
    await as(clientS).get(`/tasks/${ownerTaskId}`).expect(404);
  });

  it('archive: only admins/developers archive; archived tab; restore returns the previous status', async () => {
    const denied = await as(clientS).post(`/tasks/${clientTaskId}/archive`); // even their own
    expect([denied.status, denied.body.error.code]).toEqual([403, 'WORKFLOW_FORBIDDEN']);

    const a1 = await as(devS).post(`/tasks/${ownerTaskId}/archive`);
    expect(a1.status).toBe(200);
    expect(a1.body.data).toMatchObject({ status: 'ARCHIVED' });
    expect(a1.body.data.archivedAt).toBeTruthy();
    await as(devS).post(`/tasks/${clientTaskId}/archive`).expect(200);

    const counts = (await as(ownerS).get('/tasks')).body.data.counts;
    expect(counts).toEqual({ all: 0, open: 0, in_progress: 0, done: 0, archived: 2 });
    const archived = await as(ownerS).get('/tasks?tab=archived');
    expect(archived.body.data.items).toHaveLength(2);
    // the client's view: only their own archived task
    expect((await as(clientS).get('/tasks')).body.data.counts).toEqual({ all: 0, open: 0, in_progress: 0, done: 0, archived: 1 });

    const r1 = await as(devS).del(`/tasks/${ownerTaskId}/archive`);
    expect(r1.body.data).toMatchObject({ status: 'IN_PROGRESS', archivedAt: null }); // where it was
    const r2 = await as(devS).del(`/tasks/${clientTaskId}/archive`);
    expect(r2.body.data.status).toBe('OPEN');
    const activity = await prisma.taskActivity.findMany({
      where: { taskId: ownerTaskId, type: { in: ['ARCHIVED', 'RESTORED'] } },
      orderBy: { createdAt: 'asc' },
    });
    expect(activity.map((a) => [a.type, a.previousValue, a.newValue, a.actorId])).toEqual([
      ['ARCHIVED', 'IN_PROGRESS', 'ARCHIVED', dev.id],
      ['RESTORED', 'ARCHIVED', 'IN_PROGRESS', dev.id],
    ]);
  });

  it('uploads a screenshot (real image bytes only) and serves it via a signed URL', async () => {
    const shot = `/tasks/${clientTaskId}/attachments?kind=screenshot`;
    const fake = await as(clientS).post(shot).set('Content-Type', 'image/png').send(Buffer.from('<svg>not an image</svg>'));
    expect(fake.body.error.code).toBe('INVALID_FILE');
    const notOwn = await as(clientS).post(`/tasks/${ownerTaskId}/attachments?kind=screenshot`).set('Content-Type', 'image/png').send(PNG);
    expect(notOwn.status).toBe(404); // someone else's task is invisible to a client

    const up = await as(clientS).post(shot).set('Content-Type', 'image/png').set('X-File-Name', 'footer.png').send(PNG);
    expect(up.status).toBe(201);
    expect(up.body.data).toMatchObject({ kind: 'SCREENSHOT', fileName: 'footer.png', mimeType: 'image/png' });
    const res = await as(clientS).get(`/tasks/${clientTaskId}`);
    const url = new URL(res.body.data.screenshotUrl);
    expect(url.pathname).toMatch(/^\/api\/v1\/files\/[0-9a-f-]{36}$/);

    const file = await request(app).get(url.pathname + url.search);
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toBe('image/png');
    expect(file.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(Buffer.compare(file.body as Buffer, PNG)).toBe(0);

    const tampered = new URLSearchParams(url.search);
    tampered.set('sig', `${tampered.get('sig')!.slice(0, -2)}xx`);
    await request(app).get(`${url.pathname}?${tampered}`).expect(404);
    await request(app).get(url.pathname).expect(404);

    const attachment = await prisma.taskAttachment.findFirstOrThrow({ where: { taskId: clientTaskId } });
    expect(fs.existsSync(`${process.env.UPLOAD_DIR}/${attachment.storageKey}`)).toBe(true);

    // Dashboard task detail returns the signed URL too
    const detail = await owner.agent.get(`${API}/tasks/${clientTaskId}`);
    expect(detail.body.data.attachments[0].url).toContain(`/api/v1/files/${attachment.id}?exp=`);
  });

  it('reply: lists and adds comments, notifying the task creator', async () => {
    const res = await as(devS).post(`/tasks/${clientTaskId}/comments`).send({ body: 'Fixed on staging' });
    expect(res.status).toBe(201);
    const list = await as(clientS).get(`/tasks/${clientTaskId}/comments`);
    expect(list.body.data.items.map((c: { body: string; author: { name: string } }) => [c.author.name, c.body])).toEqual([
      ['Dev', 'Fixed on staging'],
    ]);
    const notifications = await prisma.notification.findMany({ where: { userId: client.id, type: 'TASK_COMMENTED' } });
    expect(notifications).toHaveLength(1);
    expect((await as(clientS).get('/tasks?tab=open')).body.data.items[0].commentCount).toBe(1);
  });

  it('cannot reach tasks of another website with this site token', async () => {
    const otherWebsite = await prisma.website.findUniqueOrThrow({ where: { siteId: otherSiteId } });
    const project = await prisma.project.create({ data: { websiteId: otherWebsite.id, name: 'Other P' } });
    const foreign = await prisma.task.create({ data: { websiteId: otherWebsite.id, projectId: project.id, title: 'Secret' } });
    await as(ownerS).get(`/tasks/${foreign.id}/comments`).expect(404);
    await as(ownerS).post(`/tasks/${foreign.id}/archive`).expect(404);
    const list = await as(ownerS).get('/tasks?q=Secret');
    expect(list.body.data.items).toEqual([]);
  });

  it('website settings accept a widget project only from the same website', async () => {
    const otherProject = await prisma.project.findFirstOrThrow({ where: { name: 'Other P' } });
    const bad = await owner.agent.patch(`${API}/websites/${websiteId}/settings`).send({ widgetProjectId: otherProject.id });
    expect(bad.body.error.code).toBe('INVALID_PROJECT');
    await owner.agent.patch(`${API}/websites/${websiteId}/settings`).send({ widgetProjectId: projectId }).expect(200);
  });
});
