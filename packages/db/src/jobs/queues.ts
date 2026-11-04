/*
 * The job queue catalog (ADR 006): every pg-boss queue VIME uses, with its policy and default retry
 * behavior. `pnpm db:migrate` creates the queues and keeps their options in sync with this file
 * (`installJobSchema`), as the schema owner; runtime roles cannot create or alter queues. The worker
 * and the API check at start that every queue exists (`verifyJobQueues`).
 *
 * Queue names follow `<area>.<action>`. The names that modules dispatch are repeated, as constants,
 * in `JOB_NAMES` of @vime/platform (a test there checks they are all listed here).
 *
 * Policies (pg-boss 12):
 * - `standard`: every send creates a job.
 * - `stately`: at most one job per state (created, retry, active) per `singletonKey`. A send while
 *   one is queued is a no-op (coalescing), and two jobs with the same key never run at once.
 */

/** Postgres schema of pg-boss. */
export const JOB_SCHEMA = 'pgboss';

/**
 * VIME's coalescing fence in the pg-boss schema, `(queue_name text, key text) → boolean` (created by
 * `installJobSchema`, used by `PgBossJobDispatcher`).
 */
export const HOLD_QUEUED_JOB_FUNCTION = 'vime_hold_queued_job';

export type JobQueuePolicy = 'standard' | 'stately';

export interface JobQueueDefinition {
  readonly name: string;
  readonly policy: JobQueuePolicy;
  /** Retries after the first attempt before the job is marked failed. */
  readonly retryLimit: number;
  /** Seconds before the first retry (doubled per retry, with jitter, when `retryBackoff`). */
  readonly retryDelay: number;
  readonly retryBackoff: boolean;
  /** Cap of the backoff delay, in seconds (null: no cap). */
  readonly retryDelayMax: number | null;
  /** How long a job may stay active before pg-boss fails (and retries) it. */
  readonly expireInSeconds: number;
  /** How long a job may wait in created/retry before pg-boss deletes it. */
  readonly retentionSeconds: number;
  /** How long a finished job is kept (for inspection) before deletion. */
  readonly deleteAfterSeconds: number;
}

const DAY = 86_400;

/** Queue names, by role. A domain module adds its queues here. */
export const JOB_QUEUE_NAMES = {
  /** Example of a per-organization job: a note was created. `{ orgId, noteId }`, singleton per note. */
  exampleNoteCreated: 'example.note.created',
  /** Cron: purge old idempotency keys. `{}`. */
  platformPurge: 'platform.purge',
} as const;

export type JobQueueName = (typeof JOB_QUEUE_NAMES)[keyof typeof JOB_QUEUE_NAMES];

export const JOB_QUEUES: readonly JobQueueDefinition[] = [
  {
    // Cheap and idempotent; failures are mostly lock conflicts, so retry soon.
    name: JOB_QUEUE_NAMES.exampleNoteCreated,
    policy: 'stately',
    retryLimit: 5,
    retryDelay: 5,
    retryBackoff: true,
    retryDelayMax: 300,
    expireInSeconds: 300,
    retentionSeconds: 14 * DAY,
    deleteAfterSeconds: 2 * DAY,
  },
  {
    name: JOB_QUEUE_NAMES.platformPurge,
    policy: 'standard',
    retryLimit: 2,
    retryDelay: 300,
    retryBackoff: false,
    retryDelayMax: null,
    expireInSeconds: 900,
    retentionSeconds: DAY,
    deleteAfterSeconds: 7 * DAY,
  },
];

const BY_NAME: ReadonlyMap<string, JobQueueDefinition> = new Map(
  JOB_QUEUES.map((queue) => [queue.name, queue]),
);

/** The catalog entry of `name`, or undefined for a queue VIME does not define. */
export function jobQueue(name: string): JobQueueDefinition | undefined {
  return BY_NAME.get(name);
}

/** The pg-boss queue options of a definition (everything but the name). */
export function queueOptions(queue: JobQueueDefinition) {
  return {
    policy: queue.policy,
    retryLimit: queue.retryLimit,
    retryDelay: queue.retryDelay,
    retryBackoff: queue.retryBackoff,
    ...(queue.retryDelayMax === null ? {} : { retryDelayMax: queue.retryDelayMax }),
    expireInSeconds: queue.expireInSeconds,
    retentionSeconds: queue.retentionSeconds,
    deleteAfterSeconds: queue.deleteAfterSeconds,
  };
}
