-- Custom migration: RLS context functions (ADR 0004). Must run before any policy is created.
--
-- withTenant/withUser set `app.org_id` / `app.user_id` with set_config(..., true) (transaction
-- local). On a pooled connection that used them before, the settings read as '' afterwards, so
-- nullif maps '' (and an unset setting) to NULL: policies then compare with NULL and match zero
-- rows (fail closed). STABLE + plain SQL without SET clauses keeps the functions inlinable in
-- policies; they run with the caller's privileges (no SECURITY DEFINER).
CREATE SCHEMA IF NOT EXISTS app;
--> statement-breakpoint
REVOKE ALL ON SCHEMA app FROM PUBLIC;
--> statement-breakpoint
GRANT USAGE ON SCHEMA app TO vime_app, vime_system;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.current_org_id() RETURNS uuid
  LANGUAGE sql
  STABLE
  PARALLEL SAFE
AS $$
  SELECT nullif(pg_catalog.current_setting('app.org_id', true), '')::uuid
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.current_user_id() RETURNS uuid
  LANGUAGE sql
  STABLE
  PARALLEL SAFE
AS $$
  SELECT nullif(pg_catalog.current_setting('app.user_id', true), '')::uuid
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.current_org_id(), app.current_user_id() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.current_org_id(), app.current_user_id() TO vime_app, vime_system;
