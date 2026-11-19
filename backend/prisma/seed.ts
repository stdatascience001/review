/**
 * Creates (or promotes) the platform SUPER_ADMIN account.
 *   SEED_ADMIN_EMAIL=you@example.com SEED_ADMIN_PASSWORD='Str0ngPassw0rd' pnpm db:seed
 * Platform admins cannot be created through the public API.
 */
import { prisma } from '../src/lib/prisma';
import { hashPassword } from '../src/lib/password';

const main = async () => {
  const email = process.env.SEED_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.SEED_ADMIN_PASSWORD;
  if (!email || !password) {
    console.error('Set SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD to create the super admin.');
    process.exit(1);
  }
  if (password.length < 12) {
    console.error('SEED_ADMIN_PASSWORD must be at least 12 characters.');
    process.exit(1);
  }
  const passwordHash = await hashPassword(password);
  const user = await prisma.user.upsert({
    where: { email },
    create: {
      email,
      name: process.env.SEED_ADMIN_NAME ?? 'Platform Admin',
      passwordHash,
      role: 'SUPER_ADMIN',
      emailVerifiedAt: new Date(),
    },
    update: { role: 'SUPER_ADMIN', passwordHash, status: 'ACTIVE' },
  });
  console.log(`Super admin ready: ${user.email} (${user.id})`);
};

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
