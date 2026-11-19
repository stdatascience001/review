import { expect, request as pwRequest, test, type APIRequestContext, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { API_URL, DEMO_URL } from './env';
import { expectToast, linkFromOutbox, login, unique } from './helpers';

/**
 * Review widget on a separate demo website (127.0.0.1:5600 — a different origin from the
 * dashboard and the API). Covers: embed script from Website Management, installation
 * (static HTML, multi-page, SPA/React-style injection, duplicate tags), the Review button +
 * badge, popup, tabs/filters/cards, login popup (password, registration, verification,
 * forgot password, Google popup), create task + screenshot, reply, archive, SPA navigation,
 * allowed-domain checks, CSS isolation both ways, and the mobile layout.
 */
test.describe.configure({ mode: 'serial' });

const PASSWORD = 'Widget-pass-2026';
const owner = { name: 'Wendy Owner', email: unique('widget.owner') };
const BRAND = 'rgb(79, 70, 229)'; // default widget color #4f46e5

let api: APIRequestContext; // owner's dashboard session (cookies)
let websiteId = '';
let siteId = '';
let ownerCtx: BrowserContext;
let site: Page; // demo site, owner signed in to the widget

const fab = (page: Page) => page.getByRole('button', { name: /^Open review comments/ });
const panel = (page: Page) => page.getByRole('dialog', { name: 'Review comments' });
const authDialog = (page: Page) => page.getByRole('dialog', { name: /Sign in to review|Create your account|Reset your password/ });
const card = (page: Page, title: string) => panel(page).locator('article.card', { hasText: title });

const newContext = (browser: Browser, opts: Parameters<Browser['newContext']>[0] = {}) =>
  browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'], ...opts });

const openPanel = async (page: Page) => {
  await fab(page).click();
  await expect(panel(page)).toBeVisible();
};

const signInInWidget = async (page: Page, email: string, password: string) => {
  const dialog = authDialog(page);
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Email').fill(email);
  await dialog.getByLabel('Password').fill(password);
  await dialog.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(dialog).toBeHidden();
};

test.beforeAll(async () => {
  // Owner account via the real auth API (verified through the emailed link).
  api = await pwRequest.newContext({ baseURL: API_URL });
  const reg = await api.post('/api/v1/auth/register', { data: { name: owner.name, email: owner.email, password: PASSWORD } });
  expect(reg.status()).toBe(201);
  const link = await linkFromOutbox(owner.email, '/verify-email');
  await api.post('/api/v1/auth/verify-email', { data: { token: new URL(link, 'http://x').searchParams.get('token') } });
  const w = await api.post('/api/v1/websites', { data: { name: 'Acme Shoes', url: DEMO_URL } });
  expect(w.status()).toBe(201);
  ({ id: websiteId, siteId } = await w.json().then((r) => r.data));
});

test.afterAll(async () => {
  await ownerCtx?.close();
  await api?.dispose();
});

test('admin copies the embed script (widget.js + data-site-id + async) and per-platform install code', async ({ browser }) => {
  ownerCtx = await newContext(browser);
  const page = await ownerCtx.newPage();
  await login(page, owner.email, PASSWORD);
  await page.goto(`/websites/${websiteId}`);

  const expected = `<script src="${API_URL}/widget.js" data-site-id="${siteId}" async></script>`;
  await expect(page.getByTestId('embed-script')).toHaveText(expected);
  await page.getByRole('button', { name: 'Copy' }).first().click();
  await expectToast(page, 'Embed script copied to clipboard');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(expected);

  const guide = page.getByTestId('install-guide');
  for (const [tab, text] of [
    ['WordPress', "add_action('wp_footer'"],
    ['React', `s.dataset.siteId = '${siteId}'`],
    ['Next.js', 'strategy="lazyOnload"'],
    ['Astro', 'is:inline'],
    ['HTML', expected],
  ] as const) {
    await guide.getByRole('tab', { name: tab }).click();
    await expect(guide.getByTestId('install-code')).toContainText(text);
  }

  // "Install" it on the demo website, exactly as copied.
  const res = await fetch(`${DEMO_URL}/__demo/config`, {
    method: 'POST',
    body: JSON.stringify({ siteId, widgetSrc: `${API_URL}/widget.js` }),
  });
  expect(res.status).toBe(204);
  await page.close();
});

test('installed widget shows the Review button without changing the host page', async ({ browser }) => {
  const ctx = await newContext(browser);
  const page = await ctx.newPage();

  // Baseline of the host page with the widget blocked.
  await page.route('**/widget.js', (r) => r.abort());
  await page.goto(`${DEMO_URL}/`);
  const snapshot = () =>
    page.evaluate(() => ({
      head: document.head.innerHTML,
      sheets: document.styleSheets.length,
      bodyChildren: document.body.children.length,
      bodyStyle: document.body.getAttribute('style'),
      htmlFont: getComputedStyle(document.documentElement).fontSize,
      siteButton: (({ backgroundColor, borderTopStyle, fontFamily }) => ({ backgroundColor, borderTopStyle, fontFamily }))(
        getComputedStyle(document.getElementById('site-button')!),
      ),
    }));
  const before = await snapshot();
  await page.unroute('**/widget.js');

  const widgetRequests: string[] = [];
  page.on('request', (r) => r.url().startsWith(API_URL) && widgetRequests.push(new URL(r.url()).pathname));
  await page.goto(`${DEMO_URL}/`);
  await expect(fab(page)).toBeVisible();
  await expect(fab(page)).toHaveText('Review');

  // Only the loader + the public config call; the React panel is not loaded until needed.
  expect(widgetRequests).toEqual(['/widget.js', '/api/v1/widget/config']);

  // Host page untouched: same <head>, stylesheets, styles; exactly one extra element in <body>.
  const after = await snapshot();
  expect(after).toEqual({ ...before, bodyChildren: before.bodyChildren + 1 });
  await expect(page.locator('wrtm-review-widget')).toHaveCount(1);

  // The hostile site CSS (lime buttons, Comic Sans, 10px root font) doesn't reach the button.
  const style = await fab(page).evaluate((el) => {
    const s = getComputedStyle(el);
    return { bg: s.backgroundColor, font: s.fontFamily, size: s.fontSize, height: s.height, border: s.borderTopStyle, transform: s.textTransform };
  });
  expect(style.bg).toBe(BRAND);
  expect(style.font).not.toContain('Comic');
  expect(style).toMatchObject({ size: '14px', height: '44px', border: 'none', transform: 'none' });
  const box = (await fab(page).boundingBox())!;
  const vp = page.viewportSize()!;
  expect(vp.width - (box.x + box.width)).toBeCloseTo(20, 0); // bottom-right
  expect(vp.height - (box.y + box.height)).toBeCloseTo(20, 0);
  await ctx.close();
});

test('anonymous visitor: popup opens, protected action opens the login popup; owner signs in and creates a task with a screenshot', async ({ browser }) => {
  site = await (await newContext(browser)).newPage();
  const appChunk = site.waitForRequest((r) => /\/widget-app\/app-[\w-]+\.js$/.test(r.url()));
  await site.goto(`${DEMO_URL}/`);
  await fab(site).click();
  await appChunk; // panel lazy-loaded on first use
  const p = panel(site);
  await expect(p).toBeVisible();
  await expect(p.getByRole('heading', { name: 'Review Comments' })).toBeVisible();
  for (const tab of ['All', 'Open', 'In Progress', 'Done', 'Archived']) await expect(p.getByRole('tab', { name: tab })).toBeVisible();
  await expect(p.getByLabel('Pages')).toHaveValue('all');
  await expect(p.getByRole('heading', { name: 'Sign in to review' })).toBeVisible();

  // Panel is visible even though the host CSS hides [role=dialog], .panel, .card … with !important.
  const panelFont = await p.evaluate((el) => getComputedStyle(el).fontFamily);
  expect(panelFont).not.toContain('Comic');

  // Close icon hides the popup; Review opens it again.
  await p.getByRole('button', { name: 'Close review comments' }).click();
  await expect(p).toBeHidden();
  await openPanel(site);

  // Protected action → login popup → back in the Review popup, continuing the action.
  await p.getByRole('button', { name: 'Add a Comment' }).click();
  await signInInWidget(site, owner.email, PASSWORD);
  // "Add a Comment" → element picking: only the element under the cursor is outlined (with its
  // tag and size); clicking it opens the comment form for that element.
  const bar = site.getByRole('dialog', { name: 'Select an element' });
  await expect(bar).toBeVisible();
  await expect(p).toBeHidden();
  expect(await site.evaluate(() => document.documentElement.classList.contains('wrtm-picking'))).toBe(true);
  // no grid over the whole page: other elements are not outlined
  expect(await site.locator('#headline').evaluate((el) => getComputedStyle(el).outlineStyle)).not.toBe('dashed');
  expect(await site.locator('#footer-text').evaluate((el) => getComputedStyle(el).outlineStyle)).not.toBe('dashed');
  await site.locator('#headline').hover();
  await expect(site.getByTestId('pick-hover')).toHaveCount(1);
  await expect(site.getByTestId('pick-hover')).toContainText('H1');
  const hl = (await site.locator('#headline').boundingBox())!;
  const hb = (await site.getByTestId('pick-hover').boundingBox())!;
  expect(Math.abs(hb.y + 3 - hl.y)).toBeLessThan(2);
  await site.locator('#headline').click();
  await expect(bar).toBeHidden();
  expect(await site.evaluate(() => document.documentElement.classList.contains('wrtm-picking'))).toBe(false);
  await expect(p.getByRole('form', { name: 'Create task' })).toBeVisible();
  await expect(p.getByTestId('picked-element')).toContainText('H1');
  await expect(p.getByTestId('picked-element')).toContainText('Shoes for every step');
  await expect(site.getByTestId('selected-element')).toBeVisible();
  // Wider / Narrower walk up and back down the page structure
  await p.getByRole('button', { name: 'Wider' }).click();
  await expect(p.getByTestId('picked-element')).not.toContainText('H1 ·');
  await p.getByRole('button', { name: 'Narrower' }).click();
  await expect(p.getByTestId('picked-element')).toContainText('H1 ·');
  await expect(p.locator('.page-box')).toContainText('Acme Shoes — Home');
  await expect(p.locator('.page-box')).toContainText(`${DEMO_URL}/`);

  await p.getByLabel('Task title').fill('Hero headline is cut off');
  await p.getByLabel('Description').fill('On 1280px the headline wraps under the image.');
  await p.getByLabel('Task type').selectOption('BUG');
  await p.getByRole('button', { name: 'Capture this page' }).click();
  await expect(p.getByRole('img', { name: 'Screenshot preview' })).toBeVisible();
  const upload = site.waitForResponse((r) => r.url().includes('/attachments?kind=screenshot') && r.request().method() === 'POST');
  await p.getByRole('button', { name: 'Create task' }).click();
  expect((await upload).status()).toBe(201);
  await expect(p.getByRole('status').filter({ hasText: 'Task created' })).toBeVisible();

  const c = card(site, 'Hero headline is cut off');
  await expect(c).toBeVisible();
  await expect(c.locator('.name').first()).toHaveText(owner.name);
  await expect(c.locator('.badge')).toHaveText('Open');
  await expect(c.locator('.type')).toHaveText('Bug');
  await expect(c.locator('.page-link')).toContainText('127.0.0.1:5600');
  await expect(c.getByRole('button', { name: /^Show TASK-\d+ on the page$/ })).toContainText('Shoes for every step');
  await expect(c.locator('.desc')).toContainText('wraps under the image');
  await expect(c.locator('time')).toHaveText('just now');
  const img = c.getByRole('img', { name: /Screenshot for/ });
  await expect.poll(() => img.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth)).toBeGreaterThan(100);
  await expect(c.getByRole('button', { name: 'Reply' })).toBeVisible();
  await expect(c.getByRole('button', { name: 'Archive' })).toBeVisible();

  await expect(p.getByTestId('open-count')).toHaveText('1 open');
  await expect(p.getByRole('tab', { name: 'Open' })).toContainText('1');
  // Footer: logged-in user profile
  await expect(p.getByRole('button', { name: `Account: ${owner.name}` })).toBeVisible();
  await site.screenshot({ path: 'test-results/widget-desktop.png' });
  // Badge on the Review button
  await p.getByRole('button', { name: 'Close review comments' }).click();
  await expect(fab(site)).toHaveAccessibleName('Open review comments (1 open)');
  await expect(fab(site).locator('.fab-badge')).toHaveText('1');
});

test('session persists across pages; SPA navigation updates the page and the "This Page" filter', async () => {
  // Multi-page: new page load, still signed in (site-bound session in localStorage).
  await site.goto(`${DEMO_URL}/about`);
  await expect(fab(site).locator('.fab-badge')).toHaveText('1');

  // SPA where the widget is injected from JavaScript (React useEffect style).
  await site.goto(`${DEMO_URL}/app`);
  await expect(fab(site)).toBeVisible();
  await site.getByRole('link', { name: 'Cart' }).click(); // history.pushState
  await expect(site.locator('#route-title')).toHaveText('Cart');

  await openPanel(site);
  const p = panel(site);
  await p.getByRole('button', { name: 'Add a Comment' }).click();
  await site.getByRole('dialog', { name: 'Select an element' }).getByRole('button', { name: 'Whole page' }).click(); // comment on the whole page
  await expect(p.locator('.page-box')).toContainText('Store — Cart');
  await expect(p.locator('.page-box')).toContainText(`${DEMO_URL}/app/cart`);
  await p.getByLabel('Task title').fill('Cart total missing tax');
  await p.getByLabel('Task type').selectOption('IMPROVEMENT');
  await p.getByRole('button', { name: 'Create task' }).click();
  await expect(card(site, 'Cart total missing tax')).toBeVisible();

  await p.getByLabel('Pages').selectOption('page');
  await expect(card(site, 'Cart total missing tax')).toBeVisible();
  await expect(card(site, 'Hero headline is cut off')).toHaveCount(0);

  // Navigate inside the SPA while the panel is open: the filter follows the new URL.
  await p.getByRole('button', { name: 'Close review comments' }).click();
  await site.getByRole('link', { name: 'Checkout' }).click();
  await openPanel(site);
  await expect(p.getByRole('heading', { name: 'No matching comments' })).toBeVisible();
  await site.goBack(); // popstate → /app/cart
  await expect(card(site, 'Cart total missing tax')).toBeVisible();
  await p.getByLabel('Pages').selectOption('all');
  await expect(p.locator('article.card')).toHaveCount(2);
});

test('tabs, search, Mine, reply and archive', async () => {
  const p = panel(site);
  const hero = await card(site, 'Hero headline is cut off').getAttribute('data-task-id');

  // Status changed by the team in the dashboard → "In Progress" tab.
  expect((await api.patch(`/api/v1/tasks/${hero}`, { data: { status: 'IN_PROGRESS' } })).status()).toBe(200);
  await p.getByRole('tab', { name: 'In Progress' }).click();
  await expect(card(site, 'Hero headline is cut off').locator('.badge')).toHaveText('In progress');
  await expect(p.locator('article.card')).toHaveCount(1);
  await p.getByRole('tab', { name: 'Done' }).click();
  await expect(p.getByRole('heading', { name: 'No matching comments' })).toBeVisible();
  await p.getByRole('tab', { name: 'All' }).click();

  await p.getByLabel('Search').fill('tax');
  await expect(p.locator('article.card')).toHaveCount(1);
  await expect(card(site, 'Cart total missing tax')).toBeVisible();
  await p.getByLabel('Search').fill('');
  expect(await p.getByRole('button', { name: 'Mine' }).evaluate((el) => getComputedStyle(el).paddingLeft)).toBe('10px');
  await p.getByRole('button', { name: 'Mine' }).click();
  await expect(p.getByRole('button', { name: 'Mine' })).toHaveAttribute('aria-pressed', 'true');
  await expect(p.locator('article.card')).toHaveCount(2);
  await p.getByRole('button', { name: 'Mine' }).click();

  // Reply
  const c = card(site, 'Cart total missing tax');
  // Reply opens the task detail at its comments
  await c.getByRole('button', { name: 'Reply' }).click();
  await expect(p.getByText('No comments yet. Start the conversation.')).toBeVisible();
  await p.getByRole('textbox', { name: 'Write a comment' }).fill('Tax should be 8.25% for TX.');
  await p.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(p.getByTestId('thread').locator('.comment')).toContainText('Tax should be 8.25% for TX.'); // saved + rendered
  await p.getByRole('button', { name: 'Back to comments' }).click();
  await expect(c.getByRole('button', { name: 'Reply (1)' })).toBeVisible();
  await site.screenshot({ path: 'test-results/widget-thread.png' });

  // Archive → Archived tab → Restore
  await c.getByRole('button', { name: 'Archive' }).click();
  await p.getByRole('alertdialog').getByRole('button', { name: 'Archive' }).click(); // confirmation
  await expect(p.getByRole('status').filter({ hasText: 'Task archived' })).toBeVisible();
  await expect(card(site, 'Cart total missing tax')).toHaveCount(0);
  await expect(p.getByRole('tab', { name: 'Archived' })).toContainText('1');
  await p.getByRole('tab', { name: 'Archived' }).click();
  const archived = card(site, 'Cart total missing tax');
  await expect(archived.locator('.badge')).toHaveText('Archived');
  await archived.getByRole('button', { name: 'Restore' }).click();
  await expect(p.getByRole('status').filter({ hasText: 'Task restored' })).toBeVisible();
  await expect(p.getByRole('tab', { name: 'Archived' })).toContainText('0');
  await p.getByRole('tab', { name: 'All' }).click();
});

test('the dashboard shows widget tasks with screenshot, page and browser context', async () => {
  const page = await ownerCtx.newPage();
  await page.goto('/tasks');
  await page.getByTestId('task-row').filter({ hasText: 'Hero headline is cut off' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Review widget')).toBeVisible();
  await expect(dialog.getByText('Acme Shoes — Home —')).toBeVisible();
  const shot = dialog.getByTestId('task-attachments').getByRole('img');
  await expect.poll(() => shot.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth)).toBeGreaterThan(100);
  await expect(dialog.getByTestId('capture-context')).toContainText('Viewport');
  await expect(dialog.getByTestId('capture-context')).toContainText('Chrome');
  await page.close();
});

test('registration, email verification, no-access state, sign-out and forgot password in the widget', async ({ browser }) => {
  // Invite-only mode: with auto-join switched off, signing up never grants access.
  expect((await api.patch(`/api/v1/websites/${websiteId}/settings`, { data: { widgetAutoJoin: false } })).status()).toBe(200);
  const ctx = await newContext(browser);
  const page = await ctx.newPage();
  const visitor = { name: 'Rita Reviewer', email: unique('visitor') };
  await page.goto(`${DEMO_URL}/about`);
  await openPanel(page);
  const p = panel(page);
  await p.getByRole('button', { name: 'Sign in', exact: true }).first().click();
  const dialog = authDialog(page);
  await page.screenshot({ path: 'test-results/widget-login.png' });
  await dialog.getByRole('button', { name: 'Create one' }).click();
  await expect(dialog.getByRole('heading', { name: 'Create your account' })).toBeVisible();
  await dialog.getByLabel('Name').fill(visitor.name);
  await dialog.getByLabel('Email').fill(visitor.email);
  await dialog.getByLabel('Password').fill('short');
  await dialog.getByRole('button', { name: 'Create account' }).click();
  await expect(dialog.getByRole('alert')).toContainText('at least 8 characters');
  await dialog.getByLabel('Password').fill(PASSWORD);
  await dialog.getByRole('button', { name: 'Create account' }).click();
  await expect(dialog).toBeHidden();

  await expect(p.getByRole('heading', { name: 'Verify your email' })).toBeVisible();
  const verifyPage = await ctx.newPage();
  await verifyPage.goto(await linkFromOutbox(visitor.email, '/verify-email')); // dashboard verify page
  await expect(verifyPage.getByText(/verified/i).first()).toBeVisible();
  await verifyPage.close();
  await p.getByRole('button', { name: "I've verified my email" }).click();
  // Registering never grants access to someone else's website.
  await expect(p.getByRole('heading', { name: 'No access to this website' })).toBeVisible();

  // Owner adds them as a Website User. Like the dashboard, they only see projects they're assigned to.
  const added = await api.post(`/api/v1/websites/${websiteId}/members`, { data: { email: visitor.email, role: 'WEBSITE_USER' } });
  expect(added.status()).toBe(201);
  await p.getByRole('button', { name: 'Close review comments' }).click();
  await page.reload();
  await openPanel(page);
  await expect(p.getByRole('heading', { name: 'No comments yet' })).toBeVisible();
  await expect(p.getByRole('button', { name: 'Add a Comment' })).toBeDisabled();

  // Assigned to the widget's feedback project → they see its comments and can add their own.
  const projects = (await (await api.get(`/api/v1/websites/${websiteId}/projects`)).json()).data.items as { id: string; name: string }[];
  const feedback = projects.find((x) => x.name === 'Website Feedback')!;
  const memberId = (await (await api.get(`/api/v1/websites/${websiteId}/members`)).json()).data.find(
    (m: { user: { email: string } }) => m.user.email === visitor.email,
  ).user.id;
  await api.put(`/api/v1/websites/${websiteId}/members/${memberId}/projects`, { data: { projects: [{ projectId: feedback.id }] } });
  await p.getByRole('button', { name: 'Close review comments' }).click();
  await page.reload();
  await openPanel(page);
  // Private reporting: a Website User never sees other people's tasks — only their own.
  await expect(p.getByRole('heading', { name: 'No comments yet' })).toBeVisible();
  await expect(card(page, 'Hero headline is cut off')).toHaveCount(0);
  await expect(p.getByRole('button', { name: 'Add a Comment' })).toBeEnabled();
  await p.getByRole('button', { name: 'Add a Comment' }).click();
  await page.getByRole('dialog', { name: 'Select an element' }).getByRole('button', { name: 'Whole page' }).click(); // comment on the whole page
  await p.getByLabel('Task title').fill('Visitor: footer link broken');
  await p.getByRole('button', { name: 'Create task' }).click();
  await expect(card(page, 'Visitor: footer link broken')).toBeVisible();
  await expect(p.locator('article.card')).toHaveCount(1);
  // Archiving stays a team action (unchanged).
  await expect(card(page, 'Visitor: footer link broken').getByRole('button', { name: 'Archive' })).toHaveCount(0);

  // Sign out from the footer profile menu
  await p.getByRole('button', { name: `Account: ${visitor.name}` }).click();
  await p.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(p.getByRole('heading', { name: 'Sign in to review' })).toBeVisible();
  await expect(fab(page).locator('.fab-badge')).toBeHidden();
  expect(await page.evaluate((id) => localStorage.getItem(`wrtm-widget:${id}`), siteId)).toBeNull();

  // Forgot password
  await p.getByRole('button', { name: 'Sign in', exact: true }).first().click();
  await dialog.getByRole('button', { name: 'Forgot password?' }).click();
  await dialog.getByLabel('Email').fill(visitor.email);
  await dialog.getByRole('button', { name: 'Send reset link' }).click();
  await expect(dialog.getByRole('status')).toContainText('we sent a link');
  expect(await linkFromOutbox(visitor.email, '/reset-password')).toContain('token=');
  await ctx.close();
  expect((await api.patch(`/api/v1/websites/${websiteId}/settings`, { data: { widgetAutoJoin: true } })).status()).toBe(200);
});

test('auto-join: a visitor who signs in on the website joins it, reports, and shows under the project users', async ({ browser }) => {
  const ctx = await newContext(browser);
  const page = await ctx.newPage();
  const gur = { name: 'Gur Visitor', email: unique('gur') };
  await page.goto(`${DEMO_URL}/about`);
  await openPanel(page);
  const p = panel(page);
  await p.getByRole('button', { name: 'Sign in', exact: true }).first().click();
  const dialog = authDialog(page);
  await dialog.getByRole('button', { name: 'Create one' }).click();
  await dialog.getByLabel('Name').fill(gur.name);
  await dialog.getByLabel('Email').fill(gur.email);
  await dialog.getByLabel('Password').fill(PASSWORD);
  await dialog.getByRole('button', { name: 'Create account' }).click();
  await expect(p.getByRole('heading', { name: 'Verify your email' })).toBeVisible();
  const verifyPage = await ctx.newPage();
  await verifyPage.goto(await linkFromOutbox(gur.email, '/verify-email'));
  await expect(verifyPage.getByText(/verified/i).first()).toBeVisible();
  await verifyPage.close();
  await p.getByRole('button', { name: "I've verified my email" }).click();

  // Joined automatically: no "No access" screen; only their own (no) tasks; can report.
  await expect(p.getByRole('heading', { name: 'No comments yet' })).toBeVisible();
  await expect(p.getByRole('button', { name: 'Add a Comment' })).toBeEnabled();
  await p.getByRole('button', { name: 'Add a Comment' }).click();
  await page.getByRole('dialog', { name: 'Select an element' }).getByRole('button', { name: 'Whole page' }).click(); // comment on the whole page
  await p.getByLabel('Task title').fill('Gur: about page typo');
  await p.getByRole('button', { name: 'Create task' }).click();
  await expect(card(page, 'Gur: about page typo')).toBeVisible();
  await expect(p.locator('article.card')).toHaveCount(1);
  await ctx.close();

  // Admin dashboard → Projects → Acme Shoes: Gur is listed under its users, with the task.
  const admin = await ownerCtx.newPage();
  await admin.goto('/');
  const row = admin.getByTestId('project-row').filter({ hasText: 'Acme Shoes' });
  await expect(row).toBeVisible();
  await row.click();
  const users = admin.getByTestId('project-users');
  await expect(users.getByRole('row').filter({ hasText: gur.email })).toContainText('Website User');
  await expect(admin.getByTestId('task-row').filter({ hasText: 'Gur: about page typo' })).toBeVisible();
  await admin.getByRole('button', { name: 'All projects' }).click();
  await expect(admin.getByTestId('projects-panel')).toBeVisible();
  await admin.close();

  // Gur's own dashboard: only this project, only their task; New task saves into it.
  const gurCtx = await newContext(browser);
  const g = await gurCtx.newPage();
  await login(g, gur.email, PASSWORD);
  await expect(g.getByTestId('project-row')).toHaveCount(1);
  await g.getByTestId('project-row').click();
  await expect(g.getByTestId('project-users')).toHaveCount(0); // other users stay private
  await expect(g.getByTestId('task-row')).toHaveCount(1);
  await g.getByRole('button', { name: 'New task' }).click();
  const form = g.getByRole('dialog', { name: 'New task' });
  await form.getByLabel('Project').selectOption({ index: 1 });
  await expect(form.getByLabel('Status')).toHaveCount(0); // team-only fields hidden for the User role
  await form.getByLabel('Title').fill('Gur: dashboard task');
  await form.getByRole('button', { name: 'Create task' }).click();
  await expect(g.getByTestId('task-row').filter({ hasText: 'Gur: dashboard task' })).toBeVisible();
  await expect(g.getByTestId('task-row')).toHaveCount(2);
  await gurCtx.close();
});

test('Google login opens a popup and reports the result back to the widget', async ({ browser }) => {
  const ctx = await newContext(browser);
  // The popup opens our API, which redirects to Google. We let the real API answer (state
  // cookie + Google URL), check it, then stand in for Google: the user cancels and Google
  // redirects back to our real callback with an error. (Google rejects the e2e client id.)
  let googleUrl: URL | null = null;
  await ctx.route(`${API_URL}/api/v1/widget/auth/google?**`, async (route) => {
    const res = await route.fetch({ maxRedirects: 0 });
    expect(res.status()).toBe(302);
    googleUrl = new URL(res.headers().location!);
    const back = `${API_URL}/api/v1/auth/google/callback?error=access_denied&state=${googleUrl.searchParams.get('state')}`;
    await route.fulfill({ status: 302, headers: { ...res.headers(), location: back } });
  });
  const page = await ctx.newPage();
  await page.goto(`${DEMO_URL}/`);
  await openPanel(page);
  await panel(page).getByRole('button', { name: 'Sign in', exact: true }).first().click();
  const dialog = authDialog(page);
  const [popup] = await Promise.all([ctx.waitForEvent('page'), dialog.getByRole('button', { name: 'Continue with Google' }).click()]);
  await expect(dialog.getByRole('alert')).toHaveText('Google sign-in was cancelled.');
  expect(googleUrl!.origin + googleUrl!.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
  expect(googleUrl!.searchParams.get('client_id')).toBe('e2e-client-id.apps.googleusercontent.com');
  expect(googleUrl!.searchParams.get('redirect_uri')).toBe(`${API_URL}/api/v1/auth/google/callback`);
  await expect.poll(() => popup.isClosed()).toBe(true);
  await ctx.close();
});

test('duplicate script tags initialise one widget; unknown domains and disabled widgets add nothing', async ({ browser }) => {
  const ctx = await newContext(browser);
  const page = await ctx.newPage();
  await page.goto(`${DEMO_URL}/double`);
  await expect(fab(page)).toBeVisible();
  await page.waitForTimeout(500);
  await expect(page.locator('wrtm-review-widget')).toHaveCount(1);

  // Same demo site reached as "localhost" — not an allowed domain for this website.
  const warnings: string[] = [];
  page.on('console', (m) => m.type() === 'warning' && warnings.push(m.text()));
  await page.goto(`http://localhost:5600/`);
  await expect.poll(() => warnings.join('\n')).toContain('not allowed on localhost');
  await expect(page.locator('wrtm-review-widget')).toHaveCount(0);

  // Allowing it in Settings makes it work there too.
  await api.patch(`/api/v1/websites/${websiteId}/settings`, { data: { allowedDomains: ['localhost'] } });
  await page.reload();
  await expect(fab(page)).toBeVisible();

  // Widget switched off in Settings → nothing is added to the site.
  await api.patch(`/api/v1/websites/${websiteId}/settings`, { data: { widgetEnabled: false, allowedDomains: [] } });
  warnings.length = 0;
  await page.goto(`${DEMO_URL}/`);
  await expect.poll(() => warnings.join('\n')).toContain('turned off');
  await expect(page.locator('wrtm-review-widget')).toHaveCount(0);
  await api.patch(`/api/v1/websites/${websiteId}/settings`, { data: { widgetEnabled: true } });
  await ctx.close();
});

test('mobile layout: full-screen popup, button hidden while open', async ({ browser }) => {
  const ctx = await newContext(browser, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
  // Reuse the owner's widget session (same site-bound tokens in this origin's storage).
  const session = await site.evaluate((id) => localStorage.getItem(`wrtm-widget:${id}`), siteId);
  await ctx.addInitScript(([key, value]) => localStorage.setItem(key, value), [`wrtm-widget:${siteId}`, session!] as const);
  const page = await ctx.newPage();
  await page.goto(`${DEMO_URL}/`);

  const box = (await fab(page).boundingBox())!;
  expect(box.height).toBe(48);
  expect(390 - (box.x + box.width)).toBeCloseTo(14, 0);

  await fab(page).tap();
  const p = panel(page);
  await expect(p).toBeVisible();
  await expect.poll(() => p.boundingBox()).toEqual({ x: 0, y: 0, width: 390, height: 844 }); // after the open animation
  await expect(fab(page)).toBeHidden();
  await expect(p.locator('article.card')).toHaveCount(5); // the owner sees every task, incl. the visitors'
  await page.screenshot({ path: 'test-results/widget-mobile.png' });
  // The site's own fixed promo (z-index 999999, bottom-left) must not cover the panel.
  expect(await page.evaluate(() => document.elementFromPoint(40, 820)?.tagName)).toBe('WRTM-REVIEW-WIDGET');
  // Tabs scroll horizontally instead of wrapping; footer stays visible.
  await expect(p.getByRole('button', { name: 'Add a Comment' })).toBeInViewport();

  await p.getByRole('button', { name: 'Close review comments' }).tap();
  await expect(p).toBeHidden();
  await expect(fab(page)).toBeVisible();
  await ctx.close();
});

test('element comments: page-wise list, Show on page across pages, after a refresh, and from a dashboard link', async () => {
  const p = panel(site);
  const pickAndComment = async (url: string, selector: string, title: string) => {
    await site.goto(url);
    await openPanel(site);
    await p.getByRole('button', { name: 'Add a Comment' }).click();
    await site.locator(selector).click();
    await p.getByLabel('Task title').fill(title);
    await p.getByRole('button', { name: 'Create task' }).click();
    const c = card(site, title);
    await expect(c).toBeVisible();
    return (await c.getAttribute('data-task-id'))!;
  };
  const aboutId = await pickAndComment(`${DEMO_URL}/about`, 'h1', 'About heading wording');
  const footerId = await pickAndComment(`${DEMO_URL}/`, '#footer-text', 'Footer text is outdated');

  // Page-wise list: the current page's group comes first, every group named by its page.
  const groups = p.getByTestId('page-group');
  await expect(groups.first().getByRole('heading')).toContainText('/');
  await expect(groups.first().getByRole('heading')).toContainText('This page');
  const aboutGroup = groups.filter({ has: site.getByRole('heading', { name: /^\/about/ }) });
  await expect(aboutGroup.locator('article.card', { hasText: 'About heading wording' })).toBeVisible();
  await expect(aboutGroup.locator('article.card', { hasText: 'About heading wording' })).toContainText(owner.name);

  // Same page: Show → scrolls to the element and highlights it.
  await site.evaluate(() => window.scrollTo(0, 0));
  await card(site, 'Footer text is outdated').getByRole('button', { name: /on the page$/ }).click();
  const highlight = site.getByTestId('element-highlight');
  await expect(highlight).toBeVisible();
  await expect(site.locator('#footer-text')).toBeInViewport();
  await expect.poll(async () => Math.round((await highlight.boundingBox())!.y + 3 - (await site.locator('#footer-text').boundingBox())!.y)).toBe(0);
  await highlight.getByRole('button', { name: 'Dismiss highlight' }).click();
  await expect(highlight).toBeHidden();

  // Other page: Show → redirects to /about, then highlights its <h1>.
  if (!(await p.isVisible())) await openPanel(site);
  await card(site, 'About heading wording').getByRole('button', { name: /on the page$/ }).click();
  await site.waitForURL(`${DEMO_URL}/about`);
  await expect(highlight).toBeVisible();
  await expect(highlight).toContainText(/TASK-\d+/);
  const h1 = (await site.locator('h1').boundingBox())!;
  const box = (await highlight.boundingBox())!;
  expect(Math.abs(box.x + 3 - h1.x)).toBeLessThan(2);
  expect(Math.abs(box.width - 6 - h1.width)).toBeLessThan(2);

  // A refresh keeps pointing at it until dismissed.
  await site.reload();
  await expect(highlight).toBeVisible();
  await highlight.getByRole('button', { name: 'Open' }).click();
  await expect(p.getByTestId('detail-key')).toBeVisible();
  await expect(p.getByRole('button', { name: /on the page$/ })).toContainText('About us');
  await p.getByRole('button', { name: 'Back to comments' }).click();
  await highlight.getByRole('button', { name: 'Dismiss highlight' }).click();
  await site.reload();
  await site.waitForTimeout(800);
  await expect(highlight).toHaveCount(0);

  // Dashboard → task → "Show on page" link (…?wrtm_task=<id>) opens the page with the element highlighted.
  const dash = await ownerCtx.newPage();
  await dash.goto(`/tasks?task=${footerId}`);
  const link = dash.getByTestId('task-element').getByRole('link', { name: 'Show on page' });
  await expect(dash.getByTestId('task-element')).toContainText('End of page.');
  const href = (await link.getAttribute('href'))!;
  expect(href).toContain(`wrtm_task=${footerId}`);
  await dash.close();
  await site.goto(href);
  await expect(highlight).toBeVisible();
  await expect(site.locator('#footer-text')).toBeInViewport();
  expect(site.url()).not.toContain('wrtm_task'); // the link parameter is removed again
  await highlight.getByRole('button', { name: 'Dismiss highlight' }).click();
  void aboutId;
});
