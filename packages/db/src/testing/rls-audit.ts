import { sql } from 'drizzle-orm';
import { withSystem } from '../client';
import { DB_ROLES } from '../roles';

/**
 * RLS catalog audit (ADR 0004, architecture.md §3.5). Every table that has an `organization_id`
 * column is a tenant table and must:
 *
 * - have row level security enabled;
 * - have at least one policy, and every policy must have both USING and WITH CHECK. Write tenant
 *   policies FOR ALL (see tenantIsolationPolicy). FOR SELECT/INSERT-only policies cannot carry
 *   both clauses, so they are reported;
 * - have a valid, non-partial index whose first column is `organization_id` (the
 *   UNIQUE(organization_id, id) constraint index counts);
 * - not be owned by vime_app (an owner bypasses its own table's RLS).
 */

export type RlsViolationKind =
  | 'rls_disabled'
  | 'no_policy'
  | 'policy_without_using'
  | 'policy_without_with_check'
  | 'no_organization_index'
  | 'owned_by_app_role';

export interface RlsViolation {
  schema: string;
  table: string;
  kind: RlsViolationKind;
  /** The policy name, for policy-level violations. */
  policy?: string;
  message: string;
}

/** @internal Catalog facts about one table with an organization_id column. */
export interface TenantTableFacts {
  schema: string;
  table: string;
  owner: string;
  rlsEnabled: boolean;
  hasOrganizationIndex: boolean;
  policies: { name: string; hasUsing: boolean; hasWithCheck: boolean }[];
}

/** @internal Pure rule evaluation, separate from the catalog query so it can be unit tested. */
export function evaluateTenantTable(facts: TenantTableFacts): RlsViolation[] {
  const { schema, table } = facts;
  const name = `${schema}.${table}`;
  const violations: RlsViolation[] = [];
  const add = (kind: RlsViolationKind, message: string, policy?: string) => {
    violations.push({ schema, table, kind, message, ...(policy === undefined ? {} : { policy }) });
  };

  if (!facts.rlsEnabled) {
    add('rls_disabled', `${name}: row level security is not enabled`);
  }
  if (facts.policies.length === 0) {
    add('no_policy', `${name}: has no RLS policy`);
  }
  for (const policy of facts.policies) {
    if (!policy.hasUsing) {
      add(
        'policy_without_using',
        `${name}: policy ${policy.name} has no USING clause`,
        policy.name,
      );
    }
    if (!policy.hasWithCheck) {
      add(
        'policy_without_with_check',
        `${name}: policy ${policy.name} has no WITH CHECK clause`,
        policy.name,
      );
    }
  }
  if (!facts.hasOrganizationIndex) {
    add('no_organization_index', `${name}: no index starts with organization_id`);
  }
  if (facts.owner === DB_ROLES.app) {
    add('owned_by_app_role', `${name}: is owned by ${DB_ROLES.app}, which bypasses its RLS`);
  }
  return violations;
}

interface CatalogRow extends Record<string, unknown> {
  schema: string;
  table: string;
  owner: string;
  rls_enabled: boolean;
  has_organization_index: boolean;
  policies: TenantTableFacts['policies'];
}

export interface RlsAuditOptions {
  /** Schemas to audit. Defaults to ['public']. */
  schemas?: readonly string[];
}

/**
 * Returns every RLS violation among the tables (and partitioned tables) with an `organization_id`
 * column in `schemas`. An empty array means the catalog passes. Reads the catalog through the
 * system pool, so it sees every table regardless of grants.
 */
export async function rlsCatalogAudit({ schemas = ['public'] }: RlsAuditOptions = {}): Promise<
  RlsViolation[]
> {
  if (schemas.length === 0) {
    return [];
  }
  const schemaList = sql.join(
    schemas.map((schema) => sql`${schema}`),
    sql`, `,
  );
  const result = await withSystem((tx) =>
    tx.execute<CatalogRow>(sql`
      select n.nspname as schema,
             c.relname as table,
             pg_get_userbyid(c.relowner) as owner,
             c.relrowsecurity as rls_enabled,
             exists (
               select 1
               from pg_index i
               where i.indrelid = c.oid
                 and i.indkey[0] = a.attnum
                 and i.indpred is null
                 and i.indisvalid
             ) as has_organization_index,
             coalesce(
               (select json_agg(
                         json_build_object(
                           'name', p.polname,
                           'hasUsing', p.polqual is not null,
                           'hasWithCheck', p.polwithcheck is not null
                         ) order by p.polname)
                from pg_policy p
                where p.polrelid = c.oid),
               '[]'::json
             ) as policies
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a
        on a.attrelid = c.oid
       and a.attname = 'organization_id'
       and a.attnum > 0
       and not a.attisdropped
      where c.relkind in ('r', 'p')
        and n.nspname in (${schemaList})
      order by n.nspname, c.relname
    `),
  );
  return result.rows.flatMap((row) =>
    evaluateTenantTable({
      schema: row.schema,
      table: row.table,
      owner: row.owner,
      rlsEnabled: row.rls_enabled,
      hasOrganizationIndex: row.has_organization_index,
      policies: row.policies,
    }),
  );
}
