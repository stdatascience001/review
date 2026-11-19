import http from 'node:http';
import { createApp } from './app';
import { env } from './config/env';
import { logger } from './lib/logger';
import { prisma } from './lib/prisma';
import { closeRealtime, initRealtime } from './lib/realtime';

const main = async () => {
  await prisma.$connect();
  const app = createApp();
  const server = http.createServer(app);
  initRealtime(server); // Socket.IO shares the HTTP server (path /socket.io)
  server.listen(env.PORT, () => {
    logger.info(
      { port: env.PORT, env: env.NODE_ENV, googleOAuth: env.googleEnabled, smtp: Boolean(env.SMTP_HOST) },
      `API listening on ${env.API_URL}/api/v1`,
    );
  });

  // Housekeeping: purge long-expired sessions and auth tokens once an hour.
  const cleanup = setInterval(
    async () => {
      const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      try {
        await prisma.userSession.deleteMany({ where: { expiresAt: { lt: cutoff } } });
        await prisma.authToken.deleteMany({ where: { expiresAt: { lt: cutoff } } });
      } catch (err) {
        logger.warn({ err }, 'session cleanup failed');
      }
    },
    60 * 60 * 1000,
  );
  cleanup.unref();

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'shutting down');
    void closeRealtime();
    server.close(async () => {
      await prisma.$disconnect();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('unhandledRejection', (reason) => logger.error({ err: reason }, 'unhandled promise rejection'));
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'uncaught exception');
    shutdown('uncaughtException');
  });
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
};

main().catch((err) => {
  logger.fatal({ err }, 'failed to start');
  process.exit(1);
});
