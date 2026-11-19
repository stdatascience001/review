# Website Review & Task Management

A multi-tenant SaaS for collecting feedback on websites and turning it into tracked tasks:
- **Embeddable widget:** customers add one `<script>` tag to their site; reviewers click **Review**, comment on any page
  (with a screenshot) and follow progress live.
- **Admin dashboard:** teams triage, assign and complete the work in a React dashboard.

```
.
├── backend/      Node.js · Express 5 · TypeScript · PostgreSQL · Prisma · Socket.IO   (API, port 4000)
├── frontend/     React 19 · Vite · Tailwind v4 · TanStack Query                      (dashboard, port 3000)
├── widget/       widget.js loader (3.5 KB) + lazy React panel in Shadow DOM           (served by the API)
├── demo-site/    separate demo customer website for testing the widget               (port 5600)
├── deploy/       Caddyfile · nginx.conf · systemd unit
├── docs/         API.md · DATABASE.md · DEPLOYMENT.md · widget-installation.md
├── Dockerfile · docker-compose.yml
└── package.json  pnpm workspace root
```

## Documentation

| Guide | |
|---|---|
| [docs/API.md](docs/API.md) | REST and real-time API reference |
| [docs/DATABASE.md](docs/DATABASE.md) | PostgreSQL setup, roles (least privilege), migrations, backups |
| [docs/widget-installation.md](docs/widget-installation.md) | Embed script for HTML, WordPress, React, Next.js, Astro, GTM… |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Production: Docker Compose / bare metal, HTTPS, environment, operations |
| `backend/.env.example` · `backend/.env.production.example` · `frontend/.env.example` | Configuration templates |

## Quick start (development)

Requirements: Node 20+, pnpm 10, PostgreSQL 13+.

```bash
pnpm install
cp backend/.env.example backend/.env           # set DATABASE_URL and JWT_ACCESS_SECRET (SMTP optional in dev)
cp frontend/.env.example frontend/.env
pnpm db:deploy                                 # create the schema
SEED_ADMIN_EMAIL=admin@example.com SEED_ADMIN_PASSWORD='a-long-password' pnpm db:seed   # platform Super Admin
pnpm dev                                       # API :4000, dashboard :3000, widget build in watch mode
```

Open http://localhost:3000.
- **Email in development:** without SMTP, emails (verification, reset, invitations) are written to
  `backend/.mail-outbox/`.
- **Trying the widget:**
  1. Add a website with URL `http://127.0.0.1:5600`.
  2. Run `SITE_ID=<its Site ID> pnpm demo`.
  3. Open http://127.0.0.1:5600.

## Features

| Area | What you get |
|---|---|
| **Accounts & security** | Email/password with verification, Google OAuth (PKCE), password reset, session list and revoke, HTTP-only cookies with rotating refresh tokens, account lockout, Super Admin. Every request is checked for its role and website (tenant isolation, with 404 for anything outside your websites). The security audit log records logins, failures, denials and permission changes. |
| **Admin dashboard** | Live cards (websites, projects, users, tasks, open, in progress, completed, overdue), trend chart, recent activity. Website, project and team management (invitations, roles, project assignment, developer performance). Responsive layout, lazy-loaded pages. |
| **Websites** | Unique Site ID, embed script with copy button and per-platform install guide, domain verification (meta tag or installed script, SSRF-safe), allowed domains, widget on/off, default project, brand color |
| **Review widget** | Review button with open-count badge; popup with tabs, This Page / All Pages, Mine and search; task cards; sign-in, registration, forgot password and Google; screenshot capture or upload, plus files. Shadow DOM isolation, SPA navigation, mobile layout, live updates. |
| **Task workflow** | Task IDs (`TASK-42`). Statuses Open, In progress, Under review, Completed, Reopened and Archived; types and priorities; assignment to developers. Field-level permissions: reporters create and discuss; developers and admins run the workflow. |
| **Comments** | Threaded replies, avatars, timestamps, image and file attachments, unread markers, edit and delete your own |
| **Activity log** | Every action stored with actor, field, previous and new value, and timestamp |
| **Real time** | Socket.IO events (task created, assigned, started, status updated, completed, reopened, new comment, new reply) in the dashboard (toasts, live lists and counters) and the widget (badge, bubble, live status). Sent only to authorized users. |
| **Analytics** | Totals, website-wise and developer-wise statistics, daily, weekly or monthly reports, website, project and date filters, CSV export |

### Roles

| Role | Scope | Can |
|---|---|---|
| Super Admin | Platform | Everything on every website; users; platform audit log |
| Owner / Admin | Website | Manage the website, settings, team, all projects and tasks; analytics; website audit log |
| Project Manager | Website | Create projects; manage the projects they belong to |
| Developer | Website | Work on tasks in assigned projects: start, change status and priority, assign, complete, reopen, archive |
| Website User | Website | Reviewer or client: create tasks, comment and reply, follow progress, add screenshots to their own tasks |

## Scripts

| Command | |
|---|---|
| `pnpm dev` | Everything in watch mode |
| `pnpm build` | Widget, then dashboard, then API (production builds) |
| `pnpm test` | Backend integration tests (Vitest, real PostgreSQL) |
| `pnpm test:e2e` | End-to-end tests (Playwright, Chromium); starts its own API, dashboard and demo site |
| `pnpm --filter @wrtm/frontend test:prod` | Smoke test of the production build (`pnpm build` first) |
| `pnpm db:deploy` · `pnpm db:seed` | Migrations · Super Admin |
| `pnpm --filter @wrtm/backend db:app-role` | SQL for the least-privilege database role |
| `pnpm demo` | Demo customer website |

## Testing

All test suites run against real PostgreSQL databases; nothing is mocked.

```bash
pnpm test                                   # 194 backend integration tests  (database wrtm_test)
pnpm test:e2e                               # 38 end-to-end browser tests    (database wrtm_e2e)
pnpm build && pnpm --filter @wrtm/frontend test:prod   # 3 production smoke tests (database wrtm_e2e_prod)
```

| Suite | Covers |
|---|---|
| `backend/tests/auth`, `rbac`, `tasks-workflow`, `admin-features`, `widget`, `task-management` | Tasks 1–4: authentication, roles, tenancy, websites, team, widget API, the task workflow, comments and files |
| `backend/tests/realtime.test.ts` | Socket authentication (cookie, widget token, origin). Every event type reaches exactly the authorized users (not other tenants, not developers outside the project), personal flags, access changes, disconnect on logout. |
| `backend/tests/multi-tenant.test.ts` | Three websites, two owners: unique Site IDs and configuration, domain verification per site, task ownership, website-wise listings, a 404 matrix across tenants (dashboard and widget), signed file links, roles across sites |
| `backend/tests/security.test.ts` | Forged, re-signed and `alg:none` tokens; HttpOnly and SameSite cookies; CSRF; XSS and security headers; rate limits and lockout; upload validation (content sniffing, size, path traversal, sandboxed serving); SSRF; input validation; environment safety; the database least-privilege role; the audit log |
| `backend/tests/analytics.test.ts` | Exact totals, website-wise and developer-wise numbers, day, week and month buckets, filters, CSV (formula-injection safe), access rules |
| `frontend/e2e/admin-dashboard`, `widget`, `task-workflow` | Dashboard, widget on a hostile-CSS demo site (isolation, SPA, mobile, Google popup, duplicate tags), and the Task 4 workflow |
| `frontend/e2e/final-workflow.spec.ts` | **All 17 workflow steps, live, for two websites with separate teams side by side**, plus cross-tenant isolation in the UI and over live events |
| `frontend/e2e-prod/production.spec.ts` | The built app under `NODE_ENV=production`: headers and caching, Secure cookies, CSP without violations, WebSocket, lazy routes, widget on an external site |
