import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { API, PASSWORD, makeApp, prisma, request, resetDb, signUp, type TestUser } from './helpers';

/**
 * Dashboard → widget sign-in handoff ("Show on page").
 *
 * The dashboard and the review widget have separate sign-ins (the widget runs on the customer's
 * website, where the dashboard cookie doesn't exist). "Show on page" asks for the page link with
 * a single-use ticket; the widget swaps it for a site-bound widget session, so a Super Admin (or
 * any team member) reviewing a task lands on the page signed in, without a second login.
 */
const app = makeApp();
const ORIGIN = 'https://shop.example.com';
const OTHER_ORIGIN = 'https://blog.example.org';
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001', 'hex');

let owner: TestUser;
let client: TestUser;
let admin: request.SuperAgentTest;
let adminId: string;
let siteId: string;
let otherSiteId: string;
let clientTaskId: string;

const widgetLogin = async (email: string, sid = siteId, origin = ORIGIN) => {
  const res = await request(app).post(`${API}/widget/auth/login`).set('Origin', origin).send({ siteId: sid, email, password: PASSWORD });
  return res.body.data.session.accessToken as string;
};
const asWidget = (token: string, origin = ORIGIN) => ({
  get: (p: string) => request(app).get(`${API}/widget${p}`).set('Origin', origin).set('Authorization', `Bearer ${token}`),
  post: (p: string) => request(app).post(`${API}/widget${p}`).set('Origin', origin).set('Authorization', `Bearer ${token}`),
});
const ticketOf = (url: string) => {
  const u = new URL(url);
  return u.searchParams.get('wrtm_ticket') ?? /^#wrtm_ticket=(.+)$/.exec(u.hash)?.[1] ?? null;
};
const redeem = (ticket: string, sid = siteId, origin = ORIGIN) =>
  request(app).post(`${API}/widget/auth/handoff`).set('Origin', origin).send({ siteId: sid, ticket });

beforeAll(async () => {
  await resetDb();
  let adminUser: TestUser;
  [owner, client, adminUser] = await Promise.all([
    signUp(app, { name: 'Owner' }),
    signUp(app, { name: 'Client' }),
    signUp(app, { name: 'Platform Admin' }),
  ]);
  // The Super Admin is not a member of the website (platform role only).
  await prisma.user.update({ where: { id: adminUser.id }, data: { role: 'SUPER_ADMIN' } });
  adminId = adminUser.id;
  admin = request.agent(app);
  await admin.post(`${API}/auth/login`).send({ email: adminUser.email, password: PASSWORD }).expect(200);

  siteId = (await owner.agent.post(`${API}/websites`).send({ name: 'Shop', url: ORIGIN })).body.data.siteId;
  otherSiteId = (await owner.agent.post(`${API}/websites`).send({ name: 'Blog', url: OTHER_ORIGIN })).body.data.siteId;

  // A client reports an issue on an element, with a screenshot, through the widget.
  const w = asWidget(await widgetLogin(client.email));
  const created = await w.post('/tasks').send({
    title: 'About text is cut off',
    pageUrl: `${ORIGIN}/about`,
    element: { selector: '#about > p', tag: 'p', text: 'We create useful digital experiences' },
  });
  expect(created.status).toBe(201);
  clientTaskId = created.body.data.id;
  await w.post(`/tasks/${clientTaskId}/attachments?kind=screenshot`).set('Content-Type', 'image/png').set('X-File-Name', 'shot.png').send(PNG).expect(201);
});
afterAll(() => prisma.$disconnect());

describe('Show on page: dashboard → widget sign-in handoff', () => {
  it('a Super Admin gets the page link with a one-time sign-in, and the widget signs them in', async () => {
    const res = await admin.post(`${API}/tasks/${clientTaskId}/review-link`);
    expect(res.status).toBe(200);
    expect(res.body.data.signedIn).toBe(true);
    const url = new URL(res.body.data.url);
    expect(url.origin + url.pathname).toBe(`${ORIGIN}/about`);
    expect(url.searchParams.get('wrtm_task')).toBe(clientTaskId);
    expect(url.hash).toMatch(/^#wrtm_ticket=[A-Za-z0-9_-]{40,}$/); // fragment: never sent to the website's server

    // Stored hashed only.
    const stored = await prisma.authToken.findMany({ where: { userId: adminId, type: 'WIDGET_HANDOFF' } });
    expect(stored).toHaveLength(1);
    expect(stored[0]!.tokenHash).not.toContain(ticketOf(url.href)!);

    const signedIn = await redeem(ticketOf(url.href)!);
    expect(signedIn.status).toBe(200);
    expect(signedIn.body.data.user.id).toBe(adminId);
    const w = asWidget(signedIn.body.data.session.accessToken);

    // Signed in as the Super Admin: full review access to the client's task, screenshot included.
    const me = await w.get('/me');
    expect(me.status).toBe(200);
    expect(me.body.data.access).toBeTruthy();
    const task = await w.get(`/tasks/${clientTaskId}`);
    expect(task.status).toBe(200);
    expect(task.body.data.title).toBe('About text is cut off');
    expect(task.body.data.element).toMatchObject({ tag: 'p', text: 'We create useful digital experiences' });
    expect(task.body.data.attachments).toHaveLength(1);
    expect(task.body.data.attachments[0].kind).toBe('SCREENSHOT');
    await w.post(`/tasks/${clientTaskId}/comments`).send({ body: 'Checked on the page, fixing it.' }).expect(201);

    // Super Admin stays a platform admin: no website membership was created for them.
    expect(await prisma.websiteMember.count({ where: { userId: adminId } })).toBe(0);
    const session = await prisma.userSession.findFirstOrThrow({ where: { userId: adminId, authMethod: 'widget-handoff' } });
    expect(session.websiteId).not.toBeNull();
  });

  it('a ticket works once', async () => {
    const ticket = ticketOf((await admin.post(`${API}/tasks/${clientTaskId}/review-link`)).body.data.url)!;
    await redeem(ticket).expect(200);
    const again = await redeem(ticket);
    expect([again.status, again.body.error.code]).toEqual([401, 'HANDOFF_INVALID']);
  });

  it('a ticket expires', async () => {
    const ticket = ticketOf((await admin.post(`${API}/tasks/${clientTaskId}/review-link`)).body.data.url)!;
    await prisma.authToken.updateMany({ where: { userId: adminId, type: 'WIDGET_HANDOFF', usedAt: null }, data: { createdAt: new Date(Date.now() - 5 * 60_000), expiresAt: new Date(Date.now() - 1000) } });
    expect((await redeem(ticket)).status).toBe(401);
  });

  it("a ticket only works on its own website's widget, from an allowed domain", async () => {
    const ticket = ticketOf((await admin.post(`${API}/tasks/${clientTaskId}/review-link`)).body.data.url)!;
    expect((await redeem(ticket, otherSiteId, OTHER_ORIGIN)).status).toBe(401); // other website
    expect((await redeem(ticket, siteId, 'https://evil.example.net')).status).toBe(403); // not an allowed domain
    await redeem(ticket).expect(200); // still unused after the rejected attempts
  });

  it('malformed tickets are rejected', async () => {
    for (const ticket of ['', 'short', 'x'.repeat(201), 'has spaces in it and is long enough']) {
      expect((await redeem(ticket)).status).toBe(400);
    }
  });

  it('team members get it too; access rules are the dashboard ones', async () => {
    const res = await owner.agent.post(`${API}/tasks/${clientTaskId}/review-link`);
    expect(res.status).toBe(200);
    expect(res.body.data.signedIn).toBe(true);

    // Someone without access to the task gets nothing (same answer as a missing task).
    const outsider = await signUp(app, { name: 'Outsider' });
    expect((await outsider.agent.post(`${API}/tasks/${clientTaskId}/review-link`)).status).toBe(404);
    // Not signed in to the dashboard.
    expect((await request(app).post(`${API}/tasks/${clientTaskId}/review-link`)).status).toBe(401);
  });

  it('a page outside the website\'s domains gets the plain link (a ticket is never handed to another site)', async () => {
    // The widget only accepts pages of its own website, so this can only come from older or edited data.
    const w = asWidget(await widgetLogin(client.email));
    const t = (await w.post('/tasks').send({ title: 'Odd page', pageUrl: `${ORIGIN}/odd` })).body.data;
    await prisma.task.update({ where: { id: t.id }, data: { pageUrl: 'https://elsewhere.example.net/page' } });
    const before = await prisma.authToken.count({ where: { type: 'WIDGET_HANDOFF' } });
    const res = await admin.post(`${API}/tasks/${t.id}/review-link`);
    expect(res.status).toBe(200);
    expect(res.body.data.signedIn).toBe(false);
    expect(ticketOf(res.body.data.url)).toBeNull();
    expect(new URL(res.body.data.url).searchParams.get('wrtm_task')).toBe(t.id);
    expect(await prisma.authToken.count({ where: { type: 'WIDGET_HANDOFF' } })).toBe(before);
  });

  it('pages that use the fragment keep it; the ticket goes in the query instead', async () => {
    const w = asWidget(await widgetLogin(client.email));
    const t = (await w.post('/tasks').send({ title: 'SPA page', pageUrl: `${ORIGIN}/app#/settings` })).body.data;
    const url = new URL((await admin.post(`${API}/tasks/${t.id}/review-link`)).body.data.url);
    expect(url.hash).toBe('#/settings');
    expect(url.searchParams.get('wrtm_ticket')).toMatch(/^[A-Za-z0-9_-]{40,}$/);
  });

  it('a suspended account cannot use a ticket', async () => {
    const ticket = ticketOf((await owner.agent.post(`${API}/tasks/${clientTaskId}/review-link`)).body.data.url)!;
    await prisma.user.update({ where: { id: owner.id }, data: { status: 'SUSPENDED' } });
    expect((await redeem(ticket)).status).toBe(403);
    await prisma.user.update({ where: { id: owner.id }, data: { status: 'ACTIVE' } });
  });
});
