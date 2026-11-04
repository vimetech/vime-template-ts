import { closeDb } from '@vime/db';
import { PgBossJobDispatcher, startJobBoss } from '@vime/db/jobs';
import { CredentialCipher } from '@vime/platform';
import type { WorkerDeps } from './deps';
import { loadWorkerEnv } from './env';
import { registerSchedules, registerWorkers } from './jobs';
import { errorReporter, sentryConfig, setErrorReporter, startSentry } from './error-reporting';
import { createLogger } from './logger';

/*
 * apps/worker: the jobs composition root (ADR 006). Starts pg-boss (system role, never migrates:
 * `pnpm db:migrate` installs the schema and queues), registers one worker per queue and the cron
 * schedules, and shuts down gracefully on SIGTERM/SIGINT.
 */

async function main(): Promise<void> {
  const env = loadWorkerEnv();
  const logger = createLogger(env);
  const reporter = startSentry(sentryConfig(env), 'worker');
  setErrorReporter(reporter);
  const cipher = CredentialCipher.fromBase64(
    env.CREDENTIALS_ENCRYPTION_KEY,
    env.CREDENTIALS_ENCRYPTION_KEYS_PREVIOUS,
  );
  const boss = await startJobBoss({
    mode: 'worker',
    instanceName: 'vime-worker',
    applicationName: 'vime-worker-boss',
    onError: (error) => {
      logger.error({ err: error }, 'pg-boss error');
      reporter.capture(error, { source: 'pg-boss' });
    },
    onWarning: (warning) => logger.warn({ data: warning.data }, `pg-boss: ${warning.message}`),
  });
  const abort = new AbortController();
  const deps: WorkerDeps = {
    dispatcher: new PgBossJobDispatcher(boss),
    cipher,
    logger,
    now: () => new Date(),
    signal: abort.signal,
    reporter,
  };

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    const timeoutMs = env.WORKER_SHUTDOWN_TIMEOUT_SECONDS * 1000;
    const timer = setTimeout(() => {
      logger.error('graceful shutdown timed out');
      process.exit(1);
    }, timeoutMs + 5_000);
    timer.unref();
    try {
      // Running jobs get the timeout to finish; external calls are aborted first so long jobs
      // stop early (their job is retried later).
      setTimeout(() => abort.abort(), Math.max(0, timeoutMs - 5_000)).unref();
      await boss.stop({ graceful: true, timeout: timeoutMs });
      await closeDb();
      await reporter.flush(2_000);
      logger.info('stopped');
      process.exit(0);
    } catch (error) {
      logger.error({ err: error }, 'error during shutdown');
      process.exit(1);
    }
  };
  process.once('SIGINT', (signal) => void shutdown(signal));
  process.once('SIGTERM', (signal) => void shutdown(signal));

  const workers = await registerWorkers(boss, deps, { concurrency: env.WORKER_CONCURRENCY });
  if (env.WORKER_SCHEDULES) {
    await registerSchedules(boss, logger);
  }
  logger.info(
    {
      workers: workers.length,
      schedules: env.WORKER_SCHEDULES,
      concurrency: env.WORKER_CONCURRENCY,
    },
    'worker started',
  );
}

main().catch(async (error: unknown) => {
  console.error(error);
  errorReporter().capture(error, { phase: 'boot' });
  await errorReporter().flush(2_000);
  process.exit(1);
});
