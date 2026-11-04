import type { JobDispatcher } from '@vime/db';
import type { CredentialCipher } from '@vime/platform';
import type { ErrorReporter } from './error-reporting';
import type { Logger } from './logger';

/**
 * What every job handler receives (the worker's composition root builds it once). A project adds
 * its own services here (external API clients, object storage), built in `main.ts`.
 */
export interface WorkerDeps {
  /** Transactional enqueue (pg-boss through the withTenant transaction). */
  dispatcher: JobDispatcher;
  /** Decrypts credentials stored at rest (`CREDENTIALS_ENCRYPTION_KEY`). */
  cipher: CredentialCipher;
  logger: Logger;
  /** Server clock (tests pass a fixed one). */
  now: () => Date;
  /** Aborted on shutdown: external calls stop waiting and the job is retried later. */
  signal?: AbortSignal;
  /** Where final job failures are reported (Sentry); none in tests. */
  reporter?: ErrorReporter;
}

/** The pg-boss attempt of the job being handled. */
export interface JobAttempt {
  id: string;
  /** Retries so far (0 on the first attempt). */
  retryCount: number;
  /** Retries allowed (the queue's `retryLimit`). */
  retryLimit: number;
}

/** True on the job's last attempt: a failure now is final (no retry follows). */
export function isFinalAttempt(attempt: JobAttempt): boolean {
  return attempt.retryCount >= attempt.retryLimit;
}

/** The attempt of a handler called directly (tests, scripts): a single, final attempt. */
export const SINGLE_ATTEMPT: JobAttempt = { id: 'direct', retryCount: 0, retryLimit: 0 };
