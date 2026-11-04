import type { Tx } from '../client';

/*
 * The job dispatch port (ADR 006). Pure types, exported from the main `@vime/db` entry point so that
 * modules can depend on them without loading pg-boss; the pg-boss implementation lives in
 * `@vime/db/jobs` and is used only by the composition roots (apps/api, apps/worker).
 */

/** JSON-serializable job payload. Always names the organization: the worker opens withTenant(orgId). */
export type JobData = Record<string, unknown> & { orgId: string };

export interface JobRequest {
  /** Queue name (one of `JOB_QUEUES` in `@vime/db/jobs`). */
  name: string;
  data: JobData;
  /**
   * Coalescing key. On a `stately` queue there is at most one queued (not yet started) job per
   * `(name, singletonKey)`: dispatching again while one is queued is a no-op, so bursts of changes
   * collapse into one run that reads the latest state.
   */
  singletonKey?: string;
  /** Delay before the job may start (with `singletonKey`, a short delay debounces bursts). */
  startAfterSeconds?: number;
}

/**
 * Enqueues jobs INSIDE the caller's transaction (transactional enqueue, our outbox): the job exists
 * if and only if the transaction commits.
 */
export interface JobDispatcher {
  dispatch(tx: Tx, job: JobRequest): Promise<void>;
}
