import { expect, test, type ConsoleMessage } from '@playwright/test';
import { PROD_ADMIN, PROD_DEMO_PORT, PROD_URL } from '../playwright.prod.config';

/**
 * Smoke test of the production build, served by `node dist/server.js` (NODE_ENV=production).
 */
test.describe.configure({ mode: 'serial' });

const DEMO = `http://127.0.0.1:${PROD_DEMO_PORT}`;
let siteId = '';

test('serves the built dashboard with production headers and caching', async ({ request }) => {
  const index = await request.get('/');
  expect(index.status()).toBe(200);
  expect(index.headers()['content-type']).toContain('text/html');
  expect(index.headers()['cache-control']).toBe('no-cache');
  const csp = index.headers()['content-security-policy'];
  expect(csp).toContain("default-src 'self'");
  expect(csp).toContain(`connect-src 'self' ws://localhost:4200`);
  expect(index.headers()['strict-transport-security']).toBeDefined();
  const asset = (await index.text()).match(/\/assets\/[\w.-]+\.js/)![0];
  const js = await request.get(asset);
  expect(js.headers()['cache-control']).toBe('public, max-age=31536000, immutable');
  // SPA routes fall back to index.html; API 404s stay JSON
  expect((await request.get('/tasks/some/deep/link')).headers()['content-type']).toContain('text/html');
  const api404 = await request.get('/api/v1/nope');
  expect(api404.status()).toBe(404);
  expect(await api404.json()).toMatchObject({ error: { code: 'ROUTE_NOT_FOUND' } });
  // Widget bundle
  const widget = await request.get('/widget.js');
  expect(widget.headers()['cache-control']).toBe('public, max-age=300');
  expect(widget.headers()['access-control-allow-origin']).toBe('*');
});

test('sign-in sets Secure HTTP-only cookies; dashboard is live with no CSP or console errors', async ({ page, context }) => {
  const problems: string[] = [];
  // JS errors and CSP violations. (The anonymous session probe on /login answers 401 by design.)
  page.on('console', (m: ConsoleMessage) => m.type() === 'error' && !/status of 401/.test(m.text()) && problems.push(m.text()));
  page.on('pageerror', (e) => problems.push(e.message));

  await page.goto('/login');
  await page.getByLabel('Email').fill(PROD_ADMIN.email);
  await page.getByLabel('Password').fill(PROD_ADMIN.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
  await expect(page.getByTestId('live-status')).toHaveAttribute('data-status', 'live'); // WebSocket through the same origin

  const cookies = await context.cookies();
  for (const name of ['wrtm_at', 'wrtm_rt']) {
    const c = cookies.find((x) => x.name === name)!;
    expect(c).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Lax' });
  }
  // Lazy-loaded routes
  for (const [link, heading] of [
    ['Analytics', 'Analytics'],
    ['Websites', 'Websites'],
    ['All Tasks', 'All Tasks'],
    ['Audit Log', 'Audit Log'],
  ]) {
    await page.getByRole('link', { name: link, exact: true }).click();
    await expect(page.getByRole('heading', { name: heading, level: 1 })).toBeVisible();
  }
  await expect(page.getByTestId('audit-rows')).toContainText('auth.login');
  expect(problems).toEqual([]);
});

test('production widget: installed on an external site, creates a task that appears in the dashboard live', async ({ page, browser, request }) => {
  // Admin session (API) creates the website for the external demo site
  const login = await request.post('/api/v1/auth/login', { data: { email: PROD_ADMIN.email, password: PROD_ADMIN.password }, headers: { origin: PROD_URL } });
  expect(login.status()).toBe(200);
  const w = await request.post('/api/v1/websites', { data: { name: 'Prod Demo', url: DEMO }, headers: { origin: PROD_URL } });
  siteId = (await w.json()).data.siteId;
  await request.post(`${DEMO}/__demo/config`, { data: { siteId, widgetSrc: `${PROD_URL}/widget.js` } });

  // Dashboard open on All Tasks (live)
  await page.goto('/login');
  await page.getByLabel('Email').fill(PROD_ADMIN.email);
  await page.getByLabel('Password').fill(PROD_ADMIN.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('link', { name: 'All Tasks' }).click();
  await expect(page.getByTestId('live-status')).toHaveAttribute('data-status', 'live');

  // External site
  const ctx = await browser.newContext();
  const site = await ctx.newPage();
  const problems: string[] = [];
  site.on('pageerror', (e) => problems.push(e.message));
  await site.goto(`${DEMO}/`);
  await site.getByRole('button', { name: /^Open review comments/ }).click();
  const panel = site.getByRole('dialog', { name: 'Review comments' });
  await panel.getByRole('button', { name: 'Add a Comment' }).click();
  const auth = site.getByRole('dialog', { name: 'Sign in to review' });
  await auth.getByLabel('Email').fill(PROD_ADMIN.email);
  await auth.getByLabel('Password').fill(PROD_ADMIN.password);
  await auth.getByRole('button', { name: 'Sign in', exact: true }).click();
  const form = panel.getByRole('form', { name: 'Create task' });
  await form.getByLabel('Task title').fill('Production smoke task');
  await form.getByRole('button', { name: 'Capture this page' }).click();
  await expect(form.getByRole('img', { name: 'Screenshot preview' })).toBeVisible();
  await form.getByRole('button', { name: 'Create task' }).click();
  await expect(panel.locator('article.card', { hasText: 'Production smoke task' })).toBeVisible();

  // Appears in the dashboard without reload; screenshot served via signed URL
  const row = page.getByTestId('task-row').filter({ hasText: 'Production smoke task' });
  await expect(row).toBeVisible();
  await row.click();
  const shot = page.getByRole('dialog').getByTestId('task-attachments').getByRole('img').first();
  await expect.poll(() => shot.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBeGreaterThan(100);
  expect(problems).toEqual([]);
  await ctx.close();
});
