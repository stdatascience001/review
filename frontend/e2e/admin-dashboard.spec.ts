import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { SUPER_ADMIN } from './env';
import { confirmDialog, expectToast, linkFromOutbox, login, statValue, unique } from './helpers';

/**
 * Full admin-dashboard journey against the real backend + PostgreSQL:
 * auth → dashboard → websites → projects → team/invitations → tasks/comments →
 * notifications → users (super admin) → role-based access → deletes.
 */
test.describe.configure({ mode: 'serial' });

const PASSWORD = 'Owner-pass-2026';
const owner = { name: 'Olivia Owner', email: unique('owner') };
const dev = { name: 'Dev Patel', email: unique('dev'), password: 'Dev-pass-2026' };

// Stand-in for the customer's website, used for real domain verification.
let siteHtml = '<html><head><title>Customer</title></head><body>Hello</body></html>';
const customerSite = http.createServer((_req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(siteHtml));
let siteUrl = '';

let ownerCtx: BrowserContext;
let ownerPage: Page;
let websiteUrlPath = '';

const newPage = async (browser: Browser) => {
  const ctx = await browser.newContext();
  return { ctx, page: await ctx.newPage() };
};

test.beforeAll(async ({ browser }) => {
  await new Promise<void>((r) => customerSite.listen(0, '127.0.0.1', r));
  siteUrl = `http://127.0.0.1:${(customerSite.address() as AddressInfo).port}`;
  ({ ctx: ownerCtx, page: ownerPage } = await newPage(browser));
});

test.afterAll(async () => {
  customerSite.close();
  await ownerCtx?.close();
});

test('protected routes redirect to login; Google login starts the OAuth flow', async ({ page }) => {
  await page.goto('/websites');
  await expect(page).toHaveURL(/\/login\?redirect=%2Fwebsites/);
  await expect(page.getByRole('heading', { name: 'Sign in to your account' })).toBeVisible();

  // Google button is wired to the backend OAuth endpoint, which redirects to Google.
  // (Google itself rejects the e2e client id; we only assert the request our backend builds.)
  const [googleRequest] = await Promise.all([
    page.waitForRequest((r) => r.url().startsWith('https://accounts.google.com/o/oauth2/v2/auth')),
    page.getByRole('button', { name: 'Continue with Google' }).click(),
  ]);
  const u = new URL(googleRequest.url());
  expect(u.searchParams.get('client_id')).toBe('e2e-client-id.apps.googleusercontent.com');
  expect(u.searchParams.get('code_challenge_method')).toBe('S256');
  expect(u.searchParams.get('scope')).toBe('openid email profile');
});

test('register → verify email → dashboard with live (empty) statistics', async () => {
  const page = ownerPage;
  await page.goto('/register');
  await page.getByLabel('Full name').fill(owner.name);
  await page.getByLabel('Email').fill(owner.email);
  await page.getByLabel('Password').fill('short');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('alert')).toContainText('password');

  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'Verify your email' })).toBeVisible();

  await page.goto(await linkFromOutbox(owner.email, '/verify-email'));
  await expect(page.getByText('Your email has been verified.')).toBeVisible();
  await page.getByRole('link', { name: /Go to dashboard/ }).click();

  await expect(page.getByRole('heading', { name: /Hello, Olivia/ })).toBeVisible();
  for (const label of ['Total Websites', 'Total Projects', 'Total Tasks', 'Open Tasks', 'In Progress Tasks', 'Completed Tasks', 'Overdue Tasks']) {
    await expect(statValue(page, label)).toHaveText('0');
  }
  await expect(statValue(page, 'Total Users')).toHaveText('0'); // no teams yet
  await expect(page.getByText('No activity yet')).toBeVisible();
  // Regular users don't get the Users (platform admin) menu item
  await expect(page.getByRole('link', { name: 'Users', exact: true })).toHaveCount(0);
});

test('logout and login (wrong password shows an error)', async () => {
  const page = ownerPage;
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login/);
  await page.goto('/');
  await expect(page).toHaveURL(/\/login/);

  await page.getByLabel('Email').fill(owner.email);
  await page.getByLabel('Password').fill('Wrong-password-1');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Invalid email or password');
  await login(page, owner.email, PASSWORD);
});

test('website management: add, search, embed script, Site ID, verify domain, allowed domains, edit, deactivate', async () => {
  const page = ownerPage;
  await page.getByRole('link', { name: 'Websites' }).click();
  await expect(page.getByText('No websites yet')).toBeVisible();

  // Add website
  await page.getByRole('button', { name: 'Add website' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Add website' });
  await dialog.getByLabel('Website name').fill('Acme Store');
  await dialog.getByLabel('Website URL').fill(siteUrl);
  await dialog.getByLabel('Description').fill('Main e-commerce site');
  await dialog.getByRole('button', { name: 'Add website' }).click();
  await expectToast(page, 'Website added');
  await expect(page.getByTestId('website-row')).toHaveCount(1);

  // A second website, then search
  await page.getByRole('button', { name: 'Add website' }).first().click();
  await page.getByRole('dialog').getByLabel('Website name').fill('Blog');
  await page.getByRole('dialog').getByLabel('Website URL').fill('https://blog.example.com');
  await page.getByRole('dialog').getByRole('button', { name: 'Add website' }).click();
  await expect(page.getByTestId('website-row')).toHaveCount(2);
  await page.getByPlaceholder('Search by name, URL or Site ID…').fill('acme');
  await expect(page.getByTestId('website-row')).toHaveCount(1);
  await expect(page.getByTestId('website-row')).toContainText('Acme Store');
  await expect(page.getByTestId('website-row')).toContainText(/site_[a-f0-9]{20}/);

  // Open detail
  await page.getByRole('link', { name: 'Acme Store' }).click();
  await expect(page.getByRole('heading', { name: 'Acme Store' })).toBeVisible();
  websiteUrlPath = new URL(page.url()).pathname;
  const siteId = (await page.getByTestId('site-id').textContent())!;
  expect(siteId).toMatch(/^site_[a-f0-9]{20}$/);
  await expect(page.getByTestId('embed-script')).toHaveText(`<script src="http://localhost:4100/widget.js" data-site-id="${siteId}" async></script>`);

  // Copy embed script → clipboard
  await page.getByRole('button', { name: 'Copy', exact: true }).first().click();
  await expectToast(page, 'Embed script copied');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(siteId);

  // Regenerate Site ID (with confirmation)
  await page.getByRole('button', { name: 'Regenerate' }).click();
  await confirmDialog(page, 'Generate new ID');
  await expect(page.getByTestId('site-id')).not.toHaveText(siteId);
  const newSiteId = (await page.getByTestId('site-id').textContent())!;

  // Domain verification: fails, then succeeds once the meta tag is on the site
  await page.getByRole('button', { name: 'Verify domain' }).click();
  await expect(page.getByRole('status')).toContainText('not found');
  const metaTag = (await page.getByTestId('verification-meta').textContent())!;
  expect(metaTag).toMatch(/^<meta name="wrtm-site-verification" content="[a-f0-9]{32}">$/);
  siteHtml = `<html><head>${metaTag}</head><body>ok</body></html>`;
  await page.getByRole('button', { name: 'Verify domain' }).click();
  await expect(page.getByRole('status')).toContainText('Verified via meta tag');
  await expect(page.getByText('Verified', { exact: true }).first()).toBeVisible();

  // Allowed domains
  await page.getByRole('tab', { name: 'Settings' }).click();
  await page.getByLabel('New allowed domain').fill('not a domain');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expectToast(page, 'valid domain');
  await page.getByLabel('New allowed domain').fill('https://staging.acme.com/path');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByLabel('New allowed domain').fill('*.acme.com');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('allowed-domains')).toContainText('staging.acme.com');
  await expect(page.getByTestId('allowed-domains')).toContainText('*.acme.com');
  const removed = page.waitForResponse((r) => r.url().endsWith('/settings') && r.request().method() === 'PATCH' && !r.request().postData()?.includes('*.acme.com'));
  await page.getByRole('button', { name: 'Remove *.acme.com' }).click();
  expect((await removed).status()).toBe(200);
  await page.reload();
  await expect(page.getByTestId('allowed-domains')).toHaveText(/staging\.acme\.com/);
  await expect(page.getByTestId('allowed-domains')).not.toContainText('*.acme.com');

  // Edit website (logo)
  await page.getByRole('button', { name: 'Edit' }).click();
  await page.getByRole('dialog').getByLabel('Logo URL').fill('http://insecure.example/logo.png');
  await page.getByRole('dialog').getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('https');
  await page.getByRole('dialog').getByLabel('Logo URL').fill('');
  await page.getByRole('dialog').getByLabel('Website name').fill('Acme Store EU');
  await page.getByRole('dialog').getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('heading', { name: 'Acme Store EU' })).toBeVisible();

  // Deactivate → reactivate
  await page.getByRole('button', { name: 'Deactivate' }).click();
  await confirmDialog(page, 'Deactivate');
  await expectToast(page, 'Website deactivated');
  await expect(page.getByText('Inactive', { exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Activate' }).click();
  await confirmDialog(page, 'Activate');
  await expectToast(page, 'Website activated');

  // Site ID was preserved through edits
  await page.getByRole('tab', { name: 'Overview & embed' }).click();
  await expect(page.getByTestId('site-id')).toHaveText(newSiteId);
});

test('project management: create with website, dates and status; edit; progress', async () => {
  const page = ownerPage;
  await page.getByRole('link', { name: 'Projects' }).click();
  await expect(page.getByText('No projects yet')).toBeVisible();
  await page.getByRole('button', { name: 'Create project' }).first().click();
  const d = page.getByRole('dialog', { name: 'Create project' });
  await d.getByLabel('Website').selectOption({ label: 'Acme Store EU' });
  await d.getByLabel('Project name').fill('Checkout QA');
  await d.getByLabel('Start date').fill('2026-11-01');
  await d.getByLabel('Deadline').fill('2026-10-01');
  await d.getByRole('button', { name: 'Create project' }).click();
  await expect(d.getByRole('alert')).toContainText('Deadline must be on or after the start date');
  await d.getByLabel('Deadline').fill('2026-12-31');
  await d.getByRole('button', { name: 'Create project' }).click();
  await expectToast(page, 'Project created');
  const row = page.getByTestId('project-row');
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('Acme Store EU');
  await expect(row).toContainText('0%');

  await page.getByRole('button', { name: 'Edit Checkout QA' }).click();
  await page.getByRole('dialog').getByLabel('Status').selectOption('ON_HOLD');
  await page.getByRole('dialog').getByRole('button', { name: 'Save changes' }).click();
  await expect(row).toContainText('On hold');

  await page.getByPlaceholder('Search projects…').fill('nothing-matches');
  await expect(page.getByText('No projects match your filters')).toBeVisible();
  await page.getByPlaceholder('Search projects…').fill('');
  await expect(row).toHaveCount(1);
});

test('team: invite a developer by email with a project, invitee accepts, roles & projects managed', async ({ browser }) => {
  const page = ownerPage;
  await page.getByRole('link', { name: 'Team Members' }).click();
  await page.getByLabel('Select website').selectOption({ label: 'Acme Store EU' });
  await expect(page.getByTestId('member-row')).toHaveCount(1); // just the owner

  await page.getByRole('button', { name: 'Add developer' }).click();
  const d = page.getByRole('dialog', { name: 'Add developer' });
  await d.getByLabel('Email address').fill(dev.email);
  await expect(d.getByRole('radio', { name: /Developer/ })).toBeChecked();
  await d.getByRole('checkbox', { name: 'Checkout QA' }).check();
  await d.getByRole('button', { name: 'Send invite' }).click();
  await expectToast(page, `Invitation sent to ${dev.email}`);
  await expect(page.getByTestId('pending-invitations')).toContainText(dev.email);

  // Invitee opens the emailed link in their own browser and signs up
  const { ctx, page: devPage } = await newPage(browser);
  await devPage.goto(await linkFromOutbox(dev.email, '/accept-invite'));
  await expect(devPage.getByText('Acme Store EU')).toBeVisible();
  await expect(devPage.getByText('Role: Developer')).toBeVisible();
  await devPage.getByRole('button', { name: 'Create account to accept' }).click();
  await expect(devPage.getByLabel('Email')).toHaveValue(dev.email);
  await devPage.getByLabel('Full name').fill(dev.name);
  await devPage.getByLabel('Password').fill(dev.password);
  await devPage.getByRole('button', { name: 'Create account' }).click();
  await devPage.getByRole('button', { name: 'Accept invitation' }).click();
  await expectToast(devPage, 'You joined Acme Store EU');
  await expect(devPage.getByRole('heading', { name: 'Acme Store EU' })).toBeVisible();
  // Developers can't manage the website
  await expect(devPage.getByRole('button', { name: 'Deactivate' })).toHaveCount(0);
  await ctx.close();

  // Owner sees the new member with the assigned project
  await page.reload();
  const devRow = page.getByTestId('member-row').filter({ hasText: dev.name });
  await expect(devRow).toContainText('Checkout QA');
  await expect(page.getByText('No pending invitations')).toBeVisible();

  // Change role → Project Manager, then back to Developer
  await devRow.getByLabel(`Role for ${dev.name}`).selectOption('PROJECT_MANAGER');
  await expectToast(page, 'Role updated');
  await devRow.getByLabel(`Role for ${dev.name}`).selectOption('DEVELOPER');

  // Assign projects modal: unassign then reassign
  await devRow.getByRole('button', { name: 'Projects' }).click();
  await page.getByRole('dialog').getByRole('checkbox', { name: 'Checkout QA' }).uncheck();
  await page.getByRole('dialog').getByRole('button', { name: 'Save assignments' }).click();
  await expect(devRow).toContainText('None');
  await devRow.getByRole('button', { name: 'Projects' }).click();
  await page.getByRole('dialog').getByRole('checkbox', { name: 'Checkout QA' }).check();
  await page.getByRole('dialog').getByRole('button', { name: 'Save assignments' }).click();
  await expect(devRow).toContainText('Checkout QA');

  // Invite + revoke a website user
  await page.getByRole('button', { name: 'Invite member' }).click();
  await page.getByRole('dialog').getByLabel('Email address').fill('client.reviewer@example.com');
  await page.getByRole('dialog').getByRole('radio', { name: /Website User/ }).check();
  await page.getByRole('dialog').getByRole('button', { name: 'Send invite' }).click();
  await expect(page.getByTestId('pending-invitations')).toContainText('client.reviewer@example.com');
  await page.getByTestId('pending-invitations').getByRole('button', { name: 'Revoke' }).click();
  await confirmDialog(page, 'Revoke');
  await expect(page.getByText('No pending invitations')).toBeVisible();
});

test('tasks: create & assign, filter, update status, comment; developer sees My Tasks', async ({ browser }) => {
  const page = ownerPage;
  await page.getByRole('link', { name: 'All Tasks' }).click();
  await expect(page.getByText('No tasks yet')).toBeVisible();

  const createTask = async (title: string, opts: { priority?: string; due?: string; assignee?: string } = {}) => {
    await page.getByRole('button', { name: 'New task' }).first().click();
    const d = page.getByRole('dialog', { name: 'New task' });
    await d.getByLabel('Project').selectOption({ label: 'Checkout QA — Acme Store EU' });
    await d.getByLabel('Title').fill(title);
    if (opts.priority) await d.getByLabel('Priority').selectOption(opts.priority);
    if (opts.due) await d.getByLabel('Due date').fill(opts.due);
    if (opts.assignee) await d.getByLabel('Assignee').selectOption({ label: opts.assignee });
    await d.getByRole('button', { name: 'Create task' }).click();
    await expect(d).toBeHidden(); // saved (an earlier "Task created" toast may still be showing)
    await expectToast(page, 'Task created');
  };

  await createTask('Payment button misaligned on mobile', { priority: 'URGENT', assignee: dev.name });
  await createTask('Typo in footer', { priority: 'LOW', due: '2026-01-15' }); // overdue
  await createTask('Update hero copy', { assignee: dev.name });
  await expect(page.getByTestId('task-row')).toHaveCount(3);

  // Filters
  await page.getByLabel('Filter by priority').selectOption('URGENT');
  await expect(page.getByTestId('task-row')).toHaveCount(1);
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await page.getByLabel('Overdue only').click();
  await expect(page.getByLabel('Overdue only')).toBeChecked();
  await expect(page.getByTestId('task-row')).toHaveCount(1);
  await expect(page.getByTestId('task-row')).toContainText('Typo in footer');
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await page.getByPlaceholder('Search tasks…').fill('hero');
  await expect(page.getByTestId('task-row')).toHaveCount(1);
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(page.getByTestId('task-row')).toHaveCount(3);

  // Task detail: status + comment
  await page.getByTestId('task-row').filter({ hasText: 'Payment button' }).click();
  const d = page.getByRole('dialog', { name: 'Payment button misaligned on mobile' });
  await d.getByLabel('Status').selectOption('COMPLETED');
  await page.getByRole('dialog', { name: /as completed\?/ }).getByRole('button', { name: 'Mark completed' }).click();
  await expectToast(page, 'Task updated');
  await d.getByLabel('Write a comment').fill('Fixed in release 2.3 — please re-test.');
  await d.getByRole('button', { name: 'Post comment' }).click();
  await expect(d.getByTestId('comment-list')).toContainText('Fixed in release 2.3');
  await d.getByRole('tab', { name: /activity/i }).click();
  await expect(d.getByTestId('activity-list')).toContainText('completed the task');
  await d.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByTestId('task-row').filter({ hasText: 'Payment button' })).toContainText('Completed');

  // Developer: My Tasks + notification
  const { ctx, page: devPage } = await newPage(browser);
  await login(devPage, dev.email, dev.password);
  await devPage.getByRole('link', { name: 'My Tasks' }).click();
  await expect(devPage.getByTestId('task-row')).toHaveCount(2);
  await devPage.getByRole('link', { name: /^Notifications/ }).first().click();
  await expect(devPage.getByTestId('notification-list')).toContainText('You were assigned: Payment button misaligned on mobile');
  await expect(devPage.getByTestId('notification-list')).toContainText('New comment on Payment button');
  await devPage.getByRole('button', { name: 'Mark all as read' }).click();
  await expectToast(devPage, 'All notifications marked as read');
  await devPage.getByRole('button', { name: 'Unread' }).click();
  await expect(devPage.getByText("You're all caught up")).toBeVisible();
  // Developers can't open the platform Users page
  await devPage.goto('/users');
  await expect(devPage.getByText('Access restricted')).toBeVisible();
  await ctx.close();
});

test('dashboard reflects real data; comments page; performance', async () => {
  const page = ownerPage;
  await page.getByRole('link', { name: 'Dashboard' }).click();
  await expect(statValue(page, 'Total Websites')).toHaveText('2');
  await expect(statValue(page, 'Total Projects')).toHaveText('1');
  await expect(statValue(page, 'Total Users')).toHaveText('2');
  await expect(statValue(page, 'Total Tasks')).toHaveText('3');
  await expect(statValue(page, 'Open Tasks')).toHaveText('2');
  await expect(statValue(page, 'Completed Tasks')).toHaveText('1');
  await expect(statValue(page, 'Overdue Tasks')).toHaveText('1');
  await expect(page.getByTestId('recent-activity')).toContainText('Payment button misaligned on mobile');

  // Website filter narrows statistics
  await page.getByLabel('Filter dashboard by website').selectOption({ label: 'Blog' });
  await expect(statValue(page, 'Total Tasks')).toHaveText('0');
  await page.getByLabel('Filter dashboard by website').selectOption('');

  // Card deep-links into the filtered task list
  await page.getByTestId('stat-overdue-tasks').click();
  await expect(page).toHaveURL(/\/tasks\?overdue=true/);
  await expect(page.getByTestId('task-row')).toHaveCount(1);

  await page.getByRole('link', { name: 'Comments' }).click();
  await expect(page.getByTestId('comments-feed')).toContainText('Fixed in release 2.3');
  await page.getByPlaceholder('Search comments…').fill('zzz');
  await expect(page.getByText('No comments found')).toBeVisible();

  await page.getByRole('link', { name: 'Team Members' }).click();
  await page.getByLabel('Select website').selectOption({ label: 'Acme Store EU' });
  await page.getByRole('tab', { name: 'Performance' }).click();
  const perf = page.getByTestId('performance-row').filter({ hasText: dev.name });
  await expect(perf).toContainText('50%'); // 1 of 2 assigned tasks completed
});

test('super admin: platform users, suspend and reactivate', async ({ browser }) => {
  const { ctx, page } = await newPage(browser);
  await login(page, SUPER_ADMIN.email, SUPER_ADMIN.password);
  await expect(page.getByText('Platform-wide overview')).toBeVisible();
  await expect(statValue(page, 'Total Users')).toHaveText('3');
  await page.getByRole('link', { name: 'Users', exact: true }).click();
  await expect(page.getByTestId('user-row')).toHaveCount(3);
  await page.getByPlaceholder('Search name or email…').fill('dev');
  await expect(page.getByTestId('user-row')).toHaveCount(1);
  const row = page.getByTestId('user-row');
  await row.getByRole('button', { name: 'Suspend' }).click();
  await confirmDialog(page, 'Suspend');
  await expect(row).toContainText('Suspended');

  // Suspended developer cannot sign in
  const { ctx: devCtx, page: devPage } = await newPage(browser);
  await devPage.goto('/login');
  await devPage.getByLabel('Email').fill(dev.email);
  await devPage.getByLabel('Password').fill(dev.password);
  await devPage.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(devPage.getByRole('alert')).toHaveText('Account is suspended');
  await devCtx.close();

  await row.getByRole('button', { name: 'Reactivate' }).click();
  await confirmDialog(page, 'Reactivate');
  await expect(row).toContainText('Active');

  // Super admin can open any website
  await page.getByRole('link', { name: 'Websites' }).click();
  await expect(page.getByTestId('website-row')).toHaveCount(2);
  await ctx.close();
});

test('settings: profile update and sessions', async () => {
  const page = ownerPage;
  await page.getByRole('link', { name: 'Settings' }).click();
  await page.getByLabel('Full name').fill('Olivia O. Owner');
  await page.getByRole('button', { name: 'Save profile' }).click();
  await expectToast(page, 'Profile updated');
  await expect(page.getByRole('button', { name: 'Account menu' })).toContainText('Olivia O. Owner');
  await expect(page.getByTestId('session-row').filter({ hasText: 'This device' })).toHaveCount(1);
});

test('deletes require confirmation: project, then website', async () => {
  const page = ownerPage;
  await page.getByRole('link', { name: 'Projects' }).click();
  await page.getByRole('button', { name: 'Delete Checkout QA' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByTestId('project-row')).toHaveCount(1);
  await page.getByRole('button', { name: 'Delete Checkout QA' }).click();
  await confirmDialog(page, 'Delete project');
  await expectToast(page, 'Project deleted');
  await expect(page.getByText('No projects yet')).toBeVisible();

  await page.goto(websiteUrlPath);
  await page.getByRole('button', { name: 'Delete' }).click();
  await confirmDialog(page, 'Delete website');
  await expect(page).toHaveURL(/\/websites$/);
  await expect(page.getByTestId('website-row')).toHaveCount(1);
});

test('responsive: mobile layout uses a slide-out sidebar', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, storageState: await ownerCtx.storageState() });
  const page = await ctx.newPage();
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeHidden();
  await page.getByRole('button', { name: 'Open menu' }).click();
  await page.getByRole('link', { name: 'Websites' }).click();
  await expect(page.getByRole('heading', { name: 'Websites' })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(overflow).toBe(false);
  await ctx.close();
});
