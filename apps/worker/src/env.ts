import { isWeakCredentialKey } from '@vime/platform';
import { z } from 'zod';

/**
 * Worker configuration from environment variables (see `.env.example`). Parsed once at startup by
 * `loadWorkerEnv`; the rest of the worker receives the typed result.
 *
 * The database URLs are read by @vime/db itself (lazily, per role); they are listed here so the
 * worker fails fast at boot when one is missing. The worker uses DATABASE_URL (withTenant, and
 * transactional enqueue) and DATABASE_URL_SYSTEM (withSystem fan-out, and pg-boss's own pool); it
 * never needs DATABASE_URL_OWNER or DATABASE_URL_ADMIN.
 */

const PostgresUrlSchema = z.url({ protocol: /^postgres(ql)?$/ });

const optionalString = z
  .string()
  .trim()
  .transform((value) => (value === '' ? undefined : value))
  .optional();

const Base64KeySchema = z
  .string()
  .trim()
  .refine((value) => /^[A-Za-z0-9+/]+={0,2}$/.test(value), 'must be base64')
  .refine((value) => Buffer.from(value, 'base64').length === 32, 'must decode to exactly 32 bytes');

const positiveInt = (fallback: number, max: number) =>
  z.coerce.number().int().min(1).max(max).default(fallback);

export const WorkerEnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),

    DATABASE_URL: PostgresUrlSchema,
    DATABASE_URL_SYSTEM: PostgresUrlSchema,

    /** 32 random bytes, base64: decrypts (and re-encrypts) credentials stored at rest. */
    CREDENTIALS_ENCRYPTION_KEY: Base64KeySchema,
    /**
     * Comma-separated previous keys, still accepted for decryption while rows are re-encrypted after
     * a key rotation. Optional.
     */
    CREDENTIALS_ENCRYPTION_KEYS_PREVIOUS: z
      .string()
      .optional()
      .transform((value) =>
        (value ?? '')
          .split(',')
          .map((key) => key.trim())
          .filter((key) => key !== ''),
      )
      .pipe(z.array(Base64KeySchema)),

    /** Jobs of one queue processed at the same time by this process. */
    WORKER_CONCURRENCY: positiveInt(2, 32),
    /** Seconds a graceful shutdown waits for running jobs before they are left to pg-boss's expiry. */
    WORKER_SHUTDOWN_TIMEOUT_SECONDS: positiveInt(25, 300),
    /** Set to `false` to run no cron schedules from this process (e.g. a second worker). */
    WORKER_SCHEDULES: z
      .enum(['true', 'false'])
      .default('true')
      .transform((value) => value === 'true'),

    /** Error reporting (error-reporting.ts); unset: nothing is sent. */
    SENTRY_DSN: optionalString.pipe(z.url().optional()),
    SENTRY_ENVIRONMENT: optionalString,
    SENTRY_RELEASE: optionalString,
    /** Set by Railway: the deployed version when SENTRY_RELEASE is not. */
    RAILWAY_GIT_COMMIT_SHA: optionalString,
    RAILWAY_DEPLOYMENT_ID: optionalString,
  })
  .superRefine((env, ctx) => {
    // The keys published in this repository work everywhere else, never in production.
    if (env.NODE_ENV !== 'production') {
      return;
    }
    const message =
      'must be 32 random bytes in production (openssl rand -base64 32), not the example/CI key';
    if (isWeakCredentialKey(env.CREDENTIALS_ENCRYPTION_KEY)) {
      ctx.addIssue({ code: 'custom', path: ['CREDENTIALS_ENCRYPTION_KEY'], message });
    }
    env.CREDENTIALS_ENCRYPTION_KEYS_PREVIOUS.forEach((key, index) => {
      if (isWeakCredentialKey(key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['CREDENTIALS_ENCRYPTION_KEYS_PREVIOUS', index],
          message,
        });
      }
    });
  });

export type WorkerEnv = z.output<typeof WorkerEnvSchema>;

/**
 * Parses and validates the worker environment. Throws an Error that names every invalid variable
 * and why, without ever echoing values (they include secrets).
 */
export function loadWorkerEnv(source: NodeJS.ProcessEnv = process.env): WorkerEnv {
  // Empty strings count as unset, so `FOO=` in a .env file falls back to the default.
  const input = Object.fromEntries(
    Object.entries(source).filter(([, value]) => value !== undefined && value !== ''),
  );
  const result = WorkerEnvSchema.safeParse(input);
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid worker environment:\n${problems}`);
  }
  return Object.freeze(result.data);
}
