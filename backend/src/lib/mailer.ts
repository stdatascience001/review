import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import nodemailer, { type Transporter } from 'nodemailer';
import { env } from '../config/env';
import { logger } from './logger';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/**
 * In development/test without SMTP configured, messages are kept in memory and written to
 * apps/api/.mail-outbox/ so links (verification, password reset) can be opened locally.
 * In production SMTP is mandatory (enforced in config/env.ts).
 */
export const devOutbox: (MailMessage & { sentAt: Date })[] = [];
const OUTBOX_DIR = path.resolve(__dirname, '../../.mail-outbox');

let transporter: Transporter | undefined;
const getTransporter = () => {
  if (!env.SMTP_HOST) return undefined;
  transporter ??= nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
  });
  return transporter;
};

export const sendMail = async (message: MailMessage): Promise<void> => {
  const smtp = getTransporter();
  if (smtp) {
    try {
      await smtp.sendMail({ from: env.EMAIL_FROM, ...message });
      logger.info({ to: message.to, subject: message.subject }, 'email sent');
      return;
    } catch (err) {
      if (env.isProd) throw err;
      // Development: keep working locally even if SMTP credentials are wrong.
      logger.error({ err, to: message.to }, 'SMTP send failed; falling back to dev outbox');
    }
  }
  await writeToOutbox(message);
};

const writeToOutbox = async (message: MailMessage): Promise<void> => {
  devOutbox.push({ ...message, sentAt: new Date() });
  if (devOutbox.length > 200) devOutbox.shift();
  if (env.isTest) return;

  try {
    await fs.mkdir(OUTBOX_DIR, { recursive: true });
    // Random part: two emails with the same subject in the same millisecond must not overwrite each other.
    const unique = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const file = path.join(OUTBOX_DIR, `${unique}-${message.subject.replace(/[^a-z0-9]+/gi, '-')}.html`);
    await fs.writeFile(file, `<!-- To: ${message.to} | Subject: ${message.subject} -->\n${message.html}`);
    logger.info({ to: message.to, subject: message.subject, file }, 'email written to dev outbox');
  } catch (err) {
    logger.warn({ err }, 'failed to write dev outbox email');
  }
};

/** Fire-and-forget wrapper: email delivery problems must never break the API request. */
export const queueMail = (message: MailMessage): void => {
  sendMail(message).catch((err) => logger.error({ err, to: message.to }, 'failed to send email'));
};

// ───────────────────────────── Templates ─────────────────────────────

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const layout = (title: string, body: string, cta?: { label: string; url: string }) => `<!doctype html>
<html><body style="font-family:Arial,Helvetica,sans-serif;background:#f5f6f8;padding:24px;color:#1f2937">
<table role="presentation" width="100%" style="max-width:560px;margin:auto;background:#fff;border-radius:8px;padding:32px">
<tr><td>
<h1 style="font-size:20px;margin:0 0 16px">${escapeHtml(title)}</h1>
${body}
${
  cta
    ? `<p style="margin:24px 0"><a href="${escapeHtml(cta.url)}" style="background:#2563eb;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none;display:inline-block">${escapeHtml(cta.label)}</a></p>
<p style="font-size:12px;color:#6b7280">If the button does not work, copy this link into your browser:<br>${escapeHtml(cta.url)}</p>`
    : ''
}
</td></tr></table></body></html>`;

const appLink = (pathname: string, token: string) => {
  const url = new URL(pathname, env.APP_URL);
  url.searchParams.set('token', token);
  return url.toString();
};

export const verificationEmail = (to: string, name: string, token: string): MailMessage => {
  const url = appLink('/verify-email', token);
  return {
    to,
    subject: 'Verify your email address',
    text: `Hi ${name},\n\nPlease verify your email address by opening this link:\n${url}\n\nThe link expires in ${env.EMAIL_VERIFICATION_TTL_HOURS} hours.`,
    html: layout(
      'Verify your email address',
      `<p>Hi ${escapeHtml(name)},</p><p>Please confirm your email address to finish setting up your account. This link expires in ${env.EMAIL_VERIFICATION_TTL_HOURS} hours.</p>`,
      { label: 'Verify email', url },
    ),
  };
};

export const passwordResetEmail = (to: string, name: string, token: string): MailMessage => {
  const url = appLink('/reset-password', token);
  return {
    to,
    subject: 'Reset your password',
    text: `Hi ${name},\n\nReset your password using this link:\n${url}\n\nThe link expires in ${env.PASSWORD_RESET_TTL_MINUTES} minutes. If you did not request this, you can ignore this email.`,
    html: layout(
      'Reset your password',
      `<p>Hi ${escapeHtml(name)},</p><p>We received a request to reset your password. This link expires in ${env.PASSWORD_RESET_TTL_MINUTES} minutes.</p><p>If you did not request a reset, you can safely ignore this email.</p>`,
      { label: 'Reset password', url },
    ),
  };
};

const ROLE_LABELS: Record<string, string> = {
  ADMIN: 'Admin',
  PROJECT_MANAGER: 'Project Manager',
  DEVELOPER: 'Developer',
  WEBSITE_USER: 'Website User',
};

export const invitationEmail = (
  to: string,
  inviterName: string,
  websiteName: string,
  role: string,
  token: string,
): MailMessage => {
  const url = appLink('/accept-invite', token);
  const roleLabel = ROLE_LABELS[role] ?? role;
  return {
    to,
    subject: `You're invited to join ${websiteName}`,
    text: `${inviterName} invited you to join ${websiteName} as ${roleLabel}.\n\nAccept the invitation:\n${url}\n\nThe invitation expires in ${env.INVITATION_TTL_DAYS} days.`,
    html: layout(
      `Join ${websiteName}`,
      `<p><strong>${escapeHtml(inviterName)}</strong> invited you to join <strong>${escapeHtml(websiteName)}</strong> as <strong>${escapeHtml(roleLabel)}</strong>.</p><p>This invitation expires in ${env.INVITATION_TTL_DAYS} days.</p>`,
      { label: 'Accept invitation', url },
    ),
  };
};

export const addedToWebsiteEmail = (to: string, name: string, websiteName: string, role: string): MailMessage => {
  const url = new URL('/websites', env.APP_URL).toString();
  const roleLabel = ROLE_LABELS[role] ?? role;
  return {
    to,
    subject: `You were added to ${websiteName}`,
    text: `Hi ${name},\n\nYou now have access to ${websiteName} as ${roleLabel}.\n${url}`,
    html: layout(
      `You were added to ${websiteName}`,
      `<p>Hi ${escapeHtml(name)},</p><p>You now have access to <strong>${escapeHtml(websiteName)}</strong> as <strong>${escapeHtml(roleLabel)}</strong>.</p>`,
      { label: 'Open dashboard', url },
    ),
  };
};

export const passwordChangedEmail =(to: string, name: string): MailMessage => ({
  to,
  subject: 'Your password was changed',
  text: `Hi ${name},\n\nThe password for your account was just changed and all other sessions were signed out. If this was not you, reset your password immediately.`,
  html: layout(
    'Your password was changed',
    `<p>Hi ${escapeHtml(name)},</p><p>The password for your account was just changed and your other sessions were signed out.</p><p>If this was not you, reset your password immediately.</p>`,
  ),
});
