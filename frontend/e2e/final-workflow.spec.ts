import { expect, request as pwRequest, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { API_URL, APP_URL } from './env';
import { linkFromOutbox, login, unique } from './helpers';

/**
 * Task 5 — the complete workflow, live (no page reloads), for TWO websites registered by
 * different admins, each with its own developer and reviewer, running side by side:
 *
 *   1 admin registers a website        2 unique Site ID            3 copy embed script
 *   4 install on the external site     5 Review button appears     6 user opens the popup
 *   7 user signs in (email; Google offered)   8 user creates a task   9 attaches a screenshot
 *  10 task appears in the admin dashboard (real time)   11 admin assigns a developer
 *  12 developer starts it   13 developer comments   14 user is notified (real time)
 *  15 developer updates the status   16 developer completes it   17 user sees "Completed" (real time)
 *
 * Then: tenant isolation between the two websites, in the UI and over the live connection.
 */
test.describe.configure({ mode: 'serial' });

const PASSWORD = 'Final-flow-pass-2026';
const DEMO_PORT = 5600;

interface Team {
  label: string;
  host: string; // the external site: two hosts = two origins = two customer websites
  admin: { name: string; email: string };
  dev: { name: string; email: string };
  user: { name: string; email: string };
  siteId?: string;
  websiteId?: string;
  taskId?: string;
  taskKey?: string;
  adminPage?: Page;
  devPage?: Page;
  userPage?: Page;
  title: string;
}

const teams: Team[] = [
  {
    label: 'Orion',
    host: `127.0.0.1:${DEMO_PORT}`,
    admin: { name: 'Olga Orion', email: unique('orion.admin') },
    dev: { name: 'Omar OrionDev', email: unique('orion.dev') },
    user: { name: 'Ora OrionUser', email: unique('orion.user') },
    title: 'Orion: newsletter button misaligned',
  },
  {
    label: 'Vega',
    host: `localhost:${DEMO_PORT}`,
    admin: { name: 'Victor Vega', email: unique('vega.admin') },
    dev: { name: 'Vera VegaDev', email: unique('vega.dev') },
    user: { name: 'Vik VegaUser', email: unique('vega.user') },
    title: 'Vega: price wraps on mobile',
  },
];
const contexts: BrowserContext[] = [];

const fab = (page: Page) => page.getByRole('button', { name: /^Open review comments/ });
const panel = (page: Page) => page.getByRole('dialog', { name: 'Review comments' });
const card = (page: Page, title: string) => panel(page).locator('article.card', { hasText: title });
const toastWith = (page: Page, text: string | RegExp) => page.locator('[data-sonner-toast]').filter({ hasText: text });

const registerAccount = async (u: { name: string; email: string }) => {
  const ctx = await pwRequest.newContext({ baseURL: API_URL });
  expect((await ctx.post('/api/v1/auth/register', { data: { ...u, password: PASSWORD } })).status()).toBe(201);
  const link = await linkFromOutbox(u.email, '/verify-email');
  await ctx.post('/api/v1/auth/verify-email', { data: { token: new URL(link, 'http://x').searchParams.get('token') } });
  return ctx;
};
const newPage = async (browser: Browser) => {
  const ctx = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
  contexts.push(ctx);
  return ctx.newPage();
};

test.beforeAll(async () => {
  for (const t of teams) await Promise.all([registerAccount(t.admin), registerAccount(t.dev), registerAccount(t.user)]).then((cs) => Promise.all(cs.map((c) => c.dispose())));
});

test.afterAll(async () => {
  await Promise.all(contexts.map((c) => c.close()));
  // Remove this spec's per-host settings so the other specs see the demo site's defaults.
  for (const t of teams) {
    await fetch(`http://127.0.0.1:${DEMO_PORT}/__demo/config`, { method: 'POST', body: JSON.stringify({ host: t.host, reset: true }) });
  }
});

for (const team of teams) {
  test(`${team.label} — steps 1–4: admin registers the website, gets a unique Site ID, copies and installs the embed script`, async ({ browser }) => {
    const page = (team.adminPage = await newPage(browser));
    await login(page, team.admin.email, PASSWORD);
    await page.goto('/websites');
    // 1. register
    await page.getByRole('button', { name: 'Add website' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Add website' });
    await dialog.getByLabel('Website name').fill(`${team.label} Store`);
    await dialog.getByLabel('Website URL').fill(`http://${team.host}`);
    await dialog.getByRole('button', { name: 'Add website' }).click();
    await page.getByRole('link', { name: `${team.label} Store` }).click();
    team.websiteId = page.url().split('/websites/')[1];
    // 2. unique Site ID
    team.siteId = (await page.getByTestId('site-id').textContent())!;
    expect(team.siteId).toMatch(/^site_[a-f0-9]{20}$/);
    if (team !== teams[0]) expect(team.siteId).not.toBe(teams[0]!.siteId);
    // 3. copy the embed script
    await page.getByRole('button', { name: 'Copy', exact: true }).first().click();
    const snippet = await page.evaluate(() => navigator.clipboard.readText());
    expect(snippet).toBe(`<script src="${API_URL}/widget.js" data-site-id="${team.siteId}" async></script>`);
    // 4. install it on the external website
    const res = await fetch(`http://127.0.0.1:${DEMO_PORT}/__demo/config`, {
      method: 'POST',
      body: JSON.stringify({ host: team.host, siteId: team.siteId, widgetSrc: `${API_URL}/widget.js` }),
    });
    expect(res.status).toBe(204);

    // Team setup (Team Members UI is covered elsewhere): developer + reviewer on a project.
    const api = await pwRequest.newContext({ baseURL: API_URL, storageState: await page.context().storageState() });
    const project = (await (await api.post(`/api/v1/websites/${team.websiteId}/projects`, { data: { name: `${team.label} QA` } })).json()).data;
    for (const [u, role] of [
      [team.dev, 'DEVELOPER'],
      [team.user, 'WEBSITE_USER'],
    ] as const) {
      const m = (await (await api.post(`/api/v1/websites/${team.websiteId}/members`, { data: { email: u.email, role } })).json()).data;
      await api.put(`/api/v1/websites/${team.websiteId}/members/${m.user.id}/projects`, { data: { projects: [{ projectId: project.id }] } });
    }
    await api.dispose();

    // Admin keeps All Tasks open — new tasks must appear here live.
    await page.goto('/tasks');
    await expect(page.getByTestId('live-status')).toHaveAttribute('data-status', 'live');
  });

  test(`${team.label} — steps 5–9: Review button, popup, sign-in, create a task with a screenshot`, async ({ browser }) => {
    // Developer watches My Tasks live
    team.devPage = await newPage(browser);
    await login(team.devPage, team.dev.email, PASSWORD);
    await team.devPage.goto('/tasks/mine');
    await expect(team.devPage.getByTestId('live-status')).toHaveAttribute('data-status', 'live');

    const page = (team.userPage = await newPage(browser));
    await page.goto(`http://${team.host}/`);
    await expect(fab(page)).toBeVisible(); // 5
    await fab(page).click(); // 6
    const p = panel(page);
    await expect(p).toBeVisible();
    await p.getByRole('button', { name: 'Add a Comment' }).click(); // protected → sign-in popup
    const auth = page.getByRole('dialog', { name: 'Sign in to review' });
    await expect(auth.getByRole('button', { name: 'Continue with Google' })).toBeVisible(); // 7 (Google offered)
    await auth.getByLabel('Email').fill(team.user.email);
    await auth.getByLabel('Password').fill(PASSWORD);
    await auth.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.getByRole('dialog', { name: 'Select an element' }).getByRole('button', { name: 'Whole page' }).click(); // comment on the whole page

    const form = p.getByRole('form', { name: 'Create task' }); // back in the popup, continuing
    await form.getByLabel('Task title').fill(team.title); // 8
    await form.getByLabel('Description').fill(`Reported on the ${team.label} website.`);
    await form.getByLabel('Task type').selectOption('UI_ISSUE');
    await form.getByLabel('Priority').selectOption('HIGH');
    await form.getByRole('button', { name: 'Capture this page' }).click(); // 9
    await expect(form.getByRole('img', { name: 'Screenshot preview' })).toBeVisible();
    const created = page.waitForResponse((r) => r.url().endsWith('/api/v1/widget/tasks') && r.request().method() === 'POST');
    const uploaded = page.waitForResponse((r) => r.url().includes('/attachments?kind=screenshot'));
    await form.getByRole('button', { name: 'Create task' }).click();
    const body = (await (await created).json()).data;
    expect((await uploaded).status()).toBe(201);
    team.taskId = body.id;
    team.taskKey = body.key;
    await expect(card(page, team.title)).toBeVisible();
    await p.getByRole('button', { name: 'Close review comments' }).click();
  });

  test(`${team.label} — steps 10–11: task appears in the dashboard live; admin assigns the developer`, async () => {
    const admin = team.adminPage!;
    // 10. live: row + toast, without reloading
    await expect(admin.getByTestId('task-row').filter({ hasText: team.title })).toBeVisible();
    await expect(toastWith(admin, `created ${team.taskKey}`)).toBeVisible();
    await admin.getByTestId('task-row').filter({ hasText: team.title }).click();
    const d = admin.getByRole('dialog', { name: team.title });
    await expect.poll(() => d.getByTestId('task-attachments').getByRole('img').first().evaluate((i: HTMLImageElement) => i.naturalWidth)).toBeGreaterThan(100);
    // 11. assign
    await d.getByLabel('Assignee').selectOption({ label: team.dev.name });
    await expect(d.getByTestId('task-facts')).toContainText(team.dev.name);
    await d.getByRole('button', { name: 'Close' }).click();
  });

  test(`${team.label} — steps 12–17: developer starts, comments, updates and completes; the user is notified and sees "Completed" live`, async () => {
    const dev = team.devPage!;
    const user = team.userPage!;
    // The developer was notified live and the task appeared in My Tasks
    await expect(toastWith(dev, `assigned ${team.taskKey} to ${team.dev.name}`)).toBeVisible();
    await expect(dev.getByTestId('task-row').filter({ hasText: team.title })).toBeVisible();
    await dev.goto(`/tasks/${team.taskId}`);
    const actions = dev.getByTestId('workflow-actions');

    // 12. start → the user's widget badge/bubble updates without reload
    await actions.getByRole('button', { name: 'Start task' }).click();
    await expect(user.locator('.fab-nudge')).toContainText(`${team.dev.name} started ${team.taskKey}`);

    // 13. comment → 14. user notified live (bubble above the Review button)
    await dev.getByRole('textbox', { name: 'Write a comment' }).fill('Fixed the spacing — please check on your device.');
    await dev.getByRole('button', { name: 'Post comment' }).click();
    await expect(user.locator('.fab-nudge')).toContainText(`${team.dev.name} commented on ${team.taskKey}`);

    // The user opens the popup: status and the new reply are already there
    await fab(user).click();
    const c = card(user, team.title);
    await expect(c.locator('.badge')).toHaveText('In progress');
    await expect(c.locator('.unread-pill')).toHaveText('1 new');

    // 15. developer updates the status → 16. completes it
    await actions.getByRole('button', { name: 'Send to review' }).click();
    await expect(c.locator('.badge')).toHaveText('Under review'); // live in the open popup
    await actions.getByRole('button', { name: 'Mark completed' }).click();
    await dev.getByRole('dialog', { name: /as completed\?/ }).getByRole('button', { name: 'Mark completed' }).click();

    // 17. the user sees Completed — without reloading, plus an in-popup notification
    await expect(c.locator('.badge')).toHaveText('Completed');
    await expect(panel(user).getByRole('status').filter({ hasText: `${team.dev.name} completed ${team.taskKey}` })).toBeVisible();
    await expect(fab(user).locator('.fab-badge')).toBeHidden(); // no open tasks left

    // Admin dashboard reflects it live too
    await team.adminPage!.goto('/');
    await expect(team.adminPage!.getByTestId('stat-completed-tasks').locator('[data-value]')).toHaveText('1');
  });
}

test('isolation between the two websites (UI and live events)', async () => {
  const [orion, vega] = teams as [Team, Team];
  // Dashboards list only their own website's task
  for (const [team, other] of [
    [orion, vega],
    [vega, orion],
  ] as const) {
    const admin = team.adminPage!;
    await admin.goto('/tasks?status=COMPLETED');
    await expect(admin.getByTestId('task-row')).toHaveCount(1);
    await expect(admin.getByTestId('task-row')).toContainText(team.title);
    // No live notification about the other website ever reached this admin or developer
    await expect(toastWith(admin, other.taskKey!)).toHaveCount(0);
    await expect(toastWith(team.devPage!, other.taskKey!)).toHaveCount(0);
    // Opening the other website's task directly is refused
    await team.devPage!.goto(`/tasks/${other.taskId}`);
    await expect(team.devPage!.getByText('Task not found')).toBeVisible();
    // The widget on this website only shows this website's tasks
    const p = panel(team.userPage!);
    for (const tab of [/^All/, /^Done/]) {
      await p.getByRole('tab', { name: tab }).click();
      await expect(p.locator('article.card')).toHaveCount(1);
      await expect(p.locator('article.card')).toContainText(team.title);
      await expect(p.locator('article.card')).not.toContainText(other.title);
    }
  }
  // Analytics: each admin sees only their own website's numbers, developer performance included
  for (const team of teams) {
    const admin = team.adminPage!;
    await admin.getByRole('link', { name: 'Analytics' }).click();
    const totals = admin.getByTestId('analytics-totals');
    await expect(totals.getByTestId('stat-total-websites').locator('[data-value]')).toHaveText('1');
    await expect(totals.getByTestId('stat-total-tasks').locator('[data-value]')).toHaveText('1');
    await expect(totals.getByTestId('stat-completed-tasks').locator('[data-value]')).toHaveText('1');
    await expect(admin.getByTestId('by-website')).toContainText(`${team.label} Store`);
    await expect(admin.getByTestId('by-website')).not.toContainText(team === orion ? 'Vega Store' : 'Orion Store');
    const devRow = admin.getByTestId('by-developer').locator('tr', { hasText: team.dev.name });
    await expect(devRow).toContainText('100%');
    await expect(admin.getByTestId('range-totals')).toContainText('Completed 1');
    // CSV report for the same filters
    const csv = await admin.request.get(await admin.getByRole('link', { name: 'Export CSV' }).getAttribute('href').then((h) => new URL(h!, APP_URL).toString()));
    expect(csv.status()).toBe(200);
    const text = await csv.text();
    expect(text).toContain(team.taskKey!);
    expect(text).not.toContain(team === orion ? vega.taskKey! : orion.taskKey!);
  }
  await orion.adminPage!.screenshot({ path: 'test-results/t5-analytics.png', fullPage: true });

  // Each site's widget is bound to its own Site ID
  expect(orion.siteId).not.toBe(vega.siteId);
  for (const t of teams) {
    const installed = await t.userPage!.locator('script[src$="/widget.js"]').getAttribute('data-site-id');
    expect(installed).toBe(t.siteId);
  }
  expect(APP_URL).toBeTruthy();
});
