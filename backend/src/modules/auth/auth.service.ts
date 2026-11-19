import { AuthTokenType, Prisma, type User } from '@prisma/client';
import { env } from '../../config/env';
import { prisma } from '../../lib/prisma';
import { generateToken, sha256 } from '../../lib/crypto';
import { hashPassword, verifyDummyPassword, verifyPassword } from '../../lib/password';
import { AppError, badRequest, conflict, forbidden, unauthorized } from '../../lib/errors';
import type { ClientMeta } from '../../lib/http';
import {
  passwordChangedEmail,
  passwordResetEmail,
  queueMail,
  verificationEmail,
} from '../../lib/mailer';
import { selfUserSelect, toSelfProfile } from '../users/user.serializer';
import { createSession, revokeAllSessions, type IssuedSession } from './session.service';

/** Where the new session will be used: the dashboard (default) or one website's review widget. */
export interface SessionTarget {
  widgetWebsiteId?: string;
}

const sessionFor = (
  user: Pick<User, 'id' | 'role'>,
  meta: ClientMeta,
  method: 'password' | 'google',
  target?: SessionTarget,
) =>
  target?.widgetWebsiteId
    ? createSession(user, meta, method === 'password' ? 'widget-password' : 'widget-google', target.widgetWebsiteId)
    : createSession(user, meta, method);

const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MINUTES = 15;

export interface AuthResult {
  user: ReturnType<typeof toSelfProfile>;
  session: IssuedSession;
}

const loadProfile = async (userId: string) =>
  toSelfProfile(await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: selfUserSelect }));

// ───────────────────────────── Single-use tokens ─────────────────────────────

/**
 * Password-reset links: only the most recent one is valid (a new request cancels older ones).
 * Email-verification links: every unexpired link stays valid until one is used. Emails can
 * arrive out of order, so cancelling older links made people open a dead link; they only
 * prove access to the same mailbox, so keeping them valid is safe.
 */
const issueAuthToken = async (userId: string, type: AuthTokenType, ttlMs: number): Promise<string> => {
  const token = generateToken(32);
  await prisma.$transaction([
    ...(type === AuthTokenType.PASSWORD_RESET
      ? [prisma.authToken.updateMany({ where: { userId, type, usedAt: null }, data: { usedAt: new Date() } })]
      : []),
    prisma.authToken.create({
      data: { userId, type, tokenHash: sha256(token), expiresAt: new Date(Date.now() + ttlMs) },
    }),
  ]);
  return token;
};

/** Atomically consumes a token; throws if it is unknown, used, or expired. */
const consumeAuthToken = async (token: string, type: AuthTokenType) => {
  const tokenHash = sha256(token);
  const record = await prisma.authToken.findUnique({ where: { tokenHash } });
  if (!record || record.type !== type || record.usedAt || record.expiresAt <= new Date()) {
    throw badRequest('This link is invalid or has expired', 'INVALID_TOKEN');
  }
  const consumed = await prisma.authToken.updateMany({
    where: { id: record.id, usedAt: null },
    data: { usedAt: new Date() },
  });
  if (consumed.count !== 1) throw badRequest('This link is invalid or has expired', 'INVALID_TOKEN');
  return record;
};

export const sendVerificationEmail = async (user: Pick<User, 'id' | 'email' | 'name'>) => {
  const token = await issueAuthToken(
    user.id,
    AuthTokenType.EMAIL_VERIFICATION,
    env.EMAIL_VERIFICATION_TTL_HOURS * 60 * 60 * 1000,
  );
  queueMail(verificationEmail(user.email, user.name, token));
};

// ───────────────────────────── Registration & login ─────────────────────────────

export const register = async (
  input: { email: string; password: string; name: string },
  meta: ClientMeta,
  target?: SessionTarget,
): Promise<AuthResult> => {
  const existing = await prisma.user.findUnique({ where: { email: input.email }, select: { id: true } });
  if (existing) throw conflict('An account with this email already exists', 'EMAIL_TAKEN');

  const passwordHash = await hashPassword(input.password);
  let user: User;
  try {
    user = await prisma.user.create({
      data: { email: input.email, name: input.name, passwordHash, lastLoginAt: new Date() },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw conflict('An account with this email already exists', 'EMAIL_TAKEN');
    }
    throw err;
  }

  await sendVerificationEmail(user);
  const session = await sessionFor(user, meta, 'password', target);
  return { user: await loadProfile(user.id), session };
};

export const login = async (
  input: { email: string; password: string },
  meta: ClientMeta,
  target?: SessionTarget,
): Promise<AuthResult> => {
  const user = await prisma.user.findUnique({ where: { email: input.email } });
  const invalid = () => unauthorized('Invalid email or password', 'INVALID_CREDENTIALS');

  if (!user || !user.passwordHash) {
    await verifyDummyPassword(input.password);
    throw invalid();
  }

  if (user.lockedUntil && user.lockedUntil > new Date()) {
    // Still burn the hashing time so a locked account isn't distinguishable by timing.
    await verifyDummyPassword(input.password);
    throw new AppError(
      423,
      'ACCOUNT_LOCKED',
      'Too many failed sign-in attempts. Try again later or reset your password.',
    );
  }

  const ok = await verifyPassword(user.passwordHash, input.password);
  if (!ok) {
    const attempts = user.failedLoginAttempts + 1;
    const lock = attempts >= MAX_FAILED_LOGINS;
    await prisma.user.update({
      where: { id: user.id },
      data: {
        failedLoginAttempts: lock ? 0 : attempts,
        lockedUntil: lock ? new Date(Date.now() + LOCKOUT_MINUTES * 60 * 1000) : user.lockedUntil,
      },
    });
    throw invalid();
  }

  if (user.status !== 'ACTIVE') throw forbidden('Account is suspended', 'ACCOUNT_SUSPENDED');

  await prisma.user.update({
    where: { id: user.id },
    data: { failedLoginAttempts: 0, lockedUntil: null, lastLoginAt: new Date() },
  });
  const session = await sessionFor(user, meta, 'password', target);
  return { user: await loadProfile(user.id), session };
};

// ───────────────────────────── Email verification ─────────────────────────────

export const verifyEmail = async (token: string) => {
  const record = await consumeAuthToken(token, AuthTokenType.EMAIL_VERIFICATION);
  await prisma.$transaction([
    prisma.user.updateMany({ where: { id: record.userId, emailVerifiedAt: null }, data: { emailVerifiedAt: new Date() } }),
    // Verified: retire the user's other outstanding verification links.
    prisma.authToken.updateMany({
      where: { userId: record.userId, type: AuthTokenType.EMAIL_VERIFICATION, usedAt: null },
      data: { usedAt: new Date() },
    }),
  ]);
  return loadProfile(record.userId);
};

export const resendVerification = async (userId: string) => {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (user.emailVerifiedAt) throw badRequest('Email is already verified', 'ALREADY_VERIFIED');
  // Short cooldown: the previous email may simply not have arrived yet.
  const last = await prisma.authToken.findFirst({
    where: { userId, type: AuthTokenType.EMAIL_VERIFICATION },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  });
  const waitMs = last ? last.createdAt.getTime() + env.VERIFICATION_RESEND_COOLDOWN_SECONDS * 1000 - Date.now() : 0;
  if (waitMs > 0) {
    const seconds = Math.ceil(waitMs / 1000);
    throw new AppError(
      429,
      'RESEND_TOO_SOON',
      `We just sent you an email. Please check your inbox (and spam) — you can request another in ${seconds} seconds.`,
      { retryAfterSeconds: seconds },
    );
  }
  await sendVerificationEmail(user);
};

// ───────────────────────────── Password reset ─────────────────────────────

/** Always resolves the same way whether or not the email exists (no account enumeration). */
export const forgotPassword = async (email: string) => {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || user.status !== 'ACTIVE') return;
  const token = await issueAuthToken(
    user.id,
    AuthTokenType.PASSWORD_RESET,
    env.PASSWORD_RESET_TTL_MINUTES * 60 * 1000,
  );
  queueMail(passwordResetEmail(user.email, user.name, token));
};

export const resetPassword = async (token: string, newPassword: string) => {
  const record = await consumeAuthToken(token, AuthTokenType.PASSWORD_RESET);
  const passwordHash = await hashPassword(newPassword);
  const user = await prisma.user.update({
    where: { id: record.userId },
    data: { passwordHash, passwordChangedAt: new Date(), failedLoginAttempts: 0, lockedUntil: null },
  });
  // Completing a reset proves ownership of the mailbox.
  await prisma.user.updateMany({
    where: { id: user.id, emailVerifiedAt: null },
    data: { emailVerifiedAt: new Date() },
  });
  // Sign out every existing session: whoever had the old password is kicked out.
  await revokeAllSessions(user.id);
  queueMail(passwordChangedEmail(user.email, user.name));
};

export const changePassword = async (
  userId: string,
  currentSessionId: string,
  input: { currentPassword?: string; newPassword: string },
) => {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (user.passwordHash) {
    if (!input.currentPassword || !(await verifyPassword(user.passwordHash, input.currentPassword))) {
      throw badRequest('Current password is incorrect', 'INVALID_CURRENT_PASSWORD');
    }
  }
  await prisma.user.update({
    where: { id: userId },
    data: { passwordHash: await hashPassword(input.newPassword), passwordChangedAt: new Date() },
  });
  await revokeAllSessions(userId, currentSessionId);
  queueMail(passwordChangedEmail(user.email, user.name));
};

// ───────────────────────────── Google ─────────────────────────────

export interface GoogleProfile {
  sub: string;
  email: string;
  emailVerified: boolean;
  name?: string;
  picture?: string;
}

/**
 * Signs in with a profile *already verified* by Google (see google.service.ts):
 *  1. existing user linked to this Google account → sign in
 *  2. existing user with the same (Google-verified) email → link the Google account, sign in
 *  3. otherwise → create a new, email-verified user without a password
 */
export const loginWithGoogleProfile = async (
  profile: GoogleProfile,
  meta: ClientMeta,
  target?: SessionTarget,
): Promise<AuthResult> => {
  if (!profile.emailVerified) {
    throw forbidden('Your Google account email is not verified', 'GOOGLE_EMAIL_UNVERIFIED');
  }
  const email = profile.email.trim().toLowerCase();

  let user = await prisma.user.findUnique({ where: { googleId: profile.sub } });
  if (!user) {
    const byEmail = await prisma.user.findUnique({ where: { email } });
    if (byEmail) {
      if (byEmail.googleId && byEmail.googleId !== profile.sub) {
        throw conflict('This email is linked to a different Google account', 'GOOGLE_ACCOUNT_MISMATCH');
      }
      user = await prisma.user.update({
        where: { id: byEmail.id },
        data: {
          googleId: profile.sub,
          emailVerifiedAt: byEmail.emailVerifiedAt ?? new Date(),
          avatarUrl: byEmail.avatarUrl ?? profile.picture ?? null,
        },
      });
    } else {
      user = await prisma.user.create({
        data: {
          email,
          googleId: profile.sub,
          name: (profile.name?.trim() || email.split('@')[0]!).slice(0, 120),
          avatarUrl: profile.picture?.slice(0, 2048) ?? null,
          emailVerifiedAt: new Date(),
        },
      });
    }
  }

  if (user.status !== 'ACTIVE') throw forbidden('Account is suspended', 'ACCOUNT_SUSPENDED');

  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  const session = await sessionFor(user, meta, 'google', target);
  return { user: await loadProfile(user.id), session };
};

export const getProfile = loadProfile;
