# Database Setup Guide (PostgreSQL)

The app needs PostgreSQL 13 or newer (developed and tested on 16). The schema lives in
`backend/prisma/schema.prisma`. Migrations are plain SQL files in `backend/prisma/migrations/`, applied in order with
`prisma migrate deploy`.

## 1. Local development

```bash
# Create a database (any superuser/owner works locally)
createdb -U postgres wrtm_dev
# backend/.env
DATABASE_URL=postgresql://postgres:<password>@localhost:5432/wrtm_dev?schema=public

cd backend
pnpm db:deploy        # apply all migrations
pnpm db:seed          # optional: SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD create the platform Super Admin
pnpm db:studio        # optional: browse data
```

The tests use their own databases on the same server; the test helpers create them as needed:

| Database | Used by | Notes |
|---|---|---|
| `wrtm_test` | `pnpm test` (Vitest) | Emptied before each test file. The helper refuses to wipe a database whose name doesn't contain "test". |
| `wrtm_e2e` | `pnpm test:e2e` (Playwright) | Emptied at startup by `tests/e2e-prepare.ts` (refuses names without "e2e" or "test") |
| `wrtm_e2e_prod` | `pnpm --filter @wrtm/frontend test:prod` | Production smoke test |

## 2. Production: two roles

Use one role to own the schema and run migrations, and a separate, restricted role for the running app.

| Role | Used by | Rights |
|---|---|---|
| `wrtm_owner` | `prisma migrate deploy` (`MIGRATION_DATABASE_URL`) | Owns the database and schema (DDL) |
| `wrtm_app` | The API (`DATABASE_URL`) | `SELECT`, `INSERT`, `UPDATE`, `DELETE` on rows only. It cannot create, alter, drop or truncate, cannot read `_prisma_migrations`, and can only append to `audit_logs`. |

```bash
# As a superuser
psql -c "CREATE ROLE wrtm_owner LOGIN PASSWORD '<owner-password>';"
psql -c "CREATE DATABASE wrtm OWNER wrtm_owner;"

# Apply migrations as the owner
cd backend
DATABASE_URL="postgresql://wrtm_owner:<owner-password>@db-host:5432/wrtm" pnpm db:deploy

# Create/refresh the least-privilege app role (prints SQL; run it as the owner or a superuser)
pnpm --silent db:app-role --role wrtm_app --password '<app-password>' --database wrtm \
  | psql "postgresql://wrtm_owner:<owner-password>@db-host:5432/wrtm"
```

Then set `DATABASE_URL=postgresql://wrtm_app:<app-password>@db-host:5432/wrtm?schema=public&connection_limit=10`.

The automated security tests (`backend/tests/security.test.ts`) create exactly this role and check the following:
- the role can read and write rows;
- `CREATE TABLE`, `DROP TABLE`, `ALTER TABLE` and `TRUNCATE` fail;
- changing or deleting audit log rows fails;
- reading `_prisma_migrations` fails.

Run the role script again after migrations that add tables. Default privileges cover new tables, but re-running is
harmless.

## 3. Migrations in each release

1. Back up (see below).
2. Run `prisma migrate deploy` as the owner. The Docker image does this when `RUN_MIGRATIONS=true`, using
   `MIGRATION_DATABASE_URL` if it is set.
3. Start the new app version.

Never use `prisma migrate reset` or `migrate dev` against production.

Migrations shipped so far:

| Migration | Contents |
|---|---|
| `20261117163627_init` | Users, sessions, tokens, websites, members, settings, projects, tasks, comments, attachments, activity, notifications |
| `20261117163650_check_constraints` | Data-integrity CHECK constraints, single-owner index |
| `20261118090000_team_roles_website_admin` | Team roles, website status, Site ID, domain verification, invitations |
| `20261118120000_review_widget` | Widget sessions bound to one website, widget settings, archive timestamp |
| `20261119090000_task_management` | Workflow statuses, task types, Task ID numbers, activity fields, attachment kinds, unread markers |
| `20261120090000_realtime_audit_analytics` | `audit_logs` table and analytics indexes |

## 4. Indexes

Every hot query path has a supporting index. Each entry below gives the query, then the index that serves it:
- **Tenancy checks:** `website_members (website_id, user_id)` unique, plus `project_members (project_id, user_id)` unique.
- **Task lists and filters:** `tasks (project_id, status, position)`, `(website_id, status)`, `(assignee_id, status)`,
  `(creator_id)`, `(due_date)`.
- **Analytics and website listings:** `tasks (website_id, created_at)`, `(project_id, created_at)`, `(completed_at)`.
- **Comments, history and unread markers:** `task_comments (task_id, created_at)`, `task_activities (task_id, created_at)`,
  `(created_at)`, `task_reads (task_id, user_id)` primary key.
- **Notifications:** `notifications (user_id, read_at, created_at)`.
- **Sessions:** `user_sessions (refresh_token_hash)` unique, plus a partial index on active sessions.
- **Audit log:** `audit_logs (created_at)`, `(actor_id, created_at)`, `(website_id, created_at)`, `(action, created_at)`.

## 5. Backups and retention

- **Database:** take a nightly `pg_dump -Fc wrtm > wrtm-$(date +%F).dump` (or use your provider's point-in-time
  recovery). Restore with `pg_restore -d wrtm --clean wrtm-YYYY-MM-DD.dump`.
- **Uploaded files** (`UPLOAD_DIR`, the `/data` volume in Docker) must be backed up together with the database.
  Attachment rows point to these files.
- **Housekeeping:** the API purges expired sessions and tokens hourly. The audit log is append-only; archive or
  partition it yourself if it grows large, for example by moving rows older than a year to cold storage as the owner
  role.
