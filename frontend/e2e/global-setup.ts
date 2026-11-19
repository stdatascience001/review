import fs from 'node:fs';
import { OUTBOX_DIR } from './env';

/**
 * The e2e database is reset and the super admin seeded by the backend webServer command
 * (see playwright.config.ts) because Playwright starts web servers before global setup.
 * Here we only clear stale emails from previous runs.
 */
export default function globalSetup() {
  fs.rmSync(OUTBOX_DIR, { recursive: true, force: true });
}
