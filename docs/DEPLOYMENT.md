# Deployment Guide

## Architecture

In production, one Node.js process serves everything on **one HTTPS origin**, such as `https://review.example.com`:

```
                        ┌────────────────────────────────────────────────────┐
 Browser (dashboard) ───┤ Caddy / Nginx  (TLS, HTTP→HTTPS, gzip, WebSocket)  │
 Customer sites (widget)│      │                                             │
                        │      ▼                                             │
                        │  Node.js  backend/dist/server.js                   │
                        │   ├─ /api/v1/*        REST API                     │
                        │   ├─ /socket.io/*     real-time (Socket.IO)        │
                        │   ├─ /widget.js, /widget-app/*   widget bundle     │
                        │   └─ /*               dashboard (frontend/dist)    │
                        │      │                         │                   │
                        │   PostgreSQL           UPLOAD_DIR (screenshots/files)
                        └────────────────────────────────────────────────────┘
```

A single origin keeps the HTTP-only `SameSite=Lax` cookies first-party and makes CORS a non-issue for the dashboard.
The widget's API is called cross-origin from customer sites by design; it uses bearer tokens and a per-website domain
check.

## Requirements

- Node.js 20+ (22 LTS recommended), pnpm 10
- PostgreSQL 13+ (16 recommended)
- A domain with HTTPS. Caddy obtains certificates automatically; with Nginx, use certbot.
- An SMTP account, for verification, password reset and invitation emails
- Optional: a Google OAuth client, for "Continue with Google"

## Option A — Docker Compose (recommended)

```bash
cp backend/.env.production.example backend/.env.production   # fill in every CHANGE_ME
export POSTGRES_PASSWORD='<owner-password>' DOMAIN=review.example.com
docker compose up -d --build
```

This starts three services:
- **`db`:** PostgreSQL 16, not published to the host.
- **`app`:** the image built from `Dockerfile` (API, dashboard and widget). It runs migrations at startup
  (`RUN_MIGRATIONS=true`) and stores uploads in the `uploads` volume.
- **`caddy`:** HTTPS on ports 80 and 443 for `$DOMAIN`, proxying to the app, including WebSockets.

After the first start:

```bash
# Least-privilege role for the app (see docs/DATABASE.md), then point DATABASE_URL at it and restart
docker compose exec -T app npx tsx prisma/app-role.ts --role wrtm_app --password '<app-password>' --database wrtm \
  | docker compose exec -T db psql -U wrtm_owner -d wrtm
# Platform Super Admin
docker compose exec -e SEED_ADMIN_EMAIL=admin@example.com -e SEED_ADMIN_PASSWORD='<long password>' app npx tsx prisma/seed.ts
```

> The image is multi-stage, runs as a non-root user, includes a health check and uses tini. Docker wasn't available on
> the build machine, so it was written to match the verified bare-metal build (Option B) but not run there. Run
> `docker compose up --build` once in staging before relying on it.

## Option B — Bare metal / VM (verified)

```bash
# 1. Build (on the server or in CI)
pnpm install --frozen-lockfile
pnpm build                       # widget → frontend (VITE_API_URL=/api/v1) → backend (tsc)

# 2. Database
#    create roles + database, run migrations as owner, create the app role: docs/DATABASE.md
cd backend && DATABASE_URL="$MIGRATION_DATABASE_URL" npx prisma migrate deploy

# 3. Configure
cp backend/.env.production.example /opt/wrtm/backend/.env.production   # fill it in
#    FRONTEND_DIST_DIR=/opt/wrtm/frontend/dist   WIDGET_DIST_DIR=/opt/wrtm/widget/dist

# 4. Run as a service
sudo cp deploy/wrtm-api.service /etc/systemd/system/
sudo systemctl enable --now wrtm-api

# 5. HTTPS reverse proxy: deploy/Caddyfile (automatic TLS) or deploy/nginx.conf (certbot)
```

This exact production mode is covered by an automated smoke test (`pnpm build && pnpm --filter @wrtm/frontend test:prod`).
The test runs `node dist/server.js` with `NODE_ENV=production`, Secure cookies, the production CSP and the built
dashboard and widget, then drives it in Chromium:
- sign-in, live updates and lazy-loaded pages, with no CSP or JavaScript errors;
- widget installation on an external site, and a screenshot task appearing live in the dashboard.

## Option C — Separate dashboard hosting (CDN)

You can also host `frontend/dist` on a CDN or static host:
1. Build the dashboard with `VITE_API_URL=https://api.example.com/api/v1`.
2. On the API, set `CORS_ORIGINS=https://app.example.com`, `APP_URL=https://app.example.com`, and
   `COOKIE_DOMAIN=.example.com` (the dashboard and API must share a registrable domain so `SameSite=Lax` cookies keep
   working).
3. Add the API host to the dashboard host's CSP `connect-src`, for both `https:` and `wss:`.
4. To serve the widget from a CDN, upload `widget/dist/` and set `EMBED_SCRIPT_URL=https://cdn.example.com/widget.js`.
   Generated snippets then include `data-api-url`.

## Environment variables

`backend/.env.production.example` documents every variable. The important ones:

| Variable | Production value |
|---|---|
| `NODE_ENV` | `production` (enables the checks below and JSON logs) |
| `API_URL`, `APP_URL` | `https://…` (the server refuses to start with plain http, except on localhost) |
| `CORS_ORIGINS` | The dashboard origin(s) |
| `TRUST_PROXY` | `1` behind Caddy or Nginx (correct client IP for rate limits and audit logs) |
| `DATABASE_URL` / `MIGRATION_DATABASE_URL` | App role / owner role |
| `JWT_ACCESS_SECRET` | 48+ random bytes (the server refuses fewer than 32 characters) |
| `COOKIE_SECURE` | `true` (required) |
| `SMTP_*`, `EMAIL_FROM` | Required in production |
| `GOOGLE_CLIENT_ID/SECRET` | Optional. Authorized redirect URI: `https://<domain>/api/v1/auth/google/callback` |
| `FRONTEND_DIST_DIR`, `WIDGET_DIST_DIR`, `UPLOAD_DIR` | Paths (the Docker image sets them) |
| `ALLOW_PRIVATE_NETWORK_FETCH` | `false` (required; SSRF protection for domain verification) |
| `RATE_LIMIT_*`, `MAX_UPLOAD_MB`, `LOG_LEVEL` | Tuning |

Secrets belong in the environment or a secrets manager. `.env*` files are git-ignored, except the `*.example`
templates, which contain no real values; a test enforces this.

## Domains and HTTPS checklist

- [ ] DNS `A`/`AAAA` record for `review.example.com` points to the server (Caddy needs ports 80 and 443 open).
- [ ] HTTPS works and HTTP redirects to it. The app sends HSTS (`Strict-Transport-Security`) and a strict CSP.
- [ ] WebSockets pass through the proxy (`/socket.io/`). The dashboard header shows **Live**.
- [ ] `client_max_body_size` (Nginx) or `request_body max_size` (Caddy) ≥ `MAX_UPLOAD_MB`.
- [ ] Google OAuth redirect URI registered for the production domain.
- [ ] Each customer website is registered in the dashboard with its real URL. Extra hosts (staging, `www`) go under
      **Settings → Allowed domains**.

## Scaling and operations

- **Health:** `GET /api/v1/health` checks the database. Use it for load balancers and the Docker health check.
- **Logs:**
  - JSON lines on stdout (pino), each with a request id.
  - Errors include the method, path, user id and request id, and never secrets (cookies, tokens and passwords are
    redacted).
  - Ship the logs to your log platform.
- **Audit log:** Super Admin → **Audit Log** in the dashboard, or `GET /api/v1/audit-logs`.
- **Graceful shutdown:** on `SIGTERM` the server stops accepting connections, closes sockets and disconnects from the
  database.
- **More than one Node instance:**
  - Socket.IO needs a shared adapter (`@socket.io/redis-adapter`) and sticky sessions for the polling transport.
  - Rate limits are per instance, so use a shared store (e.g. `rate-limit-redis`).
  - Uploads must live on shared storage (NFS or an S3 gateway).
  - A single instance is the supported default.
- **Releases:**
  1. Back up.
  2. Run `prisma migrate deploy` (as the owner).
  3. Restart the app.
  - Hashed dashboard and widget assets are cached for a year. `index.html` and `widget.js` are revalidated (`widget.js`
    every 5 minutes), so new versions reach users and customer sites automatically.
- **Backups:** the database plus `UPLOAD_DIR`, together (see docs/DATABASE.md).

## Smoke test after deploying

```bash
curl -fsS https://review.example.com/api/v1/health
curl -sI https://review.example.com/ | grep -i -E 'strict-transport|content-security'
curl -sI https://review.example.com/widget.js | grep -i cache-control      # public, max-age=300
```

Then:
1. Sign in as the Super Admin.
2. Add a website, copy its embed script and install it on the site.
3. Click **Review → Add a Comment** on the site, and watch the task appear live in **All Tasks**.
