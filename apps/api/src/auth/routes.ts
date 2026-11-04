import { RedeemInvitationRequestSchema, UuidSchema } from '@vime/contracts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { IDEMPOTENCY_KEY_HEADER } from '../http/client-info';
import { codeForStatus, problemResponses, sendProblem } from '../http/problem';
import type { RateLimitSettings } from '../http/rate-limit';
import { AUTH_BASE_PATH, type Auth } from './auth';
import { REDEEM_INVITATION_PATH } from './invite-code';
import {
  RedeemInvitationResponseSchema,
  SignInEmailRequestSchema,
  SignInEmailResponseSchema,
} from './schemas';

const RedeemHeadersSchema = z.looseObject({
  [IDEMPOTENCY_KEY_HEADER]: UuidSchema.optional().describe(
    'Client-generated UUID that makes retries safe: an identical retry after a lost response ' +
      'replays the redemption (header Idempotent-Replayed: true) with a new session; the same key ' +
      'with a different request is a 409.',
  ),
});

/** Request headers that describe the incoming connection, not the request itself. */
const DROPPED_REQUEST_HEADERS = new Set([
  'host',
  'connection',
  'keep-alive',
  'content-length',
  'transfer-encoding',
  'upgrade',
  'expect',
]);

/** Response headers Fastify computes itself. */
const DROPPED_RESPONSE_HEADERS = new Set([
  'set-cookie',
  'content-length',
  'content-encoding',
  'transfer-encoding',
  'connection',
]);

/**
 * Fastify request → Fetch Request for Better Auth's handler. The body was already parsed by
 * Fastify (Better Auth only accepts JSON), so it is serialized again. The client IP Fastify
 * resolved (honoring TRUST_PROXY) replaces any client-sent X-Forwarded-For, and the request id is
 * forwarded so the inviteCode plugin can put it on audit events.
 */
export function toFetchRequest(request: FastifyRequest, baseUrl: string): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined || DROPPED_REQUEST_HEADERS.has(name)) continue;
    for (const item of Array.isArray(value) ? value : [value]) {
      headers.append(name, item);
    }
  }
  headers.set('x-forwarded-for', request.ip);
  headers.set('x-request-id', request.id);
  const hasBody =
    request.method !== 'GET' &&
    request.method !== 'HEAD' &&
    request.body !== undefined &&
    request.body !== null;
  if (hasBody) {
    headers.set('content-type', 'application/json');
  }
  return new Request(new URL(request.url, baseUrl), {
    method: request.method,
    headers,
    ...(hasBody ? { body: JSON.stringify(request.body) } : {}),
  });
}

interface BetterAuthErrorBody {
  code?: unknown;
  message?: unknown;
}

function parseErrorBody(text: string): BetterAuthErrorBody {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? (parsed as BetterAuthErrorBody) : {};
  } catch {
    return {};
  }
}

/**
 * Better Auth's Response → Fastify reply. Successful responses pass through unchanged (status,
 * headers, every Set-Cookie, body). Error responses become problem+json with the code derived from
 * the status; Better Auth's own error code and message are kept as the `authCode` and `message`
 * extension members (its client libraries read `message`).
 */
export async function sendFetchResponse(
  request: FastifyRequest,
  reply: FastifyReply,
  response: Response,
): Promise<FastifyReply> {
  const text = await response.text();
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) {
    reply.header('set-cookie', cookies);
  }
  if (response.status >= 400) {
    const body = parseErrorBody(text);
    const message = typeof body.message === 'string' ? body.message : undefined;
    const authCode = typeof body.code === 'string' ? body.code : undefined;
    return sendProblem(request, reply, {
      code: codeForStatus(response.status),
      status: response.status,
      ...(message === undefined ? {} : { detail: message }),
      extensions: {
        ...(authCode === undefined ? {} : { authCode }),
        ...(message === undefined ? {} : { message }),
      },
    });
  }
  for (const [name, value] of response.headers) {
    if (!DROPPED_RESPONSE_HEADERS.has(name)) {
      reply.header(name, value);
    }
  }
  reply.code(response.status);
  return text === '' ? reply.send() : reply.send(text);
}

/**
 * True when Better Auth would route `rawUrl` to the same path Fastify matched. Better Auth routes on
 * the WHATWG-normalized pathname (dot segments, `%2e` and backslashes resolved), Fastify on the raw
 * one: `/auth/./sign-in/email` matches the `/auth/*` wildcard in Fastify but reaches Better Auth's
 * sign-in, skipping the strict rate limit and the validation of the explicit route.
 */
export function isCanonicalAuthPath(rawUrl: string, baseUrl: string): boolean {
  const rawPath = rawUrl.split('?', 1)[0] ?? '';
  return new URL(rawUrl, baseUrl).pathname === rawPath;
}

/**
 * Mounts Better Auth on Fastify under /auth. Every /auth/* request with a canonical path goes to
 * `auth.handler` (any other is a 404, see `isCanonicalAuthPath`); the sign-in and invitation redeem
 * endpoints are also registered explicitly, so they get the strict rate limit, Zod validation
 * (problem+json on bad input) and an OpenAPI entry.
 */
export function registerAuthRoutes(
  app: FastifyInstance,
  auth: Auth,
  options: { publicUrl: string; rateLimits: RateLimitSettings },
): void {
  const { publicUrl, rateLimits } = options;
  const handler = async (request: FastifyRequest, reply: FastifyReply) =>
    sendFetchResponse(request, reply, await auth.handler(toFetchRequest(request, publicUrl)));
  const strict = { rateLimit: { max: rateLimits.signIn, timeWindow: rateLimits.timeWindowMs } };
  const zod = app.withTypeProvider<ZodTypeProvider>();

  zod.route({
    method: ['GET', 'POST'],
    url: `${AUTH_BASE_PATH}/*`,
    schema: { hide: true },
    config: { rateLimit: { max: rateLimits.auth, timeWindow: rateLimits.timeWindowMs } },
    handler: async (request, reply) => {
      if (!isCanonicalAuthPath(request.url, publicUrl)) {
        return reply.callNotFound();
      }
      return handler(request, reply);
    },
  });

  zod.post(
    `${AUTH_BASE_PATH}/sign-in/email`,
    {
      schema: {
        tags: ['auth'],
        summary: 'Sign in with email and password',
        description:
          'Better Auth endpoint. Sets the session cookie (web) and returns the session token in ' +
          '`token` and the `set-auth-token` header (mobile: send it as `Authorization: Bearer`). ' +
          'Strictly rate limited per IP.',
        security: [],
        body: SignInEmailRequestSchema,
        response: { 200: SignInEmailResponseSchema, ...problemResponses },
      },
      config: strict,
    },
    handler,
  );

  zod.post(
    `${AUTH_BASE_PATH}${REDEEM_INVITATION_PATH}`,
    {
      schema: {
        tags: ['auth'],
        summary: 'Redeem an invitation code (sign in without email)',
        description:
          'Creates (or reuses) the user, joins the organization with the invited roles and ' +
          'returns a new session: cookie, `set-auth-token` header and `token` in the body. A ' +
          'code-only redeemer sends only `code` (and optionally `name`); otherwise send ' +
          '`email` + `password` (a new user only for an invitation bound to that email). An ' +
          'unknown, expired or used-up code is a 400 on `code`; a suspended membership is a 409. ' +
          'An identical retry with the same Idempotency-Key replays the redemption with a new ' +
          'session. Strictly rate limited per IP.',
        security: [],
        headers: RedeemHeadersSchema,
        body: RedeemInvitationRequestSchema,
        response: { 200: RedeemInvitationResponseSchema, ...problemResponses },
      },
      config: strict,
    },
    handler,
  );
}
