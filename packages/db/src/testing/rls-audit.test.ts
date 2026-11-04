import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { closeDb } from '../client';
import { evaluateTenantTable, type RlsViolation } from './rls-audit';
import { rlsCatalogAudit, withOwner } from './index';

// Fixtures live in throwaway schemas created as vime_owner, one per test, and dropped at the end.
// They never touch public, so the public audit below stays meaningful while these tests run.
const schemas: string[] = [];

async function createSchema(...statements: string[]): Promise<string> {
  const schema = `vime_audit_test_${randomBytes(6).toString('hex')}`;
  schemas.push(schema);
  await withOwner(async (tx) => {
    await tx.execute(sql.raw(`create schema ${schema}`));
    for (const statement of statements) {
      await tx.execute(sql.raw(statement.replaceAll('$schema', schema)));
    }
  });
  return schema;
}

const kinds = (violations: RlsViolation[]) =>
  violations.map((v) => `${v.table}:${v.kind}${v.policy ? `:${v.policy}` : ''}`).sort();

// Stand-in for app.current_org_id(), which a later migration creates.
const ORG = `nullif(current_setting('app.org_id', true), '')::uuid`;

afterAll(async () => {
  await withOwner(async (tx) => {
    for (const schema of schemas) {
      await tx.execute(sql.raw(`drop schema if exists ${schema} cascade`));
    }
  });
  await closeDb();
});

describe('rlsCatalogAudit', () => {
  it('every tenant table in public passes (the CI gate)', async () => {
    expect(await rlsCatalogAudit()).toEqual([]);
  });

  it('returns no violations for an empty schema', async () => {
    const schema = await createSchema();
    expect(await rlsCatalogAudit({ schemas: [schema] })).toEqual([]);
  });

  it('flags a tenant table without RLS, policy or organization index', async () => {
    const schema = await createSchema(
      `create table $schema.leaky (id uuid primary key, organization_id uuid not null)`,
      `create table $schema.not_a_tenant_table (id uuid primary key)`,
    );
    const violations = await rlsCatalogAudit({ schemas: [schema] });
    expect(kinds(violations)).toEqual([
      'leaky:no_organization_index',
      'leaky:no_policy',
      'leaky:rls_disabled',
    ]);
    expect(violations[0]?.schema).toBe(schema);
    expect(violations.map((v) => v.message).join('\n')).toContain(`${schema}.leaky`);
  });

  it('flags policies missing USING or WITH CHECK and ignores partial indexes', async () => {
    const schema = await createSchema(
      `create table $schema.half (id uuid primary key, organization_id uuid not null)`,
      `alter table $schema.half enable row level security`,
      `create policy using_only on $schema.half for all to public using (organization_id = ${ORG})`,
      `create policy insert_only on $schema.half for insert to public with check (organization_id = ${ORG})`,
      `create index half_org_partial on $schema.half (organization_id) where id is not null`,
    );
    expect(kinds(await rlsCatalogAudit({ schemas: [schema] }))).toEqual([
      'half:no_organization_index',
      'half:policy_without_using:insert_only',
      'half:policy_without_with_check:using_only',
    ]);
  });

  it('accepts a compliant tenant table; UNIQUE (organization_id, id) counts as the index', async () => {
    const schema = await createSchema(
      `create table $schema.good (
         id uuid primary key,
         organization_id uuid not null,
         constraint good_org_id_unique unique (organization_id, id)
       )`,
      `alter table $schema.good enable row level security`,
      `create policy tenant_isolation on $schema.good as permissive for all to public
         using (organization_id = ${ORG}) with check (organization_id = ${ORG})`,
    );
    expect(await rlsCatalogAudit({ schemas: [schema] })).toEqual([]);
  });

  it('only audits the requested schemas', async () => {
    const schema = await createSchema(
      `create table $schema.leaky (id uuid primary key, organization_id uuid not null)`,
    );
    const empty = await createSchema();
    expect(await rlsCatalogAudit({ schemas: [empty] })).toEqual([]);
    expect(await rlsCatalogAudit({ schemas: [] })).toEqual([]);
    expect((await rlsCatalogAudit({ schemas: [empty, schema] })).length).toBeGreaterThan(0);
  });
});

describe('evaluateTenantTable', () => {
  const compliant = {
    schema: 'public',
    table: 'tasks',
    owner: 'vime_owner',
    rlsEnabled: true,
    hasOrganizationIndex: true,
    policies: [{ name: 'tenant_isolation', hasUsing: true, hasWithCheck: true }],
  };

  it('accepts a compliant table', () => {
    expect(evaluateTenantTable(compliant)).toEqual([]);
  });

  it('flags a table owned by vime_app', () => {
    expect(evaluateTenantTable({ ...compliant, owner: 'vime_app' })).toEqual([
      {
        schema: 'public',
        table: 'tasks',
        kind: 'owned_by_app_role',
        message: 'public.tasks: is owned by vime_app, which bypasses its RLS',
      },
    ]);
  });
});
