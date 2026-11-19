-- Dashboard → review widget sign-in handoff ("Show on page" from the dashboard):
-- single-use, short-lived tickets stored hashed in auth_tokens.
ALTER TYPE "AuthTokenType" ADD VALUE IF NOT EXISTS 'WIDGET_HANDOFF';
