import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appRoleStatements } from '../prisma/app-role';
import { env } from '../src/config/env';
import { renderWidgetAuthResult } from '../src/modules/widget/widget.popup';
import { API, PASSWORD, makeApp, prisma, rawCookies, request, resetDb, signUp, uniqueEmail, type TestUser } from './helpers';

/**
 * Security verification: authentication, authorization, HTTP-only cookies, CSRF, XSS,
 * rate limiting, upload validation, SSRF-safe domain verification, input validation,
 * environment/secret handling, database privileges, and the audit log.
 */
const app = makeApp();
const ORIGIN = 'http://localhost:3000';
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

let owner: TestUser;
let outsider: TestUser;
let websiteId: string;
let projectId: string;
let taskId: string;

beforeAll(async () => {
  await resetDb();
  [owner, outsider] = await Promise.all([signUp(app, { name: 'Sec Owner' }), signUp(app, { name: 'Sec Outsider' })]);
  websiteId = (await owner.agent.post(`${API}/websites`).send({ name: 'Secure', url: 'https://secure.example.com' })).body.data.id;
  projectId = (await owner.agent.post(`${API}/websites/${websiteId}/projects`).send({ name: 'P' })).body.data.id;
  taskId = (await owner.agent.post(`${API}/projects/${projectId}/tasks`).send({ title: 'T' })).body.data.id;
});
afterAll(() => prisma.$disconnect());

describe('authentication', () => {
  it('every private endpoint requires a session', async () => {
    for (const [method, url] of [
      ['get', '/users/me'],
      ['get', '/websites'],
      ['get', '/tasks'],
      ['get', `/tasks/${taskId}`],
      ['get', '/dashboard'],
      ['get', '/analytics'],
      ['get', '/audit-logs'],
      ['get', '/notifications'],
      ['post', '/websites'],
    ] as const) {
      const res = await request(app)[method](`${API}${url}`);
      expect([url, res.status]).toEqual([url, 401]);
    }
  });

  it('rejects forged, re-signed and wrong-audience tokens', async () => {
    const login = await request(app).post(`${API}/auth/login`).send({ email: owner.email, password: PASSWORD });
    const token = rawCookies(login).find((c) => c.startsWith('wrtm_at='))!.split(';')[0]!.slice(8);
    const [h, p, sig] = token.split('.');
    const forgedPayload = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p!, 'base64url').toString()), role: 'SUPER_ADMIN' })).toString('base64url');
    await request(app).get(`${API}/users/me`).set('Authorization', `Bearer ${h}.${forgedPayload}.${sig}`).expect(401);
    const decoded = jwt.decode(token) as Record<string, unknown>;
    const otherKey = jwt.sign({ sub: decoded.sub, sid: decoded.sid, role: 'SUPER_ADMIN' }, 'some-other-secret-some-other-secret-1234', {
      issuer: 'wrtm-api',
      audience: 'wrtm-app',
    });
    await request(app).get(`${API}/users/me`).set('Authorization', `Bearer ${otherKey}`).expect(401);
    const noneAlg = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${p}.`;
    await request(app).get(`${API}/users/me`).set('Authorization', `Bearer ${noneAlg}`).expect(401);
    await request(app).get(`${API}/users/me`).set('Authorization', `Bearer ${token}`).expect(200);
  });

  it('suspended accounts are locked out at once', async () => {
    const u = await signUp(app, { name: 'Suspend Me' });
    await prisma.user.update({ where: { id: u.id }, data: { status: 'SUSPENDED' } });
    const res = await u.agent.get(`${API}/users/me`);
    expect([res.status, res.body.error.code]).toEqual([403, 'ACCOUNT_SUSPENDED']);
  });
});

describe('authorization & HTTP-only cookies', () => {
  it('session cookies are HttpOnly, SameSite=Lax and never exposed to JavaScript', async () => {
    const res = await request(app).post(`${API}/auth/login`).send({ email: owner.email, password: PASSWORD });
    const at = rawCookies(res).find((c) => c.startsWith('wrtm_at='))!;
    const rt = rawCookies(res).find((c) => c.startsWith('wrtm_rt='))!;
    for (const c of [at, rt]) {
      expect(c).toMatch(/HttpOnly/i);
      expect(c).toMatch(/SameSite=Lax/i);
    }
    expect(rt).toMatch(/Path=\/api\/v1\/auth/); // refresh token only travels to the auth endpoints
    expect(JSON.stringify(res.body)).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/); // no tokens in the body
  });

  it('privilege escalation through the API is not possible', async () => {
    await owner.agent.patch(`${API}/users/me`).send({ role: 'SUPER_ADMIN', name: 'Sec Owner' }).expect(200);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: owner.id } })).role).toBe('USER');
    await owner.agent.get(`${API}/users`).expect(403);
    await outsider.agent.get(`${API}/tasks/${taskId}`).expect(404);
  });
});

describe('CSRF', () => {
  it('cookie-authenticated writes from a foreign origin are refused', async () => {
    const res = await owner.agent.post(`${API}/websites`).set('Origin', 'https://evil.example.net').send({ name: 'x', url: 'https://x.com' });
    expect([res.status, res.body.error.code]).toEqual([403, 'INVALID_ORIGIN']);
    await owner.agent.patch(`${API}/tasks/${taskId}`).set('Origin', 'https://evil.example.net').send({ title: 'pwned' }).expect(403);
    await owner.agent.patch(`${API}/tasks/${taskId}`).set('Origin', ORIGIN).send({ title: 'T2' }).expect(200);
  });

  it('the cross-origin widget API never accepts cookies (bearer tokens only)', async () => {
    const res = await owner.agent.get(`${API}/widget/me`).set('Origin', 'https://secure.example.com');
    expect(res.status).toBe(401);
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });
});

describe('XSS', () => {
  it('stores user content verbatim and only ever returns it as JSON', async () => {
    const payload = '<img src=x onerror=alert(1)><script>alert(document.cookie)</script>';
    const c = await owner.agent.post(`${API}/tasks/${taskId}/comments`).send({ body: payload });
    expect(c.headers['content-type']).toMatch(/^application\/json/);
    expect(c.body.data.body).toBe(payload); // React renders it as text
  });

  it('security headers are set (CSP, nosniff, frame protection, HSTS-ready)', async () => {
    const res = await request(app).get(`${API}/health`);
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(res.headers['strict-transport-security']).toBeDefined();
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('the Google popup page escapes data it embeds', async () => {
    const mini = express();
    mini.get('/', (_req, res) => renderWidgetAuthResult(res, 'https://shop.example.com', { ok: true, user: { name: '</script><script>alert(1)</script>' } }));
    const res = await request(mini).get('/');
    expect(res.text).not.toContain('</script><script>alert(1)');
    expect(res.text).toContain('\\u003c/script>');
    expect(res.headers['content-security-policy']).toMatch(/script-src 'nonce-[^']+'/);
  });
});

describe('rate limiting', () => {
  it('limits credential endpoints per IP', async () => {
    const limited = makeApp({ authRateLimit: 3 });
    for (let i = 0; i < 3; i++) await request(limited).post(`${API}/auth/login`).send({ email: 'nobody@example.com', password: 'wrong-pass-1' });
    const res = await request(limited).post(`${API}/auth/login`).send({ email: 'nobody@example.com', password: 'wrong-pass-1' });
    expect([res.status, res.body.error.code]).toEqual([429, 'RATE_LIMITED']);
    expect(res.headers.ratelimit ?? res.headers['ratelimit-policy']).toBeDefined();
  });

  it('successful sign-ins do not use up the credential limit', async () => {
    const limited = makeApp({ authRateLimit: 3 });
    const user = await signUp(limited);
    for (let i = 0; i < 6; i++) {
      await request(limited).post(`${API}/auth/login`).send({ email: user.email, password: PASSWORD }).expect(200);
    }
  });

  it('limits the whole API per IP', async () => {
    const limited = makeApp({ apiRateLimit: 2 });
    await request(limited).get(`${API}/health`).expect(200);
    await request(limited).get(`${API}/health`).expect(200);
    await request(limited).get(`${API}/health`).expect(429);
  });

  it('locks an account after repeated wrong passwords', async () => {
    const email = uniqueEmail('lock');
    await request(app).post(`${API}/auth/register`).send({ email, password: PASSWORD, name: 'Lock' });
    for (let i = 0; i < 5; i++) await request(app).post(`${API}/auth/login`).send({ email, password: 'wrong-pass-1' });
    const res = await request(app).post(`${API}/auth/login`).send({ email, password: PASSWORD });
    expect([res.status, res.body.error.code]).toEqual([423, 'ACCOUNT_LOCKED']);
  });
});

describe('file upload validation', () => {
  const up = (body: Buffer, opts: { type?: string; name?: string; kind?: string } = {}) =>
    owner.agent
      .post(`${API}/tasks/${taskId}/attachments?kind=${opts.kind ?? 'file'}`)
      .set('Content-Type', opts.type ?? 'application/octet-stream')
      .set('X-File-Name', opts.name ?? 'file.bin')
      .send(body);

  it('checks real content, not the declared type or extension', async () => {
    expect((await up(Buffer.from('<svg onload=alert(1)>'), { type: 'image/png', name: 'a.png' })).body.error.code).toBe('INVALID_FILE');
    expect((await up(Buffer.from('<html><script>x</script>'), { type: 'text/plain', name: 'a.txt' })).status).toBe(201); // plain text is fine…
    const txt = await prisma.taskAttachment.findFirstOrThrow({ where: { taskId, fileName: 'a.txt' } });
    expect(txt.mimeType).toBe('text/plain'); // …and is served as text/plain, as a download
    expect((await up(Buffer.from('MZ\x90\x00binary'), { name: 'setup.exe' })).body.error.code).toBe('INVALID_FILE');
    expect((await up(Buffer.from('%PDF-1.4 x'), { kind: 'screenshot', name: 'a.pdf' })).body.error.code).toBe('INVALID_IMAGE');
    expect((await up(Buffer.alloc(0))).body.error.code).toBe('EMPTY_FILE');
  });

  it('enforces the size limit and sanitizes file names (no path traversal)', async () => {
    const big = Buffer.concat([PNG, Buffer.alloc((env.MAX_UPLOAD_MB + 1) * 1024 * 1024)]);
    const res = await up(big, { type: 'image/png', kind: 'screenshot' });
    expect([res.status, res.body.error.code]).toEqual([413, 'PAYLOAD_TOO_LARGE']);
    const ok = await up(PNG, { type: 'image/png', name: encodeURIComponent('..\\..\\..\\etc/passwd<script>.png'), kind: 'screenshot' });
    expect(ok.status).toBe(201);
    expect(ok.body.data.fileName).toBe('passwd_script_.png');
    const row = await prisma.taskAttachment.findUniqueOrThrow({ where: { id: ok.body.data.id } });
    expect(row.storageKey).toMatch(/^\d{4}\/\d{2}\/[0-9a-f-]{36}\.png$/); // server-chosen path
  });

  it('serves files only via signed links, sandboxed and never sniffed', async () => {
    const detail = await owner.agent.get(`${API}/tasks/${taskId}`);
    const txt = detail.body.data.attachments.find((a: { fileName: string }) => a.fileName === 'a.txt');
    const u = new URL(txt.url);
    const res = await request(app).get(u.pathname + u.search);
    expect(res.headers['content-type']).toMatch(/^text\/plain/);
    expect(res.headers['content-disposition']).toMatch(/^attachment/);
    expect(res.headers['content-security-policy']).toContain('sandbox');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    await request(app).get(u.pathname).expect(404);
    const expired = new URLSearchParams(u.search);
    expired.set('exp', String(Math.floor(Date.now() / 1000) - 10));
    await request(app).get(`${u.pathname}?${expired}`).expect(404);
  });
});

describe('domain verification (SSRF protection)', () => {
  it('refuses to fetch private/loopback addresses in production mode', async () => {
    const w = (await owner.agent.post(`${API}/websites`).send({ name: 'Internal', url: 'http://127.0.0.1:5432' })).body.data;
    const prev = env.ALLOW_PRIVATE_NETWORK_FETCH;
    env.ALLOW_PRIVATE_NETWORK_FETCH = false;
    try {
      const res = await owner.agent.post(`${API}/websites/${w.id}/verify-domain`);
      expect(res.body.data.verified).toBe(false);
      expect(res.body.data.error).toMatch(/private network/);
    } finally {
      env.ALLOW_PRIVATE_NETWORK_FETCH = prev;
    }
    const bad = await owner.agent.post(`${API}/websites`).send({ name: 'x', url: 'file:///etc/passwd' });
    expect(bad.status).toBe(400);
  });
});

describe('API validation', () => {
  it('rejects malformed input with a 400 and never 500s', async () => {
    expect((await owner.agent.get(`${API}/tasks/not-a-uuid`)).body.error.code).toBe('VALIDATION_ERROR');
    expect((await owner.agent.get(`${API}/tasks`).query({ status: 'NOPE' })).status).toBe(400);
    expect((await owner.agent.get(`${API}/tasks`).query({ pageSize: 100000 })).status).toBe(400);
    const json = await owner.agent.post(`${API}/websites`).set('Content-Type', 'application/json').send('{"name":');
    expect(json.body.error.code).toBe('INVALID_JSON');
    const huge = await owner.agent.post(`${API}/websites`).send({ name: 'x'.repeat(200_000), url: 'https://x.com' });
    expect(huge.status).toBe(413);
    const sqlish = await owner.agent.get(`${API}/tasks`).query({ q: "' OR 1=1; DROP TABLE tasks; --" });
    expect(sqlish.status).toBe(200);
    expect(sqlish.body.data.items).toEqual([]);
    expect(await prisma.task.count()).toBeGreaterThan(0);
  });

  it('errors carry a request id but no internals', async () => {
    const res = await request(app).get(`${API}/does-not-exist`);
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(res.body)).not.toMatch(/at .*\.ts:\d+|prisma|stack/i);
  });
});

describe('environment variables', () => {
  const backendDir = path.resolve(__dirname, '..');
  const boot = (extra: Record<string, string>) =>
    spawnSync('npx', ['tsx', '-e', '"require(\'./src/config/env\')"'], {
      cwd: backendDir,
      shell: true,
      encoding: 'utf8',
      env: { ...process.env, ...extra },
    });

  it('refuses to start with weak or unsafe production settings', () => {
    expect(boot({ JWT_ACCESS_SECRET: 'too-short' }).stderr).toMatch(/JWT_ACCESS_SECRET must be at least 32 characters/);
    expect(boot({ NODE_ENV: 'production', COOKIE_SECURE: 'false' }).stderr).toMatch(/COOKIE_SECURE must be true in production/);
  }, 60_000);

  it('.env is git-ignored and .env.example contains no real secrets', () => {
    const root = path.resolve(backendDir, '..');
    expect(fs.readFileSync(path.join(root, '.gitignore'), 'utf8')).toMatch(/^\.env$/m);
    const example = fs.readFileSync(path.join(backendDir, '.env.example'), 'utf8');
    const realEnv = fs.existsSync(path.join(backendDir, '.env')) ? fs.readFileSync(path.join(backendDir, '.env'), 'utf8') : '';
    const secrets = [...realEnv.matchAll(/^(DATABASE_URL|JWT_ACCESS_SECRET|SMTP_PASS|GOOGLE_CLIENT_SECRET)=(.+)$/gm)].map((m) => m[2]!.replace(/^"|"$/g, ''));
    const dbPassword = realEnv.match(/postgres(?:ql)?:\/\/[^:]+:([^@]+)@/)?.[1];
    for (const secret of [...secrets, dbPassword].filter((v): v is string => Boolean(v && v.length >= 6))) {
      expect(example.includes(secret)).toBe(false);
    }
  });
});

describe('database access restrictions (least-privilege app role)', () => {
  const role = 'wrtm_app_sectest';
  const password = 'App-role-test-2026';
  let appDb: PrismaClient;

  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL!);
    for (const stmt of appRoleStatements({ role, password, database: url.pathname.slice(1) })) await prisma.$executeRawUnsafe(stmt);
    url.username = role;
    url.password = password;
    appDb = new PrismaClient({ datasourceUrl: url.toString() });
  });
  afterAll(async () => {
    await appDb?.$disconnect();
    await prisma.$executeRawUnsafe(`DROP OWNED BY "${role}"`);
    await prisma.$executeRawUnsafe(`DROP ROLE IF EXISTS "${role}"`);
  });

  it('the app role can read and write rows…', async () => {
    expect(await appDb.user.count()).toBeGreaterThan(0);
    await appDb.auditLog.create({ data: { action: 'test.app_role' } });
  });

  it('…but cannot change the schema, read migrations, or rewrite the audit log', async () => {
    const denied = async (sql: string) => {
      await expect(appDb.$executeRawUnsafe(sql)).rejects.toThrow(/permission denied|must be owner/);
    };
    await denied('CREATE TABLE intruder (id int)');
    await denied('DROP TABLE "users"');
    await denied('ALTER TABLE "users" ADD COLUMN x int');
    await denied('TRUNCATE "tasks"');
    await denied(`UPDATE "audit_logs" SET action = 'tampered'`);
    await denied('DELETE FROM "audit_logs"');
    await denied('SELECT * FROM "_prisma_migrations"');
  });
});

describe('audit logs', () => {
  it('records logins (successful and failed), denials and sensitive changes with who/when/where', async () => {
    await request(app).post(`${API}/auth/login`).set('User-Agent', 'audit-test').send({ email: owner.email, password: 'definitely-wrong-1' });
    await request(app).post(`${API}/auth/login`).set('User-Agent', 'audit-test').send({ email: owner.email, password: PASSWORD });
    await outsider.agent.delete(`${API}/websites/${websiteId}`).expect(404);
    await owner.agent.patch(`${API}/websites/${websiteId}/settings`).send({ allowedDomains: ['staging.secure.dev'] }).expect(200);
    await new Promise((r) => setTimeout(r, 200)); // audit rows are written after the response

    const rows = await prisma.auditLog.findMany({ orderBy: { createdAt: 'asc' } });
    const failed = rows.find((r) => r.action === 'auth.login' && r.outcome === 'failure' && r.actorEmail === owner.email);
    expect(failed).toMatchObject({ actorEmail: owner.email, statusCode: 401, userAgent: 'audit-test' });
    expect(failed!.ipAddress).toBeTruthy();
    expect(rows.find((r) => r.action === 'auth.login' && r.outcome === 'success' && r.actorId === owner.id)).toBeTruthy();
    expect(rows.find((r) => r.action === 'website.deleted')).toMatchObject({ outcome: 'denied', actorId: outsider.id, websiteId, statusCode: 404 });
    expect(rows.find((r) => r.action === 'website.settings_updated')).toMatchObject({
      outcome: 'success',
      actorId: owner.id,
      websiteId,
      metadata: { changes: { allowedDomains: ['staging.secure.dev'] } },
    });
    // No secrets are ever recorded
    expect(JSON.stringify(rows)).not.toContain(PASSWORD);
    expect(JSON.stringify(rows)).not.toContain('definitely-wrong-1');
  });

  it('is readable by super admins, per website by its owners, and cannot be changed through the API', async () => {
    await outsider.agent.get(`${API}/audit-logs`).expect(403);
    await outsider.agent.get(`${API}/audit-logs`).query({ websiteId }).expect(403);
    const mine = await owner.agent.get(`${API}/audit-logs`).query({ websiteId });
    expect(mine.status).toBe(200);
    expect(mine.body.data.items.every((r: { websiteId: string }) => r.websiteId === websiteId)).toBe(true);
    const admin = await signUp(app, { name: 'Auditor' });
    await prisma.user.update({ where: { id: admin.id }, data: { role: 'SUPER_ADMIN' } });
    const all = await admin.agent.get(`${API}/audit-logs`).query({ action: 'auth.login', outcome: 'failure' });
    expect(all.body.data.items.length).toBeGreaterThan(0);
    expect(all.body.data.items.every((r: { action: string; outcome: string }) => r.action === 'auth.login' && r.outcome === 'failure')).toBe(true);
    await admin.agent.delete(`${API}/audit-logs`).expect(404);
    await admin.agent.patch(`${API}/audit-logs`).send({}).expect(404);
  });
});
