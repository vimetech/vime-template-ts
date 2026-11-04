import { sql } from 'drizzle-orm';
import { PgBoss, fromDrizzle, type ConstructorOptions } from 'pg-boss';
import type { Tx } from '../client';
import { databaseUrl } from '../env';
import { queueDrift } from './drift';
import { HOLD_QUEUED_JOB_FUNCTION, JOB_QUEUES, JOB_SCHEMA, jobQueue } from './queues';
import type { JobDispatcher, JobRequest } from './types';

/*
 * pg-boss at runtime (ADR 006). Two kinds of instances, both with `migrate: false` (only
 * `pnpm db:migrate` installs or upgrades the schema, see install.ts):
 *
 * - `producer` (apps/api): enqueues only. Its own small pool uses the app role (DATABASE_URL), which
 *   may only read pg-boss's version and queue tables; the jobs themselves are inserted through the
 *   caller's withTenant transaction. No maintenance, no cron, not registered as an instance.
 * - `worker` (apps/worker): runs handlers, cron schedules and pg-boss maintenance, with the system
 *   role (DATABASE_URL_SYSTEM). Index rebuilds are off (they need the owner); bloat is still
 *   reported as a warning.
 *
 * Both own a pg pool created by pg-boss from the connection URL: this is the sanctioned exception
 * of architecture §3.3 (pg-boss runs its own queries outside our transaction callbacks).
 */

export type JobBossMode = 'producer' | 'worker';

export interface JobBossOptions {
  mode: JobBossMode;
  /** `application_name` of the pool's connections (pg_stat_activity). */
  applicationName?: string;
  /** Pool size. Default 2 (producer) / 10 (worker). */
  max?: number;
  /** Name in pg-boss's instance registry (worker only). */
  instanceName?: string;
  /**
   * Background errors of pg-boss (maintenance, cron, polling). Required: an unhandled `error`
   * event would crash the process.
   */
  onError: (error: Error) => void;
  /** pg-boss warnings (slow queries, backlog, index bloat...). */
  onWarning?: (warning: { message: string; data: unknown }) => void;
  /** Extra pg-boss options (tests: polling intervals...). */
  overrides?: Partial<ConstructorOptions>;
}

/** A configured, NOT started pg-boss instance (see `startJobBoss`). */
export function createJobBoss(options: JobBossOptions): PgBoss {
  const worker = options.mode === 'worker';
  const boss = new PgBoss({
    connectionString: databaseUrl(worker ? 'DATABASE_URL_SYSTEM' : 'DATABASE_URL'),
    application_name: options.applicationName ?? `vime-boss-${options.mode}`,
    max: options.max ?? (worker ? 10 : 2),
    connectionTimeoutMillis: 10_000,
    schema: JOB_SCHEMA,
    migrate: false,
    createSchema: false,
    supervise: worker,
    schedule: worker,
    registerInstance: worker,
    ...(worker && options.instanceName ? { instanceName: options.instanceName } : {}),
    reindex: false,
    persistQueueStats: false,
    persistWarnings: false,
    ...options.overrides,
  });
  boss.on('error', options.onError);
  if (options.onWarning) {
    const onWarning = options.onWarning;
    boss.on('warning', (warning) => onWarning({ message: warning.message, data: warning.data }));
  }
  return boss;
}

export interface QueueCheck {
  /** Catalog queues missing from the database. */
  missing: string[];
  /** Queues whose stored options differ from the catalog, with the differing option names. */
  drifted: Array<{ name: string; options: string[] }>;
}

/** Compares the database's queues with the catalog (`JOB_QUEUES`). */
export async function checkJobQueues(boss: PgBoss): Promise<QueueCheck> {
  const stored = new Map((await boss.getQueues()).map((queue) => [queue.name, queue]));
  const check: QueueCheck = { missing: [], drifted: [] };
  for (const queue of JOB_QUEUES) {
    const current = stored.get(queue.name);
    if (!current) {
      check.missing.push(queue.name);
      continue;
    }
    const drift = queueDrift(current, queue);
    if (drift.length > 0) {
      check.drifted.push({ name: queue.name, options: drift });
    }
  }
  return check;
}

/**
 * Starts `createJobBoss(options)` and checks the queues. Fails fast, with an actionable message,
 * when the pg-boss schema is missing or outdated or a catalog queue is missing (run
 * `pnpm db:migrate`). Queues whose options drifted from the catalog are reported through
 * `onWarning` (the database values apply until the next migrate).
 */
export async function startJobBoss(options: JobBossOptions): Promise<PgBoss> {
  const boss = createJobBoss(options);
  try {
    await boss.start();
  } catch (error) {
    await boss.stop({ graceful: false }).catch(() => {});
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`pg-boss could not start (${reason}). Run pnpm db:migrate.`, { cause: error });
  }
  const check = await checkJobQueues(boss);
  if (check.missing.length > 0) {
    await boss.stop({ graceful: false }).catch(() => {});
    throw new Error(
      `pg-boss queues are missing (${check.missing.join(', ')}). Run pnpm db:migrate.`,
    );
  }
  for (const drift of check.drifted) {
    options.onWarning?.({
      message: `pg-boss queue ${drift.name} differs from the catalog (${drift.options.join(', ')}). Run pnpm db:migrate.`,
      data: drift,
    });
  }
  return boss;
}

/**
 * Locks the queued (`created`) job of `name` with singleton key `key` until the end of `tx`.
 * False when there is none (it started, or was never there).
 */
async function holdQueuedJob(tx: Tx, name: string, key: string): Promise<boolean> {
  const fn = sql.raw(`${JOB_SCHEMA}.${HOLD_QUEUED_JOB_FUNCTION}`);
  const result = await tx.execute<{ held: boolean }>(sql`select ${fn}(${name}, ${key}) as held`);
  return result.rows[0]?.held === true;
}

function sendOptions(job: JobRequest) {
  return {
    ...(job.singletonKey === undefined ? {} : { singletonKey: job.singletonKey }),
    ...(job.startAfterSeconds === undefined || job.startAfterSeconds <= 0
      ? {}
      : { startAfter: job.startAfterSeconds }),
  };
}

function assertSendable(job: JobRequest): void {
  if (!jobQueue(job.name)) {
    throw new TypeError(`Unknown job queue ${job.name} (not in JOB_QUEUES of @vime/db/jobs)`);
  }
  if (typeof job.data.orgId !== 'string' || job.data.orgId === '') {
    throw new TypeError(`Job ${job.name} must carry data.orgId`);
  }
}

/** Sends of one dispatch, at most: each retry means the queued job started in between. */
const MAX_COALESCE_ATTEMPTS = 5;

/**
 * The pg-boss `JobDispatcher`: `dispatch` inserts the job through the caller's transaction (pg-boss's
 * Drizzle adapter over the withTenant `Tx`), so a rolled-back transaction never enqueues anything.
 * Retry behavior comes from the queue (catalog); `singletonKey` and `startAfterSeconds` map to
 * pg-boss's options of the same meaning. Resolves with nothing whether the job was created or
 * coalesced into a queued one (singleton).
 *
 * Coalescing is made safe: in a `stately` queue a send while a job with the same key is queued is a
 * no-op, and that queued job could start (and read the data) BEFORE this transaction commits, so
 * the change that asked for it would never be processed. The dispatcher therefore holds the queued
 * job (`vime_hold_queued_job`: a row lock that pg-boss's `SKIP LOCKED` fetch passes over) until the
 * transaction ends; if the queued job already started, it sends again (a new job is created).
 */
export class PgBossJobDispatcher implements JobDispatcher {
  constructor(private readonly boss: PgBoss) {}

  async dispatch(tx: Tx, job: JobRequest): Promise<void> {
    await this.sendInTransaction(tx, job);
  }

  /** Like `dispatch`, but resolves with the new job's id, or null when it was coalesced. */
  async sendInTransaction(tx: Tx, job: JobRequest): Promise<string | null> {
    assertSendable(job);
    const key = jobQueue(job.name)?.policy === 'stately' ? job.singletonKey : undefined;
    for (let attempt = 0; attempt < MAX_COALESCE_ATTEMPTS; attempt += 1) {
      const id = await this.boss.send(job.name, job.data, {
        ...sendOptions(job),
        db: fromDrizzle(tx, sql),
      });
      if (id !== null || key === undefined || (await holdQueuedJob(tx, job.name, key))) {
        return id;
      }
      // The queued job was fetched between the send and the hold: send again.
    }
    throw new Error(
      `Could not enqueue or hold a queued ${job.name} job (${MAX_COALESCE_ATTEMPTS} tries)`,
    );
  }

  /**
   * Enqueues OUTSIDE any transaction, on pg-boss's own pool (worker fan-out, where nothing has to
   * commit together with the job). Resolves with the job id, or null when coalesced.
   */
  async send(job: JobRequest): Promise<string | null> {
    assertSendable(job);
    return this.boss.send(job.name, job.data, sendOptions(job));
  }
}
