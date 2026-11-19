import { PrismaClient } from '@prisma/client';
import { env } from '../config/env';

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    // Query errors are propagated to the error handler (which logs real failures), so Prisma's
    // own error logging is disabled to avoid noise from expected, handled unique-constraint conflicts.
    log: ['warn'],
  });

if (!env.isProd) globalForPrisma.prisma = prisma;

/** Prisma interactive-transaction client type. */
export type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];
