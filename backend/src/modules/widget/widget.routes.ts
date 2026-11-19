import express, { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { audit } from '../../lib/audit';
import { env } from '../../config/env';
import { setOAuthStateCookie } from '../../lib/cookies';
import { forbidden, unauthorized } from '../../lib/errors';
import { clientMeta } from '../../lib/http';
import { verifyWidgetToken } from '../../lib/jwt';
import { prisma } from '../../lib/prisma';
import { requireVerifiedEmail } from '../../middleware/authenticate';
import { bodyOf, paramsOf, queryOf, validate } from '../../middleware/validate';
import * as auth from '../auth/auth.service';
import * as google from '../auth/google.service';
import * as sessions from '../auth/session.service';
import { fileNameOf, uploadQuery } from '../tasks/tasks.schemas';
import * as s from './widget.schemas';
import { widgetAuthFromToken } from './widget.auth';
import * as widget from './widget.service';

/**
 * Review widget API (/api/v1/widget), called from customer websites.
 *
 *  - CORS is open (any origin, no cookies). Every request is instead checked against the
 *    website's allowed domains via the Origin header, and data requires a bearer token.
 *  - Tokens come from site-bound sessions: the access JWT has its own audience and a
 *    website id, so it only works here, for that website.
 *  - The Site ID is public. It identifies the website; it never authorizes anything.
 */

declare global {
  namespace Express {
    interface Request {
      widgetSite?: widget.WidgetSite;
    }
  }
}

const cors: RequestHandler = (req, res, next) => {
  const origin = req.get('origin');
  if (origin) {
    res.set('Access-Control-Allow-Origin', origin);
    res.append('Vary', 'Origin');
  }
  res.set('Cross-Origin-Resource-Policy', 'cross-origin');
  if (req.method === 'OPTIONS') {
    res.set({
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-File-Name',
      'Access-Control-Max-Age': '600',
    });
    res.status(204).end();
    return;
  }
  next();
};

/** Bearer widget token → req.auth + req.widgetSite (origin re-checked on every call). */
const authenticateWidget: RequestHandler = async (req: Request, _res: Response, next: NextFunction) => {
  const header = req.get('authorization');
  const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : undefined;
  const { auth, site } = await widgetAuthFromToken(token, req.get('origin'));
  req.auth = auth;
  req.widgetSite = site;
  next();
};

const site = (req: Request) => req.widgetSite!;
const uid = (req: Request) => req.auth!.userId;

const sendSession = (res: Response, status: number, result: auth.AuthResult) =>
  res.status(status).json({
    data: {
      user: result.user,
      session: {
        accessToken: result.session.accessToken,
        refreshToken: result.session.refreshToken,
        expiresAt: result.session.expiresAt,
      },
    },
  });

export const widgetRoutes = (authLimiter: RequestHandler) => {
  const r = Router();
  r.use(cors);

  // ── Public ──
  r.get('/config', validate({ query: s.configQuery }), async (req, res) => {
    const found = await widget.siteForOrigin(queryOf(req, s.configQuery).siteId, req.get('origin'));
    res.set('Cache-Control', 'private, max-age=60');
    res.json({ data: widget.config(found) });
  });

  // ── Authentication (Task 1 auth, issuing site-bound sessions) ──
  r.post('/auth/login', authLimiter, validate({ body: s.loginBody }), audit('auth.login', { meta: (req) => ({ channel: 'widget', siteId: req.body.siteId }) }), async (req, res) => {
    const { siteId, ...credentials } = bodyOf(req, s.loginBody);
    const found = await widget.siteForOrigin(siteId, req.get('origin'));
    sendSession(res, 200, await auth.login(credentials, clientMeta(req), { widgetWebsiteId: found.id }));
  });

  r.post('/auth/register', authLimiter, validate({ body: s.registerBody }), audit('auth.register', { meta: (req) => ({ channel: 'widget', siteId: req.body.siteId }) }), async (req, res) => {
    const { siteId, ...input } = bodyOf(req, s.registerBody);
    const found = await widget.siteForOrigin(siteId, req.get('origin'));
    sendSession(res, 201, await auth.register(input, clientMeta(req), { widgetWebsiteId: found.id }));
  });

  r.post('/auth/forgot-password', authLimiter, validate({ body: s.forgotPasswordBody }), async (req, res) => {
    const { siteId, email } = bodyOf(req, s.forgotPasswordBody);
    await widget.siteForOrigin(siteId, req.get('origin'));
    await auth.forgotPassword(email);
    res.json({ data: { message: 'If an account exists for that email, a password reset link has been sent' } });
  });

  r.post('/auth/refresh', validate({ body: s.refreshBody }), async (req, res) => {
    const { siteId, refreshToken } = bodyOf(req, s.refreshBody);
    const found = await widget.siteForOrigin(siteId, req.get('origin'));
    const session = await sessions.refreshSession(refreshToken, clientMeta(req), found.id);
    res.json({
      data: { session: { accessToken: session.accessToken, refreshToken: session.refreshToken, expiresAt: session.expiresAt } },
    });
  });

  r.post('/auth/logout', async (req, res) => {
    const header = req.get('authorization');
    const payload = header?.startsWith('Bearer ') ? verifyWidgetToken(header.slice(7).trim()) : null;
    if (payload) await sessions.revokeSession(payload.sid);
    res.status(204).end();
  });

  /** Opened in a popup by the widget; ends on a page that postMessages the session back. */
  r.get('/auth/google', authLimiter, validate({ query: s.googleStartQuery }), async (req, res) => {
    const { siteId, origin } = queryOf(req, s.googleStartQuery);
    const normalized = new URL(origin).origin;
    const found = await widget.siteForOrigin(siteId, normalized);
    const { url, cookieValue } = google.buildGoogleAuthUrl('/', { websiteId: found.id, origin: normalized });
    setOAuthStateCookie(res, cookieValue);
    res.set('Cross-Origin-Opener-Policy', 'unsafe-none');
    res.redirect(302, url);
  });

  // ── Signed-in ──
  r.get('/me', authenticateWidget, async (req, res) => {
    res.json({ data: await widget.me(uid(req), site(req)) });
  });

  r.post('/auth/resend-verification', authLimiter, authenticateWidget, async (req, res) => {
    await auth.resendVerification(uid(req));
    res.json({ data: { message: 'Verification email sent' } });
  });

  const member = [authenticateWidget, requireVerifiedEmail];

  r.get('/tasks', ...member, validate({ query: s.listTasksQuery }), async (req, res) => {
    res.json({ data: await widget.listTasks(uid(req), site(req), queryOf(req, s.listTasksQuery)) });
  });

  r.post('/tasks', ...member, validate({ body: s.createTaskBody }), async (req, res) => {
    res.status(201).json({ data: await widget.createTask(uid(req), site(req), bodyOf(req, s.createTaskBody)) });
  });

  r.get('/tasks/:taskId', ...member, validate({ params: s.taskIdParams }), async (req, res) => {
    res.json({ data: await widget.getTask(uid(req), site(req).id, paramsOf(req, s.taskIdParams).taskId) });
  });

  r.patch('/tasks/:taskId', ...member, validate({ params: s.taskIdParams, body: s.updateTaskBody }), async (req, res) => {
    const { taskId } = paramsOf(req, s.taskIdParams);
    res.json({ data: await widget.updateTask(uid(req), site(req).id, taskId, bodyOf(req, s.updateTaskBody)) });
  });

  r.get('/tasks/:taskId/activity', ...member, validate({ params: s.taskIdParams }), async (req, res) => {
    res.json({ data: await widget.activity(uid(req), site(req).id, paramsOf(req, s.taskIdParams).taskId) });
  });

  r.get('/tasks/:taskId/assignees', ...member, validate({ params: s.taskIdParams }), async (req, res) => {
    res.json({ data: await widget.assignees(uid(req), site(req).id, paramsOf(req, s.taskIdParams).taskId) });
  });

  r.post('/tasks/:taskId/read', ...member, validate({ params: s.taskIdParams }), async (req, res) => {
    await widget.markRead(uid(req), site(req).id, paramsOf(req, s.taskIdParams).taskId);
    res.status(204).end();
  });

  /** Raw file body; ?kind=screenshot|file&commentId=; name in X-File-Name (URI-encoded). */
  r.post(
    '/tasks/:taskId/attachments',
    ...member,
    validate({ params: s.taskIdParams, query: uploadQuery }),
    express.raw({ type: () => true, limit: `${env.MAX_UPLOAD_MB}mb` }),
    async (req, res) => {
      const { taskId } = paramsOf(req, s.taskIdParams);
      const { kind, commentId } = queryOf(req, uploadQuery);
      const data = await widget.addAttachment(uid(req), site(req).id, taskId, {
        body: req.body,
        fileName: fileNameOf(req.get('x-file-name')),
        kind,
        commentId,
      });
      res.status(201).json({ data });
    },
  );

  r.delete('/tasks/:taskId/attachments/:attachmentId', ...member, validate({ params: s.attachmentParams }), async (req, res) => {
    const { taskId, attachmentId } = paramsOf(req, s.attachmentParams);
    await widget.removeAttachment(uid(req), site(req).id, taskId, attachmentId);
    res.status(204).end();
  });

  r.post('/tasks/:taskId/archive', ...member, validate({ params: s.taskIdParams }), async (req, res) => {
    const { taskId } = paramsOf(req, s.taskIdParams);
    res.json({ data: await widget.setArchived(uid(req), site(req).id, taskId, true) });
  });

  r.delete('/tasks/:taskId/archive', ...member, validate({ params: s.taskIdParams }), async (req, res) => {
    const { taskId } = paramsOf(req, s.taskIdParams);
    res.json({ data: await widget.setArchived(uid(req), site(req).id, taskId, false) });
  });

  r.get('/tasks/:taskId/comments', ...member, validate({ params: s.taskIdParams, query: s.commentsQuery }), async (req, res) => {
    const { taskId } = paramsOf(req, s.taskIdParams);
    res.json({ data: await widget.listComments(uid(req), site(req).id, taskId, queryOf(req, s.commentsQuery)) });
  });

  r.post('/tasks/:taskId/comments', ...member, validate({ params: s.taskIdParams, body: s.commentBody }), async (req, res) => {
    const { taskId } = paramsOf(req, s.taskIdParams);
    res.status(201).json({ data: await widget.addComment(uid(req), site(req).id, taskId, bodyOf(req, s.commentBody)) });
  });

  r.patch('/comments/:commentId', ...member, validate({ params: s.commentIdParams, body: s.editCommentBody }), async (req, res) => {
    const { commentId } = paramsOf(req, s.commentIdParams);
    res.json({ data: await widget.editComment(uid(req), site(req).id, commentId, bodyOf(req, s.editCommentBody).body) });
  });

  r.delete('/comments/:commentId', ...member, validate({ params: s.commentIdParams }), async (req, res) => {
    await widget.deleteComment(uid(req), site(req).id, paramsOf(req, s.commentIdParams).commentId);
    res.status(204).end();
  });

  return r;
};
