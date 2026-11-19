import crypto from 'node:crypto';

/** Cryptographically secure, URL-safe random token. */
export const generateToken = (bytes = 32): string => crypto.randomBytes(bytes).toString('base64url');

/** SHA-256 hex digest. Tokens are stored hashed so a database leak does not expose live tokens. */
export const sha256 = (value: string): string => crypto.createHash('sha256').update(value).digest('hex');

/** PKCE S256 code challenge. */
export const pkceChallenge = (verifier: string): string =>
  crypto.createHash('sha256').update(verifier).digest('base64url');

export const safeEqual = (a: string, b: string): boolean => {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
};
