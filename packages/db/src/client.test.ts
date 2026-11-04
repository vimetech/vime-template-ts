import { newId } from '@vime/kernel';
import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  closeDb,
  connection,
  createAuthDatabase,
  pingDb,
  withSystem,
  withTenant,
  withUser,
  type Tx,
} from './client';

interface SessionRow extends Record<string, unknown> {
  org_id: string | null;
  user_id: string | null;
  role: string;
  pid: number;
  bypass_rls: boolean;
  superuser: boolean;
}

async function readSession(tx: Tx): Promise<SessionRow> {
  const result = await tx.execute<SessionRow>(sql`
    select current_setting('app.org_id', true) as org_id,
           current_setting('app.user_id', true) as user_id,
           current_user as role,
           pg_backend_pid() as pid,
           r.rolbypassrls as bypass_rls,
           r.rolsuper as superuser
    from pg_roles r
    where r.rolname = current_user
  `);
  const row = result.rows[0];
  if (!row) {
    throw new Error('no session row');
  }
  return row;
}

/**
 * Reads the settings on the next connection the app pool hands out without opening a transaction
 * or setting anything. pg-pool reuses the most recently released idle client, so this is the
 * connection the previous withTenant/withUser call used. The pid proves it.
 */
async function readPooledConnection(): Promise<{ pid: number; org_id: string; user_id: string }> {
  const client = await connection('app').pool.connect();
  try {
    const result = await client.query<{ pid: number; org_id: string; user_id: string }>(
      `select pg_backend_pid() as pid,
              current_setting('app.org_id', true) as org_id,
              current_setting('app.user_id', true) as user_id`,
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error('no row');
    }
    return row;
  } finally {
    client.release();
  }
}

afterAll(async () => {
  await closeDb();
});

describe('withTenant', () => {
  it('sets app.org_id and app.user_id inside the transaction, as vime_app without BYPASSRLS', async () => {
    const orgId = newId();
    const userId = newId();
    const session = await withTenant({ orgId, userId }, readSession);
    expect(session).toMatchObject({
      org_id: orgId,
      user_id: userId,
      role: 'vime_app',
      bypass_rls: false,
      superuser: false,
    });
  });

  it("sets app.user_id to '' when there is no actor", async () => {
    const orgId = newId();
    expect(await withTenant({ orgId }, readSession)).toMatchObject({ org_id: orgId, user_id: '' });
    expect(await withTenant({ orgId, userId: null }, readSession)).toMatchObject({ user_id: '' });
  });

  it("leaves '' (never the previous org) on the pooled connection after the transaction", async () => {
    const inside = await withTenant({ orgId: newId(), userId: newId() }, readSession);
    const after = await readPooledConnection();
    expect(after.pid).toBe(inside.pid);
    expect(after.org_id).toBe('');
    expect(after.user_id).toBe('');
  });

  it('normalizes ids to lowercase', async () => {
    const orgId = newId();
    const session = await withTenant({ orgId: orgId.toUpperCase() }, readSession);
    expect(session.org_id).toBe(orgId);
  });

  it.each([
    '',
    'not-a-uuid',
    "x', true); drop table users; --",
    '0190b5e6-7c7a-7d8e-9f00-12345678zzzz',
  ])('rejects orgId %j before touching the database', async (orgId) => {
    const fn = vi.fn(async () => 'never');
    await expect(withTenant({ orgId }, fn)).rejects.toThrow(TypeError);
    expect(fn).not.toHaveBeenCalled();
  });

  it('rejects a non-UUID userId', async () => {
    const fn = vi.fn(async () => 'never');
    await expect(withTenant({ orgId: newId(), userId: 'user-1' }, fn)).rejects.toThrow(
      /userId must be a UUID/,
    );
    expect(fn).not.toHaveBeenCalled();
  });

  it('keeps concurrent transactions isolated from each other', async () => {
    const orgIds = Array.from({ length: 8 }, () => newId());
    const seen = await Promise.all(
      orgIds.map((orgId) =>
        withTenant({ orgId }, async (tx) => {
          await tx.execute(sql`select pg_sleep(0.02)`);
          return (await readSession(tx)).org_id;
        }),
      ),
    );
    expect(seen).toEqual(orgIds);
  });

  it('returns the callback result and rolls back when the callback throws', async () => {
    expect(await withTenant({ orgId: newId() }, async () => 42)).toBe(42);

    const table = `rollback_probe_${newId().replaceAll('-', '').slice(-12)}`;
    const boom = new Error('boom');
    let pid = 0;
    await expect(
      withTenant({ orgId: newId() }, async (tx) => {
        pid = (await readSession(tx)).pid;
        await tx.execute(sql.raw(`create temp table ${table} (x int)`));
        throw boom;
      }),
    ).rejects.toBe(boom);

    const client = await connection('app').pool.connect();
    try {
      const result = await client.query<{ pid: number; exists: boolean }>(
        'select pg_backend_pid() as pid, to_regclass($1) is not null as exists',
        [`pg_temp.${table}`],
      );
      expect(result.rows[0]).toEqual({ pid, exists: false });
    } finally {
      client.release();
    }
  });
});

describe('withUser', () => {
  it("sets only app.user_id (app.org_id is '')", async () => {
    const userId = newId();
    const session = await withUser(userId, readSession);
    expect(session).toMatchObject({ org_id: '', user_id: userId, role: 'vime_app' });
  });

  it('rejects a non-UUID userId', async () => {
    const fn = vi.fn(async () => 'never');
    await expect(withUser('abc', fn)).rejects.toThrow(TypeError);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('withSystem', () => {
  it('runs as vime_system with BYPASSRLS and no tenant context', async () => {
    const session = await withSystem(readSession);
    expect(session.role).toBe('vime_system');
    expect(session.bypass_rls).toBe(true);
    expect(session.superuser).toBe(false);
    expect(session.org_id ?? '').toBe('');
    expect(session.user_id ?? '').toBe('');
  });
});

describe('createAuthDatabase', () => {
  it('runs as vime_system on its own pool (application_name vime-auth) with no tenant context', async () => {
    const db = createAuthDatabase();
    expect(createAuthDatabase()).toBe(db);
    const result = await db.execute<{
      role: string;
      app: string;
      bypass_rls: boolean;
      org_id: string | null;
    }>(sql`
      select current_user as role,
             current_setting('application_name') as app,
             r.rolbypassrls as bypass_rls,
             current_setting('app.org_id', true) as org_id
      from pg_roles r
      where r.rolname = current_user
    `);
    const row = result.rows[0];
    expect(row?.role).toBe('vime_system');
    expect(row?.app).toBe('vime-auth');
    expect(row?.bypass_rls).toBe(true);
    expect(row?.org_id ?? '').toBe('');
  });

  it('gives a handle on a new pool after closeDb', async () => {
    const before = createAuthDatabase();
    await closeDb();
    const after = createAuthDatabase();
    expect(after).not.toBe(before);
    await expect(after.execute(sql`select 1`)).resolves.toBeDefined();
  });
});

describe('pingDb and closeDb', () => {
  it('pings, closes, and lazily reconnects', async () => {
    await expect(pingDb()).resolves.toBeUndefined();
    await closeDb();
    await expect(pingDb()).resolves.toBeUndefined();
    const orgId = newId();
    expect((await withTenant({ orgId }, readSession)).org_id).toBe(orgId);
  });
});
