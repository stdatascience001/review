import crypto from 'node:crypto';
import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';
import { BACKEND_DIR, ROOT_DIR, e2eDatabaseUrl } from './e2e/env';

/**
 * Production smoke test: the *built* app (`pnpm build`) run the way it is deployed —
 * NODE_ENV=production, `node dist/server.js`, the dashboard and widget served by the same
 * Node process (single origin), Secure cookies, production CSP, real-time over WebSocket.
 *
 *   pnpm build && pnpm --filter @wrtm/frontend test:prod
 */
export const PROD_PORT = 4200;
export const PROD_URL = `http://localhost:${PROD_PORT}`;
export const PROD_DEMO_PORT = 5700;
export const PROD_ADMIN = { email: 'admin.prod-smoke@example.com', password: 'Prod-smoke-admin-2026' };

const prodDatabaseUrl = () => {
  const url = new URL(e2eDatabaseUrl());
  url.pathname = '/wrtm_e2e_prod';
  return url.toString();
};

const prodEnv = (): Record<string, string> => ({
  NODE_ENV: 'production',
  PORT: String(PROD_PORT),
  API_URL: PROD_URL,
  APP_URL: PROD_URL,
  CORS_ORIGINS: PROD_URL,
  DATABASE_URL: prodDatabaseUrl(),
  JWT_ACCESS_SECRET: crypto.randomBytes(48).toString('base64url'),
  COOKIE_SECURE: 'true', // Chrome accepts Secure cookies on http://localhost
  SMTP_HOST: '127.0.0.1',
  SMTP_PORT: '2525',
  SMTP_USER: '',
  SMTP_PASS: '',
  EMAIL_FROM: 'Website Review <no-reply@example.com>',
  GOOGLE_CLIENT_ID: '',
  GOOGLE_CLIENT_SECRET: '',
  FRONTEND_DIST_DIR: path.join(ROOT_DIR, 'frontend', 'dist'),
  UPLOAD_DIR: path.join(BACKEND_DIR, 'storage', 'prod-smoke'),
  ALLOW_PRIVATE_NETWORK_FETCH: 'false',
  SEED_ADMIN_EMAIL: PROD_ADMIN.email,
  SEED_ADMIN_PASSWORD: PROD_ADMIN.password,
  SEED_ADMIN_NAME: 'Prod Admin',
});

export default defineConfig({
  testDir: './e2e-prod',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: { baseURL: PROD_URL, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'npx prisma migrate deploy && npx tsx tests/e2e-prepare.ts && npx tsx prisma/seed.ts && node dist/server.js',
      cwd: BACKEND_DIR,
      url: `${PROD_URL}/api/v1/health`,
      env: prodEnv(),
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: 'node demo-site/server.mjs',
      cwd: ROOT_DIR,
      url: `http://127.0.0.1:${PROD_DEMO_PORT}/`,
      env: { PORT: String(PROD_DEMO_PORT), HOST: '127.0.0.1', DEMO_ALLOW_CONFIG: '1', WIDGET_SRC: `${PROD_URL}/widget.js` },
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
});
