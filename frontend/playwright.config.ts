import { defineConfig, devices } from '@playwright/test';
import { API_PORT, API_URL, APP_PORT, APP_URL, BACKEND_DIR, DEMO_PORT, DEMO_URL, ROOT_DIR, backendEnv } from './e2e/env';

/**
 * End-to-end tests drive the real React app in Chromium against the real backend and a
 * dedicated PostgreSQL database (wrtm_e2e). The review widget is built and tested on a
 * separate demo website (127.0.0.1:5600, a different origin). All servers start automatically.
 */
export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: {
    baseURL: APP_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    permissions: ['clipboard-read', 'clipboard-write'],
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      // Migrate + empty the dedicated e2e database, seed the super admin, then start the API.
      command: 'npx prisma migrate deploy && npx tsx tests/e2e-prepare.ts && npx tsx prisma/seed.ts && npx tsx src/server.ts',
      cwd: BACKEND_DIR,
      url: `http://localhost:${API_PORT}/api/v1/health`,
      env: backendEnv(),
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: `npx vite --port ${APP_PORT} --strictPort`,
      url: APP_URL,
      env: { VITE_API_PROXY_TARGET: `http://localhost:${API_PORT}`, PORT: String(APP_PORT) },
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      // Build the widget (served by the backend at /widget.js), then start the demo customer site.
      command: 'pnpm --dir widget build && node demo-site/server.mjs',
      cwd: ROOT_DIR,
      url: `${DEMO_URL}/`,
      env: { PORT: String(DEMO_PORT), HOST: '127.0.0.1', DEMO_ALLOW_CONFIG: '1', WIDGET_SRC: `${API_URL}/widget.js` },
      reuseExistingServer: false,
      timeout: 180_000,
    },
  ],
});
