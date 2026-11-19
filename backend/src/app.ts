import crypto from 'node:crypto';
import path from 'node:path';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { env } from './config/env';
import { logger } from './lib/logger';
import { errorHandler, notFoundHandler } from './middleware/error-handler';
import { originCheck } from './middleware/origin-check';
import { createApiLimiter, createAuthLimiter } from './middleware/rate-limit';
import { apiRouter } from './routes';

export interface AppOptions {
  apiRateLimit?: number;
  authRateLimit?: number;
}

export const createApp = (options: AppOptions = {}) => {
  const app = express();

  app.disable('x-powered-by');
  if (env.TRUST_PROXY > 0) app.set('trust proxy', env.TRUST_PROXY);

  // CSP also covers the dashboard when this server serves it (FRONTEND_DIST_DIR):
  // images may come from https sources (avatars, logos); sockets connect to this origin.
  const apiOrigin = new URL(env.API_URL);
  const wsOrigin = `${apiOrigin.protocol === 'https:' ? 'wss' : 'ws'}://${apiOrigin.host}`;
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
          fontSrc: ["'self'", 'data:'],
          connectSrc: ["'self'", wsOrigin],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          frameAncestors: ["'self'"],
          upgradeInsecureRequests: apiOrigin.protocol === 'https:' ? [] : null,
        },
      },
    }),
  );

  // Review widget files, loaded by customer websites (any origin, no cookies).
  // widget.js keeps a stable URL (short cache); widget-app/* files are content-hashed (immutable).
  const crossOrigin = { 'Cross-Origin-Resource-Policy': 'cross-origin', 'Access-Control-Allow-Origin': '*' };
  app.get('/widget.js', (_req, res) => {
    res.set({ ...crossOrigin, 'Cache-Control': 'public, max-age=300', 'Content-Type': 'text/javascript; charset=utf-8' });
    res.sendFile(path.join(env.widgetDistDir, 'widget.js'), (err) => {
      if (err && !res.headersSent) res.status(404).type('text/plain').send('// widget not built: run "pnpm --filter @wrtm/widget build"');
    });
  });
  app.use(
    '/widget-app',
    express.static(path.join(env.widgetDistDir, 'widget-app'), {
      immutable: true,
      maxAge: '365d',
      setHeaders: (res) => res.set(crossOrigin),
    }),
  );

  // Dashboard CORS (credentialed, allow-list). The widget API does its own per-website check.
  const dashboardCors = cors({
    origin: (origin, cb) => cb(null, !origin || env.corsOrigins.includes(origin.replace(/\/$/, ''))),
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    maxAge: 600,
  });
  const isWidgetApi = (p: string) => p === '/api/v1/widget' || p.startsWith('/api/v1/widget/');
  app.use((req, res, next) => (isWidgetApi(req.path) ? next() : dashboardCors(req, res, next)));
  // Request ids: accept a sane upstream X-Request-Id (load balancer) or generate one; echo it back
  // so a user-visible error can be matched to the server logs.
  app.use(
    pinoHttp({
      logger,
      autoLogging: !env.isTest,
      genReqId: (req, res) => {
        const incoming = req.headers['x-request-id'];
        const id = typeof incoming === 'string' && /^[\w.-]{8,64}$/.test(incoming) ? incoming : crypto.randomUUID();
        res.setHeader('X-Request-Id', id);
        return id;
      },
      customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
      redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'],
    }),
  );
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());
  app.use((req, _res, next) => {
    req.valid = {};
    next();
  });
  // Widget requests are cookie-less (bearer tokens), so they don't need the CSRF origin check.
  app.use((req, res, next) => (isWidgetApi(req.path) ? next() : originCheck(req, res, next)));

  app.use(
    '/api/v1',
    createApiLimiter(options.apiRateLimit),
    apiRouter(createAuthLimiter(options.authRateLimit)),
  );

  // Optional: serve the built dashboard (single-origin deployment). Hashed assets are
  // immutable; index.html is always revalidated so new deployments are picked up.
  if (env.FRONTEND_DIST_DIR) {
    const dir = path.resolve(env.FRONTEND_DIST_DIR);
    app.use(
      express.static(dir, {
        index: false,
        setHeaders: (res, file) =>
          res.set('Cache-Control', file.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache'),
      }),
    );
    app.get(/^\/(?!api\/|socket\.io\/|widget-app\/|widget\.js).*/, (_req, res) => {
      res.set('Cache-Control', 'no-cache').sendFile(path.join(dir, 'index.html'));
    });
  }

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
};
