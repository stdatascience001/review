import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { API, PASSWORD, makeApp, prisma, request, resetDb, signUp, type TestUser } from './helpers';

/**
 * Multiple websites registered by different users: unique Site IDs and configuration,
 * per-site domain verification, task ownership, website-wise listings, tenant isolation
 * on every task endpoint (dashboard and widget), and role-based permissions across sites.
 */
const app = makeApp();
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const ORIGIN_A1 = 'https://alpha-shop.example.com';
const ORIGIN_A2 = 'https://alpha-blog.example.com';
const ORIGIN_B1 = 'https://beta-store.example.org';

let ownerA: TestUser; // owns A1 + A2
let devA: TestUser; // developer on A1 only
let clientA: TestUser; // reporter on A1
let ownerB: TestUser; // owns B1
let clientB: TestUser; // reporter on B1
const site: Record<'A1' | 'A2' | 'B1', { id: string; siteId: string; projectId: string }> = {} as never;
const task: Record<string, string> = {};

const widgetLogin = async (email: string, siteId: string, origin: string) =>
  (await request(app).post(`${API}/widget/auth/login`).set('Origin', origin).send({ siteId, email, password: PASSWORD })).body.data.session
    .accessToken as string;
const widget = (token: string, origin: string) => ({
  get: (p: string) => request(app).get(`${API}/widget${p}`).set('Origin', origin).set('Authorization', `Bearer ${token}`),
  post: (p: string) => request(app).post(`${API}/widget${p}`).set('Origin', origin).set('Authorization', `Bearer ${token}`),
  patch: (p: string) => request(app).patch(`${API}/widget${p}`).set('Origin', origin).set('Authorization', `Bearer ${token}`),
});

// Two "customer websites" for domain verification (paths stand in for separate homepages).
const pages: Record<string, string> = {};
const host = http.createServer((req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(pages[req.url ?? '/'] ?? '<html></html>'));
let hostUrl = '';

beforeAll(async () => {
  await resetDb();
  await new Promise<void>((r) => host.listen(0, '127.0.0.1', r));
  hostUrl = `http://127.0.0.1:${(host.address() as AddressInfo).port}`;
  [ownerA, devA, clientA, ownerB, clientB] = await Promise.all([
    signUp(app, { name: 'Alpha Owner' }),
    signUp(app, { name: 'Alpha Dev' }),
    signUp(app, { name: 'Alpha Client' }),
    signUp(app, { name: 'Beta Owner' }),
    signUp(app, { name: 'Beta Client' }),
  ]);
  const make = async (owner: TestUser, key: 'A1' | 'A2' | 'B1', name: string, url: string) => {
    const w = (await owner.agent.post(`${API}/websites`).send({ name, url })).body.data;
    const p = (await owner.agent.post(`${API}/websites/${w.id}/projects`).send({ name: `${name} QA` })).body.data;
    site[key] = { id: w.id, siteId: w.siteId, projectId: p.id };
    // invite-only websites (auto-join on widget sign-in is tested in project-access.test.ts)
    await owner.agent.patch(`${API}/websites/${w.id}/settings`).send({ widgetAutoJoin: false }).expect(200);
  };
  await make(ownerA, 'A1', 'Alpha Shop', ORIGIN_A1);
  await make(ownerA, 'A2', 'Alpha Blog', ORIGIN_A2);
  await make(ownerB, 'B1', 'Beta Store', ORIGIN_B1);
  for (const [owner, w, u, role] of [
    [ownerA, site.A1, devA, 'DEVELOPER'],
    [ownerA, site.A1, clientA, 'WEBSITE_USER'],
    [ownerB, site.B1, clientB, 'WEBSITE_USER'],
  ] as const) {
    await owner.agent.post(`${API}/websites/${w.id}/members`).send({ email: u.email, role }).expect(201);
    await owner.agent.put(`${API}/websites/${w.id}/members/${u.id}/projects`).send({ projects: [{ projectId: w.projectId }] }).expect(200);
  }
});
afterAll(async () => {
  host.close();
  await prisma.$disconnect();
});

describe('unique websites', () => {
  it('every website has its own Site ID, verification token and embed script', async () => {
    const rows = await prisma.website.findMany({ select: { siteId: true, verificationToken: true } });
    expect(new Set(rows.map((r) => r.siteId)).size).toBe(rows.length);
    expect(new Set(rows.map((r) => r.verificationToken)).size).toBe(rows.length);
    const a1 = (await ownerA.agent.get(`${API}/websites/${site.A1.id}`)).body.data;
    const b1 = (await ownerB.agent.get(`${API}/websites/${site.B1.id}`)).body.data;
    expect(a1.embedScript).toContain(`data-site-id="${site.A1.siteId}"`);
    expect(b1.embedScript).toContain(`data-site-id="${site.B1.siteId}"`);
    expect(a1.embedScript).not.toBe(b1.embedScript);
  });

  it('configuration is per website (settings, branding, widget switch, allowed domains)', async () => {
    await ownerA.agent.patch(`${API}/websites/${site.A1.id}/settings`).send({ brandColor: '#AA0000', allowedDomains: ['staging.alpha.dev'] }).expect(200);
    await ownerA.agent.patch(`${API}/websites/${site.A2.id}/settings`).send({ widgetEnabled: false }).expect(200);
    const cfg = (siteId: string, origin: string) => request(app).get(`${API}/widget/config`).query({ siteId }).set('Origin', origin);
    expect((await cfg(site.A1.siteId, ORIGIN_A1)).body.data.site).toMatchObject({ name: 'Alpha Shop', brandColor: '#AA0000' });
    expect((await cfg(site.B1.siteId, ORIGIN_B1)).body.data.site).toMatchObject({ name: 'Beta Store', brandColor: null });
    expect((await cfg(site.A2.siteId, ORIGIN_A2)).body.error.code).toBe('WIDGET_DISABLED');
    // A1's allowed domain does not open up B1, and one site's Site ID never works on another site's domain
    await cfg(site.A1.siteId, 'https://staging.alpha.dev').expect(200);
    await cfg(site.B1.siteId, 'https://staging.alpha.dev').expect(403);
    await cfg(site.A1.siteId, ORIGIN_B1).expect(403);
    await ownerA.agent.patch(`${API}/websites/${site.A2.id}/settings`).send({ widgetEnabled: true }).expect(200);
  });

  it('domain verification is checked per website (another site’s marker does not count)', async () => {
    const mk = async (owner: TestUser, name: string, path: string) =>
      (await owner.agent.post(`${API}/websites`).send({ name, url: `${hostUrl}${path}` })).body.data;
    const va = await mk(ownerA, 'Verify Alpha', '/alpha');
    const vb = await mk(ownerB, 'Verify Beta', '/beta');
    const tokenA = (await ownerA.agent.get(`${API}/websites/${va.id}`)).body.data.verification.metaTag;
    pages['/alpha'] = `<html><head>${tokenA}</head></html>`;
    pages['/beta'] = `<html><head>${tokenA}<script src="x/widget.js" data-site-id="${va.siteId}"></script></head></html>`; // Alpha's markers only
    const okA = await ownerA.agent.post(`${API}/websites/${va.id}/verify-domain`);
    expect(okA.body.data).toMatchObject({ verified: true, method: 'meta_tag' });
    const noB = await ownerB.agent.post(`${API}/websites/${vb.id}/verify-domain`);
    expect(noB.body.data.verified).toBe(false);
    pages['/beta'] = `<html><body><script src="x/widget.js" data-site-id="${vb.siteId}" async></script></body></html>`;
    const okB = await ownerB.agent.post(`${API}/websites/${vb.id}/verify-domain`);
    expect(okB.body.data).toMatchObject({ verified: true, method: 'embed_script' });
    // Only the owner can trigger it
    await ownerB.agent.post(`${API}/websites/${va.id}/verify-domain`).expect(404);
  });
});

describe('task ownership and website-wise listing', () => {
  it('tasks belong to the website and reporter they were created for', async () => {
    const tA = await widgetLogin(clientA.email, site.A1.siteId, ORIGIN_A1);
    const tB = await widgetLogin(clientB.email, site.B1.siteId, ORIGIN_B1);
    task.A1 = (await widget(tA, ORIGIN_A1).post('/tasks').send({ title: 'Alpha checkout bug', pageUrl: `${ORIGIN_A1}/checkout` })).body.data.id;
    task.B1 = (await widget(tB, ORIGIN_B1).post('/tasks').send({ title: 'Beta search bug', pageUrl: `${ORIGIN_B1}/search` })).body.data.id;
    task.A2 = (await ownerA.agent.post(`${API}/projects/${site.A2.projectId}/tasks`).send({ title: 'Alpha blog typo' })).body.data.id;
    await widget(tA, ORIGIN_A1).post(`/tasks/${task.A1}/attachments?kind=screenshot`).set('Content-Type', 'image/png').send(PNG).expect(201);

    const rows = await prisma.task.findMany({ select: { id: true, websiteId: true, creatorId: true, projectId: true } });
    expect(rows.find((r) => r.id === task.A1)).toMatchObject({ websiteId: site.A1.id, projectId: site.A1.projectId, creatorId: clientA.id });
    expect(rows.find((r) => r.id === task.B1)).toMatchObject({ websiteId: site.B1.id, creatorId: clientB.id });
    expect(rows.find((r) => r.id === task.A2)).toMatchObject({ websiteId: site.A2.id, creatorId: ownerA.id });
  });

  it('lists are website-wise and only ever contain the user’s own tenants', async () => {
    const ids = (res: request.Response) => res.body.data.items.map((t: { id: string }) => t.id).sort();
    expect(ids(await ownerA.agent.get(`${API}/tasks`).query({ websiteId: site.A1.id }))).toEqual([task.A1]);
    expect(ids(await ownerA.agent.get(`${API}/tasks`).query({ websiteId: site.A2.id }))).toEqual([task.A2]);
    expect(ids(await ownerA.agent.get(`${API}/tasks`))).toEqual([task.A1, task.A2].sort());
    expect(ids(await ownerB.agent.get(`${API}/tasks`))).toEqual([task.B1]);
    expect(ids(await devA.agent.get(`${API}/tasks`))).toEqual([task.A1]); // only A1, only its project
    // Filtering by someone else's website returns nothing (no leak through filters)
    expect(ids(await ownerB.agent.get(`${API}/tasks`).query({ websiteId: site.A1.id }))).toEqual([]);
    expect((await ownerB.agent.get(`${API}/comments`)).body.data.items).toEqual([]);
    const wsB = await ownerB.agent.get(`${API}/websites`);
    expect(wsB.body.data.items.map((w: { name: string }) => w.name)).not.toContain('Alpha Shop');
    // Widget listing is per site
    const tB = await widgetLogin(clientB.email, site.B1.siteId, ORIGIN_B1);
    expect((await widget(tB, ORIGIN_B1).get('/tasks')).body.data.items.map((t: { id: string }) => t.id)).toEqual([task.B1]);
    // Dashboard statistics are per tenant
    expect((await ownerB.agent.get(`${API}/dashboard`)).body.data.totals.tasks).toBe(1);
    expect((await ownerA.agent.get(`${API}/dashboard`)).body.data.totals.tasks).toBe(2);
  });
});

describe('tenant isolation: another website’s users cannot reach private tasks', () => {
  it('every dashboard task endpoint answers 404 across tenants', async () => {
    const t = task.A1;
    const b = ownerB.agent;
    const attempts: [string, request.Test][] = [
      ['get', b.get(`${API}/tasks/${t}`)],
      ['patch', b.patch(`${API}/tasks/${t}`).send({ status: 'COMPLETED' })],
      ['delete', b.delete(`${API}/tasks/${t}`)],
      ['activity', b.get(`${API}/tasks/${t}/activity`)],
      ['comments', b.get(`${API}/tasks/${t}/comments`)],
      ['comment', b.post(`${API}/tasks/${t}/comments`).send({ body: 'hi' })],
      ['assignees', b.get(`${API}/tasks/${t}/assignees`)],
      ['read', b.post(`${API}/tasks/${t}/read`)],
      ['restore', b.post(`${API}/tasks/${t}/restore`)],
      ['upload', b.post(`${API}/tasks/${t}/attachments`).set('Content-Type', 'image/png').send(PNG)],
      ['project', b.get(`${API}/projects/${site.A1.projectId}`)],
      ['projectTasks', b.get(`${API}/projects/${site.A1.projectId}/tasks`)],
      ['website', b.get(`${API}/websites/${site.A1.id}`)],
      ['settings', b.get(`${API}/websites/${site.A1.id}/settings`)],
      ['members', b.get(`${API}/websites/${site.A1.id}/members`)],
      ['dashboard', b.get(`${API}/dashboard`).query({ websiteId: site.A1.id })],
      ['analytics', b.get(`${API}/analytics`).query({ websiteId: site.A1.id })],
    ];
    for (const [name, req] of attempts) {
      const res = await req;
      expect([name, res.status]).toEqual([name, 404]);
    }
    // Nothing changed
    expect(await prisma.task.findUniqueOrThrow({ where: { id: t } })).toMatchObject({ status: 'OPEN' });
    expect(await prisma.taskComment.count({ where: { taskId: t } })).toBe(0);
  });

  it('widget sessions of one site cannot reach another site’s tasks', async () => {
    const tB = await widgetLogin(clientB.email, site.B1.siteId, ORIGIN_B1);
    const wb = widget(tB, ORIGIN_B1);
    for (const res of [
      await wb.get(`/tasks/${task.A1}`),
      await wb.get(`/tasks/${task.A1}/comments`),
      await wb.post(`/tasks/${task.A1}/comments`).send({ body: 'x' }),
      await wb.patch(`/tasks/${task.A1}`).send({ title: 'x' }),
      await wb.get(`/tasks/${task.A1}/activity`),
    ]) {
      expect(res.status).toBe(404);
    }
    // Same token, but pretending to be on site A's domain → rejected by the origin policy
    expect((await widget(tB, ORIGIN_A1).get(`/tasks/${task.A1}`)).status).toBe(403);
    // Beta's user signing in on Alpha's widget has no access at all
    const onAlpha = await widgetLogin(clientB.email, site.A1.siteId, ORIGIN_A1);
    expect((await widget(onAlpha, ORIGIN_A1).get('/me')).body.data.access).toBeNull();
    expect((await widget(onAlpha, ORIGIN_A1).get('/tasks')).status).toBe(403);
  });

  it('signed file links are bound to one file', async () => {
    const shot = await prisma.taskAttachment.findFirstOrThrow({ where: { taskId: task.A1 } });
    const detail = await ownerA.agent.get(`${API}/tasks/${task.A1}`);
    const url = new URL(detail.body.data.attachments[0].url);
    await request(app).get(url.pathname + url.search).expect(200);
    const other = await prisma.task.findUniqueOrThrow({ where: { id: task.B1 } });
    // Re-using A's signature for another id fails
    await request(app).get(`${API}/files/${other.id}${url.search}`).expect(404);
    expect(shot.taskId).toBe(task.A1);
  });
});

describe('role-based permissions across websites', () => {
  it('roles apply per website: a developer on A1 has no rights on A2 or B1', async () => {
    await devA.agent.get(`${API}/tasks/${task.A2}`).expect(404);
    await devA.agent.get(`${API}/tasks/${task.B1}`).expect(404);
    await devA.agent.patch(`${API}/tasks/${task.A1}`).send({ status: 'IN_PROGRESS' }).expect(200);
    await devA.agent.delete(`${API}/websites/${site.A1.id}`).expect(403); // member, but not owner
  });

  it('reporters cannot run the workflow; owners cannot manage other owners’ websites', async () => {
    const r = await clientA.agent.patch(`${API}/tasks/${task.A1}`).send({ status: 'COMPLETED' });
    expect(r.body.error.code).toBe('WORKFLOW_FORBIDDEN');
    await ownerA.agent.patch(`${API}/websites/${site.B1.id}/settings`).send({ brandColor: '#000000' }).expect(404);
    await ownerA.agent.post(`${API}/websites/${site.B1.id}/members`).send({ email: devA.email, role: 'ADMIN' }).expect(404);
  });

  it('a platform super admin can see every tenant (positive control)', async () => {
    const admin = await signUp(app, { name: 'Platform Admin' });
    await prisma.user.update({ where: { id: admin.id }, data: { role: 'SUPER_ADMIN' } });
    const all = await admin.agent.get(`${API}/tasks`);
    expect(all.body.data.items.map((t: { id: string }) => t.id).sort()).toEqual([task.A1, task.A2, task.B1].sort());
  });
});
