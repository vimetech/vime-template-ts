import { randomBytes } from 'node:crypto';
import { newId } from '@vime/kernel';
import { sql } from 'drizzle-orm';
import { Client, escapeIdentifier } from 'pg';
import { getMigrationPlans, getRollbackPlans, type PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, withSystem, withTenant } from '../client';
import { assertJobSchemaInstalled, findStoredJobs, withOwner } from '../testing';
import {
  installJobSchema,
  jobSchemaGrantStatements,
  jobSchemaTargetVersion,
  splitMigrationPlan,
} from './install';
import { JOB_QUEUES, JOB_QUEUE_NAMES, JOB_SCHEMA, jobQueue } from './queues';
import { PgBossJobDispatcher, startJobBoss } from './runtime';

const silent = { onError: () => {}, onWarning: () => {} };

describe('job queue catalog', () => {
  it('has unique names, and a singleton queue for the example job', () => {
    const names = JOB_QUEUES.map((queue) => queue.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.sort()).toEqual(Object.values(JOB_QUEUE_NAMES).sort());
    expect(jobQueue('example.note.created')?.policy).toBe('stately');
    expect(jobQueue('platform.purge')?.policy).toBe('standard');
    expect(jobQueue('nope')).toBeUndefined();
    for (const queue of JOB_QUEUES) {
      expect(queue.name).toMatch(/^[a-z]+(\.[a-z]+)+$/);
      expect(queue.retryLimit).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('splitMigrationPlan', () => {
  it('separates the inlined CONCURRENTLY index builds from the transactional block', () => {
    const plan = splitMigrationPlan(getMigrationPlans(JOB_SCHEMA, 38));
    expect(plan.transactional).toMatch(/BEGIN;[\s\S]*COMMIT;\s*$/);
    expect(plan.transactional).not.toMatch(/CONCURRENTLY/);
    expect(plan.concurrent.length).toBeGreaterThanOrEqual(1);
    for (const statement of plan.concurrent) {
      expect(statement).toMatch(
        /^-- inlined from [^\n]+\n(CREATE (UNIQUE )?INDEX|DROP INDEX) CONCURRENTLY /,
      );
      expect(statement).not.toMatch(/;/);
    }
    const plain = 'BEGIN;\nSELECT 1;\nCOMMIT;';
    expect(splitMigrationPlan(plain)).toEqual({ transactional: plain, concurrent: [] });
  });
});

describe('jobSchemaGrantStatements', () => {
  it('gives the app role only what an INSERT ... RETURNING id needs', () => {
    const statements = jobSchemaGrantStatements(['job_common']).join('\n');
    expect(statements).toContain('REVOKE ALL ON ALL TABLES IN SCHEMA "pgboss" FROM "vime_app"');
    expect(statements).toContain(
      'GRANT SELECT ON "pgboss"."version", "pgboss"."queue" TO "vime_app"',
    );
    expect(statements).toContain(
      'GRANT INSERT ON "pgboss"."job", "pgboss"."job_common" TO "vime_app"',
    );
    expect(statements).toContain('GRANT SELECT (id) ON "pgboss"."job", "pgboss"."job_common"');
    expect(statements).not.toMatch(/GRANT [^\n]*(UPDATE|DELETE)[^\n]*"vime_app"/);
  });
});

describe('pg-boss on the shared database', () => {
  let producer: PgBoss;
  let worker: PgBoss;
  let dispatcher: PgBossJobDispatcher;

  beforeAll(async () => {
    await assertJobSchemaInstalled();
    producer = await startJobBoss({ mode: 'producer', ...silent });
    worker = await startJobBoss({ mode: 'worker', ...silent, overrides: { supervise: false } });
    dispatcher = new PgBossJobDispatcher(producer);
  });

  afterAll(async () => {
    await producer?.stop({ graceful: false });
    await worker?.stop({ graceful: false });
    await closeDb();
  });

  it('enqueues inside the tenant transaction: committed → one job, rolled back → none', async () => {
    const orgId = newId();
    const committed = newId();
    const rolledBack = newId();
    await withTenant({ orgId }, (tx) =>
      dispatcher.dispatch(tx, {
        name: 'example.note.created',
        data: { orgId, noteId: committed },
        singletonKey: `note:${committed}`,
        startAfterSeconds: 5,
      }),
    );
    await expect(
      withTenant({ orgId }, async (tx) => {
        await dispatcher.dispatch(tx, {
          name: 'example.note.created',
          data: { orgId, noteId: rolledBack },
          singletonKey: `note:${rolledBack}`,
        });
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');

    expect(await findStoredJobs('example.note.created', { noteId: rolledBack })).toEqual([]);
    const [job, ...others] = await findStoredJobs('example.note.created', {
      noteId: committed,
    });
    expect(others).toEqual([]);
    expect(job).toMatchObject({
      state: 'created',
      data: { orgId, noteId: committed },
      singletonKey: `note:${committed}`,
      // Retry policy of the catalog (queue defaults).
      retryLimit: 5,
      retryDelay: 5,
      retryBackoff: true,
    });
    const delayMs = job!.startAfter.getTime() - job!.createdOn.getTime();
    expect(delayMs).toBeGreaterThanOrEqual(4_000);
    expect(delayMs).toBeLessThanOrEqual(6_000);
  });

  it('coalesces a second dispatch with the same singleton key while one is queued', async () => {
    const orgId = newId();
    const noteId = newId();
    const job = {
      name: 'example.note.created',
      data: { orgId, noteId },
      singletonKey: `note:${noteId}`,
      startAfterSeconds: 5,
    };
    const first = await withTenant({ orgId }, (tx) => dispatcher.sendInTransaction(tx, job));
    const second = await withTenant({ orgId }, (tx) => dispatcher.sendInTransaction(tx, job));
    expect(first).toEqual(expect.any(String));
    expect(second).toBeNull();
    expect(await findStoredJobs('example.note.created', { noteId })).toHaveLength(1);
  });

  it('holds the queued job while a coalesced dispatch is uncommitted, so it cannot start first', async () => {
    const orgId = newId();
    const noteId = newId();
    const job = {
      name: 'example.note.created',
      data: { orgId, noteId },
      singletonKey: `note:${noteId}`,
      // Far enough that no worker running on this database picks it up during the test.
      startAfterSeconds: 300,
    };
    const first = await withTenant({ orgId }, (tx) => dispatcher.sendInTransaction(tx, job));
    expect(first).toEqual(expect.any(String));
    // The lock pg-boss's fetch takes (`FOR UPDATE ... SKIP LOCKED`), on this job only.
    const fetchable = async () =>
      (
        await withOwner((tx) =>
          tx.execute<{ id: string }>(sql`
            select id from pgboss.job
            where name = 'example.note.created' and id = ${first} and state = 'created'
            for update skip locked
          `),
        )
      ).rows.map((row) => row.id);
    expect(await fetchable()).toEqual([first]);

    let release = () => {};
    const released = new Promise<void>((resolve) => (release = resolve));
    let reportSent = (_id: string | null) => {};
    const sent = new Promise<string | null>((resolve) => (reportSent = resolve));
    // A transaction changes data and asks for the same derivation: coalesced into the queued job.
    const writer = withTenant({ orgId }, async (tx) => {
      reportSent(await dispatcher.sendInTransaction(tx, job));
      await released;
    });
    try {
      expect(await sent).toBeNull();
      // Until it commits, a worker skips the queued job (it would read the data before the change).
      expect(await fetchable()).toEqual([]);
    } finally {
      release();
      await writer;
    }
    expect(await fetchable()).toEqual([first]);
    expect(await findStoredJobs('example.note.created', { noteId })).toHaveLength(1);
    await withOwner((tx) => tx.execute(sql`delete from pgboss.job where id = ${first}`));
  });

  it('rejects unknown queues and payloads without orgId before touching the database', async () => {
    const orgId = newId();
    await withTenant({ orgId }, async (tx) => {
      await expect(dispatcher.dispatch(tx, { name: 'nope.nope', data: { orgId } })).rejects.toThrow(
        /Unknown job queue nope\.nope/,
      );
      await expect(
        dispatcher.dispatch(tx, {
          name: 'example.note.created',
          data: { orgId: '' },
        }),
      ).rejects.toThrow(/must carry data.orgId/);
    });
  });

  it('lets the app role insert jobs but not read, change or delete them, nor manage queues', async () => {
    const orgId = newId();
    const denied = async (statement: ReturnType<typeof sql>) => {
      await expect(withTenant({ orgId }, (tx) => tx.execute(statement))).rejects.toMatchObject({
        cause: expect.objectContaining({ code: '42501' }),
      });
    };
    await denied(sql`select data from pgboss.job limit 1`);
    await denied(sql`update pgboss.job set state = 'cancelled' where false`);
    await denied(sql`delete from pgboss.job where false`);
    await denied(sql`select * from pgboss.schedule`);
    await denied(sql`insert into pgboss.queue (name) values ('x')`);
    await denied(sql`select pgboss.create_queue('x', '{"policy":"standard"}'::jsonb)`);
  });

  it('lets the worker role run the job lifecycle: fetch, complete, fail, cancel, delete', async () => {
    // A throwaway queue, so jobs left by other suites on the shared database do not interfere.
    const queue = `vime-test-${randomBytes(6).toString('hex')}`;
    await worker.createQueue(queue, { retryLimit: 0 });
    try {
      const first = await worker.send(queue, { n: 1 });
      const second = await worker.send(queue, { n: 2 });
      const fetched = await worker.fetch(queue, { batchSize: 10 });
      expect(fetched.map((job) => job.id).sort()).toEqual([first, second].sort());
      await worker.complete(queue, first!);
      await worker.fail(queue, second!, { reason: 'test' });
      const third = await worker.send(queue, { n: 3 });
      await worker.cancel(queue, third!);
      await worker.deleteJob(queue, third!);
      const states = await worker.findJobs<{ n: number }>(queue);
      expect(states.map((job) => [job.data.n, job.state]).sort()).toEqual([
        [1, 'completed'],
        [2, 'failed'],
      ]);
    } finally {
      await worker.deleteQueue(queue);
    }
  });

  it('is installed with the expected owner and grants', async () => {
    const owner = await withSystem((tx) =>
      tx.execute<{ owner: string; app: boolean; system: boolean; publicUsage: boolean }>(sql`
        select pg_get_userbyid(nspowner) as owner,
               has_schema_privilege('vime_app', 'pgboss', 'USAGE') as app,
               has_schema_privilege('vime_system', 'pgboss', 'USAGE') as system,
               has_schema_privilege('public', 'pgboss', 'USAGE') as "publicUsage"
        from pg_namespace where nspname = 'pgboss'
      `),
    );
    expect(owner.rows[0]).toEqual({
      owner: 'vime_owner',
      app: true,
      system: true,
      publicUsage: false,
    });
    const privileges = await withOwner((tx) =>
      tx.execute<{ grantee: string; table: string; privileges: string }>(sql`
        select grantee, table_name as table, string_agg(privilege_type, ',' order by privilege_type) as privileges
        from information_schema.role_table_grants
        where table_schema = 'pgboss' and grantee = 'vime_app'
        group by grantee, table_name order by table_name
      `),
    );
    expect(privileges.rows).toEqual([
      { grantee: 'vime_app', table: 'job', privileges: 'INSERT' },
      { grantee: 'vime_app', table: 'job_common', privileges: 'INSERT' },
      { grantee: 'vime_app', table: 'queue', privileges: 'SELECT' },
      { grantee: 'vime_app', table: 'version', privileges: 'SELECT' },
    ]);
    // The coalescing fence: the app may call it (it only locks a queued job), PUBLIC may not.
    const fence = await withOwner((tx) =>
      tx.execute<{ app: boolean; publicExecute: boolean; definer: boolean }>(sql`
        select has_function_privilege('vime_app', p.oid, 'EXECUTE') as app,
               has_function_privilege('public', p.oid, 'EXECUTE') as "publicExecute",
               p.prosecdef as definer
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'pgboss' and p.proname = 'vime_hold_queued_job'
      `),
    );
    expect(fence.rows).toEqual([{ app: true, publicExecute: false, definer: true }]);
  });
});

// Installs into a throwaway database (needs the admin URL to create it), so the shared database's
// pg-boss schema is never rolled back.
describe.skipIf(!process.env.DATABASE_URL_ADMIN)('installJobSchema on a new database', () => {
  it('installs, is idempotent, and upgrades an older schema (CONCURRENTLY builds included)', async () => {
    const adminUrl = process.env.DATABASE_URL_ADMIN ?? '';
    const ownerUrl = process.env.DATABASE_URL_OWNER ?? '';
    const database = `vime_jobs_test_${randomBytes(6).toString('hex')}`;
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`create database ${escapeIdentifier(database)} owner vime_owner`);
    const target = new URL(ownerUrl);
    target.pathname = `/${database}`;
    process.env.DATABASE_URL_OWNER = target.toString();
    const lines: string[] = [];
    const log = (line: string) => lines.push(line);
    try {
      const first = await installJobSchema({ log });
      expect(first).toMatchObject({ action: 'installed', version: jobSchemaTargetVersion() });
      expect(first.queuesCreated.sort()).toEqual(JOB_QUEUES.map((q) => q.name).sort());

      const second = await installJobSchema({ log });
      expect(second).toMatchObject({ action: 'none', queuesCreated: [], queuesUpdated: [] });

      // Roll back to an older pg-boss schema and drift a queue option: the next run upgrades the
      // schema (running the inlined CONCURRENTLY builds on their own) and restores the option.
      const check = new Client({ connectionString: target.toString() });
      await check.connect();
      try {
        const from = 40;
        for (let version = jobSchemaTargetVersion(); version > from; version -= 1) {
          await check.query(getRollbackPlans(JOB_SCHEMA, version));
        }
        await check.query(`update pgboss.queue set retry_limit = 99 where name = 'platform.purge'`);
        const before = await check.query<{ index: boolean }>(
          `select to_regclass('pgboss.job_common_i12') is not null as index`,
        );
        expect(before.rows[0]?.index).toBe(false);

        const third = await installJobSchema({ log });
        expect(third).toMatchObject({
          action: 'migrated',
          previousVersion: from,
          queuesUpdated: ['platform.purge'],
        });
        const state = await check.query<{ version: number; retry: number; index: boolean }>(`
          select (select version::int from pgboss.version) as version,
                 (select retry_limit from pgboss.queue where name = 'platform.purge') as retry,
                 to_regclass('pgboss.job_common_i12') is not null as index
        `);
        expect(state.rows[0]).toEqual({
          version: jobSchemaTargetVersion(),
          retry: jobQueue('platform.purge')?.retryLimit,
          index: true,
        });
      } finally {
        await check.end();
      }
    } finally {
      process.env.DATABASE_URL_OWNER = ownerUrl;
      await admin.query(`drop database if exists ${escapeIdentifier(database)} with (force)`);
      await admin.end();
    }
  });
});
