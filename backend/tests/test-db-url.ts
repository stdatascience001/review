/**
 * TEST_DATABASE_URL if set; otherwise DATABASE_URL pointed at a separate "wrtm_test" database.
 * Refuses to run against a database that is not clearly a test database, because the
 * suite truncates every table.
 */
export const resolveTestDatabaseUrl = (): string => {
  const explicit = process.env.TEST_DATABASE_URL;
  let url: URL;
  if (explicit) {
    url = new URL(explicit);
  } else {
    if (!process.env.DATABASE_URL) throw new Error('Set TEST_DATABASE_URL or DATABASE_URL to run the tests');
    url = new URL(process.env.DATABASE_URL);
    url.pathname = '/wrtm_test';
  }
  if (!/test/i.test(url.pathname)) {
    throw new Error(`Refusing to run tests against non-test database "${url.pathname.slice(1)}"`);
  }
  return url.toString();
};
