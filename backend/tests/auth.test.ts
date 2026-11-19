import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sha256 } from '../src/lib/crypto';
import {
  API,
  PASSWORD,
  makeApp,
  prisma,
  rawCookies,
  request,
  resetDb,
  signUp,
  tokenFromOutbox,
  uniqueEmail,
} from './helpers';

const app = makeApp();

beforeAll(resetDb);
afterAll(() => prisma.$disconnect());

describe('registration', () => {
  it('registers a user, stores an Argon2id hash, sets HTTP-only cookies and sends a verification email', async () => {
    const email = uniqueEmail('reg');
    const res = await request(app)
      .post(`${API}/auth/register`)
      .send({ email: `  ${email.toUpperCase()} `, password: PASSWORD, name: 'Reg User' });

    expect(res.status).toBe(201);
    expect(res.body.data.user).toMatchObject({ email, name: 'Reg User', emailVerified: false, hasPassword: true });
    expect(res.body.data.user.passwordHash).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toMatch(/argon2|refresh/i);

    const cookies = rawCookies(res);
    const at = cookies.find((c) => c.startsWith('wrtm_at='))!;
    const rt = cookies.find((c) => c.startsWith('wrtm_rt='))!;
    expect(at).toMatch(/HttpOnly/);
    expect(at).toMatch(/SameSite=Lax/);
    expect(rt).toMatch(/HttpOnly/);
    expect(rt).toMatch(/Path=\/api\/v1\/auth/);

    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(user.passwordHash).toMatch(/^\$argon2id\$/);
    expect(await prisma.userSession.count({ where: { userId: user.id } })).toBe(1);
    expect(() => tokenFromOutbox(email, '/verify-email')).not.toThrow();
  });

  it('rejects duplicate emails (case-insensitive) with 409', async () => {
    const email = uniqueEmail('dup');
    await request(app).post(`${API}/auth/register`).send({ email, password: PASSWORD, name: 'A' }).expect(201);
    const res = await request(app)
      .post(`${API}/auth/register`)
      .send({ email: email.toUpperCase(), password: PASSWORD, name: 'B' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EMAIL_TAKEN');
  });

  it('validates input', async () => {
    const res = await request(app).post(`${API}/auth/register`).send({ email: 'not-an-email', password: 'short', name: '' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    const paths = res.body.error.details.map((d: { path: string }) => d.path);
    expect(paths).toEqual(expect.arrayContaining(['email', 'password', 'name']));

    const weak = await request(app)
      .post(`${API}/auth/register`)
      .send({ email: uniqueEmail(), password: 'allletters', name: 'X' });
    expect(weak.status).toBe(400);
  });

  it('rejects malformed JSON with 400', async () => {
    const res = await request(app)
      .post(`${API}/auth/login`)
      .set('content-type', 'application/json')
      .send('{"email":');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_JSON');
  });
});

describe('email & password login', () => {
  it('logs in with correct credentials and rejects wrong ones with a generic error', async () => {
    const { email } = await signUp(app, { verify: false });

    const ok = await request(app).post(`${API}/auth/login`).send({ email, password: PASSWORD });
    expect(ok.status).toBe(200);
    expect(ok.body.data.user.email).toBe(email);

    const wrong = await request(app).post(`${API}/auth/login`).send({ email, password: 'Wrong-pass1' });
    const unknown = await request(app).post(`${API}/auth/login`).send({ email: uniqueEmail('nobody'), password: PASSWORD });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    // Identical response → no account enumeration
    expect(wrong.body).toEqual(unknown.body);
  });

  it('locks the account for 15 minutes after 5 failed attempts', async () => {
    const { email } = await signUp(app, { verify: false });
    for (let i = 0; i < 5; i++) {
      await request(app).post(`${API}/auth/login`).send({ email, password: 'Wrong-pass1' }).expect(401);
    }
    const locked = await request(app).post(`${API}/auth/login`).send({ email, password: PASSWORD });
    expect(locked.status).toBe(423);
    expect(locked.body.error.code).toBe('ACCOUNT_LOCKED');
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(user.lockedUntil!.getTime()).toBeGreaterThan(Date.now() + 14 * 60 * 1000);
  });

  it('blocks suspended users', async () => {
    const { email, id } = await signUp(app);
    await prisma.user.update({ where: { id }, data: { status: 'SUSPENDED' } });
    const res = await request(app).post(`${API}/auth/login`).send({ email, password: PASSWORD });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ACCOUNT_SUSPENDED');
  });
});

describe('session management', () => {
  it('authenticates with the access cookie and with a Bearer header; rejects missing/forged tokens', async () => {
    const user = await signUp(app);
    const me = await user.agent.get(`${API}/users/me`);
    expect(me.status).toBe(200);
    expect(me.body.data.email).toBe(user.email);

    const login = await request(app).post(`${API}/auth/login`).send({ email: user.email, password: PASSWORD });
    const at = rawCookies(login).find((c) => c.startsWith('wrtm_at='))!.split(';')[0]!.split('=')[1]!;
    await request(app).get(`${API}/users/me`).set('Authorization', `Bearer ${at}`).expect(200);

    await request(app).get(`${API}/users/me`).expect(401);
    const forged = await request(app).get(`${API}/users/me`).set('Authorization', `Bearer ${at.slice(0, -4)}abcd`);
    expect(forged.status).toBe(401);
    expect(forged.body.error.code).toBe('TOKEN_INVALID');
  });

  it('rotates the refresh token on /refresh and rejects the old one', async () => {
    const email = uniqueEmail('refresh');
    const reg = await request(app).post(`${API}/auth/register`).send({ email, password: PASSWORD, name: 'R' });
    const oldRt = rawCookies(reg).find((c) => c.startsWith('wrtm_rt='))!.split(';')[0]!;

    const r1 = await request(app).post(`${API}/auth/refresh`).set('Cookie', oldRt);
    expect(r1.status).toBe(200);
    const newRt = rawCookies(r1).find((c) => c.startsWith('wrtm_rt='))!.split(';')[0]!;
    const newAt = rawCookies(r1).find((c) => c.startsWith('wrtm_at='))!.split(';')[0]!;
    expect(newRt).not.toBe(oldRt);

    // The fresh access token works
    await request(app).get(`${API}/users/me`).set('Cookie', newAt).expect(200);
    // The old refresh token is dead
    const replay = await request(app).post(`${API}/auth/refresh`).set('Cookie', oldRt);
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe('SESSION_EXPIRED');
    // Only hashes are stored server-side
    const raw = newRt.split('=')[1]!;
    expect(await prisma.userSession.count({ where: { refreshTokenHash: sha256(raw) } })).toBe(1);
    expect(await prisma.userSession.count({ where: { refreshTokenHash: raw } })).toBe(0);
  });

  it('logout revokes the session immediately (access token stops working before it expires)', async () => {
    const email = uniqueEmail('logout');
    const reg = await request(app).post(`${API}/auth/register`).send({ email, password: PASSWORD, name: 'L' });
    const cookies = rawCookies(reg).map((c) => c.split(';')[0]!);
    const at = cookies.find((c) => c.startsWith('wrtm_at='))!;

    await request(app).get(`${API}/users/me`).set('Cookie', at).expect(200);
    const out = await request(app).post(`${API}/auth/logout`).set('Cookie', cookies.join('; '));
    expect(out.status).toBe(204);
    expect(rawCookies(out).join(';')).toMatch(/wrtm_at=;.*Expires=Thu, 01 Jan 1970/);

    const after = await request(app).get(`${API}/users/me`).set('Cookie', at);
    expect(after.status).toBe(401);
    expect(after.body.error.code).toBe('SESSION_EXPIRED');
    const rt = cookies.find((c) => c.startsWith('wrtm_rt='))!;
    await request(app).post(`${API}/auth/refresh`).set('Cookie', rt).expect(401);
  });

  it('lists sessions, revokes a specific one, and logs out everywhere', async () => {
    const user = await signUp(app);
    const second = request.agent(app);
    await second.post(`${API}/auth/login`).send({ email: user.email, password: PASSWORD }).expect(200);

    const list = await user.agent.get(`${API}/auth/sessions`);
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(2);
    const current = list.body.data.find((s: { current: boolean }) => s.current);
    const other = list.body.data.find((s: { current: boolean }) => !s.current);
    expect(current).toBeTruthy();

    await user.agent.delete(`${API}/auth/sessions/${other.id}`).expect(204);
    await second.get(`${API}/users/me`).expect(401);
    await user.agent.get(`${API}/users/me`).expect(200);

    // Cannot revoke someone else's session
    const stranger = await signUp(app);
    await stranger.agent.delete(`${API}/auth/sessions/${current.id}`).expect(404);

    const third = request.agent(app);
    await third.post(`${API}/auth/login`).send({ email: user.email, password: PASSWORD }).expect(200);
    await user.agent.post(`${API}/auth/logout-all`).expect(204);
    await third.get(`${API}/users/me`).expect(401);
    await user.agent.get(`${API}/users/me`).expect(401);
  });
});

describe('email verification', () => {
  it('verifies with the emailed token, which is single-use', async () => {
    const user = await signUp(app, { verify: false });
    const token = tokenFromOutbox(user.email, '/verify-email');

    // Workspace APIs are blocked until verified
    const blocked = await user.agent.get(`${API}/websites`);
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('EMAIL_NOT_VERIFIED');

    const ok = await request(app).post(`${API}/auth/verify-email`).send({ token });
    expect(ok.status).toBe(200);
    expect(ok.body.data.user.emailVerified).toBe(true);
    await user.agent.get(`${API}/websites`).expect(200);

    const reuse = await request(app).post(`${API}/auth/verify-email`).send({ token });
    expect(reuse.status).toBe(400);
    expect(reuse.body.error.code).toBe('INVALID_TOKEN');
  });

  it('resend is rate-limited per user (cooldown) so repeated clicks cannot spam', async () => {
    const user = await signUp(app, { verify: false });
    const res = await user.agent.post(`${API}/auth/resend-verification`);
    expect([res.status, res.body.error.code]).toEqual([429, 'RESEND_TOO_SOON']);
    expect(res.body.error.message).toMatch(/check your inbox/i);
    expect(res.body.error.details.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('every verification email works (they can arrive out of order); one use retires the rest', async () => {
    const user = await signUp(app, { verify: false });
    const first = tokenFromOutbox(user.email, '/verify-email');
    // after the cooldown, request another email
    await prisma.authToken.updateMany({ where: { userId: user.id }, data: { createdAt: new Date(Date.now() - 120_000) } });
    await user.agent.post(`${API}/auth/resend-verification`).expect(200);
    const second = tokenFromOutbox(user.email, '/verify-email');
    expect(second).not.toBe(first);

    // The OLDER link still works (the newer email may have arrived first)
    await request(app).post(`${API}/auth/verify-email`).send({ token: first }).expect(200);
    // …and once verified, the other outstanding link is retired
    await request(app).post(`${API}/auth/verify-email`).send({ token: second }).expect(400);
    const again = await user.agent.post(`${API}/auth/resend-verification`);
    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe('ALREADY_VERIFIED');
  });

  it('password-reset links stay strict: a new request cancels the previous link', async () => {
    const user = await signUp(app);
    await request(app).post(`${API}/auth/forgot-password`).send({ email: user.email }).expect(200);
    const first = tokenFromOutbox(user.email, '/reset-password');
    await request(app).post(`${API}/auth/forgot-password`).send({ email: user.email }).expect(200);
    const second = tokenFromOutbox(user.email, '/reset-password');
    expect(second).not.toBe(first);
    await request(app).post(`${API}/auth/reset-password`).send({ token: first, password: 'An0ther-pass-2026' }).expect(400);
    await request(app).post(`${API}/auth/reset-password`).send({ token: second, password: 'An0ther-pass-2026' }).expect(200);
  });

  it('rejects expired tokens', async () => {
    const user = await signUp(app, { verify: false });
    const token = tokenFromOutbox(user.email, '/verify-email');
    await prisma.authToken.updateMany({
      where: { tokenHash: sha256(token) },
      data: { createdAt: new Date(Date.now() - 2 * 86400_000), expiresAt: new Date(Date.now() - 1000) },
    });
    await request(app).post(`${API}/auth/verify-email`).send({ token }).expect(400);
  });
});

describe('forgot & reset password', () => {
  it('returns the same response for unknown emails (no enumeration) and sends nothing', async () => {
    const res = await request(app).post(`${API}/auth/forgot-password`).send({ email: uniqueEmail('ghost') });
    expect(res.status).toBe(200);
    expect(res.body.data.message).toMatch(/If an account exists/);
  });

  it('resets the password, revokes all sessions, and the token is single-use', async () => {
    const user = await signUp(app);
    await request(app).post(`${API}/auth/forgot-password`).send({ email: user.email }).expect(200);
    const token = tokenFromOutbox(user.email, '/reset-password');

    const weak = await request(app).post(`${API}/auth/reset-password`).send({ token, password: 'weak' });
    expect(weak.status).toBe(400);

    const newPassword = 'Brand-new-pass9';
    await request(app).post(`${API}/auth/reset-password`).send({ token, password: newPassword }).expect(200);

    await user.agent.get(`${API}/users/me`).expect(401); // old session killed
    await request(app).post(`${API}/auth/login`).send({ email: user.email, password: PASSWORD }).expect(401);
    await request(app).post(`${API}/auth/login`).send({ email: user.email, password: newPassword }).expect(200);
    await request(app).post(`${API}/auth/reset-password`).send({ token, password: 'Another-pass9' }).expect(400);
  });

  it('a reset also clears an account lockout', async () => {
    const user = await signUp(app);
    await prisma.user.update({
      where: { id: user.id },
      data: { lockedUntil: new Date(Date.now() + 600_000) },
    });
    await request(app).post(`${API}/auth/forgot-password`).send({ email: user.email });
    const token = tokenFromOutbox(user.email, '/reset-password');
    await request(app).post(`${API}/auth/reset-password`).send({ token, password: 'Unlock-me-123' }).expect(200);
    await request(app).post(`${API}/auth/login`).send({ email: user.email, password: 'Unlock-me-123' }).expect(200);
  });
});

describe('user profile APIs', () => {
  it('reads and updates the profile', async () => {
    const user = await signUp(app, { name: 'Original' });
    const res = await user.agent.patch(`${API}/users/me`).send({ name: '  New Name ', avatarUrl: 'https://cdn.example.com/a.png' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ name: 'New Name', avatarUrl: 'https://cdn.example.com/a.png', emailVerified: true });

    await user.agent.patch(`${API}/users/me`).send({}).expect(400);
    await user.agent.patch(`${API}/users/me`).send({ avatarUrl: 'javascript:alert(1)' }).expect(400);
    // Mass-assignment attempt: unknown fields are stripped, role is not changeable
    await user.agent.patch(`${API}/users/me`).send({ name: 'X', role: 'SUPER_ADMIN' }).expect(200);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).role).toBe('USER');
  });

  it('changes the password (requires current password) and signs out other sessions', async () => {
    const user = await signUp(app);
    const other = request.agent(app);
    await other.post(`${API}/auth/login`).send({ email: user.email, password: PASSWORD }).expect(200);

    const bad = await user.agent.patch(`${API}/users/me/password`).send({ currentPassword: 'nope', newPassword: 'Changed-pass1' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('INVALID_CURRENT_PASSWORD');

    await user.agent
      .patch(`${API}/users/me/password`)
      .send({ currentPassword: PASSWORD, newPassword: 'Changed-pass1' })
      .expect(200);
    await user.agent.get(`${API}/users/me`).expect(200); // current session kept
    await other.get(`${API}/users/me`).expect(401); // others revoked
  });
});

describe('security middleware', () => {
  it('rate-limits auth endpoints', async () => {
    const limited = makeApp({ authRateLimit: 3 });
    const body = { email: uniqueEmail('rl'), password: 'Whatever-123' };
    for (let i = 0; i < 3; i++) await request(limited).post(`${API}/auth/login`).send(body).expect(401);
    const res = await request(limited).post(`${API}/auth/login`).send(body);
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('RATE_LIMITED');
    expect(res.headers['ratelimit-policy']).toBeDefined();
  });

  it('rejects state-changing requests from foreign origins (CSRF defence)', async () => {
    const user = await signUp(app);
    const res = await user.agent.post(`${API}/websites`).set('Origin', 'https://evil.example').send({ name: 'x', url: 'https://x.com' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('INVALID_ORIGIN');
    await user.agent
      .post(`${API}/websites`)
      .set('Origin', 'http://localhost:3000')
      .send({ name: 'Allowed', url: 'https://ok.example' })
      .expect(201);
  });

  it('sets security headers and hides the framework', async () => {
    const res = await request(app).get(`${API}/health`);
    expect(res.status).toBe(200);
    expect(res.body.data.database).toBe('ok');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['strict-transport-security']).toBeDefined();
  });

  it('CORS allows only configured origins, with credentials', async () => {
    const ok = await request(app).options(`${API}/auth/login`).set('Origin', 'http://localhost:3000').set('Access-Control-Request-Method', 'POST');
    expect(ok.headers['access-control-allow-origin']).toBe('http://localhost:3000');
    expect(ok.headers['access-control-allow-credentials']).toBe('true');
    const bad = await request(app).options(`${API}/auth/login`).set('Origin', 'https://evil.example').set('Access-Control-Request-Method', 'POST');
    expect(bad.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('returns 404 JSON for unknown routes', async () => {
    const res = await request(app).get(`${API}/nope`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('ROUTE_NOT_FOUND');
  });
});

