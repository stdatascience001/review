-- Task 5: security audit log + indexes for analytics and hot query paths.

CREATE TABLE "audit_logs" (
  "id" UUID NOT NULL,
  "action" VARCHAR(64) NOT NULL,
  "outcome" VARCHAR(16) NOT NULL DEFAULT 'success',
  "actor_id" UUID,
  "actor_email" VARCHAR(320),
  "website_id" UUID,
  "target_type" VARCHAR(32),
  "target_id" VARCHAR(64),
  "status_code" INTEGER,
  "ip_address" VARCHAR(64),
  "user_agent" VARCHAR(512),
  "request_id" VARCHAR(64),
  "metadata" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs"("created_at");
CREATE INDEX "audit_logs_actor_id_created_at_idx" ON "audit_logs"("actor_id", "created_at");
CREATE INDEX "audit_logs_website_id_created_at_idx" ON "audit_logs"("website_id", "created_at");
CREATE INDEX "audit_logs_action_created_at_idx" ON "audit_logs"("action", "created_at");

-- Analytics / listings
CREATE INDEX "tasks_website_id_created_at_idx" ON "tasks"("website_id", "created_at");
CREATE INDEX "tasks_project_id_created_at_idx" ON "tasks"("project_id", "created_at");
CREATE INDEX "tasks_completed_at_idx" ON "tasks"("completed_at");
CREATE INDEX "task_activities_created_at_idx" ON "task_activities"("created_at");
