import { getTableConfig, PgDialect, pgTable, uuid } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { currentOrgIdSql, currentUserIdSql, tenantIsolationPolicy } from './rls';

const dialect = new PgDialect();

describe('tenantIsolationPolicy', () => {
  it('is a permissive FOR ALL policy to public with USING and WITH CHECK on the current org', () => {
    const policy = tenantIsolationPolicy();
    expect(policy.name).toBe('tenant_isolation');
    expect(policy.as).toBe('permissive');
    expect(policy.for).toBe('all');
    expect(policy.to).toBe('public');
    const expected = { sql: 'organization_id = app.current_org_id()', params: [] };
    expect(policy.using && dialect.sqlToQuery(policy.using)).toEqual(expected);
    expect(policy.withCheck && dialect.sqlToQuery(policy.withCheck)).toEqual(expected);
  });

  it('accepts a custom name and returns a new policy on every call', () => {
    expect(tenantIsolationPolicy('orders_tenant').name).toBe('orders_tenant');
    expect(tenantIsolationPolicy()).not.toBe(tenantIsolationPolicy());
  });

  it('attaches to a table through the extra config', () => {
    const things = pgTable(
      'things',
      { id: uuid('id').primaryKey(), organizationId: uuid('organization_id').notNull() },
      () => [tenantIsolationPolicy()],
    );
    const { policies } = getTableConfig(things);
    expect(policies.map((p) => p.name)).toEqual(['tenant_isolation']);
  });
});

describe('context SQL fragments', () => {
  it('render the app.* context functions', () => {
    expect(dialect.sqlToQuery(currentOrgIdSql).sql).toBe('app.current_org_id()');
    expect(dialect.sqlToQuery(currentUserIdSql).sql).toBe('app.current_user_id()');
  });
});
