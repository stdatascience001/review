import request from 'supertest';
import type { Express } from 'express';
import { createApp, type AppOptions } from '../src/app';
import { devOutbox } from '../src/lib/mailer';
import { prisma } from '../src/lib/prisma';

export const API = '/api/v1';
export const PASSWORD = 'Sup3rSecret!pw';

export const makeApp = (options?: AppOptions): Express => createApp(options);

/** Wipes every table (users/websites cascade to everything else). */
export const resetDb = async () => {
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "users", "websites", "audit_logs" RESTART IDENTITY CASCADE');
  devOutbox.length = 0;
};

let counter = 0;
export const uniqueEmail = (prefix = 'user') => `${prefix}.${Date.now()}.${++counter}@example.com`;

/** Last token emailed to `to` whose link path matches (e.g. "/verify-email"). */
export const tokenFromOutbox = (to: string, pathname: '/verify-email' | '/reset-password' | '/accept-invite'): string => {
  const mail = [...devOutbox].reverse().find((m) => m.to === to && m.text.includes(pathname));
  if (!mail) throw new Error(`No ${pathname} email found for ${to}`);
  const match = mail.text.match(/token=([A-Za-z0-9_-]+)/);
  if (!match?.[1]) throw new Error('Token not found in email');
  return match[1];
};

export interface TestUser {
  id: string;
  email: string;
  agent: ReturnType<typeof request.agent>;
}

/** Registers a user through the real API (agent keeps the auth cookies) and optionally verifies the email. */
export const signUp = async (
  app: Express,
  opts: { name?: string; verify?: boolean; email?: string } = {},
): Promise<TestUser> => {
  const agent = request.agent(app);
  const email = opts.email ?? uniqueEmail(opts.name?.toLowerCase().replace(/\W+/g, '') ?? 'user');
  const res = await agent.post(`${API}/auth/register`).send({ email, password: PASSWORD, name: opts.name ?? 'Test User' });
  if (res.status !== 201) throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`);
  if (opts.verify !== false) {
    const v = await agent.post(`${API}/auth/verify-email`).send({ token: tokenFromOutbox(email, '/verify-email') });
    if (v.status !== 200) throw new Error(`verify failed: ${v.status} ${JSON.stringify(v.body)}`);
  }
  return { id: res.body.data.user.id, email, agent };
};

export const cookieNames = (res: request.Response): string[] => {
  const raw = res.headers['set-cookie'] as unknown as string[] | string | undefined;
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return list.map((c) => c.split('=')[0]!);
};

export const rawCookies = (res: request.Response): string[] => {
  const raw = res.headers['set-cookie'] as unknown as string[] | string | undefined;
  return Array.isArray(raw) ? raw : raw ? [raw] : [];
};

export { prisma, request };
