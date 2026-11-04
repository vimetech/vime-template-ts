import type { JobDispatcher, JobRequest, Tx } from '@vime/db';

/*
 * Background jobs (ADR 006). Modules never talk to the queue directly: services receive a
 * `JobDispatcher` and enqueue through it IN the caller's transaction (transactional enqueue, our
 * outbox), so a job exists if and only if the state change that asked for it commits. The port
 * lives in @vime/db (re-exported here); its pg-boss implementation (`PgBossJobDispatcher`, in
 * `@vime/db/jobs`) is wired by the composition roots (apps/api, apps/worker); tests use
 * `RecordingJobDispatcher`.
 *
 * Every payload carries `orgId`: the worker wrapper opens withTenant(orgId) before running the
 * handler.
 */
export type { JobData, JobDispatcher, JobRequest } from '@vime/db';

/**
 * Names of the jobs that modules dispatch. The worker registers one handler per name; each is a
 * queue of the catalog in `@vime/db/jobs` (`JOB_QUEUES`). A domain module adds its job names here
 * (and the queue in the catalog).
 */
export const JOB_NAMES = {
  /** Example of a per-organization job: a note was created. Data: `{ orgId, noteId }`. */
  exampleNoteCreated: 'example.note.created',
} as const;
export type JobName = (typeof JOB_NAMES)[keyof typeof JOB_NAMES];

/**
 * The `example.note.created` job of one note: singleton per note (`note:<noteId>`), so a burst of
 * dispatches for the same note while one is queued coalesces into one run.
 */
export function noteCreatedJob(orgId: string, noteId: string): JobRequest {
  return {
    name: JOB_NAMES.exampleNoteCreated,
    data: { orgId, noteId },
    singletonKey: `note:${noteId}`,
  };
}

/**
 * Test double: records every dispatched job in memory, in order. It cannot see the transaction's
 * outcome, so a job dispatched in a transaction that later rolls back is still recorded; services
 * dispatch after their writes succeed, and tests should inspect jobs of committed work.
 */
export class RecordingJobDispatcher implements JobDispatcher {
  readonly jobs: JobRequest[] = [];

  dispatch(_tx: Tx, job: JobRequest): Promise<void> {
    if (!job.data.orgId) {
      throw new TypeError(`Job ${job.name} must carry data.orgId`);
    }
    this.jobs.push(structuredClone(job));
    return Promise.resolve();
  }

  /** The recorded jobs called `name`. */
  named(name: string): JobRequest[] {
    return this.jobs.filter((job) => job.name === name);
  }

  clear(): void {
    this.jobs.length = 0;
  }
}
