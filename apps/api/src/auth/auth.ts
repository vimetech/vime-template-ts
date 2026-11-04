import { createAuthDatabase } from '@vime/db';
import { newId } from '@vime/kernel';
import { authSchema } from '@vime/platform/schema';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { bearer } from 'better-auth/plugins';
import type { ApiEnv } from '../env';
import { deriveRequestHashKey } from '../context/idempotency';
import { deriveInvitationCodeKey, inviteCode, type InviteCodeOptions } from './invite-code';

/** Better Auth is mounted under this prefix (`/auth/sign-in/email`, `/auth/invite/redeem`...). */
export const AUTH_BASE_PATH = '/auth';

/** Sessions last 60 days and slide: each day of use extends them (code-only members rarely sign in again). */
export const SESSION_EXPIRES_IN_SECONDS = 60 * 24 * 60 * 60;
export const SESSION_UPDATE_AGE_SECONDS = 24 * 60 * 60;

/** Cookie names start with this (`vime.session_token`, `__Secure-` prefixed over HTTPS). */
export const AUTH_COOKIE_PREFIX = 'vime';

type LogLevel = 'debug' | 'info' | 'success' | 'warn' | 'error';

export interface AuthLogger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

export interface CreateAuthOptions extends InviteCodeOptions {
  env: Pick<ApiEnv, 'API_PUBLIC_URL' | 'WEB_ORIGIN' | 'BETTER_AUTH_SECRET'>;
  logger?: AuthLogger;
}

/**
 * Better Auth (ADR 0005): identity and sessions only. Authorization (memberships, roles,
 * permissions) is ours and is resolved per request, never stored in the session.
 *
 * - Storage: the Drizzle adapter over `createAuthDatabase()` (vime_system role): the Better Auth
 *   tables have no RLS and vime_app has no grants on them.
 * - Ids: UUIDv7 from @vime/kernel (`generateId`), as @vime/db and the platform tables require.
 * - Email + password for managers, without public sign-up: users are created by invitations
 *   (inviteCode plugin), seeds or administration.
 * - `bearer()` for the mobile app: `Authorization: Bearer <token>`; responses that set the session
 *   cookie also return the token in `set-auth-token`.
 * - Rate limiting is done by the API (@fastify/rate-limit), so Better Auth's own limiter is off.
 * - `onAPIError.throw`: errors that are not Better Auth APIErrors (our DomainErrors from the
 *   inviteCode plugin) propagate to the Fastify error handler and become problem+json.
 */
export function createAuth(options: CreateAuthOptions) {
  const { env, logger } = options;
  return betterAuth({
    appName: 'VIME Ops',
    baseURL: env.API_PUBLIC_URL,
    basePath: AUTH_BASE_PATH,
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: [env.WEB_ORIGIN],
    database: drizzleAdapter(createAuthDatabase(), { provider: 'pg', schema: authSchema }),
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: 8,
      maxPasswordLength: 128,
    },
    session: {
      expiresIn: SESSION_EXPIRES_IN_SECONDS,
      updateAge: SESSION_UPDATE_AGE_SECONDS,
    },
    advanced: {
      cookiePrefix: AUTH_COOKIE_PREFIX,
      database: { generateId: () => newId() },
    },
    rateLimit: { enabled: false },
    telemetry: { enabled: false },
    onAPIError: { throw: true },
    logger: {
      disabled: logger === undefined,
      level: 'warn',
      log: (level: LogLevel, message: string, ...args: unknown[]) => {
        if (!logger) return;
        const method = level === 'success' ? 'info' : level;
        logger[method](`[better-auth] ${message}`, ...args);
      },
    },
    plugins: [
      bearer(),
      inviteCode(
        {
          codeKey: deriveInvitationCodeKey(env.BETTER_AUTH_SECRET),
          requestHashKey: deriveRequestHashKey(env.BETTER_AUTH_SECRET),
        },
        options.onMembershipChanged ? { onMembershipChanged: options.onMembershipChanged } : {},
      ),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
