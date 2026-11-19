-- Task 4: task workflow statuses, task types, Task IDs, activity values, attachment kinds, unread markers.
-- Enums are rebuilt (create new type → convert column → drop old) so existing data is mapped explicitly.

-- ── Activity types (new values first: used below) ──
CREATE TYPE "TaskActivityType_new" AS ENUM (
  'CREATED', 'UPDATED', 'STATUS_CHANGED', 'STARTED', 'COMPLETED', 'REOPENED', 'ARCHIVED', 'RESTORED',
  'PRIORITY_CHANGED', 'ASSIGNED', 'UNASSIGNED', 'COMMENTED', 'COMMENT_EDITED', 'COMMENT_DELETED',
  'ATTACHMENT_ADDED', 'ATTACHMENT_REMOVED'
);
ALTER TABLE "task_activities" ALTER COLUMN "type" TYPE "TaskActivityType_new" USING ("type"::text::"TaskActivityType_new");
DROP TYPE "TaskActivityType";
ALTER TYPE "TaskActivityType_new" RENAME TO "TaskActivityType";

ALTER TABLE "task_activities"
  ADD COLUMN "field" VARCHAR(40),
  ADD COLUMN "previous_value" TEXT,
  ADD COLUMN "new_value" TEXT;

-- ── Task status ── RESOLVED/CLOSED → COMPLETED; archived tasks → ARCHIVED (previous status kept in history)
INSERT INTO "task_activities" ("id", "task_id", "actor_id", "type", "field", "previous_value", "new_value", "changes", "created_at")
SELECT gen_random_uuid(), t."id", NULL, 'ARCHIVED', 'status', s.prev, 'ARCHIVED',
       jsonb_build_object('status', jsonb_build_object('from', s.prev, 'to', 'ARCHIVED')), t."archived_at"
FROM "tasks" t
CROSS JOIN LATERAL (SELECT CASE WHEN t."status"::text IN ('RESOLVED', 'CLOSED') THEN 'COMPLETED' ELSE t."status"::text END AS prev) s
WHERE t."archived_at" IS NOT NULL;

CREATE TYPE "TaskStatus_new" AS ENUM ('OPEN', 'IN_PROGRESS', 'IN_REVIEW', 'COMPLETED', 'REOPENED', 'ARCHIVED');
ALTER TABLE "tasks" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "tasks" ALTER COLUMN "status" TYPE "TaskStatus_new" USING (
  CASE
    WHEN "archived_at" IS NOT NULL THEN 'ARCHIVED'
    WHEN "status"::text IN ('RESOLVED', 'CLOSED') THEN 'COMPLETED'
    ELSE "status"::text
  END
)::"TaskStatus_new";
ALTER TABLE "tasks" ALTER COLUMN "status" SET DEFAULT 'OPEN';
DROP TYPE "TaskStatus";
ALTER TYPE "TaskStatus_new" RENAME TO "TaskStatus";

-- ── Task type ── DESIGN → UI_ISSUE, CONTENT → IMPROVEMENT, FEEDBACK → OTHER
CREATE TYPE "TaskType_new" AS ENUM ('BUG', 'UI_ISSUE', 'FEATURE', 'IMPROVEMENT', 'OTHER');
ALTER TABLE "tasks" ALTER COLUMN "type" DROP DEFAULT;
ALTER TABLE "tasks" ALTER COLUMN "type" TYPE "TaskType_new" USING (
  CASE "type"::text
    WHEN 'DESIGN' THEN 'UI_ISSUE'
    WHEN 'CONTENT' THEN 'IMPROVEMENT'
    WHEN 'FEEDBACK' THEN 'OTHER'
    ELSE "type"::text
  END
)::"TaskType_new";
ALTER TABLE "tasks" ALTER COLUMN "type" SET DEFAULT 'OTHER';
DROP TYPE "TaskType";
ALTER TYPE "TaskType_new" RENAME TO "TaskType";

-- ── Task ID ── sequential, unique (existing tasks numbered by creation time)
CREATE SEQUENCE "tasks_number_seq";
ALTER TABLE "tasks" ADD COLUMN "number" INTEGER;
UPDATE "tasks" t SET "number" = n.rn
FROM (SELECT "id", row_number() OVER (ORDER BY "created_at", "id") AS rn FROM "tasks") n
WHERE t."id" = n."id";
SELECT setval('"tasks_number_seq"', COALESCE((SELECT max("number") FROM "tasks"), 0) + 1, false);
ALTER TABLE "tasks" ALTER COLUMN "number" SET DEFAULT nextval('"tasks_number_seq"');
ALTER TABLE "tasks" ALTER COLUMN "number" SET NOT NULL;
ALTER SEQUENCE "tasks_number_seq" OWNED BY "tasks"."number";
CREATE UNIQUE INDEX "tasks_number_key" ON "tasks"("number");

-- ── Attachment kind ──
CREATE TYPE "AttachmentKind" AS ENUM ('SCREENSHOT', 'FILE');
ALTER TABLE "task_attachments" ADD COLUMN "kind" "AttachmentKind" NOT NULL DEFAULT 'FILE';
UPDATE "task_attachments" SET "kind" = 'SCREENSHOT' WHERE "comment_id" IS NULL AND "mime_type" LIKE 'image/%';

-- ── Unread markers ──
CREATE TABLE "task_reads" (
  "task_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "last_read_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "task_reads_pkey" PRIMARY KEY ("task_id", "user_id")
);
CREATE INDEX "task_reads_user_id_idx" ON "task_reads"("user_id");
ALTER TABLE "task_reads" ADD CONSTRAINT "task_reads_task_id_fkey"
  FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "task_reads" ADD CONSTRAINT "task_reads_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
