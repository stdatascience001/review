import path from 'node:path';
import dotenv from 'dotenv';
import { z } from 'zod';

// Load apps/api/.env (if present). Variables already set in the real environment win.
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const bool = (def: boolean) =>
  z
    .enum(['true', 'false', '1', '0', ''])
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : v === 'true' || v === '1'));

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== '' ? v.trim() : undefined));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  API_URL: z.string().url().default('http://localhost:4000'),
  APP_URL: z.string().url().default('http://localhost:3000'),
  CORS_ORIGINS: z.string().default('http://localhost:3000'),
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  ACCESS_TOKEN_TTL_MINUTES: z.coerce.number().int().positive().default(15),
  SESSION_TTL_DAYS: z.coerce.number().int().positive().default(30),
  EMAIL_VERIFICATION_TTL_HOURS: z.coerce.number().int().positive().default(24),
  PASSWORD_RESET_TTL_MINUTES: z.coerce.number().int().positive().default(60),
  // Minimum time between "resend verification email" requests
  VERIFICATION_RESEND_COOLDOWN_SECONDS: z.coerce.number().int().min(0).default(60),
  REQUIRE_EMAIL_VERIFICATION: bool(true),
  COOKIE_SECURE: bool(false),
  COOKIE_DOMAIN: optionalString,

  GOOGLE_CLIENT_ID: optionalString,
  GOOGLE_CLIENT_SECRET: optionalString,
  GOOGLE_REDIRECT_URI: optionalString,

  SMTP_HOST: optionalString,
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_SECURE: bool(false),
  SMTP_USER: optionalString,
  SMTP_PASS: optionalString,
  EMAIL_FROM: optionalString,
  SMTP_FROM: optionalString, // alias accepted for EMAIL_FROM
  LEAD_NOTIFY_TO: optionalString, // internal address for lead/admin notifications

  // Public URL of the review widget loader (defaults to ${API_URL}/widget.js).
  EMBED_SCRIPT_URL: optionalString,
  // Built widget files (widget.js + widget-app/) served by this API; defaults to ../widget/dist.
  WIDGET_DIST_DIR: optionalString,
  // Where uploaded files (task screenshots) are stored; defaults to backend/storage/uploads.
  UPLOAD_DIR: optionalString,
  MAX_UPLOAD_MB: z.coerce.number().positive().max(25).default(10),
  // Optional: serve the built admin dashboard (frontend/dist) from this server (single origin).
  FRONTEND_DIST_DIR: optionalString,
  // Empty = default (debug in development, info in production)
  LOG_LEVEL: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).optional(),
  ),
  INVITATION_TTL_DAYS: z.coerce.number().int().positive().default(7),
  // Domain verification fetches the customer's site; private addresses are refused unless this is set.
  ALLOW_PRIVATE_NETWORK_FETCH: bool(false),

  RATE_LIMIT_WINDOW_MINUTES: z.coerce.number().int().positive().default(15),
  // Per IP: one office behind a NAT, or one developer with many dashboard/widget tabs, shares it.
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(3000),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(20),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
  // Fail fast: never boot with an invalid or insecure configuration.
  throw new Error(`Invalid environment configuration:\n${issues}`);
}

const e = parsed.data;

if (e.NODE_ENV === 'production') {
  if (!e.COOKIE_SECURE) throw new Error('COOKIE_SECURE must be true in production');
  if (!e.SMTP_HOST) throw new Error('SMTP_HOST must be configured in production');
  // Public URLs must be https (localhost is allowed for local production smoke tests).
  for (const [key, value] of [['API_URL', e.API_URL], ['APP_URL', e.APP_URL]] as const) {
    const u = new URL(value);
    if (u.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(u.hostname)) {
      throw new Error(`${key} must use https:// in production`);
    }
  }
  if (e.ALLOW_PRIVATE_NETWORK_FETCH) throw new Error('ALLOW_PRIVATE_NETWORK_FETCH must be false in production');
}

export const env = {
  ...e,
  EMAIL_FROM: e.EMAIL_FROM ?? e.SMTP_FROM ?? 'Website Review <no-reply@example.com>',
  isProd: e.NODE_ENV === 'production',
  isTest: e.NODE_ENV === 'test',
  corsOrigins: e.CORS_ORIGINS.split(',')
    .map((o) => o.trim().replace(/\/$/, ''))
    .filter(Boolean),
  embedScriptUrl: e.EMBED_SCRIPT_URL ?? `${e.API_URL.replace(/\/$/, '')}/widget.js`,
  widgetDistDir: path.resolve(e.WIDGET_DIST_DIR ?? path.resolve(__dirname, '../../../widget/dist')),
  uploadDir: path.resolve(e.UPLOAD_DIR ?? path.resolve(__dirname, '../../storage/uploads')),
  googleEnabled: Boolean(e.GOOGLE_CLIENT_ID && e.GOOGLE_CLIENT_SECRET),
  googleRedirectUri: e.GOOGLE_REDIRECT_URI ?? `${e.API_URL.replace(/\/$/, '')}/api/v1/auth/google/callback`,
};

export type Env = typeof env;
