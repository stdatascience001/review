import path from 'node:path';
import dotenv from 'dotenv';
import { defineConfig } from 'vitest/config';
import { resolveTestDatabaseUrl } from './tests/test-db-url';

dotenv.config({ path: path.resolve(__dirname, '.env'), quiet: true });

// Integration tests run against a real PostgreSQL database: TEST_DATABASE_URL, or by default
// the DATABASE_URL server with the database name replaced by "wrtm_test" (never the dev DB).
// The schema is migrated once in globalSetup; each test file truncates all tables first.
const TEST_DATABASE_URL = resolveTestDatabaseUrl();

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globalSetup: ['tests/global-setup.ts'],
    fileParallelism: false, // tests share one database
    testTimeout: 30_000,
    hookTimeout: 60_000,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: TEST_DATABASE_URL,
      JWT_ACCESS_SECRET: 'test-secret-test-secret-test-secret-0123456789',
      API_URL: 'http://localhost:4000',
      APP_URL: 'http://localhost:3000',
      CORS_ORIGINS: 'http://localhost:3000',
      REQUIRE_EMAIL_VERIFICATION: 'true',
      COOKIE_SECURE: 'false',
      SMTP_HOST: '',
      // Google OAuth client (format-valid test values; Google itself rejects them).
      GOOGLE_CLIENT_ID: 'test-client-id.apps.googleusercontent.com',
      GOOGLE_CLIENT_SECRET: 'test-client-secret',
      GOOGLE_REDIRECT_URI: '',
      ALLOW_PRIVATE_NETWORK_FETCH: 'true', // domain-verification tests use a local HTTP server
      EMBED_SCRIPT_URL: 'https://cdn.example.com/widget.js',
      UPLOAD_DIR: path.resolve(__dirname, '.test-uploads'),
      RATE_LIMIT_MAX: '10000',
      AUTH_RATE_LIMIT_MAX: '10000',
    },
  },
});
