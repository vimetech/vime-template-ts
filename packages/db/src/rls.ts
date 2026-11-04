import { sql } from 'drizzle-orm';
import { pgPolicy, type PgPolicy } from 'drizzle-orm/pg-core';

/**
 * Generic RLS building blocks for module schemas (ADR 0004). The `tenantTable()` helper, which adds
 * `organization_id` with its FK to organizations, lives in modules/platform because @vime/db cannot
 * import module schemas.
 *
 * `app.current_org_id()` and `app.current_user_id()` are created by a custom migration as STABLE
 * functions over `nullif(current_setting('app.org_id' | 'app.user_id', true), '')`. Without a
 * context they return NULL, so policies match zero rows (fail closed).
 */

/** The organization of the current transaction (set by withTenant), or NULL. */
export const currentOrgIdSql = sql`app.current_org_id()`;

/** The acting user of the current transaction (set by withTenant/withUser), or NULL. */
export const currentUserIdSql = sql`app.current_user_id()`;

export const TENANT_ISOLATION_POLICY = 'tenant_isolation';

/**
 * The standard tenant policy: `CREATE POLICY <name> ON <table> AS PERMISSIVE FOR ALL TO public
 * USING (organization_id = app.current_org_id()) WITH CHECK (organization_id = app.current_org_id())`.
 *
 * Use it in a table's extra config (`(t) => [tenantIsolationPolicy()]`). drizzle-kit then also emits
 * `ENABLE ROW LEVEL SECURITY` for the table. Returns a new policy on every call, because Drizzle links
 * each policy object to a single table.
 */
export function tenantIsolationPolicy(name: string = TENANT_ISOLATION_POLICY): PgPolicy {
  const predicate = sql`organization_id = ${currentOrgIdSql}`;
  return pgPolicy(name, {
    as: 'permissive',
    for: 'all',
    to: 'public',
    using: predicate,
    withCheck: predicate,
  });
}
