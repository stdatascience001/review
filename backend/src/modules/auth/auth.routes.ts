import { Router, type RequestHandler } from 'express';
import { audit } from '../../lib/audit';
import { authenticate } from '../../middleware/authenticate';
import { validate } from '../../middleware/validate';
import * as c from './auth.controller';
import * as s from './auth.schemas';

export const authRoutes = (authLimiter: RequestHandler) => {
  const r = Router();

  r.post('/register', authLimiter, validate({ body: s.registerBody }), audit('auth.register'), c.register);
  r.post('/login', authLimiter, validate({ body: s.loginBody }), audit('auth.login'), c.login);
  r.post('/refresh', c.refresh);
  r.post('/logout', audit('auth.logout', { failures: false }), c.logout);
  r.post('/logout-all', authenticate, audit('auth.logout_all'), c.logoutAll);

  r.get('/sessions', authenticate, c.listSessions);
  r.delete('/sessions/:sessionId', authenticate, validate({ params: s.sessionIdParams }), audit('auth.session_revoked', { target: { type: 'session', param: 'sessionId' } }), c.revokeSession);

  r.post('/verify-email', authLimiter, validate({ body: s.verifyEmailBody }), audit('auth.email_verified'), c.verifyEmail);
  r.post('/resend-verification', authLimiter, authenticate, c.resendVerification);
  r.post('/forgot-password', authLimiter, validate({ body: s.forgotPasswordBody }), audit('auth.password_reset_requested'), c.forgotPassword);
  r.post('/reset-password', authLimiter, validate({ body: s.resetPasswordBody }), audit('auth.password_reset'), c.resetPassword);

  r.get('/google', authLimiter, validate({ query: s.googleStartQuery }), c.googleStart);
  r.get('/google/callback', authLimiter, validate({ query: s.googleCallbackQuery }), c.googleCallback);
  r.post('/google/token', authLimiter, validate({ body: s.googleTokenBody }), audit('auth.google_login'), c.googleToken);

  return r;
};
