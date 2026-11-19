/**
 * Empties the dedicated end-to-end database before a Playwright run.
 * Refuses to touch any database whose name does not contain "e2e" or "test".
 * Usage (from backend/): DATABASE_URL=…/wrtm_e2e npx tsx tests/e2e-prepare.ts
 */
import { PrismaClient } from '@prisma/client';

const main = async () => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const dbName = new URL(url).pathname.slice(1);
  if (!/e2e|test/i.test(dbName)) throw new Error(`Refusing to clear non-test database "${dbName}"`);

  const prisma = new PrismaClient();
  try {
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "users", "websites", "audit_logs" RESTART IDENTITY CASCADE');
    console.log(`Cleared e2e database "${dbName}"`);
  } finally {
    await prisma.$disconnect();
  }
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
