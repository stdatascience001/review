import { expect, request as pwRequest, test, type APIRequestContext, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { API_URL, DEMO_URL } from './env';
import { expectToast, linkFromOutbox, login, unique } from './helpers';

/**
 * Task 4 — the complete task workflow in real browsers, across the review widget (on the
 * separate demo site) and the admin dashboard:
 *   reporter creates a task in the widget (type, priority, screenshot, extra file)
 *   → admin sees it in the dashboard, assigns a developer, raises priority
 *   → developer starts it, replies with a screenshot, sends to review, completes it
 *   → reporter sees progress + unread reply, replies, edits/deletes own comments
 *   → developer reopens, archives and restores it; the activity history records everything.
 */
test.describe.configure({ mode: 'serial' });

const PASSWORD = 'Workflow-pass-2026';
const admin = { name: 'Ada Admin', email: unique('wf.admin') };
const dev = { name: 'Dev Daniel', email: unique('wf.dev') };
const reporter = { name: 'Rita Reporter', email: unique('wf.reporter') };
const TITLE = 'Newsletter form overlaps the footer';

let api: APIRequestContext; // admin's dashboard session
let websiteId = '';
let siteId = '';
let taskKey = '';
let taskId = '';
const contexts: BrowserContext[] = [];

const fab = (page: Page) => page.getByRole('button', { name: /^Open review comments/ });
const panel = (page: Page) => page.getByRole('dialog', { name: 'Review comments' });
const card = (page: Page, title: string) => panel(page).locator('article.card', { hasText: title });

const register = async (u: { name: string; email: string }) => {
  const ctx = await pwRequest.newContext({ baseURL: API_URL });
  expect((await ctx.post('/api/v1/auth/register', { data: { ...u, password: PASSWORD } })).status()).toBe(201);
  const link = await linkFromOutbox(u.email, '/verify-email');
  await ctx.post('/api/v1/auth/verify-email', { data: { token: new URL(link, 'http://x').searchParams.get('token') } });
  return ctx;
};

const newPage = async (browser: Browser, viewport?: { width: number; height: number }) => {
  const ctx = await browser.newContext(viewport ? { viewport } : {});
  contexts.push(ctx);
  return ctx.newPage();
};

/** Opens the widget on the demo site and signs in through the widget's login popup. */
const widgetAs = async (browser: Browser, u: { email: string }) => {
  const page = await newPage(browser);
  await page.goto(`${DEMO_URL}/`);
  await fab(page).click();
  await panel(page).getByRole('button', { name: 'Sign in', exact: true }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Sign in to review' });
  await dialog.getByLabel('Email').fill(u.email);
  await dialog.getByLabel('Password').fill(PASSWORD);
  await dialog.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(dialog).toBeHidden();
  return page;
};

test.beforeAll(async () => {
  api = await register(admin);
  const [devApi, repApi] = await Promise.all([register(dev), register(reporter)]);
  await Promise.all([devApi.dispose(), repApi.dispose()]);

  const w = await api.post('/api/v1/websites', { data: { name: 'Acme Workflow', url: DEMO_URL } });
  ({ id: websiteId, siteId } = (await w.json()).data);
  const project = (await (await api.post(`/api/v1/websites/${websiteId}/projects`, { data: { name: 'Website QA' } })).json()).data;
  for (const [u, role] of [
    [dev, 'DEVELOPER'],
    [reporter, 'WEBSITE_USER'],
  ] as const) {
    const m = (await (await api.post(`/api/v1/websites/${websiteId}/members`, { data: { email: u.email, role } })).json()).data;
    await api.put(`/api/v1/websites/${websiteId}/members/${m.user.id}/projects`, { data: { projects: [{ projectId: project.id }] } });
  }
  await api.patch(`/api/v1/websites/${websiteId}/settings`, { data: { widgetProjectId: project.id } });
  // Install this website's embed script on the demo site.
  const res = await fetch(`${DEMO_URL}/__demo/config`, { method: 'POST', body: JSON.stringify({ siteId, widgetSrc: `${API_URL}/widget.js` }) });
  expect(res.status).toBe(204);
});

test.afterAll(async () => {
  await Promise.all(contexts.map((c) => c.close()));
  await api?.dispose();
});

let reporterPage: Page;
let devPage: Page;

test('1–2. reporter creates a task in the widget: type, priority, screenshot preview, extra file', async ({ browser }) => {
  reporterPage = await widgetAs(browser, reporter);
  const p = panel(reporterPage);
  await expect(p.getByRole('heading', { name: 'No comments yet' })).toBeVisible();
  await p.getByRole('button', { name: 'Add a Comment' }).click();
  await reporterPage.getByRole('dialog', { name: 'Select an element' }).getByRole('button', { name: 'Whole page' }).click(); // comment on the whole page

  const form = p.getByRole('form', { name: 'Create task' });
  await expect(form.getByTestId('captured-page')).toContainText('Acme Shoes — Home');
  await expect(form.getByTestId('captured-page')).toContainText(`${DEMO_URL}/`);
  await form.getByLabel('Task title').fill(TITLE);
  await form.getByLabel('Description').fill('At 1280px the email field sits on top of the footer links.');
  // Spec task types and priorities
  await expect(form.getByLabel('Task type').locator('option')).toHaveText(['Bug', 'UI issue', 'Feature request', 'Improvement', 'Other']);
  await expect(form.getByLabel('Priority').locator('option')).toHaveText(['Low', 'Medium', 'High', 'Urgent']);
  await form.getByLabel('Task type').selectOption('UI_ISSUE');
  await form.getByLabel('Priority').selectOption('HIGH');

  await form.getByRole('button', { name: 'Capture this page' }).click();
  const preview = form.getByRole('img', { name: 'Screenshot preview' });
  await expect(preview).toBeVisible();
  await expect.poll(() => preview.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBeGreaterThan(100);
  await form.getByLabel('Attach additional files').setInputFiles({
    name: 'steps-to-reproduce.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n'),
  });
  await expect(form.locator('.file-list')).toContainText('steps-to-reproduce.pdf');
  await reporterPage.screenshot({ path: 'test-results/t4-widget-create.png' });

  const created = reporterPage.waitForResponse((r) => r.url().endsWith('/api/v1/widget/tasks') && r.request().method() === 'POST');
  await form.getByRole('button', { name: 'Create task' }).click();
  const body = await (await created).json();
  taskId = body.data.id;
  taskKey = body.data.key;
  expect(taskKey).toMatch(/^TASK-\d+$/);

  await expect(p.getByRole('status').filter({ hasText: `Task created — ${taskKey}` })).toBeVisible();
  const c = card(reporterPage, TITLE);
  await expect(c).toBeVisible();
  await expect(c.locator('.task-key')).toHaveText(taskKey);
  await expect(c.locator('.badge')).toHaveText('Open');
  await expect(c.locator('.type')).toHaveText('UI issue');
  await expect(c.locator('.prio')).toHaveText('High');
  await expect.poll(() => c.getByRole('img').evaluate((i: HTMLImageElement) => i.naturalWidth)).toBeGreaterThan(100);
  await expect(p.getByTestId('open-count')).toHaveText('1 open');
  await expect(fab(reporterPage).locator('.fab-badge')).toHaveText('1');
});

test('3. reporter checks progress, files and history — no workflow controls for them', async () => {
  const p = panel(reporterPage);
  await card(reporterPage, TITLE).getByRole('button', { name: 'View details' }).click();
  await expect(p.getByTestId('detail-key')).toHaveText(taskKey);
  await expect(p.getByRole('list', { name: 'Task progress' }).locator('[aria-current="step"]')).toContainText('Open');
  await expect(p.locator('.facts')).toContainText('Not assigned yet');
  await expect(p.locator('.facts')).toContainText('Rita Reporter');
  await expect(p.getByTestId('workflow')).toHaveCount(0);
  await expect(p.getByLabel('Status')).toHaveCount(0);
  await expect(p.locator('.thumbs img')).toHaveCount(1);
  await expect(p.locator('.file-list')).toContainText('steps-to-reproduce.pdf');

  // The popup body scrolls on its own; the host page stays where it is.
  const before = await reporterPage.evaluate(() => window.scrollY);
  await p.locator('.body').hover();
  await reporterPage.mouse.wheel(0, 600);
  await expect.poll(() => p.locator('.body').evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  expect(await reporterPage.evaluate(() => window.scrollY)).toBe(before);

  await p.getByRole('tab', { name: 'History' }).click();
  await expect(p.getByTestId('history')).toContainText('Rita Reporter created the task');
  await expect(p.getByTestId('history')).toContainText('added a file steps-to-reproduce.pdf');
  await p.getByRole('button', { name: 'Back to comments' }).click();
});

test('4–5. admin finds it in the dashboard, opens the full task view, assigns the developer and raises priority', async ({ browser }) => {
  const page = await newPage(browser);
  await login(page, admin.email, PASSWORD);
  await page.goto('/tasks');
  const row = page.getByTestId('task-row').filter({ hasText: TITLE });
  await expect(row.getByTestId('task-key')).toHaveText(taskKey);
  await row.click();
  await page.getByRole('link', { name: 'Open full page' }).click();
  await expect(page).toHaveURL(new RegExp(`/tasks/${taskId}$`));

  await expect(page.getByRole('heading', { name: TITLE })).toBeVisible();
  const facts = page.getByTestId('task-facts');
  await expect(facts).toContainText(taskKey);
  await expect(facts).toContainText('Acme Workflow');
  await expect(facts).toContainText('Website QA');
  await expect(facts).toContainText('Rita Reporter');
  await expect(page.getByText('At 1280px the email field sits on top')).toBeVisible();
  const shot = page.getByTestId('task-attachments').getByRole('img').first();
  await expect.poll(() => shot.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBeGreaterThan(100);
  await shot.click(); // screenshot preview (lightbox)
  await expect(page.getByRole('dialog', { name: 'screenshot.jpg' }).getByRole('img')).toBeVisible();
  await page.getByRole('dialog', { name: 'screenshot.jpg' }).getByRole('button', { name: 'Close' }).click();

  await page.getByLabel('Assignee').selectOption({ label: dev.name });
  await expectToast(page, 'Task updated');
  await expect(facts).toContainText(dev.name);
  await page.getByLabel('Priority').selectOption('URGENT');
  await expect(page.getByText('Urgent').first()).toBeVisible();

  await page.getByRole('tab', { name: 'Activity' }).click();
  await expect(page.getByTestId('activity-list')).toContainText(`assigned the task to ${dev.name}`);
  await expect(page.getByTestId('activity-list')).toContainText('changed the priority from High to Urgent');
});

test('6. developer starts the task, replies with a screenshot, sends it to review and completes it (widget)', async ({ browser }) => {
  devPage = await widgetAs(browser, dev);
  const p = panel(devPage);
  const c = card(devPage, TITLE);
  await expect(c).toContainText(`→ ${dev.name}`);
  await expect(c.locator('.prio')).toHaveText('Urgent');
  await c.getByRole('button', { name: 'View details' }).click();

  const wf = p.getByTestId('workflow');
  await wf.getByRole('button', { name: 'Start task' }).click();
  await expect(p.locator('.subheader .badge')).toHaveText('In progress');

  await p.getByRole('textbox', { name: 'Write a comment' }).fill('Fixed the footer spacing on staging — please verify.');
  await p.getByLabel('Attach files', { exact: true }).setInputFiles({
    name: 'after-fix.png',
    mimeType: 'image/png',
    buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'),
  });
  await p.getByRole('button', { name: 'Send', exact: true }).click();
  const comment = p.getByTestId('thread').locator('.comment').first();
  await expect(comment).toContainText('Fixed the footer spacing on staging');
  await expect(comment.locator('.thumbs img')).toHaveCount(1);

  await wf.getByRole('button', { name: 'Send to review' }).click();
  await expect(p.locator('.subheader .badge')).toHaveText('Under review');
  await wf.getByRole('button', { name: 'Mark completed' }).click();
  await p.getByRole('alertdialog').getByRole('button', { name: 'Mark completed' }).click();
  await expect(p.locator('.subheader .badge')).toHaveText('Completed');
  await expect(p.getByRole('list', { name: 'Task progress' }).locator('[aria-current="step"]')).toContainText('Completed');
  await devPage.screenshot({ path: 'test-results/t4-widget-detail-dev.png' });
  // The developer leaves the task (otherwise the live update would mark new replies as read).
  await p.getByRole('button', { name: 'Back to comments' }).click();
  await p.getByRole('button', { name: 'Close review comments' }).click();
});

test('7. reporter sees the unread reply, replies, edits and deletes own comments', async () => {
  const p = panel(reporterPage);
  await reporterPage.reload();
  await fab(reporterPage).click();
  const c = card(reporterPage, TITLE);
  await expect(c.locator('.badge')).toHaveText('Completed');
  await expect(c.locator('.unread-pill')).toHaveText('1 new');
  await expect(fab(reporterPage).locator('.fab-badge')).toBeHidden(); // no open tasks left
  await p.getByRole('tab', { name: /^Done/ }).click();
  await expect(card(reporterPage, TITLE)).toBeVisible();

  await card(reporterPage, TITLE).getByRole('button', { name: 'Reply (1)' }).click();
  const devComment = p.locator('.comment', { hasText: 'Fixed the footer spacing' });
  await expect(devComment.locator('.new-tag')).toHaveText('New');
  await expect(devComment).toContainText(dev.name);

  // Reply to the developer
  await devComment.getByRole('button', { name: 'Reply' }).click();
  await p.getByRole('textbox', { name: 'Write a reply' }).fill('Looks good on Chrome, still off on Safari.');
  await p.getByRole('button', { name: 'Reply', exact: true }).last().click();
  const reply = p.locator('.replies .comment', { hasText: 'still off on Safari' });
  await expect(reply).toBeVisible();

  // Edit own reply
  await reply.getByRole('button', { name: 'Edit' }).click();
  await p.getByRole('textbox', { name: 'Edit comment' }).fill('Looks good on Chrome, still off on Safari 17.');
  await p.getByRole('button', { name: 'Save' }).click();
  await expect(reply).toContainText('Safari 17');
  await expect(reply).toContainText('(edited)');
  await reporterPage.screenshot({ path: 'test-results/t4-widget-thread.png' });
  // Can't edit or delete someone else's comment
  await expect(devComment.locator('.comment-actions').first().getByRole('button', { name: 'Edit' })).toHaveCount(0);

  // Add, then delete (with confirmation), an extra comment
  await p.getByRole('textbox', { name: 'Write a comment' }).fill('Duplicate note');
  await p.getByRole('button', { name: 'Send', exact: true }).click();
  const extra = p.locator('.comment', { hasText: 'Duplicate note' });
  await extra.getByRole('button', { name: 'Delete' }).click();
  await p.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click();
  await expect(extra).toHaveCount(0);
  await expect(p.getByTestId('thread')).toContainText('Safari 17');
});

test('8. developer sees the unread reply in the dashboard, reopens, archives and restores; history is complete', async ({ browser }) => {
  const page = await newPage(browser);
  await login(page, dev.email, PASSWORD);
  await page.goto('/tasks/mine');
  const row = page.getByTestId('task-row').filter({ hasText: TITLE });
  await expect(row.getByLabel('Unread comments')).toBeVisible();
  await expect(row).toContainText('1 new');
  await row.click();
  const d = page.getByRole('dialog', { name: TITLE });
  await expect(d.locator('[data-testid="comment"][data-new]')).toHaveCount(1);
  await expect(d.locator('[data-testid="comment"][data-new]')).toContainText('Safari 17');

  await d.getByTestId('workflow-actions').getByRole('button', { name: 'Reopen' }).click();
  await expectToast(page, 'Task updated');
  await expect(d.getByTestId('task-progress').locator('[aria-current="step"]')).toContainText('Reopened');

  await d.getByTestId('workflow-actions').getByRole('button', { name: 'Archive' }).click();
  await page.getByRole('dialog', { name: `Archive ${taskKey}?` }).getByRole('button', { name: 'Archive task' }).click();
  await expect(d.getByTestId('workflow-actions').getByRole('button', { name: 'Restore' })).toBeVisible();
  await d.getByTestId('workflow-actions').getByRole('button', { name: 'Restore' }).click();
  await expectToast(page, 'Task restored');
  await expect(d.getByTestId('workflow-actions').getByRole('button', { name: 'Start task' })).toBeVisible(); // back to Reopened
  // Row no longer unread after opening
  await d.getByRole('button', { name: 'Close' }).click();
  await expect(row.getByLabel('Unread comments')).toHaveCount(0);

  await page.goto(`/tasks/${taskId}`);
  await page.getByRole('tab', { name: 'Activity' }).click();
  const log = page.getByTestId('activity-list');
  for (const line of [
    'Rita Reporter created the task',
    `Ada Admin assigned the task to ${dev.name}`,
    'Ada Admin changed the priority from High to Urgent',
    'Dev Daniel started the task',
    'Dev Daniel changed the status from In progress to Under review',
    'Dev Daniel completed the task',
    'Dev Daniel commented',
    'Rita Reporter commented',
    'Rita Reporter edited a comment',
    'Rita Reporter deleted a comment',
    'Dev Daniel reopened the task',
    'Dev Daniel archived the task',
    'Dev Daniel restored the task to Reopened',
  ]) {
    await expect(log).toContainText(line);
  }
  await page.screenshot({ path: 'test-results/t4-dashboard-task.png', fullPage: true });
});

test('responsive: the task form and detail fit a phone screen', async ({ browser }) => {
  const page = await newPage(browser, { width: 390, height: 844 });
  await page.goto(`${DEMO_URL}/`);
  const session = await reporterPage.evaluate((id) => localStorage.getItem(`wrtm-widget:${id}`), siteId);
  await page.evaluate(([k, v]) => localStorage.setItem(k, v), [`wrtm-widget:${siteId}`, session!] as const);
  await page.reload();
  await fab(page).click();
  const p = panel(page);
  await card(page, TITLE).getByRole('button', { name: 'View details' }).click();
  await expect(p.getByTestId('detail-key')).toHaveText(taskKey);
  const noOverflow = () => p.evaluate((el) => el.scrollWidth <= el.clientWidth + 1);
  expect(await noOverflow()).toBe(true);
  await p.getByRole('button', { name: 'Back to comments' }).click();
  await p.getByRole('button', { name: 'Add a Comment' }).click();
  await page.getByRole('dialog', { name: 'Select an element' }).getByRole('button', { name: 'Whole page' }).click(); // comment on the whole page
  await expect(p.getByRole('form', { name: 'Create task' })).toBeVisible();
  expect(await noOverflow()).toBe(true);
  await expect(p.getByRole('button', { name: 'Create task' })).toBeVisible();
});
