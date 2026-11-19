# API Reference

Base URL: `https://<your-domain>/api/v1`. In development the dashboard reaches it at `http://localhost:3000/api/v1`
through the Vite proxy; the API itself runs on `http://localhost:4000`.

## Conventions

| Topic | Rule |
|---|---|
| Format | JSON in and out. Success: `{ "data": … }`. Error: `{ "error": { "code", "message", "details?", "requestId?" } }`. |
| Lists | `?page=1&pageSize=20` (max 100). Response: `{ items, pagination: { page, pageSize, total, totalPages } }`. |
| Auth (dashboard) | HTTP-only cookies `wrtm_at` (15-minute JWT) and `wrtm_rt` (refresh token, rotated on every use, path `/api/v1/auth`). |
| Auth (widget) | `Authorization: Bearer <widget token>`. Widget tokens work only for one website's widget API. |
| CSRF | A cookie-authenticated `POST`/`PATCH`/`PUT`/`DELETE` that carries an `Origin` header must come from `CORS_ORIGINS`, or it gets `403 INVALID_ORIGIN`. |
| Tenancy | Anything outside your websites returns **404**, not 403, so its existence isn't revealed. |
| Validation | Bad input returns `400 VALIDATION_ERROR` with `details: [{ path, message }]`. Unknown body fields are dropped. |
| Rate limits | Per IP: all of the API (`RATE_LIMIT_MAX` per window) and credential endpoints (`AUTH_RATE_LIMIT_MAX` failed attempts; successful sign-ins are not counted). Exceeding them returns `429 RATE_LIMITED` with `RateLimit-*` headers. |
| Tracing | Every response has `X-Request-Id`. `500` bodies include `requestId` and nothing internal. |

Common error codes:
- `UNAUTHORIZED`, `SESSION_EXPIRED`, `TOKEN_INVALID`
- `EMAIL_NOT_VERIFIED`, `ACCOUNT_SUSPENDED`, `ACCOUNT_LOCKED`
- `FORBIDDEN`, `WORKFLOW_FORBIDDEN`
- `NOT_FOUND`, `VALIDATION_ERROR`, `INVALID_TRANSITION`
- `INVALID_FILE`, `PAYLOAD_TOO_LARGE`, `DOMAIN_NOT_ALLOWED`

## Health & providers

| Method | Path | Notes |
|---|---|---|
| GET | `/health` | `{ status, database, time }` (checks the database) |
| GET | `/auth/providers` | `{ password: true, google: boolean }` |

## Authentication (`/auth`)

| Method | Path | Body / notes |
|---|---|---|
| POST | `/auth/register` | `{ name, email, password }` (8+ characters, at least one letter and one number). Sends a verification email and sets cookies. |
| POST | `/auth/login` | `{ email, password }`. Five failures lock the account for 15 minutes (`423`). |
| POST | `/auth/refresh` | Rotates the refresh cookie. |
| POST | `/auth/logout` · `/auth/logout-all` | Revokes the session(s) and disconnects their live sockets. |
| GET / DELETE | `/auth/sessions`, `/auth/sessions/:id` | Lists or revokes your sessions. |
| POST | `/auth/verify-email` | `{ token }` |
| POST | `/auth/resend-verification` | (signed in) |
| POST | `/auth/forgot-password` · `/auth/reset-password` | `{ email }` · `{ token, password }`. The answer is the same whether or not the account exists. |
| GET | `/auth/google?redirect=/path` → `/auth/google/callback` | OAuth 2.0 code flow with PKCE and state |
| POST | `/auth/google/token` | `{ credential }` (Google Identity Services ID token) |

## Users (`/users`)

| Method | Path | Notes |
|---|---|---|
| GET / PATCH | `/users/me` | `{ name?, avatarUrl? }` |
| PATCH | `/users/me/password` | `{ currentPassword?, newPassword }`. Revokes your other sessions. |
| GET / GET / PATCH | `/users`, `/users/:id` | Super Admin only. `PATCH { role?, status? }`; suspending revokes all sessions. |

## Dashboard, analytics and audit

| Method | Path | Notes |
|---|---|---|
| GET | `/dashboard?websiteId=` | Live totals, 14-day trend, status and priority breakdown, recent activity |
| GET | `/analytics?from=YYYY-MM-DD&to=&interval=day\|week\|month&websiteId=&projectId=` | Website owners and admins (Super Admin: everything). See below. |
| GET | `/analytics/tasks.csv?…same filters…` | Task report for the date range as CSV (UTF-8 BOM; formula-injection safe) |
| GET | `/audit-logs?action=&outcome=&websiteId=&actorId=&q=&from=&to=` | Super Admin: everything. Website owners and admins: `websiteId` is required. Read-only. |

`GET /analytics` returns:
- **`totals`:** websites, projects, users, tasks, openTasks, inProgressTasks, completedTasks, archivedTasks, overdueTasks;
  plus, for the date range, createdInRange, completedInRange, reopenedInRange and avgResolutionHours.
- **`timeline`:** `[{ date, created, completed }]`.
- **`byWebsite`:** per website: total, open, inProgress, completed, archived, overdue, createdInRange, completedInRange,
  completionRate, avgResolutionHours.
- **`byDeveloper`:** per assignee: assigned, open, inProgress, completed, completedInRange, overdue, completionRate,
  avgResolutionHours.
- **`byType`, `byPriority`, `byStatus`:** counts.

## Websites and team (`/websites`)

| Method | Path | Notes |
|---|---|---|
| GET / POST | `/websites` | `?q=&status=`. Create: `{ name, url, description?, logoUrl?, status? }`. Generates a unique `siteId` and verification token. |
| GET / PATCH / DELETE | `/websites/:id` | `GET` includes `embedScript`, and `verification` for managers. `DELETE` is owner only; it also removes uploaded files. |
| POST | `/websites/:id/regenerate-site-id` · `/websites/:id/verify-domain` | Verification checks the homepage for the meta tag or the installed script (with SSRF protection). |
| GET / PATCH | `/websites/:id/settings` | Fields: `allowedDomains[]`, `widgetEnabled`, `widgetProjectId`, `brandColor`, `clientsCanCreateTasks`, `defaultTaskPriority`, `timezone`, `emailNotifications` |
| GET / POST | `/websites/:id/members` | Add an existing user: `{ email, role }`. Roles: `ADMIN`, `PROJECT_MANAGER`, `DEVELOPER`, `WEBSITE_USER`. |
| PATCH / DELETE | `/websites/:id/members/:userId` | Change role / remove |
| PUT | `/websites/:id/members/:userId/projects` | `{ projects: [{ projectId, role? }] }` |
| GET / POST | `/websites/:id/invitations` (+ `/:invId/resend`, `DELETE /:invId`) | `{ email, role, projectIds? }` |
| GET | `/invitations/:token` · POST `/invitations/accept` `{ token }` | |
| GET | `/websites/:id/performance` | Per-developer statistics (managers) |
| GET / POST | `/websites/:id/projects` | |

## Projects (`/projects`)

| Method | Path | Notes |
|---|---|---|
| GET / POST | `/projects` | Across all your websites (with `progress`). Create: `{ websiteId, name, description?, status?, startDate?, dueDate?, memberIds? }`. |
| GET / PATCH / DELETE | `/projects/:id` | |
| GET / POST / PATCH / DELETE | `/projects/:id/members[/:userId]` | Project roles: `MANAGER`, `CONTRIBUTOR`, `REVIEWER`, `VIEWER` |
| GET / POST | `/projects/:id/tasks` | |

## Tasks (`/tasks`)

| Method | Path | Notes |
|---|---|---|
| GET | `/tasks` | Filters: `scope=all\|mine\|created`, `websiteId`, `projectId`, `status=A,B`, `priority`, `type`, `assigneeId=me\|none\|<id>`, `overdue=true`, `q` (also `TASK-42`), `sort=createdAt\|updatedAt\|dueDate\|priority\|number`, `order`. Archived tasks are excluded unless `status` includes `ARCHIVED`. Each item has `key` (Task ID) and `unreadCount`. |
| POST | `/tasks` | `{ projectId, title, description?, type?, priority?, pageUrl?, status?, assigneeId?, dueDate? }`. Status, assignee and due date need developer or admin rights. |
| GET | `/tasks/:id` | Includes `attachments[]` (signed `url`) and `permissions { update, manage, delete, comment, upload }` |
| PATCH | `/tasks/:id` | Content: `title`, `description`, `type`, `pageUrl` (reporter: own task). Workflow: `status`, `priority`, `assigneeId`, `dueDate` (developers and admins). |
| DELETE | `/tasks/:id` | Also deletes the task's files |
| POST | `/tasks/:id/restore` | Restores an archived task to its previous status |
| GET | `/tasks/:id/activity` | `[{ type, field, previousValue, newValue, changes, actor, createdAt }]` |
| GET | `/tasks/:id/assignees` | Developers and managers that can be assigned |
| POST | `/tasks/:id/read` | Marks comments as read (unread indicators) |
| POST | `/tasks/:id/attachments?kind=screenshot\|file&commentId=` | The raw file is the request body; the name goes in `X-File-Name` (URI-encoded); maximum `MAX_UPLOAD_MB`. The type is detected from the content. |
| DELETE | `/tasks/:id/attachments/:attachmentId` | Uploader or project manager |
| GET / POST | `/tasks/:id/comments` | Chronological, with `isNew` and `attachments[]`. `POST { body, parentId? }` (replies are one level deep). |
| PATCH / DELETE | `/comments/:id` | Edit your own comment / delete your own (managers can delete any) |
| GET | `/comments` | Feed: `?websiteId=&projectId=&q=&mine=true` |

**Statuses:** `OPEN` → `IN_PROGRESS` → `IN_REVIEW` → `COMPLETED`, plus `REOPENED` (only from `COMPLETED` or `ARCHIVED`)
and `ARCHIVED`.

**Types:** `BUG`, `UI_ISSUE`, `FEATURE`, `IMPROVEMENT`, `OTHER`. **Priorities:** `LOW`, `MEDIUM`, `HIGH`, `URGENT`.

## Notifications and files

| Method | Path | Notes |
|---|---|---|
| GET | `/notifications?unreadOnly=true` · `/notifications/unread-count` | |
| PATCH / POST / DELETE | `/notifications/:id/read` · `/notifications/read-all` · `/notifications/:id` | |
| GET | `/files/:id?exp=&sig=` | Signed links that expire after about 2 hours. Images display inline; other files download (`Content-Disposition: attachment`, CSP sandbox, `nosniff`). |

## Review widget API (`/widget`)

The widget API is called from customer websites. CORS is open, but each request's `Origin` must be the website's own
domain or one of its allowed domains. The API never uses cookies.

| Method | Path | Notes |
|---|---|---|
| GET | `/widget/config?siteId=` | Public: site name, brand color and sign-in options. `404 SITE_NOT_FOUND`, `403 DOMAIN_NOT_ALLOWED`, `WIDGET_DISABLED` or `WEBSITE_INACTIVE`. |
| POST | `/widget/auth/login` · `/register` · `/forgot-password` · `/refresh` · `/logout` · `/resend-verification` | Body includes `siteId`. Returns `{ user, session: { accessToken, refreshToken, expiresAt } }`. |
| GET | `/widget/auth/google?siteId=&origin=` | Popup flow; the result is sent with `postMessage` to `origin` only |
| GET | `/widget/me` | `{ user, access: { role, canCreate, projects, defaultProjectId } \| null, counts }` |
| GET / POST | `/widget/tasks` | `?tab=all\|open\|in_progress\|done\|archived&pageUrl=&mine=true&q=` · `{ title, description?, type?, priority?, projectId?, pageUrl, pageTitle?, context? }` |
| GET / PATCH | `/widget/tasks/:id` | Same permission rules as the dashboard |
| GET | `/widget/tasks/:id/activity` · `/assignees` | |
| POST | `/widget/tasks/:id/read` · `/attachments` | |
| DELETE | `/widget/tasks/:id/attachments/:aid` | |
| POST / DELETE | `/widget/tasks/:id/archive` | Archive / restore |
| GET / POST | `/widget/tasks/:id/comments` | |
| PATCH / DELETE | `/widget/comments/:id` | |

## Real-time (Socket.IO)

Socket.IO is served at path `/socket.io` on the API origin.

| Namespace | Authentication | Receives |
|---|---|---|
| `/` (dashboard) | The `wrtm_at` cookie (same checks as REST). The origin must be in `CORS_ORIGINS`. | Events for every task the user can access |
| `/widget` | `auth: { token: <widget access token> }`. The origin must be allowed for that website. | Events for that website's tasks the user can access |

After authentication the server sends `ready`. Each event arrives as `task:event`:

```json
{
  "id": "…", "type": "task.completed", "message": "Dev Daniel completed TASK-12",
  "personal": true,
  "task": { "id": "…", "key": "TASK-12", "title": "…", "status": "COMPLETED", "priority": "HIGH",
            "websiteId": "…", "projectId": "…", "assigneeId": "…", "creatorId": "…" },
  "actor": { "id": "…", "name": "Dev Daniel" }, "commentId": null, "at": "2026-11-20T10:00:00.000Z"
}
```

**Event types:**
- `task.created`, `task.assigned`, `task.started`, `task.status_updated`, `task.completed`, `task.reopened`;
- `comment.created`, `comment.reply`;
- `task.updated` and `task.deleted`, sent so open screens refresh.

**Who receives an event:** each event goes only to users who can see the task (website owners and admins, members of
the task's project, Super Admins). `personal` is true for the reporter, the assignee, and the author being replied to.
Revoking a session (logout, password reset, suspension) disconnects its sockets.
