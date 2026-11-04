import { JOB_QUEUE_NAMES, type JobQueueName } from '@vime/db/jobs';
import type { JobWithMetadata, PgBoss } from 'pg-boss';
import { isFinalAttempt, type JobAttempt, type WorkerDeps } from './deps';
import { handleNoteCreated } from './handlers/example';
import { InvalidJobPayloadError } from './handlers/payload';
import { handlePurge } from './handlers/purge';
import type { Logger } from './logger';

/*
 * Worker wiring: one pg-boss worker per queue of the catalog, and the cron schedules.
 */

export type JobHandler = (deps: WorkerDeps, data: unknown, attempt: JobAttempt) => Promise<unknown>;

/** Handler of every queue (the catalog's queues; a missing entry fails the type check). */
export const JOB_HANDLERS: Readonly<Record<JobQueueName, JobHandler>> = {
  [JOB_QUEUE_NAMES.exampleNoteCreated]: (deps, data) => handleNoteCreated(deps, data),
  [JOB_QUEUE_NAMES.platformPurge]: (deps) => handlePurge(deps),
};

/** Queues fed by a cron schedule: one job at a time per process. */
const CRON_QUEUES: ReadonlySet<JobQueueName> = new Set([JOB_QUEUE_NAMES.platformPurge]);

/** The worker's shutdown signal combined with the job's own (pg-boss aborts it at expiry). */
function jobSignal(deps: WorkerDeps, job: { signal?: AbortSignal }): AbortSignal | undefined {
  if (deps.signal && job.signal) return AbortSignal.any([deps.signal, job.signal]);
  return job.signal ?? deps.signal;
}

/**
 * Runs one job through its handler, with a logger bound to the job. An invalid payload is logged
 * and the job completes (retrying cannot fix it); any other error is rethrown so pg-boss retries
 * (or fails) the job.
 *
 * The handler's `signal` is also aborted when pg-boss gives up on this attempt (the job passed its
 * `expireInSeconds`, and pg-boss retries it): provider calls stop, instead of a stale attempt
 * running on next to its retry.
 */
export async function runJob(
  deps: WorkerDeps,
  queue: JobQueueName,
  job: Pick<JobWithMetadata<unknown>, 'id' | 'data' | 'retryCount' | 'retryLimit'> & {
    signal?: AbortSignal;
  },
): Promise<unknown> {
  const data = job.data as Record<string, unknown> | null;
  const log = deps.logger.child({
    job: queue,
    jobId: job.id,
    attempt: job.retryCount + 1,
    ...(typeof data?.orgId === 'string' ? { orgId: data.orgId } : {}),
  });
  const started = Date.now();
  try {
    const signal = jobSignal(deps, job);
    const handlerDeps: WorkerDeps = { ...deps, logger: log, ...(signal ? { signal } : {}) };
    const result = await JOB_HANDLERS[queue](handlerDeps, job.data, {
      id: job.id,
      retryCount: job.retryCount,
      retryLimit: job.retryLimit,
    });
    log.info({ durationMs: Date.now() - started, result }, 'job completed');
    return result;
  } catch (error) {
    if (error instanceof InvalidJobPayloadError) {
      log.error({ issues: error.issues }, 'job payload is invalid; not retried');
      return { status: 'invalid_payload' };
    }
    log.error({ err: error, durationMs: Date.now() - started }, 'job failed');
    // Only when no retry follows: a transient failure that a retry fixes is not an incident.
    if (isFinalAttempt(job)) {
      deps.reporter?.capture(error, {
        job: queue,
        job_id: job.id,
        attempt: job.retryCount + 1,
        org_id: typeof data?.orgId === 'string' ? data.orgId : undefined,
      });
    }
    throw error;
  }
}

export interface RegisterWorkersOptions {
  /** Concurrent jobs per queue in this process. */
  concurrency: number;
  pollingIntervalSeconds?: number;
  /** Only these queues (default: every queue of `JOB_HANDLERS`). */
  queues?: readonly JobQueueName[];
}

/** Registers a pg-boss worker for every queue. Returns the worker ids. */
export async function registerWorkers(
  boss: PgBoss,
  deps: WorkerDeps,
  options: RegisterWorkersOptions,
): Promise<string[]> {
  const ids: string[] = [];
  for (const queue of options.queues ?? (Object.keys(JOB_HANDLERS) as JobQueueName[])) {
    const cron = CRON_QUEUES.has(queue);
    ids.push(
      await boss.work(
        queue,
        {
          includeMetadata: true,
          batchSize: 1,
          localConcurrency: cron ? 1 : options.concurrency,
          pollingIntervalSeconds: options.pollingIntervalSeconds ?? 2,
        },
        async ([job]) => (job ? runJob(deps, queue, job) : undefined),
      ),
    );
  }
  return ids;
}

export interface CronSchedule {
  queue: JobQueueName;
  /** Distinguishes several schedules of one queue. */
  key: string;
  /** 5-field cron, evaluated in UTC (organizations live in different time zones). */
  cron: string;
  data: Record<string, unknown>;
}

/**
 * The cron schedules. Times are UTC: 08:40 UTC is 03:40 in Lima (UTC−5, no DST); organizations in
 * other zones get the nightly jobs at another local hour (every job here is idempotent). A domain
 * module adds its schedules here.
 */
export const CRON_SCHEDULES: readonly CronSchedule[] = [
  {
    queue: JOB_QUEUE_NAMES.platformPurge,
    key: 'nightly',
    cron: '40 8 * * *',
    data: {},
  },
];

/**
 * Upserts the cron schedules and removes schedules of these queues that are no longer listed
 * (renamed keys). pg-boss runs each occurrence once across worker instances.
 */
export async function registerSchedules(boss: PgBoss, log: Logger): Promise<void> {
  const wanted = new Set(CRON_SCHEDULES.map((s) => `${s.queue}\u0000${s.key}`));
  const queues = new Set<string>(CRON_SCHEDULES.map((s) => s.queue));
  for (const schedule of await boss.getSchedules()) {
    if (queues.has(schedule.name) && !wanted.has(`${schedule.name}\u0000${schedule.key}`)) {
      await boss.unschedule(schedule.name, schedule.key);
      log.info({ queue: schedule.name, key: schedule.key }, 'removed stale schedule');
    }
  }
  for (const schedule of CRON_SCHEDULES) {
    await boss.schedule(schedule.queue, schedule.cron, schedule.data, {
      tz: 'UTC',
      key: schedule.key,
    });
  }
}
