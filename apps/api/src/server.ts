import { closeDb } from '@vime/db';
import { buildApp } from './app';
import { loadEnv } from './env';
import { errorReporter, sentryConfig, setErrorReporter, startSentry } from './http/error-reporting';

/** Longest a graceful shutdown may take before the process exits anyway. */
const SHUTDOWN_TIMEOUT_MS = 10_000;

async function main(): Promise<void> {
  const env = loadEnv();
  setErrorReporter(startSentry(sentryConfig(env), 'api'));
  const app = await buildApp({ env });

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'shutting down');
    const timer = setTimeout(() => {
      app.log.error('graceful shutdown timed out');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    timer.unref();
    try {
      // Stops accepting connections and waits for in-flight requests, then closes the pools.
      await app.close();
      await closeDb();
      await errorReporter().flush(2_000);
      process.exit(0);
    } catch (error) {
      app.log.error({ err: error }, 'error during shutdown');
      process.exit(1);
    }
  };
  process.once('SIGINT', (signal) => void shutdown(signal));
  process.once('SIGTERM', (signal) => void shutdown(signal));

  await app.listen({ host: env.API_HOST, port: env.API_PORT });
}

main().catch(async (error: unknown) => {
  console.error(error);
  errorReporter().capture(error, { phase: 'boot' });
  await errorReporter().flush(2_000);
  process.exit(1);
});
