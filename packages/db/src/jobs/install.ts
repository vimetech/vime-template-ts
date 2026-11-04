import { createRequire } from 'node:module';
import { Client, escapeIdentifier } from 'pg';
import { PgBoss, getConstructionPlans, getMigrationPlans, type Db } from 'pg-boss';
import { databaseUrl } from '../env';
import { DB_ROLES } from '../roles';
import { queueDrift } from './drift';
import { HOLD_QUEUED_JOB_FUNCTION, JOB_QUEUES, JOB_SCHEMA, queueOptions } from './queues';

/*
 * pg-boss installation (`pnpm db:migrate`, after the Drizzle migrations). Runs as the schema owner
 * (DATABASE_URL_OWNER), so `vime_owner` owns the `pgboss` schema and every object in it, like the
 * rest of the database. Runtime instances never install or migrate (they start with
 * `migrate: false` and fail fast when the schema is missing or outdated).
 *
 * Privileges (least privilege, re-applied on every run, so they also cover tables that a pg-boss
 * upgrade adds):
 * - `vime_system` (the worker's pg-boss pool): USAGE on the schema and SELECT/INSERT/UPDATE/DELETE
 *   on its tables, plus EXECUTE on its functions. Enough to fetch, complete, fail, retry, expire
 *   and delete jobs, run cron schedules and keep the instance registry. No DDL: queues are created
 *   here, index rebuilds are disabled in the worker (`reindex: false`), queue stats are not
 *   persisted (no partition creation) and no queue is partitioned.
 * - `vime_app` (transactional enqueue from withTenant transactions, and the API's producer pool):
 *   SELECT on `version` and `queue` (pg-boss's start check and its queue cache), INSERT on the job
 *   tables plus SELECT of their `id` column (`INSERT ... RETURNING id`), and EXECUTE on
 *   `job_now()` and on VIME's coalescing fence `vime_hold_queued_job` (see
 *   `jobSchemaFunctionStatements`). It cannot read payloads, change or delete jobs, or touch
 *   queues and schedules.
 * - PUBLIC: nothing (no USAGE on the schema, no EXECUTE on its functions).
 */

const requireFromHere = createRequire(import.meta.url);

/** Schema version of the installed pg-boss package (what `installJobSchema` installs). */
export function jobSchemaTargetVersion(): number {
  const pkg = requireFromHere('pg-boss/package.json') as { pgboss?: { schema?: unknown } };
  const version = pkg.pgboss?.schema;
  if (typeof version !== 'number' || !Number.isInteger(version)) {
    throw new Error('Cannot read the pg-boss schema version from pg-boss/package.json');
  }
  return version;
}

/**
 * VIME's own function in the pg-boss schema (re-created on every run, owned by `vime_owner`):
 * `vime_hold_queued_job(queue, key)` locks (`FOR KEY SHARE`) the QUEUED (`created`) job of a stately
 * queue with that singleton key and returns whether there was one. A transaction whose send was
 * coalesced into that job calls it, so the job cannot be fetched (pg-boss fetches with
 * `FOR UPDATE SKIP LOCKED`) until the transaction ends: the job then runs AFTER the change that
 * asked for it is committed, instead of possibly reading the data before it. SECURITY DEFINER,
 * because the app role must not lock (UPDATE privilege) or read jobs itself.
 */
export function jobSchemaFunctionStatements(): string[] {
  const schema = escapeIdentifier(JOB_SCHEMA);
  const fn = `${schema}.${escapeIdentifier(HOLD_QUEUED_JOB_FUNCTION)}`;
  return [
    `CREATE OR REPLACE FUNCTION ${fn}(queue_name text, key text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  PERFORM 1 FROM ${schema}.job j
   WHERE j.name = queue_name AND j.singleton_key = key AND j.state = 'created'
   FOR KEY SHARE;
  RETURN FOUND;
END
$fn$`,
    `REVOKE ALL ON FUNCTION ${fn}(text, text) FROM PUBLIC`,
  ];
}

/** The GRANT/REVOKE statements described above, for the given job tables. */
export function jobSchemaGrantStatements(jobTables: readonly string[]): string[] {
  const schema = escapeIdentifier(JOB_SCHEMA);
  const app = escapeIdentifier(DB_ROLES.app);
  const system = escapeIdentifier(DB_ROLES.system);
  const tables = [...new Set(['job', ...jobTables])]
    .sort()
    .map((table) => `${schema}.${escapeIdentifier(table)}`)
    .join(', ');
  return [
    `REVOKE ALL ON SCHEMA ${schema} FROM PUBLIC`,
    `REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA ${schema} FROM PUBLIC`,
    `GRANT USAGE ON SCHEMA ${schema} TO ${system}, ${app}`,
    // Worker runtime.
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${schema} TO ${system}`,
    `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${schema} TO ${system}`,
    `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${schema} TO ${system}`,
    // Transactional enqueue: reset to nothing, then grant exactly what an insert needs.
    `REVOKE ALL ON ALL TABLES IN SCHEMA ${schema} FROM ${app}`,
    `REVOKE ALL ON ALL SEQUENCES IN SCHEMA ${schema} FROM ${app}`,
    `REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ${schema} FROM ${app}`,
    `GRANT SELECT ON ${schema}."version", ${schema}."queue" TO ${app}`,
    `GRANT INSERT ON ${tables} TO ${app}`,
    `GRANT SELECT (id) ON ${tables} TO ${app}`,
    `GRANT EXECUTE ON FUNCTION ${schema}.job_now() TO ${app}`,
    // The coalescing fence (jobSchemaFunctionStatements): locks a queued job, nothing else.
    `GRANT EXECUTE ON FUNCTION ${schema}.${escapeIdentifier(HOLD_QUEUED_JOB_FUNCTION)}(text, text) TO ${system}, ${app}`,
  ];
}

const INLINED_MARKER = '-- inlined from ';

/**
 * Splits an exported pg-boss migration script (`getMigrationPlans`) into its transactional block
 * and the index builds pg-boss inlines after the COMMIT (`CREATE INDEX CONCURRENTLY`, each preceded
 * by a `-- inlined from ...` comment), which must each run as a statement of their own.
 */
export function splitMigrationPlan(script: string): {
  transactional: string;
  concurrent: string[];
} {
  const start = script.indexOf(`\n${INLINED_MARKER}`);
  if (start === -1) {
    return { transactional: script, concurrent: [] };
  }
  const concurrent = script
    .slice(start + 1)
    .split(new RegExp(`;\\s*\\n(?=${INLINED_MARKER})`))
    .map((statement) => statement.trim().replace(/;$/, ''))
    .filter((statement) => statement !== '');
  return { transactional: script.slice(0, start), concurrent };
}

export interface JobSchemaInstallResult {
  /** pg-boss schema version after the run. */
  version: number;
  /** `installed`: the schema was created; `migrated`: upgraded from `previousVersion`. */
  action: 'installed' | 'migrated' | 'none';
  previousVersion: number | null;
  queuesCreated: string[];
  queuesUpdated: string[];
}

export interface InstallJobSchemaOptions {
  /** Receives progress lines. Defaults to console.log. */
  log?: (line: string) => void;
}

/**
 * Installs or upgrades the pg-boss schema, creates the catalog's queues (and updates the options of
 * existing ones), and applies the grants. Idempotent; concurrent runs are serialized by a session
 * advisory lock (pg-boss's own plans also take one). Throws when the database has a NEWER pg-boss
 * schema than this code, or when a queue's policy differs from the catalog (a policy cannot be
 * changed in place: drain and delete the queue by hand first).
 */
export async function installJobSchema({
  log = console.log,
}: InstallJobSchemaOptions = {}): Promise<JobSchemaInstallResult> {
  const target = jobSchemaTargetVersion();
  const client = new Client({
    connectionString: databaseUrl('DATABASE_URL_OWNER'),
    application_name: 'vime-migrate-jobs',
  });
  await client.connect();
  try {
    await client.query(`select pg_advisory_lock(hashtext('vime:jobs'))`);
    const db: Db = {
      executeSql: async (text, values) => client.query(text, values as unknown[] | undefined),
    };
    // Not started: used only for its schema and queue helpers, on this owner connection.
    const boss = new PgBoss({
      db,
      schema: JOB_SCHEMA,
      migrate: false,
      supervise: false,
      schedule: false,
      registerInstance: false,
    });

    let action: JobSchemaInstallResult['action'] = 'none';
    let previousVersion: number | null = null;
    if (!(await boss.isInstalled())) {
      await client.query(getConstructionPlans(JOB_SCHEMA));
      action = 'installed';
      log(`pg-boss: installed schema ${JOB_SCHEMA} (version ${target}).`);
    } else {
      previousVersion = await boss.schemaVersion();
      if (previousVersion === null) {
        throw new Error(`pg-boss: schema ${JOB_SCHEMA} exists but has no version row.`);
      }
      if (previousVersion > target) {
        throw new Error(
          `pg-boss: schema ${JOB_SCHEMA} is at version ${previousVersion}, newer than this code ` +
            `(${target}). Deploy the newer code or roll the schema back by hand.`,
        );
      }
      if (previousVersion < target) {
        const plan = splitMigrationPlan(getMigrationPlans(JOB_SCHEMA, previousVersion));
        await client.query(plan.transactional);
        // CREATE INDEX CONCURRENTLY cannot run in a transaction (nor in a multi-statement query).
        for (const statement of plan.concurrent) {
          await client.query(statement);
        }
        action = 'migrated';
        log(`pg-boss: migrated schema ${JOB_SCHEMA} from version ${previousVersion} to ${target}.`);
      }
    }

    const queuesCreated: string[] = [];
    const queuesUpdated: string[] = [];
    for (const queue of JOB_QUEUES) {
      const stored = await boss.getQueue(queue.name);
      if (!stored) {
        await boss.createQueue(queue.name, queueOptions(queue));
        queuesCreated.push(queue.name);
        continue;
      }
      const drift = queueDrift(stored, queue);
      if (drift.includes('policy')) {
        throw new Error(
          `pg-boss: queue ${queue.name} has policy ${stored.policy}, the catalog says ` +
            `${queue.policy}. A policy cannot change in place: drain and delete the queue first.`,
        );
      }
      if (drift.length > 0) {
        const { policy: _policy, ...options } = queueOptions(queue);
        await boss.updateQueue(queue.name, { ...options, retryDelayMax: queue.retryDelayMax });
        queuesUpdated.push(queue.name);
      }
    }
    if (queuesCreated.length > 0) log(`pg-boss: created queues ${queuesCreated.join(', ')}.`);
    if (queuesUpdated.length > 0) log(`pg-boss: updated queues ${queuesUpdated.join(', ')}.`);

    const tables = await client.query<{ table_name: string }>(
      `select distinct table_name from ${escapeIdentifier(JOB_SCHEMA)}.queue order by table_name`,
    );
    await client.query('BEGIN');
    try {
      for (const statement of [
        ...jobSchemaFunctionStatements(),
        ...jobSchemaGrantStatements(tables.rows.map((r) => r.table_name)),
      ]) {
        await client.query(statement);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
    log(
      action === 'none' && queuesCreated.length + queuesUpdated.length === 0
        ? `pg-boss: schema ${JOB_SCHEMA} is up to date (version ${target}); grants applied.`
        : `pg-boss: grants applied.`,
    );
    return { version: target, action, previousVersion, queuesCreated, queuesUpdated };
  } finally {
    // Ending the session also releases the advisory lock.
    await client.end();
  }
}
