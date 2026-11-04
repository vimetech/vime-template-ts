import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import type { JobDispatcher } from '@vime/db';
import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { createAuth, type AuthLogger } from './auth/auth';
import { deriveInvitationCodeKey } from './auth/invite-code';
import { deriveRequestHashKey } from './context/idempotency';
import { registerAuthRoutes } from './auth/routes';
import { MembershipCache } from './context/membership-cache';
import { registerRequestContext } from './context/request-context';
import { registerServices } from './context/services';
import { loadEnv, type ApiEnv } from './env';
import {
  APP_VERSION_HEADER,
  CLIENT_SENT_AT_HEADER,
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENT_REPLAY_HEADER,
} from './http/client-info';
import {
  REQUEST_ID_HEADER,
  generateRequestId,
  loggerOptions,
  type LoggerSetting,
} from './http/logging';
import { registerOpenApi } from './http/openapi';
import { errorHandler, notFoundHandler } from './http/problem';
import { DEFAULT_RATE_LIMITS, registerRateLimit, type RateLimitSettings } from './http/rate-limit';
import {
  contentSecurityPolicyDirectives,
  registerStaticSites,
  staticSitesFromEnv,
  stripApiPrefix,
} from './http/static';
import { CSV_BODY_LIMIT_BYTES } from './routes/csv';
import { registerRoutes } from './routes';

export interface BuildAppOptions {
  /** Parsed environment; defaults to `loadEnv()` (process.env). */
  env?: ApiEnv;
  /** `false` disables logging; an object overrides the level or the destination stream. */
  logger?: LoggerSetting;
  rateLimits?: Partial<RateLimitSettings>;
  membershipCache?: MembershipCache;
  /**
   * Job dispatcher of the routes. Default: a pg-boss producer (transactional enqueue through the
   * request's transaction), stopped by `app.close()`.
   */
  jobs?: JobDispatcher;
}

function authLogger(log: FastifyBaseLogger): AuthLogger {
  return {
    debug: (message, ...args) => log.debug({ args }, message),
    info: (message, ...args) => log.info({ args }, message),
    warn: (message, ...args) => log.warn({ args }, message),
    error: (message, ...args) => log.error({ args }, message),
  };
}

/**
 * Builds the API (composition root): Fastify with Zod validation/serialization, problem+json
 * errors, security headers, CORS for the web app, rate limits, request ids, OpenAPI, Better Auth
 * under /auth and the /v1 routes. Used by server.ts and by tests (`app.inject`).
 *
 * Single origin (ADR 0014): every route also answers under `/api` (`/api/v1/me` is `/v1/me`), and
 * when its build is present (WEB_DIST_DIR) the web app is served at `/` (http/static.ts).
 *
 * The database pools belong to @vime/db: after `app.close()`, call `closeDb()` (server.ts does).
 */
export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const env = options.env ?? loadEnv();
  const rateLimits: RateLimitSettings = {
    ...DEFAULT_RATE_LIMITS,
    ...(env.RATE_LIMIT_GLOBAL === undefined ? {} : { global: env.RATE_LIMIT_GLOBAL }),
    ...options.rateLimits,
  };

  const app = Fastify({
    logger: loggerOptions(env, options.logger),
    genReqId: generateRequestId,
    logController: new LogController({ requestIdLogLabel: 'requestId' }),
    trustProxy: env.TRUST_PROXY,
    // `/api/...` is the same-origin path of the web app (as the Vite dev proxy does).
    rewriteUrl: (request) => stripApiPrefix(request.url ?? '/'),
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler(errorHandler);
  app.addHook('onRequest', async (request, reply) => {
    reply.header(REQUEST_ID_HEADER, request.id);
  });

  await app.register(helmet, {
    // Reads come from the web app on the same origin (or site).
    crossOriginResourcePolicy: { policy: 'same-site' },
    contentSecurityPolicy: { useDefaults: false, directives: contentSecurityPolicyDirectives(env) },
  });
  await app.register(cors, {
    origin: [env.WEB_ORIGIN],
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: [
      'authorization',
      'content-type',
      IDEMPOTENCY_KEY_HEADER,
      APP_VERSION_HEADER,
      REQUEST_ID_HEADER,
      CLIENT_SENT_AT_HEADER,
      'if-none-match',
    ],
    exposedHeaders: [
      'set-auth-token',
      REQUEST_ID_HEADER,
      IDEMPOTENT_REPLAY_HEADER,
      'retry-after',
      // Conditional polling and the CSV downloads.
      'etag',
      'content-disposition',
    ],
    maxAge: 600,
  });
  await registerRateLimit(app, rateLimits);
  const { sites, skipped } = staticSitesFromEnv(env);
  for (const site of skipped) {
    app.log.warn(site, `${site.name} app not served: ${site.reason}`);
  }
  if (sites.web) {
    app.log.info({ web: sites.web.root }, 'serving the web app on this origin');
  }
  const spaFallback = await registerStaticSites(app, sites);
  app.setNotFoundHandler({ preHandler: app.rateLimit() }, (request, reply) => {
    if (!spaFallback(request, reply)) {
      notFoundHandler(request, reply);
    }
  });
  await registerOpenApi(app, env);

  app.addContentTypeParser(
    'text/csv',
    { parseAs: 'string', bodyLimit: CSV_BODY_LIMIT_BYTES },
    (_request, body, done) => done(null, body),
  );

  const membershipCache = options.membershipCache ?? new MembershipCache();
  const auth = createAuth({
    env,
    logger: authLogger(app.log),
    onMembershipChanged: ({ userId, orgId }) => membershipCache.invalidate(userId, orgId),
  });
  registerRequestContext(app, {
    auth,
    membershipCache,
    trustedOrigins: [env.WEB_ORIGIN, env.API_PUBLIC_URL],
    invitationCodeKey: deriveInvitationCodeKey(env.BETTER_AUTH_SECRET),
    platformAdminUserIds: env.PLATFORM_ADMIN_USER_IDS,
    requestHashKey: deriveRequestHashKey(env.BETTER_AUTH_SECRET),
  });
  registerAuthRoutes(app, auth, { publicUrl: env.API_PUBLIC_URL, rateLimits });
  await registerServices(app, { env, ...(options.jobs ? { jobs: options.jobs } : {}) });
  await registerRoutes(app, { rateLimits });
  return app;
}
