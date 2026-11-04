-- Custom migration: platform RLS policies that are not the standard tenant policy, privileges of
-- vime_app beyond the bootstrap defaults, and SECURITY DEFINER lookups (ADR 0004, ADR 012,
-- ADR 0015).
--
-- Bootstrap grants SELECT/INSERT/UPDATE/DELETE on every new table in public to vime_app and
-- vime_system (default privileges); this file only narrows them.

-- organizations: visible as the current organization, or to a user with an active membership in
-- it (withUser: "my organizations"). Writes only on the current organization. The EXISTS reads
-- memberships under the caller's RLS, whose policy lets a user see their own memberships.
CREATE POLICY "organization_access" ON "organizations" AS PERMISSIVE FOR ALL TO public
  USING (
    id = app.current_org_id()
    OR EXISTS (
      SELECT 1
      FROM public.memberships m
      WHERE m.organization_id = organizations.id
        AND m.user_id = app.current_user_id()
        AND m.status = 'active'
    )
  )
  WITH CHECK (id = app.current_org_id());
--> statement-breakpoint

-- Deleting an organization cascades to all of its data: platform administration only (withSystem).
REVOKE DELETE ON "organizations" FROM vime_app;
--> statement-breakpoint

-- Suspension is platform administration (withSystem, ADR 0015). vime_app keeps UPDATE only on the
-- columns an organization edits itself (updateOrganization), so no organization can lift its own
-- suspension. A new column of organizations needs its own GRANT here, in a later migration.
REVOKE UPDATE ON "organizations" FROM vime_app;
--> statement-breakpoint
GRANT UPDATE ("name", "slug", "timezone", "locale", "settings", "updated_at") ON "organizations" TO vime_app;
--> statement-breakpoint

-- memberships: the current organization's memberships, plus the current user's own memberships in
-- any organization (withUser). Writes only in the current organization.
CREATE POLICY "membership_access" ON "memberships" AS PERMISSIVE FOR ALL TO public
  USING (organization_id = app.current_org_id() OR user_id = app.current_user_id())
  WITH CHECK (organization_id = app.current_org_id());
--> statement-breakpoint

-- activity_events is append-only for the app.
REVOKE UPDATE, DELETE ON "activity_events" FROM vime_app;
--> statement-breakpoint

-- Entitlements are read-only for the app; platform administration writes them through withSystem.
REVOKE INSERT, UPDATE, DELETE ON "organization_entitlements" FROM vime_app;
--> statement-breakpoint

-- Better Auth tables are not tenant tables: only vime_system (withSystem) may touch them.
REVOKE ALL ON "user", "session", "account", "verification" FROM vime_app;
--> statement-breakpoint

-- Name and email of the users that are members of the current organization (members list). vime_app
-- has no access to "user", so this SECURITY DEFINER function (owned by vime_owner, which is not
-- subject to RLS on its own tables) returns only those three columns, only for members of
-- app.current_org_id(). Fixed search_path and fully qualified names (no search_path hijacking).
CREATE OR REPLACE FUNCTION app.organization_member_profiles()
  RETURNS TABLE (user_id uuid, name text, email text)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT u.id, u.name, u.email
  FROM public."user" u
  WHERE EXISTS (
    SELECT 1
    FROM public.memberships m
    WHERE m.user_id = u.id
      AND m.organization_id = app.current_org_id()
  )
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.organization_member_profiles() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.organization_member_profiles() TO vime_app, vime_system;
