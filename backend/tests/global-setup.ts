import { execSync } from 'node:child_process';
import path from 'node:path';
import dotenv from 'dotenv';
import { resolveTestDatabaseUrl } from './test-db-url';

/** Creates (if needed) and migrates the test database before the suite runs. */
export default function setup() {
  dotenv.config({ path: path.resolve(__dirname, '../.env'), quiet: true });
  execSync('npx prisma migrate deploy', {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, DATABASE_URL: resolveTestDatabaseUrl() },
    stdio: 'pipe',
  });
}
