# Review Widget: Installation Guide

The Review widget adds a **Review** button to the bottom-right corner of your website. Your team and clients use it
to leave comments on pages (with a screenshot), track their status, and reply, all without leaving the site.

## 1. Get your embed script

1. In the admin dashboard, open **Websites** and choose your website.
2. On the **Overview & embed** tab, click **Copy** next to *Embed script*.

The script looks like this:

```html
<script
  src="https://YOUR-DOMAIN.com/widget.js"
  data-site-id="site_3f9a0c1d2e4b5a6c7d8e"
  async>
</script>
```

| Attribute | Meaning |
|---|---|
| `src` | The widget loader (about 3 KB gzipped). |
| `data-site-id` | Your website's unique, **public** Site ID. It identifies the website; it is not a password. |
| `async` | Loads without blocking your page. |
| `data-api-url` | Only present when the script is served from a CDN on a different domain than the API. |

The same tab has a copy-ready **Installation guide** for each platform below.

## 2. Install it

Add the script **once per page**, ideally just before `</body>`. Including it more than once is harmless: only one widget
starts.

### HTML / static sites

Paste the snippet before `</body>` in your template (or on every page).

### WordPress

**Option A, with a plugin (no code).** Install a header/footer plugin such as *WPCode* and paste the snippet into the
**Footer** box.

**Option B, in a child theme.** Add this to `functions.php` so it survives theme updates:

```php
add_action('wp_footer', function () {
  ?>
  <script src="https://YOUR-DOMAIN.com/widget.js" data-site-id="YOUR_SITE_ID" async></script>
  <?php
});
```

### React (Vite, Create React App, React Router)

Add it once, in your root component:

```tsx
import { useEffect } from 'react';

export default function App() {
  useEffect(() => {
    if (document.querySelector('script[data-site-id="YOUR_SITE_ID"]')) return;
    const s = document.createElement('script');
    s.src = 'https://YOUR-DOMAIN.com/widget.js';
    s.async = true;
    s.dataset.siteId = 'YOUR_SITE_ID';
    document.body.appendChild(s);
  }, []);
  return <>{/* your app */}</>;
}
```

Alternatively, paste the plain snippet into `index.html`.

### Next.js

App Router (`app/layout.tsx`). With the Pages Router, put the same `<Script>` in `pages/_app.tsx`.

```tsx
import Script from 'next/script';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
        <Script src="https://YOUR-DOMAIN.com/widget.js" data-site-id="YOUR_SITE_ID" strategy="lazyOnload" />
      </body>
    </html>
  );
}
```

### Astro

In your base layout (`src/layouts/Layout.astro`). `is:inline` stops Astro from bundling the script.

```astro
<script is:inline async src="https://YOUR-DOMAIN.com/widget.js" data-site-id="YOUR_SITE_ID"></script>
```

### Other platforms

- **Site builders** (Webflow, Shopify, Wix, Squarespace, Framer…): paste the snippet into the site-wide custom code
  (footer) setting.
- **Google Tag Manager:** create a *Custom HTML* tag containing the snippet, with the trigger *All Pages*.
- **Vue, Angular, Svelte and other single-page apps:** add the snippet to `index.html`. Page changes made with the
  History API are detected automatically.

## 3. Allow your domains

For security, the widget only runs on:

- the host of the website URL you registered (with or without `www.`), and
- the domains listed under **Websites → Settings → Allowed domains**, such as `staging.example.com`, `*.example.com`
  or `localhost`.

On any other domain the widget adds nothing to the page and logs a console warning such as
`[Review widget] The review widget is not allowed on other.com`.

Other settings under **Settings**:
- **Review widget enabled** turns the widget on or off without removing the script.
- **Project for widget feedback** picks the project that new comments go to.
- **Brand color** sets the button and accent color.
- **Website users can create tasks** controls whether clients can add new comments.

## 4. Check that it works

1. Reload your site. A **Review** button appears at the bottom-right.
2. Click it, then **Sign in** with your dashboard account. You can also sign in with Google or create an account.
3. Click **Add a Comment**. The page URL, title and a screenshot are captured automatically.
4. The comment appears in the widget and in the dashboard under **All Tasks**, together with the screenshot, the
   browser and the viewport size.
5. Optional: **Websites → Overview → Verify domain** confirms the script is installed on your home page.

## Who can see what

| Visitor | Sees |
|---|---|
| Not signed in | The Review button and a sign-in prompt. No comments are visible. |
| Signed in, not a team member | A "No access to this website" message. Creating an account never grants access. |
| Website User (client) | Comments in the projects they're assigned to. They can create tasks, follow their progress, reply, edit or delete their own comments, add screenshots to their own tasks, and view the history. |
| Developer / Project Manager | Comments in their projects. They can also start tasks, change status and priority, assign developers, complete, reopen and archive. |
| Owner / Admin / Super Admin | Every comment on the website. |

To give someone access, invite them under **Team Members** and assign them a project.

## Using the widget

- **Header:** "Review Comments", the number of open comments, and a close button (Esc also closes it).
- **Tabs:** All · Open (open and reopened) · In Progress (in progress and under review) · Done (completed) · Archived. Each tab shows
  its count.
- **Filters:**
  - **All Pages / This Page**: "This Page" follows in-app navigation and ignores query strings and `#hash`.
  - **Mine**: comments you created or that are assigned to you.
  - **Search**: matches title, description and page URL.
- **Each card shows:**
  - the author's avatar and name;
  - Task ID (e.g. `TASK-42`), title, status badge, type and priority;
  - an unread marker ("2 new") when someone replied since you last looked;
  - page link and created date;
  - description and screenshot preview;
  - **Reply**, **Archive / Restore** (developers and admins, with confirmation) and **View details** buttons.
- **Task details** (click a card):
  - progress (Open → In progress → Under review → Completed, or Reopened);
  - priority, assignee, type, reporter, dates and page;
  - screenshots and files;
  - comments with replies, attachments, "New" markers, and editing or deleting your own comments;
  - the full history.
  - Developers and admins also get **Start task**, **Send to review**, **Mark completed**, **Reopen** and **Archive**, plus
    status, priority and assignee pickers.
- **Footer:**
  - **Add a Comment** opens the task form. The page URL and title, the website, you and the time are captured
    automatically. The form has:
    - task title, description, type (Bug, UI issue, Feature request, Improvement, Other) and priority (Low, Medium, High,
      Urgent);
    - a screenshot, either **Capture this page** or **Upload image**, with a preview;
    - additional files (images, PDF, ZIP, Office documents or text, up to 10 MB each).
  - your profile, with **Sign out**.

On phones (screens narrower than 640 px) the panel opens full-screen.

## Live updates

Signed-in reviewers get updates in real time, with no page reloads and no polling:
- **Statuses and badge:** card statuses, the Review button's open-task badge and an open task's details update as the
  team works.
- **While the popup is closed:** a short bubble above the Review button announces events that concern you. For example
  "Dev Daniel completed TASK-12", or a reply to your comment. Clicking it opens the popup.
- **While the popup is open:** the same events appear as a notification inside it.

Events only reach people who can see the task, and only on that website's widget.

## Performance and impact on your site

- **Small to load:**
  - At page load the browser fetches only `widget.js` (about 3.5 KB gzipped) and one cached config request.
  - The loader waits until your page has finished loading and the browser is idle.
- **Loaded only when needed:**
  - Anonymous visitors download the React panel (about 79 KB gzipped) only when they hover over or click the button.
  - Signed-in reviewers get it in idle time, so their live updates work.
  - The task form, task details and sign-in each load as small separate chunks (2–5 KB) the first time they're used.
  - The live-update client (about 13 KB) and the screenshot library (about 5 KB) are fetched only when needed.
  - Content-hashed files are cached for a year.
- **Lighter uploads:** images wider than 2560 px or larger than 1.5 MB are downscaled and re-encoded (WebP) in the
  browser before upload.
- **No interference with your site:**
  - The widget lives in a single `<wrtm-review-widget>` element with a Shadow DOM, so your CSS can't change it and
    its CSS can't change your site.
  - It adds no global styles, nothing to `<head>`, no cookies, and no changes to `history` or other globals. The only
    global is `window.__wrtmReviewWidget`, the duplicate guard and a small API: `.open()`, `.close()`, `.version`.
- **No repeated loading:** a page that includes the script several times still gets one widget.

## Security

- **The Site ID is public.** It only identifies the website. Every comment, screenshot and action requires a signed-in
  team member with access to that website.
- **Sessions are bound to one website:**
  - The tokens issued to the widget work only for that website's widget API.
  - They are rejected by the dashboard API and can't be turned into a dashboard session. A token taken from a
    customer's page therefore can't be used anywhere else.
  - Tokens are stored in that site's `localStorage` (key `wrtm-widget:<siteId>`).
  - Access tokens expire after 15 minutes. Refresh tokens rotate on every use, and signing out revokes the session.
- **Domain policy:** each request's Origin is checked against the website's allowed domains.
- **Google sign-in:**
  - It opens in a popup on the API's domain.
  - The result is sent back with `postMessage`, only to the origin that was validated when sign-in started.
- **Screenshots:**
  - The server checks the file content (PNG, JPEG or WebP only).
  - Screenshots are stored outside the web root and served only through signed links that expire.
- **Rate limits:** all endpoints are rate-limited, with stricter limits for sign-in.

## Troubleshooting

| Symptom | Fix |
|---|---|
| No button, and the console says *not allowed on …* | Add that domain under **Settings → Allowed domains**. |
| No button, and the console says *turned off* or *inactive* | Turn on **Review widget enabled**, or activate the website. |
| No button, and the console says *missing or invalid data-site-id* | Copy the snippet again. Did you regenerate the Site ID? |
| Script blocked by Content-Security-Policy | Allow your widget domain in `script-src`, in `connect-src` (`https:` and `wss:` for live updates) and in `img-src` (screenshots). |
| "Your browser blocked the sign-in popup" | Allow popups for the site, or sign in with email and password. |
| A signed-in user sees no comments | They need to be a team member assigned to a project. Invite them under **Team Members**. |
| A screenshot shows blank images | Images from other domains that don't allow CORS can't be captured (a browser restriction). Attach an image instead. |

## For developers: the widget API

All endpoints are under `/api/v1/widget`. Signed-in calls use `Authorization: Bearer <widget access token>`.

| Method and path | Purpose |
|---|---|
| `GET /config?siteId=` | Public: checks the Site ID and domain, and returns the site name, brand color and sign-in options. |
| `POST /auth/login`, `/auth/register`, `/auth/forgot-password` | Task 1 authentication, issuing a session bound to this website (`{ siteId, … }`). |
| `POST /auth/refresh` · `POST /auth/logout` · `POST /auth/resend-verification` | Session management. |
| `GET /auth/google?siteId=&origin=` | Starts Google sign-in in a popup. |
| `GET /me` | The user, their access (role, projects, whether they can create comments) and open counts. |
| `GET /tasks?tab=&pageUrl=&mine=&q=&page=` | Comment cards plus the count for each tab. |
| `POST /tasks` | Creates a task: `title`, `description`, `type`, `priority`, `projectId?`, `pageUrl`, `pageTitle`, `context`. Returns its Task ID (`key`). |
| `GET` / `PATCH /tasks/:id` | Task details; updates the title or description (reporter), or the status, priority or assignee (developers and admins). |
| `GET /tasks/:id/activity` · `GET /tasks/:id/assignees` · `POST /tasks/:id/read` | History · assignable developers · mark comments read. |
| `POST /tasks/:id/attachments?kind=screenshot\|file&commentId=` | Uploads the raw file body (name in `X-File-Name`); the server checks the real type. `DELETE /tasks/:id/attachments/:attachmentId` removes one. |
| `POST` / `DELETE /tasks/:id/archive` | Archives the task, or restores it to its previous status. |
| `GET` / `POST /tasks/:id/comments` · `PATCH` / `DELETE /comments/:id` | Comments and replies (`parentId`); edit or delete your own. |

The demo site in [`demo-site/`](../demo-site) is a separate customer website used to test all of this. See the
README for how to run it.
