import type { Request } from 'express';

export interface ClientMeta {
  ipAddress: string | null;
  userAgent: string | null;
}

export const clientMeta = (req: Request): ClientMeta => ({
  ipAddress: (req.ip ?? '').slice(0, 64) || null,
  userAgent: (req.get('user-agent') ?? '').slice(0, 512) || null,
});

/** Accept only same-site relative paths, to prevent open redirects. */
export const safeRedirectPath = (value: unknown): string => {
  if (typeof value !== 'string') return '/';
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return '/';
  return value.slice(0, 512);
};
