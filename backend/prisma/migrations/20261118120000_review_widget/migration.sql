-- Review widget (Task 3)

-- Site-bound widget sessions
ALTER TABLE "user_sessions" ADD COLUMN "website_id" UUID;
CREATE INDEX "user_sessions_website_id_idx" ON "user_sessions"("website_id");
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_website_id_fkey"
  FOREIGN KEY ("website_id") REFERENCES "websites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Widget settings
ALTER TABLE "website_settings" ADD COLUMN "widget_enabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "website_settings" ADD COLUMN "widget_project_id" UUID;
ALTER TABLE "website_settings" ADD CONSTRAINT "website_settings_widget_project_id_fkey"
  FOREIGN KEY ("widget_project_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Archiving
ALTER TABLE "tasks" ADD COLUMN "archived_at" TIMESTAMP(3);
CREATE INDEX "tasks_website_id_archived_at_idx" ON "tasks"("website_id", "archived_at");
