import { getTableName, is } from 'drizzle-orm';
import { PgDialect, PgTable, getTableConfig, text, uuid } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import * as schema from './schema';
import { tenantForeignKey, tenantTable } from './schema';

const NOT_TENANT_TABLES = new Set(['organizations', 'user', 'session', 'account', 'verification']);
const dialect = new PgDialect();

const tables = Object.values(schema as Record<string, unknown>).filter((value): value is PgTable =>
  is(value, PgTable),
);

describe('tenantTable()', () => {
  const parents = tenantTable('test_parents', { name: text('name').notNull() });
  const children = tenantTable('test_children', { parentId: uuid('parent_id') }, (t) => [
    tenantForeignKey(t.organizationId, t.parentId, parents).onDelete('cascade'),
  ]);

  it('adds id, organization_id and timestamps', () => {
    const config = getTableConfig(children);
    const columns = Object.fromEntries(config.columns.map((c) => [c.name, c]));
    expect(columns.id?.primary).toBe(true);
    expect(columns.id?.defaultFn?.()).toMatch(/^[0-9a-f-]{36}$/);
    expect(columns.organization_id?.notNull).toBe(true);
    expect(columns.created_at?.notNull).toBe(true);
    expect(columns.updated_at?.notNull).toBe(false);
    expect(columns.updated_at?.onUpdateFn).toBeTypeOf('function');
    expect(columns.parent_id).toBeDefined();
  });

  it('adds UNIQUE (organization_id, id), the organization FK and the tenant policy', () => {
    const config = getTableConfig(children);
    expect(
      config.uniqueConstraints.map((u) => [u.getName(), u.columns.map((c) => c.name)]),
    ).toEqual([['test_children_organization_id_id_unique', ['organization_id', 'id']]]);
    const fks = config.foreignKeys.map((fk) => {
      const ref = fk.reference();
      return {
        name: fk.getName(),
        columns: ref.columns.map((c) => c.name),
        foreignTable: getTableName(ref.foreignTable),
        foreignColumns: ref.foreignColumns.map((c) => c.name),
        onDelete: fk.onDelete,
      };
    });
    expect(fks).toEqual([
      {
        name: 'test_children_organization_id_fk',
        columns: ['organization_id'],
        foreignTable: 'organizations',
        foreignColumns: ['id'],
        onDelete: 'cascade',
      },
      {
        name: 'test_children_parent_id_fk',
        columns: ['organization_id', 'parent_id'],
        foreignTable: 'test_parents',
        foreignColumns: ['organization_id', 'id'],
        onDelete: 'cascade',
      },
    ]);
    expect(config.policies).toHaveLength(1);
    const [policy] = config.policies;
    expect(policy?.name).toBe('tenant_isolation');
    expect(policy?.for).toBe('all');
    const render = (value: Parameters<PgDialect['sqlToQuery']>[0] | undefined) =>
      value ? dialect.sqlToQuery(value).sql : undefined;
    expect(render(policy?.using)).toBe('organization_id = app.current_org_id()');
    expect(render(policy?.withCheck)).toBe('organization_id = app.current_org_id()');
  });
});

describe('platform schema', () => {
  it('every tenant table has organization_id, UNIQUE/PK leading with it and an RLS policy', () => {
    const tenantTables = tables.filter((table) => !NOT_TENANT_TABLES.has(getTableName(table)));
    expect(tenantTables.map((t) => getTableName(t)).sort()).toEqual([
      'activity_events',
      'idempotency_keys',
      'invitations',
      'memberships',
      'notifications',
      'ops_flags',
      'organization_entitlements',
    ]);
    for (const table of tenantTables) {
      const config = getTableConfig(table);
      const name = config.name;
      const organizationId = config.columns.find((c) => c.name === 'organization_id');
      expect(organizationId?.notNull, name).toBe(true);
      expect(
        config.foreignKeys.some((fk) => fk.getName() === `${name}_organization_id_fk`),
        name,
      ).toBe(true);
      // memberships' special policy lives in the custom migration (0001_platform_policies).
      if (name === 'memberships') {
        expect(config.enableRLS, name).toBe(true);
      } else {
        expect(
          config.policies.map((p) => p.name),
          name,
        ).toEqual(['tenant_isolation']);
      }
      // Composite FKs always include organization_id first.
      for (const fk of config.foreignKeys) {
        const columns = fk.reference().columns.map((c) => c.name);
        if (columns.length > 1) {
          expect(columns[0], `${name}.${fk.getName()}`).toBe('organization_id');
        }
      }
    }
  });

  it('constraint names fit in 63 characters', () => {
    for (const table of tables) {
      const config = getTableConfig(table);
      const names = [
        ...config.foreignKeys.map((fk) => fk.getName()),
        ...config.uniqueConstraints.map((u) => u.getName() ?? ''),
        ...config.indexes.map((i) => i.config.name ?? ''),
        ...config.checks.map((c) => c.name),
      ];
      for (const constraint of names) {
        expect(constraint.length, constraint).toBeLessThanOrEqual(63);
      }
    }
  });

  it('exposes the Better Auth tables under their model names, with uuid ids', () => {
    expect(Object.keys(schema.authSchema)).toEqual(['user', 'session', 'account', 'verification']);
    for (const table of Object.values(schema.authSchema)) {
      const config = getTableConfig(table);
      const id = config.columns.find((c) => c.name === 'id');
      expect(id?.getSQLType(), config.name).toBe('uuid');
      expect(config.policies, config.name).toEqual([]);
      expect(config.enableRLS, config.name).toBe(false);
    }
  });
});
