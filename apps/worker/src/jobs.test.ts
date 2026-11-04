import { randomUUID } from 'node:crypto';
import { JOB_QUEUES, JOB_QUEUE_NAMES } from '@vime/db/jobs';
import { CredentialCipher, RecordingJobDispatcher } from '@vime/platform';
import { describe, expect, it, vi } from 'vitest';
import type { WorkerDeps } from './deps';
import { loadWorkerEnv } from './env';
import { CRON_SCHEDULES, JOB_HANDLERS, runJob } from './jobs';
import { silentLogger } from './logger';
import type * as purgeModule from './handlers/purge';

// The purge handler is made to fail on purpose: runJob's reporting is what this file tests, not the
// handler, and a real database (CI, a developer's machine) would let the purge succeed.
vi.mock('./handlers/purge', async (importOriginal) => {
  const actual = await importOriginal<typeof purgeModule>();
  return { ...actual, handlePurge: () => Promise.reject(new Error('purge failed on purpose')) };
});

/*
 * Wiring of the worker, without a database: the catalog, the environment and the job wrapper. A
 * handler that touches the database gets its own test next to it (see the API's tests for the
 * pattern: the real database, its own organizations, never truncating tables).
 */

function deps(): WorkerDeps {
  return {
    dispatcher: new RecordingJobDispatcher(),
    cipher: CredentialCipher.fromBase64(Buffer.alloc(32, 7).toString('base64'), []),
    logger: silentLogger(),
    now: () => new Date('2026-10-10T12:00:00Z'),
  };
}

describe('wiring', () => {
  it('has a handler for every queue of the catalog', () => {
    expect(Object.keys(JOB_HANDLERS).sort()).toEqual(JOB_QUEUES.map((q) => q.name).sort());
    for (const schedule of CRON_SCHEDULES) {
      expect(JOB_HANDLERS[schedule.queue]).toBeDefined();
    }
  });

  it('validates the environment without echoing secrets', () => {
    const key = Buffer.alloc(32, 3).toString('base64');
    const env = loadWorkerEnv({
      DATABASE_URL: 'postgres://vime_app:x@localhost/vime',
      DATABASE_URL_SYSTEM: 'postgres://vime_system:x@localhost/vime',
      CREDENTIALS_ENCRYPTION_KEY: key,
      CREDENTIALS_ENCRYPTION_KEYS_PREVIOUS: ` ${key} , `,
    });
    expect(env).toMatchObject({
      WORKER_CONCURRENCY: 2,
      WORKER_SCHEDULES: true,
      CREDENTIALS_ENCRYPTION_KEYS_PREVIOUS: [key],
    });
    expect(() =>
      loadWorkerEnv({
        DATABASE_URL: 'postgres://vime_app:x@localhost/vime',
        CREDENTIALS_ENCRYPTION_KEY: 'c2hvcnQ=',
      }),
    ).toThrow(
      /DATABASE_URL_SYSTEM[\s\S]*CREDENTIALS_ENCRYPTION_KEY: must decode to exactly 32 bytes/,
    );
    try {
      loadWorkerEnv({ CREDENTIALS_ENCRYPTION_KEY: 'c2VjcmV0LXZhbHVl' });
    } catch (error) {
      expect(String(error)).not.toContain('c2VjcmV0LXZhbHVl');
    }
  });
});

describe('runJob', () => {
  it('completes a job with an invalid payload instead of retrying it', async () => {
    const result = await runJob(deps(), JOB_QUEUE_NAMES.exampleNoteCreated, {
      id: randomUUID(),
      data: { orgId: 'not-a-uuid' },
      retryCount: 0,
      retryLimit: 3,
    });
    expect(result).toEqual({ status: 'invalid_payload' });
  });

  it('reports a failure only on the final attempt', async () => {
    const captured: unknown[] = [];
    const reporter = {
      enabled: true,
      capture: (error: unknown) => {
        captured.push(error);
      },
      flush: () => Promise.resolve(true),
    };
    const failing: WorkerDeps = { ...deps(), reporter };
    const job = { id: randomUUID(), data: {}, retryLimit: 1 };
    await expect(
      runJob(failing, JOB_QUEUE_NAMES.platformPurge, { ...job, retryCount: 0 }),
    ).rejects.toThrow();
    expect(captured).toHaveLength(0);
    await expect(
      runJob(failing, JOB_QUEUE_NAMES.platformPurge, { ...job, retryCount: 1 }),
    ).rejects.toThrow();
    expect(captured).toHaveLength(1);
  });
});
