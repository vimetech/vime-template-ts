import type { JobDispatcher } from '@vime/db';
import { PgBossJobDispatcher, startJobBoss } from '@vime/db/jobs';
import { CredentialCipher } from '@vime/platform';
import type { FastifyInstance } from 'fastify';
import type { ApiEnv } from '../env';

declare module 'fastify' {
  interface FastifyInstance {
    /**
     * Transactional job enqueue for module services (`dispatch(tx, job)` inside the request's
     * withTenant transaction): a job exists only if the request's transaction commits.
     */
    jobs: JobDispatcher;
    /** Encrypts credentials at rest (`CREDENTIALS_ENCRYPTION_KEY`). */
    credentialCipher: CredentialCipher;
    /** Public origin of this API (`API_PUBLIC_URL`), for URLs handed to third parties (webhooks). */
    publicUrl: string;
  }
}

export interface ServiceOptions {
  env: ApiEnv;
  /** A dispatcher to use instead of the pg-boss producer (tests). */
  jobs?: JobDispatcher;
}

/**
 * Decorates the app with the services routes need beyond the database: the job dispatcher (a
 * pg-boss producer on the app role, stopped when the app closes), the credential cipher and the
 * public URL. Fails at boot when the pg-boss schema or a queue is missing (`pnpm db:migrate`).
 * A project adds its own services (object storage, external APIs) here, always called OUTSIDE
 * any tenant transaction.
 */
export async function registerServices(
  app: FastifyInstance,
  options: ServiceOptions,
): Promise<void> {
  let jobs = options.jobs;
  if (!jobs) {
    const boss = await startJobBoss({
      mode: 'producer',
      applicationName: 'vime-api-boss',
      onError: (error) => app.log.error({ err: error }, 'pg-boss error'),
      onWarning: (warning) => app.log.warn({ data: warning.data }, `pg-boss: ${warning.message}`),
    });
    app.addHook('onClose', async () => {
      await boss.stop({ graceful: false });
    });
    jobs = new PgBossJobDispatcher(boss);
  }
  app.decorate('jobs', jobs);
  app.decorate(
    'credentialCipher',
    CredentialCipher.fromBase64(
      options.env.CREDENTIALS_ENCRYPTION_KEY,
      options.env.CREDENTIALS_ENCRYPTION_KEYS_PREVIOUS,
    ),
  );
  app.decorate('publicUrl', options.env.API_PUBLIC_URL);
}
