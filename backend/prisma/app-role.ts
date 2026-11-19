/**
 * Least-privilege PostgreSQL role for the running application.
 *
 *   Migrations run as the database OWNER (DDL).  The API connects as an APP role that can
 *   only read/write rows: no CREATE/DROP/ALTER, no access to Prisma's migration table, and
 *   the audit log is append-only (no UPDATE/DELETE).
 *
 * Usage (prints the SQL to run as the owner/superuser, e.g. with psql):
 *   pnpm --filter @wrtm/backend db:app-role -- --role wrtm_app --password '<strong password>' --database wrtm
 */

const ident = (v: string) => {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(v)) throw new Error(`Invalid identifier: ${v}`);
  return `"${v}"`;
};
const literal = (v: string) => `'${v.replace(/'/g, "''")}'`;

/** The statements, one per entry (Prisma/pg run one statement per call). */
export const appRoleStatements = (opts: { role: string; password: string; database: string; schema?: string }): string[] => {
  const role = ident(opts.role);
  const db = ident(opts.database);
  const schema = ident(opts.schema ?? 'public');
  return [
    `DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = ${literal(opts.role)}) THEN
    CREATE ROLE ${role} LOGIN PASSWORD ${literal(opts.password)} NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  ELSE
    ALTER ROLE ${role} LOGIN PASSWORD ${literal(opts.password)} NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END $$`,
    `GRANT CONNECT ON DATABASE ${db} TO ${role}`,
    `REVOKE CREATE ON SCHEMA ${schema} FROM PUBLIC`,
    `REVOKE ALL ON SCHEMA ${schema} FROM ${role}`,
    `GRANT USAGE ON SCHEMA ${schema} TO ${role}`,
    `REVOKE ALL ON ALL TABLES IN SCHEMA ${schema} FROM ${role}`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${schema} TO ${role}`,
    `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${schema} TO ${role}`,
    // Migration bookkeeping is the owner's business.
    `REVOKE ALL ON TABLE ${schema}."_prisma_migrations" FROM ${role}`,
    // Audit trail: append-only for the application.
    `REVOKE UPDATE, DELETE, TRUNCATE ON TABLE ${schema}."audit_logs" FROM ${role}`,
    // Tables created by future migrations (run by the owner) get the same row-level rights.
    `ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${role}`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} GRANT USAGE, SELECT ON SEQUENCES TO ${role}`,
  ];
};

export const appRoleSql = (opts: { role: string; password: string; database: string; schema?: string }) =>
  `${appRoleStatements(opts).join(';\n')};`;

// CLI
if (require.main === module) {
  const arg = (name: string) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > -1 ? process.argv[i + 1] : undefined;
  };
  const role = arg('role') ?? 'wrtm_app';
  const password = arg('password');
  const database = arg('database');
  if (!password || !database) {
    console.error('Usage: tsx prisma/app-role.ts --role wrtm_app --password <password> --database <db> [--schema public]');
    process.exit(1);
  }
  console.log(appRoleSql({ role, password, database, schema: arg('schema') }));
}
