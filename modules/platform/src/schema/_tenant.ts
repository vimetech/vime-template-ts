import { tenantIsolationPolicy } from '@vime/db';
import { newId } from '@vime/kernel';
import { getTableName, sql, type BuildExtraConfigColumns } from 'drizzle-orm';
import {
  foreignKey,
  pgTable,
  unique,
  uuid,
  type AnyPgColumn,
  type ForeignKeyBuilder,
  type PgColumnBuilderBase,
  type PgTableExtraConfigValue,
} from 'drizzle-orm/pg-core';
import { timestamptz } from './_columns';

export { enumCheck, timestamptz } from './_columns';
import { organizations } from './organizations';

/*
 * Building blocks for tenant tables (ADR 0004). Every module defines its tables with
 * `tenantTable()` (or `tenantTableWithoutId()` for natural composite keys), so that each tenant
 * table gets the same columns, constraints and RLS policy:
 *
 * - `id uuid PRIMARY KEY`, generated in the app as a UUIDv7 (`newId()`), never by the database;
 * - `organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE`
 *   (`<table>_organization_id_fk`);
 * - `created_at timestamptz NOT NULL DEFAULT now()` and `updated_at timestamptz` (NULL until the
 *   first update; Drizzle sets it to `now()` on every `.update()` through `$onUpdate`. Raw SQL
 *   updates and `onConflictDoUpdate` must set it explicitly);
 * - `UNIQUE (organization_id, id)`: the target of composite foreign keys, and the index that starts
 *   with `organization_id` required by the RLS catalog audit;
 * - the `tenant_isolation` policy (USING + WITH CHECK `organization_id = app.current_org_id()`),
 *   which also makes drizzle-kit emit `ENABLE ROW LEVEL SECURITY`.
 *
 * Children reference parents with composite foreign keys (`tenantForeignKey`), so a row of
 * organization A can never point to a row of organization B, not even through the system role.
 */

function organizationIdColumn() {
  return uuid('organization_id').notNull();
}

function timestampColumns() {
  return {
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    // The explicit NULL default stops Drizzle from also applying $onUpdate on insert.
    updatedAt: timestamptz('updated_at')
      .default(sql`null`)
      .$onUpdate(() => sql`now()`),
  };
}

/**
 * Columns of a tenant table. Returns new column builders on every call (one set per table). A table
 * built from these columns without `tenantTable()` must also add `organizationForeignKey()`,
 * `UNIQUE (organization_id, id)` and an RLS policy itself.
 */
export function tenantColumns() {
  return {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => newId()),
    organizationId: organizationIdColumn(),
    ...timestampColumns(),
  };
}

/** Columns of a tenant table keyed by a natural composite primary key (no `id`). */
export function tenantColumnsWithoutId() {
  return {
    organizationId: organizationIdColumn(),
    ...timestampColumns(),
  };
}

export type TenantColumns = ReturnType<typeof tenantColumns>;

/**
 * `organization_id → organizations (id) ON DELETE CASCADE`, named `<table>_organization_id_fk`
 * (Drizzle's default name would exceed Postgres' 63-character limit for longer table names).
 */
export function organizationForeignKey(organizationId: AnyPgColumn): ForeignKeyBuilder {
  return foreignKey({
    name: `${getTableName(organizationId.table)}_organization_id_fk`,
    columns: [organizationId],
    foreignColumns: [organizations.id],
  }).onDelete('cascade');
}
export type TenantColumnsWithoutId = ReturnType<typeof tenantColumnsWithoutId>;

/**
 * Defines a standard tenant table: `tenantColumns()` plus `columns`, `UNIQUE (organization_id, id)`
 * (named `<table>_organization_id_id_unique`), the `tenant_isolation` RLS policy and whatever
 * `extra` returns (indexes, composite foreign keys, checks).
 *
 * ```ts
 * export const notes = tenantTable(
 *   'notes',
 *   { title: text('title').notNull(), folderId: uuid('folder_id') },
 *   (t) => [
 *     index('notes_organization_id_created_at_idx').on(t.organizationId, t.createdAt),
 *     tenantForeignKey(t.organizationId, t.folderId, folders),
 *   ],
 * );
 * ```
 */
export function tenantTable<
  TName extends string,
  TColumns extends Record<string, PgColumnBuilderBase>,
>(
  name: TName,
  columns: TColumns,
  extra?: (
    t: BuildExtraConfigColumns<TName, TenantColumns & TColumns, 'pg'>,
  ) => PgTableExtraConfigValue[],
) {
  const allColumns: TenantColumns & TColumns = { ...tenantColumns(), ...columns };
  return pgTable(name, allColumns, (t) => [
    organizationForeignKey(t.organizationId),
    unique(`${name}_organization_id_id_unique`).on(t.organizationId, t.id),
    tenantIsolationPolicy(),
    ...(extra ? extra(t) : []),
  ]);
}

/**
 * Defines a tenant table without `id`, keyed by a natural composite primary key that `extra` must
 * declare (`primaryKey({ columns: [...] })`). It gets `organization_id`, the timestamps and the
 * `tenant_isolation` policy. The RLS catalog audit requires an index that starts with
 * `organization_id`: either the primary key starts with it, or `extra` adds one.
 */
export function tenantTableWithoutId<
  TName extends string,
  TColumns extends Record<string, PgColumnBuilderBase>,
>(
  name: TName,
  columns: TColumns,
  extra: (
    t: BuildExtraConfigColumns<TName, TenantColumnsWithoutId & TColumns, 'pg'>,
  ) => PgTableExtraConfigValue[],
) {
  const allColumns: TenantColumnsWithoutId & TColumns = { ...tenantColumnsWithoutId(), ...columns };
  return pgTable(name, allColumns, (t) => [
    organizationForeignKey(t.organizationId),
    tenantIsolationPolicy(),
    ...extra(t),
  ]);
}

/** A parent tenant table: anything with `organization_id` and `id` columns. */
export interface TenantParent {
  organizationId: AnyPgColumn;
  id: AnyPgColumn;
}

/**
 * Composite foreign key `(organization_id, <column>) → parent (organization_id, id)`, named
 * `<table>_<column>_fk`. Chain `.onDelete('cascade')` for children that cannot outlive the parent.
 *
 * With the default MATCH SIMPLE, a NULL `<column>` skips the check, so this also works for optional
 * references. Do not use `ON DELETE SET NULL`: it would also null `organization_id`.
 */
export function tenantForeignKey(
  organizationId: AnyPgColumn,
  column: AnyPgColumn,
  parent: TenantParent,
): ForeignKeyBuilder {
  return foreignKey({
    name: `${getTableName(column.table)}_${column.name}_fk`,
    columns: [organizationId, column],
    foreignColumns: [parent.organizationId, parent.id],
  });
}
