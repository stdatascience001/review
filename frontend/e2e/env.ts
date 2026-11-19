import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Shared settings for the end-to-end run (isolated ports + database). */
export const BACKEND_DIR = path.resolve(HERE, '../../backend');
export const OUTBOX_DIR = path.join(BACKEND_DIR, '.mail-outbox');
export const API_PORT = 4100;
export const APP_PORT = 3100;
export const APP_URL = `http://localhost:${APP_PORT}`;
export const API_URL = `http://localhost:${API_PORT}`;
/** Separate demo customer website (different origin) where the widget is installed. */
export const DEMO_PORT = 5600;
export const DEMO_URL = `http://127.0.0.1:${DEMO_PORT}`;
export const ROOT_DIR = path.resolve(HERE, '../..');
export const SUPER_ADMIN = { email: 'superadmin.e2e@example.com', password: 'SuperAdmin-e2e-2026', name: 'Platform Admin' };

const readEnvFile = (file: string): Record<string, string> => {
  if (!fs.existsSync(file)) return {};
  return Object.fromEntries(
    fs
      .readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .filter((l) => /^[A-Z0-9_]+=/.test(l))
      .map((l) => {
        const i = l.indexOf('=');
        return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, '')];
      }),
  );
};

/** Same PostgreSQL server as the backend's DATABASE_URL, separate "wrtm_e2e" database. */
export const e2eDatabaseUrl = () => {
  const base = process.env.E2E_DATABASE_URL ?? readEnvFile(path.join(BACKEND_DIR, '.env')).DATABASE_URL;
  if (!base) throw new Error('Set E2E_DATABASE_URL or backend/.env DATABASE_URL');
  if (process.env.E2E_DATABASE_URL) return base;
  const url = new URL(base);
  url.pathname = '/wrtm_e2e';
  return url.toString();
};

export const backendEnv = (): Record<string, string> => ({
  NODE_ENV: 'development',
  PORT: String(API_PORT),
  API_URL: `http://localhost:${API_PORT}`,
  APP_URL,
  CORS_ORIGINS: APP_URL,
  DATABASE_URL: e2eDatabaseUrl(),
  // Emails go to backend/.mail-outbox so the tests can open verification/invite links.
  SMTP_HOST: '',
  // Format-valid client so the Google button is enabled; the test intercepts the redirect to Google.
  GOOGLE_CLIENT_ID: 'e2e-client-id.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'e2e-client-secret',
  GOOGLE_REDIRECT_URI: '',
  // Domain verification fetches a local test server.
  ALLOW_PRIVATE_NETWORK_FETCH: 'true',
  SEED_ADMIN_EMAIL: SUPER_ADMIN.email,
  SEED_ADMIN_PASSWORD: SUPER_ADMIN.password,
  SEED_ADMIN_NAME: SUPER_ADMIN.name,
  UPLOAD_DIR: path.join(BACKEND_DIR, 'storage', 'e2e-uploads'),
  RATE_LIMIT_MAX: '100000',
  AUTH_RATE_LIMIT_MAX: '100000',
});
