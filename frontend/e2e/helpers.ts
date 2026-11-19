import fs from 'node:fs';
import path from 'node:path';
import { expect, type Page } from '@playwright/test';
import { OUTBOX_DIR } from './env';

/** Waits for an email to `to` in the backend dev outbox and returns the app-relative link (path + token). */
export const linkFromOutbox = async (to: string, pathname: '/verify-email' | '/reset-password' | '/accept-invite') => {
  const deadline = Date.now() + 10_000;
  const re = new RegExp(`${pathname.replace('/', '\\/')}\\?token=([A-Za-z0-9_-]+)`);
  while (Date.now() < deadline) {
    if (fs.existsSync(OUTBOX_DIR)) {
      const files = fs
        .readdirSync(OUTBOX_DIR)
        .sort()
        .reverse()
        .map((f) => fs.readFileSync(path.join(OUTBOX_DIR, f), 'utf8'));
      const mail = files.find((html) => html.startsWith(`<!-- To: ${to} |`) && re.test(html));
      if (mail) return `${pathname}?token=${mail.match(re)![1]}`;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`No ${pathname} email for ${to}`);
};

export const unique = (prefix: string) => `${prefix}.${Date.now()}.${Math.floor(Math.random() * 1e4)}@example.com`;

export const expectToast = async (page: Page, text: string | RegExp) => {
  await expect(page.locator('[data-sonner-toast]').filter({ hasText: text }).first()).toBeVisible();
};

export const statValue = (page: Page, label: string) =>
  page.getByTestId(`stat-${label.toLowerCase().replace(/\s+/g, '-')}`).locator('[data-value]');

export const login = async (page: Page, email: string, password: string) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
};

/** Confirms the currently open confirmation dialog. */
export const confirmDialog = async (page: Page, button: string | RegExp) => {
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: button }).click();
  await expect(dialog).toBeHidden();
};
