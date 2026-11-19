import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loginWithGoogleProfile } from '../src/modules/auth/auth.service';
import * as google from '../src/modules/auth/google.service';
import { API, PASSWORD, makeApp, prisma, rawCookies, request, resetDb, signUp, uniqueEmail } from './helpers';

/**
 * The only thing replaced here is the network call to Google's token endpoint
 * (exchangeCodeForProfile) — by default it still runs the real implementation; individual
 * tests override it once to simulate Google returning a verified profile.
 */
vi.mock('../src/modules/auth/google.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/modules/auth/google.service')>();
  return { ...actual, exchangeCodeForProfile: vi.fn(actual.exchangeCodeForProfile) };
});

const app = makeApp();
const meta = { ipAddress: '127.0.0.1', userAgent: 'vitest' };

beforeAll(resetDb);
afterAll(() => prisma.$disconnect());

const startFlow = async (redirect = '/dashboard') => {
  const res = await request(app).get(`${API}/auth/google`).query({ redirect });
  const stateCookie = rawCookies(res).find((c) => c.startsWith('wrtm_oauth='))!;
  const location = new URL(res.headers.location!);
  return { res, stateCookie: stateCookie.split(';')[0]!, rawStateCookie: stateCookie, location };
};

describe('Google OAuth – redirect flow', () => {
  it('redirects to Google with client_id, scopes, state and a PKCE S256 challenge', async () => {
    const { res, rawStateCookie, location } = await startFlow();
    expect(res.status).toBe(302);
    expect(location.origin).toBe('https://accounts.google.com');
    expect(location.searchParams.get('client_id')).toBe('test-client-id.apps.googleusercontent.com');
    expect(location.searchParams.get('redirect_uri')).toBe('http://localhost:4000/api/v1/auth/google/callback');
    expect(location.searchParams.get('scope')).toBe('openid email profile');
    expect(location.searchParams.get('response_type')).toBe('code');
    expect(location.searchParams.get('code_challenge_method')).toBe('S256');
    expect(location.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(location.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(rawStateCookie).toMatch(/HttpOnly/);
    expect(rawStateCookie).toMatch(/Path=\/api\/v1\/auth\/google/);
  });

  it('rejects a callback whose state does not match the cookie (CSRF)', async () => {
    const { stateCookie } = await startFlow();
    const res = await request(app)
      .get(`${API}/auth/google/callback`)
      .query({ code: 'abc', state: 'attacker-state' })
      .set('Cookie', stateCookie);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('http://localhost:3000/login?error=invalid_state');
    expect(rawCookies(res).some((c) => c.startsWith('wrtm_at='))).toBe(false);
  });

  it('rejects a callback without the state cookie', async () => {
    const res = await request(app).get(`${API}/auth/google/callback`).query({ code: 'abc', state: 'x' });
    expect(res.headers.location).toBe('http://localhost:3000/login?error=invalid_state');
  });

  it('handles the user denying consent', async () => {
    const res = await request(app).get(`${API}/auth/google/callback`).query({ error: 'access_denied' });
    expect(res.headers.location).toBe('http://localhost:3000/login?error=google_denied');
  });

  it('fails safely when Google rejects the authorization code (real token-endpoint call)', async () => {
    const { stateCookie, location } = await startFlow();
    const res = await request(app)
      .get(`${API}/auth/google/callback`)
      .query({ code: 'invalid-code', state: location.searchParams.get('state') })
      .set('Cookie', stateCookie);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('http://localhost:3000/login?error=google_failed');
    expect(rawCookies(res).some((c) => c.startsWith('wrtm_at='))).toBe(false);
  });

  it('on success: creates the user, sets session cookies, and redirects to the requested page only', async () => {
    const email = uniqueEmail('g-new');
    vi.mocked(google.exchangeCodeForProfile).mockResolvedValueOnce({
      sub: 'google-sub-123',
      email,
      emailVerified: true,
      name: 'Gina Google',
      picture: 'https://lh3.googleusercontent.com/a/photo',
    });
    const { stateCookie, location } = await startFlow('/projects/42');
    const res = await request(app)
      .get(`${API}/auth/google/callback`)
      .query({ code: 'good-code', state: location.searchParams.get('state') })
      .set('Cookie', stateCookie);

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('http://localhost:3000/projects/42');
    expect(vi.mocked(google.exchangeCodeForProfile)).toHaveBeenLastCalledWith('good-code', expect.any(String));
    const at = rawCookies(res).find((c) => c.startsWith('wrtm_at='))!.split(';')[0]!;

    const me = await request(app).get(`${API}/users/me`).set('Cookie', at);
    expect(me.status).toBe(200);
    expect(me.body.data).toMatchObject({ email, name: 'Gina Google', emailVerified: true, hasPassword: false, googleLinked: true });
    const session = await prisma.userSession.findFirstOrThrow({ where: { user: { email } } });
    expect(session.authMethod).toBe('google');
  });

  it('never redirects off-site (open-redirect protection)', async () => {
    for (const evil of ['https://evil.example', '//evil.example', '/\\evil.example']) {
      const { stateCookie, location } = await startFlow(evil);
      vi.mocked(google.exchangeCodeForProfile).mockResolvedValueOnce({
        sub: `sub-${Math.random()}`,
        email: uniqueEmail('g-redirect'),
        emailVerified: true,
      });
      const res = await request(app)
        .get(`${API}/auth/google/callback`)
        .query({ code: 'c', state: location.searchParams.get('state') })
        .set('Cookie', stateCookie);
      expect(res.headers.location).toBe('http://localhost:3000/');
    }
  });
});

describe('Google OAuth – ID token endpoint', () => {
  it('rejects tokens that fail Google signature verification', async () => {
    const fakeJwt = [
      Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'x', typ: 'JWT' })).toString('base64url'),
      Buffer.from(JSON.stringify({ sub: '1', email: 'a@b.c', aud: 'test-client-id.apps.googleusercontent.com' })).toString('base64url'),
      'c2lnbmF0dXJl',
    ].join('.');
    const res = await request(app).post(`${API}/auth/google/token`).send({ credential: fakeJwt });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('GOOGLE_TOKEN_INVALID');
  });
});

describe('Google OAuth – account resolution (loginWithGoogleProfile)', () => {
  it('links Google to an existing password account with the same email and verifies it', async () => {
    const user = await signUp(app, { verify: false });
    const result = await loginWithGoogleProfile(
      { sub: 'link-sub-1', email: user.email.toUpperCase(), emailVerified: true, name: 'Ignored' },
      meta,
    );
    expect(result.user.id).toBe(user.id);
    expect(result.user).toMatchObject({ googleLinked: true, hasPassword: true, emailVerified: true });
    // Password login still works afterwards
    await request(app).post(`${API}/auth/login`).send({ email: user.email, password: PASSWORD }).expect(200);
  });

  it('signs in the same user again by Google id, even if their Google email changed', async () => {
    const first = await loginWithGoogleProfile({ sub: 'stable-sub', email: uniqueEmail('g1'), emailVerified: true }, meta);
    const second = await loginWithGoogleProfile({ sub: 'stable-sub', email: uniqueEmail('g2'), emailVerified: true }, meta);
    expect(second.user.id).toBe(first.user.id);
  });

  it('refuses unverified Google emails', async () => {
    await expect(
      loginWithGoogleProfile({ sub: 'unverified', email: uniqueEmail('gu'), emailVerified: false }, meta),
    ).rejects.toMatchObject({ code: 'GOOGLE_EMAIL_UNVERIFIED' });
  });

  it('refuses when the email is already linked to a different Google account', async () => {
    const email = uniqueEmail('gm');
    await loginWithGoogleProfile({ sub: 'owner-sub', email, emailVerified: true }, meta);
    await expect(
      loginWithGoogleProfile({ sub: 'other-sub', email, emailVerified: true }, meta),
    ).rejects.toMatchObject({ code: 'GOOGLE_ACCOUNT_MISMATCH' });
  });

  it('refuses suspended accounts', async () => {
    const r = await loginWithGoogleProfile({ sub: 'susp-sub', email: uniqueEmail('gs'), emailVerified: true }, meta);
    await prisma.user.update({ where: { id: r.user.id }, data: { status: 'SUSPENDED' } });
    await expect(
      loginWithGoogleProfile({ sub: 'susp-sub', email: 'x@example.com', emailVerified: true }, meta),
    ).rejects.toMatchObject({ code: 'ACCOUNT_SUSPENDED' });
  });

  it('Google-only accounts (no password) cannot use password login', async () => {
    const email = uniqueEmail('g-pw');
    await loginWithGoogleProfile({ sub: 'pw-sub', email, emailVerified: true }, meta);
    await request(app).post(`${API}/auth/login`).send({ email, password: PASSWORD }).expect(401);
  });
});
