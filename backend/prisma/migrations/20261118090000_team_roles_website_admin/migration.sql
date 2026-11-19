-- Task 2: team roles, website administration (status, site id, logo, domain verification), invitations.

-- Website team roles: MEMBER -> DEVELOPER, CLIENT -> WEBSITE_USER (renamed in place, data preserved),
-- plus a new PROJECT_MANAGER role.
ALTER TYPE "WebsiteRole" RENAME VALUE 'MEMBER' TO 'DEVELOPER';
ALTER TYPE "WebsiteRole" RENAME VALUE 'CLIENT' TO 'WEBSITE_USER';
ALTER TYPE "WebsiteRole" ADD VALUE 'PROJECT_MANAGER' BEFORE 'DEVELOPER';
ALTER TABLE "website_members" ALTER COLUMN "role" SET DEFAULT 'DEVELOPER';

-- Website administration fields
CREATE TYPE "WebsiteStatus" AS ENUM ('ACTIVE', 'INACTIVE');

ALTER TABLE "websites"
  ADD COLUMN "logo_url" VARCHAR(2048),
  ADD COLUMN "status" "WebsiteStatus" NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN "site_id" VARCHAR(40),
  ADD COLUMN "verification_token" VARCHAR(64),
  ADD COLUMN "domain_verified_at" TIMESTAMP(3);

-- Backfill existing websites with random identifiers, then enforce NOT NULL.
UPDATE "websites" SET
  "site_id" = 'site_' || substr(md5(random()::text || "id"::text), 1, 20),
  "verification_token" = md5(random()::text || clock_timestamp()::text || "id"::text)
WHERE "site_id" IS NULL;

ALTER TABLE "websites" ALTER COLUMN "site_id" SET NOT NULL;
ALTER TABLE "websites" ALTER COLUMN "verification_token" SET NOT NULL;
CREATE UNIQUE INDEX "websites_site_id_key" ON "websites"("site_id");
CREATE INDEX "websites_status_idx" ON "websites"("status");
ALTER TABLE "websites" ADD CONSTRAINT "websites_site_id_format_chk" CHECK ("site_id" ~ '^site_[a-z0-9]{12,32}$');

-- Invitations
CREATE TABLE "website_invitations" (
    "id" UUID NOT NULL,
    "website_id" UUID NOT NULL,
    "email" VARCHAR(320) NOT NULL,
    "role" "WebsiteRole" NOT NULL,
    "project_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "token_hash" CHAR(64) NOT NULL,
    "invited_by_id" UUID,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "accepted_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "website_invitations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "website_invitations_email_lowercase_chk" CHECK ("email" = lower("email")),
    CONSTRAINT "website_invitations_not_owner_chk" CHECK ("role" <> 'OWNER')
);

CREATE UNIQUE INDEX "website_invitations_token_hash_key" ON "website_invitations"("token_hash");
CREATE INDEX "website_invitations_website_id_email_idx" ON "website_invitations"("website_id", "email");
CREATE INDEX "website_invitations_email_idx" ON "website_invitations"("email");
-- At most one pending invitation per email per website.
CREATE UNIQUE INDEX "website_invitations_one_pending_idx" ON "website_invitations"("website_id", "email")
  WHERE "accepted_at" IS NULL AND "revoked_at" IS NULL;

ALTER TABLE "website_invitations" ADD CONSTRAINT "website_invitations_website_id_fkey"
  FOREIGN KEY ("website_id") REFERENCES "websites"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "website_invitations" ADD CONSTRAINT "website_invitations_invited_by_id_fkey"
  FOREIGN KEY ("invited_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
