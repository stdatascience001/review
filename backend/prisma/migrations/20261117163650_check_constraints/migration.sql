-- Data-integrity CHECK constraints (not expressible in the Prisma schema language).

-- Emails are normalised to lower case by the application; enforce it in the DB too.
ALTER TABLE "users" ADD CONSTRAINT "users_email_lowercase_chk" CHECK ("email" = lower("email"));
ALTER TABLE "users" ADD CONSTRAINT "users_failed_login_attempts_chk" CHECK ("failed_login_attempts" >= 0);
ALTER TABLE "users" ADD CONSTRAINT "users_name_not_blank_chk" CHECK (length(btrim("name")) > 0);

ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_expiry_chk" CHECK ("expires_at" > "created_at");
ALTER TABLE "auth_tokens" ADD CONSTRAINT "auth_tokens_expiry_chk" CHECK ("expires_at" > "created_at");

ALTER TABLE "websites" ADD CONSTRAINT "websites_slug_format_chk" CHECK ("slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$');
ALTER TABLE "websites" ADD CONSTRAINT "websites_name_not_blank_chk" CHECK (length(btrim("name")) > 0);

ALTER TABLE "website_settings" ADD CONSTRAINT "website_settings_brand_color_chk"
  CHECK ("brand_color" IS NULL OR "brand_color" ~ '^#[0-9A-Fa-f]{6}$');

ALTER TABLE "projects" ADD CONSTRAINT "projects_dates_chk"
  CHECK ("start_date" IS NULL OR "due_date" IS NULL OR "due_date" >= "start_date");
ALTER TABLE "projects" ADD CONSTRAINT "projects_name_not_blank_chk" CHECK (length(btrim("name")) > 0);

ALTER TABLE "tasks" ADD CONSTRAINT "tasks_title_not_blank_chk" CHECK (length(btrim("title")) > 0);
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_position_chk" CHECK ("position" >= 0);

ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_body_not_blank_chk" CHECK (length(btrim("body")) > 0);
ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_not_self_parent_chk" CHECK ("parent_id" IS NULL OR "parent_id" <> "id");

ALTER TABLE "task_attachments" ADD CONSTRAINT "task_attachments_size_chk" CHECK ("size_bytes" >= 0);

-- A Website's owner must always also be an OWNER member (kept in sync by the app);
-- partial unique index guarantees at most one OWNER membership per website.
CREATE UNIQUE INDEX "website_members_single_owner_idx" ON "website_members" ("website_id") WHERE "role" = 'OWNER';

-- Fast lookup of a user's active (non-revoked) sessions.
CREATE INDEX "user_sessions_active_idx" ON "user_sessions" ("user_id") WHERE "revoked_at" IS NULL;
