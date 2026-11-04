import { fileURLToPath } from 'node:url';
import { isWeakCredentialKey } from '@vime/platform';
import { z } from 'zod';

/**
 * API configuration from environment variables (see `.env.example`). Parsed once at startup by
 * `loadEnv`; the rest of the app receives the typed result and never reads `process.env` directly.
 *
 * The database URLs are read by @vime/db itself (lazily, per role); they are listed here only so the
 * API fails fast at boot when one is missing. The API never needs DATABASE_URL_OWNER/ADMIN.
 */

const booleanString = z
  .enum(['true', 'false', '1', '0', 'yes', 'no'])
  .transform((value) => value === 'true' || value === '1' || value === 'yes');

const optionalString = z
  .string()
  .trim()
  .transform((value) => (value === '' ? undefined : value))
  .optional();

const PostgresUrlSchema = z.url({ protocol: /^postgres(ql)?$/ });

/** 32 bytes, base64 (a credentials encryption key). */
const Base64KeySchema = z
  .string()
  .trim()
  .refine((value) => /^[A-Za-z0-9+/]+={0,2}$/.test(value), 'must be base64')
  .refine((value) => Buffer.from(value, 'base64').length === 32, 'must decode to exactly 32 bytes');

/** `BETTER_AUTH_SECRET` values published in this repository (`.env.example`, CI). */
const PUBLISHED_AUTH_SECRETS: ReadonlySet<string> = new Set([
  'dev-only-secret-change-me-0123456789abcdef',
  'ci-only-secret-0123456789abcdef0123456789',
]);

/**
 * Build output of the web app, next to this module: apps/api/src (tsx) and apps/api/dist (the
 * bundle) are at the same depth, so both resolve to apps/web/dist. The Docker image keeps that
 * layout.
 */
export const DEFAULT_WEB_DIST_DIR = fileURLToPath(new URL('../../web/dist', import.meta.url));

/** Origin only (scheme, host, port): no path, so cookies and CORS match exactly. */
function originOf(value: string): string {
  return new URL(value).origin;
}

export const ApiEnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),

    API_HOST: z.string().trim().min(1).default('0.0.0.0'),
    /** Listening port. `loadEnv` falls back to `PORT` (set by Railway and most PaaS), then 4000. */
    API_PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
    /** Public base URL of this API (Better Auth builds its URLs and cookie scope from it). */
    API_PUBLIC_URL: z.url({ protocol: /^https?$/ }).transform(originOf),
    /** The web app's origin: the only CORS origin with credentials and Better Auth trusted origin. */
    WEB_ORIGIN: z.url({ protocol: /^https?$/ }).transform(originOf),
    /**
     * Trust X-Forwarded-* from a reverse proxy (needed behind a load balancer so rate limits key on
     * the client IP, not the proxy's). Only enable when a proxy you control is in front. On Railway
     * it must be `true` (its edge proxy is the only way in; see docs/deploy.md).
     */
    TRUST_PROXY: booleanString.default(false),
    /**
     * Requests per minute and client IP of every route without its own limit (the global budget of
     * http/rate-limit.ts). Unset: the default (600). The end-to-end suite raises it: all its
     * browsers and API clients share one IP.
     */
    RATE_LIMIT_GLOBAL: z.coerce.number().int().min(1).optional(),

    /**
     * Build output served on the API's origin (http/static.ts): the web app at `/`. Unset in
     * production: the directory next to the bundle (DEFAULT_WEB_DIST_DIR); unset elsewhere: not
     * served (Vite serves it in development). A directory without an index.html is skipped.
     */
    WEB_DIST_DIR: optionalString,

    BETTER_AUTH_SECRET: z.string().min(32, 'must be at least 32 characters'),
    /**
     * 32 random bytes, base64: AES-256-GCM key of credentials stored at rest (`CredentialCipher`).
     * Same value as the worker's.
     */
    CREDENTIALS_ENCRYPTION_KEY: Base64KeySchema,
    /**
     * Comma-separated previous keys, still accepted for decryption after a key rotation (same value
     * as the worker's). Rows encrypted with one of them stay readable until they are rewritten.
     * Optional.
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

    DATABASE_URL: PostgresUrlSchema,
    DATABASE_URL_SYSTEM: PostgresUrlSchema,

    /**
     * User ids (comma separated) of the platform administrators: the only users who see the
     * platform console (`/v1/platform/*`, ADR 0015) to create, suspend and enable modules of
     * organizations. Ids, not emails: an email can be given to a new user by anyone who invites
     * one, an id cannot. It does not let them into an organization's data. Unset: nobody sees the
     * console.
     */
    PLATFORM_ADMIN_USER_IDS: z
      .string()
      .optional()
      .transform((value) =>
        (value ?? '')
          .split(',')
          .map((id) => id.trim().toLowerCase())
          .filter((id) => id !== ''),
      )
      .pipe(z.array(z.uuid())),

    /** Error reporting (http/error-reporting.ts); unset: nothing is sent. */
    SENTRY_DSN: optionalString.pipe(z.url().optional()),
    SENTRY_ENVIRONMENT: optionalString,
    SENTRY_RELEASE: optionalString,
    /** Set by Railway: the deployed version when SENTRY_RELEASE is not. */
    RAILWAY_GIT_COMMIT_SHA: optionalString,
    RAILWAY_DEPLOYMENT_ID: optionalString,
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== 'production') {
      return;
    }
    // Values published in this repository work everywhere else, never in production.
    const weakKey =
      'must be 32 random bytes in production (openssl rand -base64 32), not the example/CI key';
    if (isWeakCredentialKey(env.CREDENTIALS_ENCRYPTION_KEY)) {
      ctx.addIssue({ code: 'custom', path: ['CREDENTIALS_ENCRYPTION_KEY'], message: weakKey });
    }
    env.CREDENTIALS_ENCRYPTION_KEYS_PREVIOUS.forEach((key, index) => {
      if (isWeakCredentialKey(key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['CREDENTIALS_ENCRYPTION_KEYS_PREVIOUS', index],
          message: weakKey,
        });
      }
    });
    if (PUBLISHED_AUTH_SECRETS.has(env.BETTER_AUTH_SECRET)) {
      ctx.addIssue({
        code: 'custom',
        path: ['BETTER_AUTH_SECRET'],
        message: 'must be a random secret in production (openssl rand -base64 32), not the example',
      });
    }
  });

export type ApiEnv = z.output<typeof ApiEnvSchema>;

/**
 * Parses and validates the API environment. Throws an Error that names every invalid variable and
 * why, without ever echoing values (they include secrets).
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): ApiEnv {
  // Empty strings count as unset, so `FOO=` in a .env file falls back to the default.
  const input: Record<string, string | undefined> = Object.fromEntries(
    Object.entries(source).filter(([, value]) => value !== undefined && value !== ''),
  );
  // Platforms (Railway, Render, Fly) tell the process where to listen through PORT.
  input['API_PORT'] ??= input['PORT'];
  const result = ApiEnvSchema.safeParse(input);
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid API environment:\n${problems}`);
  }
  const env = result.data;
  const production = env.NODE_ENV === 'production';
  return Object.freeze({
    ...env,
    WEB_DIST_DIR: env.WEB_DIST_DIR ?? (production ? DEFAULT_WEB_DIST_DIR : undefined),
  });
}
