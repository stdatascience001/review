import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { env } from '../src/config/env';
import { fetchHomepage } from '../src/modules/websites/domain-verification';
import { API, PASSWORD, makeApp, prisma, request, resetDb, signUp, tokenFromOutbox, uniqueEmail, type TestUser } from './helpers';

const app = makeApp();

let owner: TestUser;
let dev: TestUser;
let websiteId: string;
let projectId: string;

// A real HTTP server standing in for the customer's website.
let pageHtml = '<html><head><title>Customer site</title></head><body>Hello</body></html>';
const site = http.createServer((req, res) => {
  if (req.url === '/moved') {
    res.writeHead(302, { location: '/' }).end();
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html' }).end(pageHtml);
});
let siteUrl: string;

beforeAll(async () => {
  await resetDb();
  await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve));
  siteUrl = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
  [owner, dev] = await Promise.all([signUp(app, { name: 'Owner' }), signUp(app, { name: 'Dev' })]);
  const w = await owner.agent.post(`${API}/websites`).send({ name: 'Client Site', url: `${siteUrl}/moved` });
  websiteId = w.body.data.id;
  projectId = (await owner.agent.post(`${API}/websites/${websiteId}/projects`).send({ name: 'Launch' })).body.data.id;
});
afterAll(async () => {
  site.close();
  await prisma.$disconnect();
});

describe('website administration', () => {
  it('generates a unique Site ID and an embed script on creation', async () => {
    const res = await owner.agent.get(`${API}/websites/${websiteId}`);
    expect(res.body.data.siteId).toMatch(/^site_[a-f0-9]{20}$/);
    expect(res.body.data.status).toBe('ACTIVE');
    expect(res.body.data.embedScript).toBe(
      `<script src="https://cdn.example.com/widget.js" data-site-id="${res.body.data.siteId}" data-api-url="http://localhost:4000/api/v1" async></script>`,
    );
    expect(res.body.data.verification.metaTag).toMatch(/^<meta name="wrtm-site-verification" content="[a-f0-9]{32}">$/);
  });

  it('regenerates the Site ID (old one stops matching)', async () => {
    const before = (await owner.agent.get(`${API}/websites/${websiteId}`)).body.data.siteId;
    const res = await owner.agent.post(`${API}/websites/${websiteId}/regenerate-site-id`);
    expect(res.status).toBe(200);
    expect(res.body.data.siteId).not.toBe(before);
    expect(res.body.data.embedScript).toContain(res.body.data.siteId);
    expect(await prisma.website.count({ where: { siteId: before } })).toBe(0);
  });

  it('edits name/description/logo and validates the logo URL', async () => {
    const ok = await owner.agent
      .patch(`${API}/websites/${websiteId}`)
      .send({ description: 'Main marketing site', logoUrl: 'https://cdn.example.com/logo.png' });
    expect(ok.status).toBe(200);
    expect(ok.body.data.logoUrl).toBe('https://cdn.example.com/logo.png');
    await owner.agent.patch(`${API}/websites/${websiteId}`).send({ logoUrl: 'http://insecure/logo.png' }).expect(400);
  });

  it('deactivating a website blocks new tasks; reactivating allows them', async () => {
    await owner.agent.patch(`${API}/websites/${websiteId}`).send({ status: 'INACTIVE' }).expect(200);
    const blocked = await owner.agent.post(`${API}/projects/${projectId}/tasks`).send({ title: 'x' });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('WEBSITE_INACTIVE');
    const filtered = await owner.agent.get(`${API}/websites`).query({ status: 'INACTIVE' });
    expect(filtered.body.data.items.map((w: { id: string }) => w.id)).toEqual([websiteId]);
    await owner.agent.patch(`${API}/websites/${websiteId}`).send({ status: 'ACTIVE' }).expect(200);
    await owner.agent.post(`${API}/projects/${projectId}/tasks`).send({ title: 'Now allowed' }).expect(201);
  });

  it('searches and paginates websites', async () => {
    await owner.agent.post(`${API}/websites`).send({ name: 'Another Shop', url: 'https://shop.example' });
    const res = await owner.agent.get(`${API}/websites`).query({ q: 'shop', pageSize: 1 });
    expect(res.body.data.pagination.total).toBe(1);
    expect(res.body.data.items[0].name).toBe('Another Shop');
  });

  it('configures allowed domains (validated and de-duplicated)', async () => {
    const res = await owner.agent
      .patch(`${API}/websites/${websiteId}/settings`)
      .send({ allowedDomains: ['example.com', '*.example.com', 'EXAMPLE.com'] });
    expect(res.status).toBe(200);
    expect(res.body.data.allowedDomains).toEqual(['example.com', '*.example.com']);
    await owner.agent.patch(`${API}/websites/${websiteId}/settings`).send({ allowedDomains: ['not a domain'] }).expect(400);
  });
});

describe('domain verification (real HTTP fetch)', () => {
  it('fails when the marker is missing, with a helpful error', async () => {
    const res = await owner.agent.post(`${API}/websites/${websiteId}/verify-domain`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ verified: false, domainVerifiedAt: null, checkedUrl: `${siteUrl}/` });
    expect(res.body.data.error).toMatch(/not found/);
  });

  it('verifies via the meta tag (after following a redirect)', async () => {
    const w = (await owner.agent.get(`${API}/websites/${websiteId}`)).body.data;
    pageHtml = `<html><head>${w.verification.metaTag}</head><body></body></html>`;
    const res = await owner.agent.post(`${API}/websites/${websiteId}/verify-domain`);
    expect(res.body.data).toMatchObject({ verified: true, method: 'meta_tag' });
    expect(res.body.data.domainVerifiedAt).not.toBeNull();
  });

  it('verifies via the installed embed script', async () => {
    const w = (await owner.agent.get(`${API}/websites/${websiteId}`)).body.data;
    pageHtml = `<html><body>${w.embedScript}</body></html>`;
    const res = await owner.agent.post(`${API}/websites/${websiteId}/verify-domain`);
    expect(res.body.data).toMatchObject({ verified: true, method: 'embed_script' });
  });

  it('changing the domain resets verification', async () => {
    const res = await owner.agent.patch(`${API}/websites/${websiteId}`).send({ url: 'https://new-domain.example' });
    expect(res.body.data.domainVerifiedAt).toBeNull();
    await owner.agent.patch(`${API}/websites/${websiteId}`).send({ url: `${siteUrl}/moved` });
  });

  it('refuses private-network addresses when ALLOW_PRIVATE_NETWORK_FETCH is off (SSRF guard)', async () => {
    env.ALLOW_PRIVATE_NETWORK_FETCH = false;
    try {
      await expect(fetchHomepage(siteUrl)).rejects.toThrow(/private network/);
      await expect(fetchHomepage('http://169.254.169.254/latest/meta-data')).rejects.toThrow(/private network/);
      await expect(fetchHomepage('file:///etc/passwd')).rejects.toThrow(/http/);
    } finally {
      env.ALLOW_PRIVATE_NETWORK_FETCH = true;
    }
  });

  it('only website managers can verify or regenerate', async () => {
    await owner.agent.post(`${API}/websites/${websiteId}/invitations`).send({ email: dev.email, role: 'DEVELOPER' }).expect(201);
    await dev.agent.post(`${API}/websites/${websiteId}/verify-domain`).expect(403);
    await dev.agent.post(`${API}/websites/${websiteId}/regenerate-site-id`).expect(403);
    const res = await dev.agent.get(`${API}/websites/${websiteId}`);
    expect(res.body.data.verification).toBeNull(); // token hidden from non-managers
  });
});

describe('team invitations', () => {
  const inviteeEmail = uniqueEmail('invitee');
  let token: string;

  it('inviting an existing user adds them immediately', async () => {
    // dev was added in the previous block via the invitations endpoint
    const members = await owner.agent.get(`${API}/websites/${websiteId}/members`);
    expect(members.body.data.find((m: { user: { id: string } }) => m.user.id === dev.id).role).toBe('DEVELOPER');
    const again = await owner.agent.post(`${API}/websites/${websiteId}/invitations`).send({ email: dev.email });
    expect(again.status).toBe(409);
  });

  it('inviting a new email sends an invitation with project assignment', async () => {
    const res = await owner.agent
      .post(`${API}/websites/${websiteId}/invitations`)
      .send({ email: inviteeEmail, role: 'PROJECT_MANAGER', projectIds: [projectId] });
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('invited');
    token = tokenFromOutbox(inviteeEmail, '/accept-invite');

    const pending = await owner.agent.get(`${API}/websites/${websiteId}/invitations`);
    expect(pending.body.data.map((i: { email: string }) => i.email)).toEqual([inviteeEmail]);

    const preview = await request(app).get(`${API}/invitations/${token}`);
    expect(preview.status).toBe(200);
    expect(preview.body.data).toMatchObject({
      email: inviteeEmail,
      role: 'PROJECT_MANAGER',
      website: { name: 'Client Site' },
      invitedBy: 'Owner',
      accountExists: false,
    });
  });

  it('rejects projects from another website', async () => {
    const other = (await owner.agent.post(`${API}/websites`).send({ name: 'Other', url: 'https://o.example' })).body.data.id;
    const otherProject = (await owner.agent.post(`${API}/websites/${other}/projects`).send({ name: 'P' })).body.data.id;
    const res = await owner.agent
      .post(`${API}/websites/${websiteId}/invitations`)
      .send({ email: uniqueEmail('x'), projectIds: [otherProject] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_PROJECTS');
  });

  it('only the invited email can accept; acceptance grants role, projects and verifies email', async () => {
    const stranger = await signUp(app);
    const mismatch = await stranger.agent.post(`${API}/invitations/accept`).send({ token });
    expect(mismatch.status).toBe(403);
    expect(mismatch.body.error.code).toBe('INVITATION_EMAIL_MISMATCH');

    // Invitee registers (unverified) and accepts
    const invitee = await signUp(app, { email: inviteeEmail, verify: false, name: 'Invitee' });
    const accept = await invitee.agent.post(`${API}/invitations/accept`).send({ token });
    expect(accept.status).toBe(200);
    expect(accept.body.data).toMatchObject({ websiteId, role: 'PROJECT_MANAGER' });

    const me = await invitee.agent.get(`${API}/users/me`);
    expect(me.body.data.emailVerified).toBe(true);
    const project = await invitee.agent.get(`${API}/projects/${projectId}`);
    expect(project.body.data.role).toBe('MANAGER');

    // PROJECT_MANAGER can create projects but not manage the website
    await invitee.agent.post(`${API}/websites/${websiteId}/projects`).send({ name: 'PM project' }).expect(201);
    await invitee.agent.patch(`${API}/websites/${websiteId}`).send({ name: 'x' }).expect(403);

    await invitee.agent.post(`${API}/invitations/accept`).send({ token }).expect(400); // single use
    const pending = await owner.agent.get(`${API}/websites/${websiteId}/invitations`);
    expect(pending.body.data).toHaveLength(0);
  });

  it('resend issues a new token (old link dies); revoke cancels', async () => {
    const email = uniqueEmail('resend');
    const created = await owner.agent.post(`${API}/websites/${websiteId}/invitations`).send({ email, role: 'WEBSITE_USER' });
    const invId = created.body.data.invitation.id;
    const first = tokenFromOutbox(email, '/accept-invite');
    await owner.agent.post(`${API}/websites/${websiteId}/invitations/${invId}/resend`).expect(200);
    const second = tokenFromOutbox(email, '/accept-invite');
    expect(second).not.toBe(first);
    await request(app).get(`${API}/invitations/${first}`).expect(400);
    await request(app).get(`${API}/invitations/${second}`).expect(200);

    await owner.agent.delete(`${API}/websites/${websiteId}/invitations/${invId}`).expect(204);
    await request(app).get(`${API}/invitations/${second}`).expect(400);
  });

  it('developers cannot invite; nobody can invite as OWNER; only the owner invites admins', async () => {
    await dev.agent.post(`${API}/websites/${websiteId}/invitations`).send({ email: uniqueEmail('n') }).expect(403);
    await owner.agent.post(`${API}/websites/${websiteId}/invitations`).send({ email: uniqueEmail('n'), role: 'OWNER' }).expect(400);
  });
});

describe('roles, project assignment & performance', () => {
  it('assigns projects to a member and changing role downgrades disallowed project roles', async () => {
    const set = await owner.agent
      .put(`${API}/websites/${websiteId}/members/${dev.id}/projects`)
      .send({ projects: [{ projectId }] });
    expect(set.status).toBe(200);
    expect(set.body.data).toEqual([{ role: 'CONTRIBUTOR', project: { id: projectId, name: 'Launch' } }]);

    const bad = await owner.agent
      .put(`${API}/websites/${websiteId}/members/${dev.id}/projects`)
      .send({ projects: [{ projectId, role: 'MANAGER' }] });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('INVALID_PROJECT_ROLE');

    await owner.agent.patch(`${API}/websites/${websiteId}/members/${dev.id}`).send({ role: 'WEBSITE_USER' }).expect(200);
    const members = await owner.agent.get(`${API}/websites/${websiteId}/members`);
    const m = members.body.data.find((x: { user: { id: string } }) => x.user.id === dev.id);
    expect(m.projects).toEqual([{ id: projectId, name: 'Launch', role: 'REVIEWER' }]);
    await owner.agent.patch(`${API}/websites/${websiteId}/members/${dev.id}`).send({ role: 'DEVELOPER' }).expect(200);
    await owner.agent
      .put(`${API}/websites/${websiteId}/members/${dev.id}/projects`)
      .send({ projects: [{ projectId, role: 'CONTRIBUTOR' }] })
      .expect(200);
  });

  it('computes developer performance from real task data', async () => {
    const yesterday = new Date(Date.now() - 86_400_000).toISOString();
    const mk = (title: string, extra = {}) =>
      owner.agent.post(`${API}/projects/${projectId}/tasks`).send({ title, assigneeId: dev.id, ...extra });
    const t1 = (await mk('Done 1')).body.data.id;
    const t2 = (await mk('Done 2')).body.data.id;
    await mk('Late', { dueDate: yesterday });
    await mk('Working', { status: 'IN_PROGRESS' });
    await dev.agent.patch(`${API}/tasks/${t1}`).send({ status: 'COMPLETED' }).expect(200);
    await dev.agent.patch(`${API}/tasks/${t2}`).send({ status: 'COMPLETED' }).expect(200);

    await dev.agent.get(`${API}/websites/${websiteId}/performance`).expect(403);
    const res = await owner.agent.get(`${API}/websites/${websiteId}/performance`);
    expect(res.status).toBe(200);
    const row = res.body.data.find((r: { user: { id: string } }) => r.user.id === dev.id);
    expect(row).toMatchObject({
      role: 'DEVELOPER',
      assigned: 4,
      completed: 2,
      open: 2,
      inProgress: 1,
      overdue: 1,
      completedLast30Days: 2,
      completionRate: 50,
    });
    expect(row.avgResolutionHours).toBeGreaterThanOrEqual(0);
  });
});

describe('cross-website lists & dashboard', () => {
  it('GET /projects returns accessible projects with progress', async () => {
    const res = await owner.agent.get(`${API}/projects`).query({ websiteId });
    const launch = res.body.data.items.find((p: { name: string }) => p.name === 'Launch');
    expect(launch.website.name).toBe('Client Site');
    expect(launch.progress).toEqual({ total: 5, completed: 2, percent: 40 });

    const devView = await dev.agent.get(`${API}/projects`);
    expect(devView.body.data.items.map((p: { name: string }) => p.name)).toEqual(['Launch']);
  });

  it('POST /projects assigns website + members; members must belong to the website', async () => {
    const res = await owner.agent
      .post(`${API}/projects`)
      .send({ websiteId, name: 'Redesign', startDate: '2026-12-01', dueDate: '2027-01-15', memberIds: [dev.id] });
    expect(res.status).toBe(201);
    const members = await owner.agent.get(`${API}/projects/${res.body.data.id}/members`);
    expect(members.body.data.map((m: { user: { id: string }; role: string }) => [m.user.id, m.role])).toEqual(
      expect.arrayContaining([[owner.id, 'MANAGER'], [dev.id, 'CONTRIBUTOR']]),
    );
    const outsider = await signUp(app);
    const bad = await owner.agent.post(`${API}/projects`).send({ websiteId, name: 'Bad', memberIds: [outsider.id] });
    expect(bad.status).toBe(400);
    await outsider.agent.post(`${API}/projects`).send({ websiteId, name: 'Sneaky' }).expect(404);
  });

  it('GET /tasks supports scope=mine, overdue and website filters', async () => {
    const mine = await dev.agent.get(`${API}/tasks`).query({ scope: 'mine' });
    expect(mine.body.data.pagination.total).toBe(4);
    expect(mine.body.data.items[0].project.name).toBe('Launch');
    const overdue = await dev.agent.get(`${API}/tasks`).query({ scope: 'mine', overdue: 'true' });
    expect(overdue.body.data.items.map((t: { title: string }) => t.title)).toEqual(['Late']);
    const all = await owner.agent.get(`${API}/tasks`).query({ websiteId, status: 'COMPLETED' });
    expect(all.body.data.pagination.total).toBe(2);
    const created = await owner.agent.post(`${API}/tasks`).send({ projectId, title: 'Via global form' });
    expect(created.status).toBe(201);
  });

  it('GET /comments lists comments across accessible tasks', async () => {
    const task = (await dev.agent.get(`${API}/tasks`).query({ scope: 'mine', q: 'Late' })).body.data.items[0];
    await dev.agent.post(`${API}/tasks/${task.id}/comments`).send({ body: 'Blocked by content' }).expect(201);
    const res = await owner.agent.get(`${API}/comments`).query({ q: 'blocked' });
    expect(res.body.data.items).toHaveLength(1);
    expect(res.body.data.items[0].task).toMatchObject({ title: 'Late', project: { name: 'Launch' } });
    const outsider = await signUp(app);
    expect((await outsider.agent.get(`${API}/comments`)).body.data.items).toHaveLength(0);
  });

  it('dashboard statistics match the database exactly (workspace scope)', async () => {
    const res = await owner.agent.get(`${API}/dashboard`).query({ websiteId });
    expect(res.status).toBe(200);
    const d = res.body.data;
    const dbTotal = await prisma.task.count({ where: { websiteId } });
    expect(d.scope).toBe('website');
    expect(d.totals).toMatchObject({
      websites: 1,
      projects: await prisma.project.count({ where: { websiteId } }),
      users: await prisma.websiteMember.count({ where: { websiteId } }),
      tasks: dbTotal,
      completedTasks: 2,
      overdueTasks: 1,
      inProgressTasks: 1,
    });
    expect(d.totals.openTasks).toBe(await prisma.task.count({ where: { websiteId, status: { in: ['OPEN', 'REOPENED'] } } }));
    expect(d.trend).toHaveLength(14);
    expect(d.trend.at(-1).created).toBe(dbTotal); // all created today
    expect(d.trend.at(-1).completed).toBe(2);
    expect(d.recentActivity.length).toBeGreaterThan(0);
    expect(d.recentActivity[0].task.project.name).toBeTruthy();
  });

  it('super admin gets platform-wide stats and can open any website', async () => {
    const admin = await signUp(app, { name: 'Platform' });
    await prisma.user.update({ where: { id: admin.id }, data: { role: 'SUPER_ADMIN' } });
    const d = (await admin.agent.get(`${API}/dashboard`)).body.data;
    expect(d.scope).toBe('platform');
    expect(d.totals.users).toBe(await prisma.user.count());
    expect(d.totals.websites).toBe(await prisma.website.count());
    expect(d.totals.tasks).toBe(await prisma.task.count());

    const w = await admin.agent.get(`${API}/websites/${websiteId}`);
    expect(w.status).toBe(200);
    expect(w.body.data.role).toBe('OWNER');
    const list = await admin.agent.get(`${API}/websites`);
    expect(list.body.data.pagination.total).toBe(await prisma.website.count());

    // Regular users only see their own scope
    const devStats = (await dev.agent.get(`${API}/dashboard`)).body.data;
    expect(devStats.scope).toBe('workspace');
    expect(devStats.totals.websites).toBe(1);
  });

  it('exposes which sign-in providers are enabled', async () => {
    const res = await request(app).get(`${API}/auth/providers`);
    expect(res.body.data).toEqual({ password: true, google: true });
  });

  it('dashboard is unreachable for other tenants’ websites', async () => {
    const outsider = await signUp(app);
    await outsider.agent.get(`${API}/dashboard`).query({ websiteId }).expect(404);
    await request(app).post(`${API}/auth/login`).send({ email: outsider.email, password: PASSWORD }).expect(200);
  });
});
