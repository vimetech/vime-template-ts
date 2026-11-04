/**
 * @vime/db/testing: helpers for integration tests only. Never import this from runtime code.
 */
import { sql } from 'drizzle-orm';
import { Client, escapeIdentifier } from 'pg';
import { connection, type Tx } from '../client';
import { databaseUrl } from '../env';
import { jobSchemaTargetVersion } from '../jobs/install';
import { JOB_QUEUES, JOB_SCHEMA } from '../jobs/queues';
import { pendingMigrations, readJournal, type AppliedMigration } from '../migrate';

export { rlsCatalogAudit } from './rls-audit';
export type { RlsAuditOptions, RlsViolation, RlsViolationKind } from './rls-audit';
export { ensureDatabaseBootstrapped } from '../bootstrap';

/**
 * Runs `fn` in a transaction as `vime_owner` (DATABASE_URL_OWNER): the schema owner, which is not
 * subject to RLS on its own tables. Use it for test fixtures that the app role cannot create, such
 * as throwaway schemas and tables, or raw SQL (`tx.execute(sql.raw('...'))`). Do not use it to
 * prove tenant isolation. Isolation tests must go through withTenant.
 */
export async function withOwner<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return connection('owner').db.transaction(fn);
}

/**
 * Global-setup check of integration test suites: every migration of packages/db/migrations is
 * applied, and the applied history matches the journal (same hashes and order; a database migrated
 * before a migration was rewritten would otherwise run the tests on a stale schema). Throws an
 * actionable error otherwise.
 */
export async function assertMigrationsApplied(): Promise<void> {
  const journal = readJournal();
  const applied = await withOwner(async (tx): Promise<AppliedMigration[]> => {
    const table = await tx.execute<{ exists: boolean }>(
      sql`select to_regclass('drizzle.__drizzle_migrations') is not null as exists`,
    );
    if (!table.rows[0]?.exists) {
      return [];
    }
    const rows = await tx.execute<{ hash: string; created_at: string }>(
      sql`select hash, created_at from drizzle.__drizzle_migrations order by id`,
    );
    return rows.rows.map((row) => ({ hash: row.hash, createdAt: Number(row.created_at) }));
  });
  const pending = pendingMigrations(applied, journal);
  if (pending.length > 0) {
    throw new Error(
      `The test database has ${applied.length} of ${journal.length} migrations applied ` +
        `(pending: ${pending.join(', ')}). Run pnpm db:migrate.`,
    );
  }
}

/**
 * Global-setup check of suites that enqueue jobs: the pg-boss schema is installed at this code's
 * version and every catalog queue exists (`pnpm db:migrate` installs them). Throws an actionable
 * error otherwise.
 */
export async function assertJobSchemaInstalled(): Promise<void> {
  const target = jobSchemaTargetVersion();
  const problem = await withOwner(async (tx): Promise<string | null> => {
    const table = await tx.execute<{ exists: boolean }>(
      sql`select to_regclass(${`${JOB_SCHEMA}.version`}) is not null as exists`,
    );
    if (!table.rows[0]?.exists) {
      return `pg-boss is not installed in schema ${JOB_SCHEMA}`;
    }
    const version = await tx.execute<{ version: number }>(
      sql`select version::int as version from ${sql.identifier(JOB_SCHEMA)}.version`,
    );
    if (version.rows[0]?.version !== target) {
      return `pg-boss schema is at version ${version.rows[0]?.version ?? 'none'}, expected ${target}`;
    }
    const queues = await tx.execute<{ name: string }>(
      sql`select name from ${sql.identifier(JOB_SCHEMA)}.queue`,
    );
    const names = new Set(queues.rows.map((row) => row.name));
    const missing = JOB_QUEUES.filter((queue) => !names.has(queue.name)).map((q) => q.name);
    return missing.length > 0 ? `pg-boss queues are missing: ${missing.join(', ')}` : null;
  });
  if (problem !== null) {
    throw new Error(`${problem}. Run pnpm db:migrate.`);
  }
}

/** A pg-boss job row, as tests inspect it. */
export interface StoredJob {
  id: string;
  name: string;
  state: string;
  data: Record<string, unknown>;
  singletonKey: string | null;
  startAfter: Date;
  createdOn: Date;
  retryLimit: number;
  retryDelay: number;
  retryBackoff: boolean;
}

/**
 * Jobs of queue `name` whose payload contains `data` (jsonb `@>`), oldest first. Read as the schema
 * owner (the runtime roles cannot read payloads through the app role).
 */
export async function findStoredJobs(
  name: string,
  data: Record<string, unknown>,
): Promise<StoredJob[]> {
  const rows = await withOwner((tx) =>
    tx.execute<StoredJob & Record<string, unknown>>(sql`
      select id, name, state::text as state, data, singleton_key as "singletonKey",
             start_after as "startAfter", created_on as "createdOn", retry_limit as "retryLimit",
             retry_delay as "retryDelay", retry_backoff as "retryBackoff"
      from ${sql.identifier(JOB_SCHEMA)}.job
      where name = ${name} and data @> ${JSON.stringify(data)}::jsonb
      order by created_on, id
    `),
  );
  return rows.rows.map((row) => ({
    ...row,
    startAfter: new Date(row.startAfter),
    createdOn: new Date(row.createdOn),
  }));
}

/** Names of the throwaway databases tests create (and may drop). */
const TEST_DATABASE_NAME = /^vime_test_[a-z0-9_]{1,40}$/;

/**
 * Drops a throwaway database a test created (for example by running the release against a fresh
 * database), terminating its connections first. Only names matching `vime_test_*` are accepted,
 * so a shared database can never be dropped by mistake. Connects with DATABASE_URL_ADMIN.
 */
export async function dropTestDatabase(name: string): Promise<void> {
  if (!TEST_DATABASE_NAME.test(name)) {
    throw new Error(`Refusing to drop ${name}: test databases are named vime_test_*.`);
  }
  const client = new Client({
    connectionString: databaseUrl('DATABASE_URL_ADMIN'),
    application_name: 'vime-test-drop',
  });
  await client.connect();
  try {
    await client.query(`DROP DATABASE IF EXISTS ${escapeIdentifier(name)} WITH (FORCE)`);
  } finally {
    await client.end();
  }
}
