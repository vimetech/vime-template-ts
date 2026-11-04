import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { bootstrapDatabase, parseConnectionTarget } from './bootstrap';
import { closeDb, withSystem } from './client';
import { withOwner } from './testing';

afterAll(async () => {
  await closeDb();
});

describe('parseConnectionTarget', () => {
  it('reads the percent-decoded user, password and database', () => {
    const target = parseConnectionTarget(
      'postgres://vime_app:s%40cr%3Aet@localhost:5432/vime_dev?sslmode=disable',
      'DATABASE_URL',
      'vime_app',
    );
    expect(target).toEqual({ user: 'vime_app', password: 's@cr:et', database: 'vime_dev' });
  });

  it('rejects a URL for another role without echoing the password', () => {
    const run = () =>
      parseConnectionTarget('postgres://someone:topsecret@h/vime', 'DATABASE_URL', 'vime_app');
    expect(run).toThrow(/DATABASE_URL must connect as role vime_app/);
    expect(run).not.toThrow(/topsecret/);
  });

  it('requires a password and a database name', () => {
    expect(() =>
      parseConnectionTarget('postgres://vime_app@h/vime', 'DATABASE_URL', 'vime_app'),
    ).toThrow(/must include a password/);
    expect(() =>
      parseConnectionTarget('postgres://vime_app:pw@h:5432', 'DATABASE_URL', 'vime_app'),
    ).toThrow(/must include a database name/);
  });
});

describe('bootstrapped database', () => {
  it('has the three roles with the expected attributes', async () => {
    const roles = await withSystem(async (tx) => {
      const result = await tx.execute(sql`
        select rolname, rolcanlogin, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb
        from pg_roles
        where rolname in ('vime_owner', 'vime_app', 'vime_system')
        order by rolname
      `);
      return result.rows;
    });
    const base = { rolcanlogin: true, rolsuper: false, rolcreaterole: false, rolcreatedb: false };
    expect(roles).toEqual([
      { rolname: 'vime_app', ...base, rolbypassrls: false },
      { rolname: 'vime_owner', ...base, rolbypassrls: false },
      { rolname: 'vime_system', ...base, rolbypassrls: true },
    ]);
  });

  it('is owned by vime_owner, and only vime_owner can create in schema public', async () => {
    const row = await withSystem(async (tx) => {
      const result = await tx.execute(sql`
        select pg_get_userbyid(d.datdba) as db_owner,
               has_schema_privilege('vime_owner', 'public', 'CREATE') as owner_create,
               has_schema_privilege('vime_app', 'public', 'USAGE') as app_usage,
               has_schema_privilege('vime_app', 'public', 'CREATE') as app_create,
               has_schema_privilege('vime_system', 'public', 'USAGE') as system_usage,
               has_schema_privilege('vime_system', 'public', 'CREATE') as system_create,
               exists (
                 select 1
                 from pg_namespace n, aclexplode(n.nspacl) acl
                 where n.nspname = 'public' and acl.grantee = 0 and acl.privilege_type = 'CREATE'
               ) as public_create
        from pg_database d
        where d.datname = current_database()
      `);
      return result.rows[0];
    });
    expect(row).toEqual({
      db_owner: 'vime_owner',
      owner_create: true,
      app_usage: true,
      app_create: false,
      system_usage: true,
      system_create: false,
      public_create: false,
    });
  });

  it('grants CRUD, sequence and function privileges on new owner objects to app and system', async () => {
    const name = `default_privileges_probe_${randomBytes(6).toString('hex')}`;
    const table = `public.${name}`;
    const fn = `public.${name}_fn()`;
    // Created and dropped in the same transaction, so no other session ever sees these objects.
    const rows = await withOwner(async (tx) => {
      await tx.execute(
        sql.raw(`create table ${table} (id integer generated always as identity primary key)`),
      );
      await tx.execute(sql.raw(`create function ${fn} returns integer language sql as 'select 1'`));
      const result = await tx.execute(sql`
        select role.name as role,
               priv.name as privilege,
               has_table_privilege(role.name, ${table}, priv.name) as granted
        from unnest(array['vime_app', 'vime_system']) as role(name),
             unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'])
               as priv(name)
        union all
        select role.name, 'SEQUENCE ' || priv.name,
               has_sequence_privilege(role.name, pg_get_serial_sequence(${table}, 'id'), priv.name)
        from unnest(array['vime_app', 'vime_system']) as role(name),
             unnest(array['USAGE', 'SELECT', 'UPDATE']) as priv(name)
        union all
        select role.name, 'EXECUTE', has_function_privilege(role.name, ${fn}, 'EXECUTE')
        from unnest(array['vime_app', 'vime_system']) as role(name)
      `);
      await tx.execute(sql.raw(`drop function ${fn}`));
      await tx.execute(sql.raw(`drop table ${table}`));
      return result.rows;
    });

    const granted = (role: string) =>
      rows
        .filter((r) => r.role === role && r.granted === true)
        .map((r) => r.privilege)
        .sort();
    const expected = [
      'DELETE',
      'EXECUTE',
      'INSERT',
      'SELECT',
      'SEQUENCE SELECT',
      'SEQUENCE USAGE',
      'UPDATE',
    ];
    expect(granted('vime_app')).toEqual(expected);
    expect(granted('vime_system')).toEqual(expected);
  });

  it.skipIf(!process.env.DATABASE_URL_ADMIN)('can be re-run safely', async () => {
    const lines: string[] = [];
    await bootstrapDatabase({ log: (line) => lines.push(line) });
    const output = lines.join('\n');
    expect(output).toMatch(/updated role vime_owner/);
    expect(output).toMatch(/updated role vime_app .*NOBYPASSRLS/);
    expect(output).toMatch(/updated role vime_system .* BYPASSRLS/);
    expect(output).toMatch(/database \S+ already exists \(owner vime_owner\)/);
    expect(output).not.toMatch(/created/);
  });
});
