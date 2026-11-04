import { TimestampSchema, UuidSchema } from '@vime/contracts';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireFeature } from '../context/request-context';
import {
  APP_VERSION_HEADER,
  CLIENT_SENT_AT_HEADER,
  IDEMPOTENCY_KEY_HEADER,
} from '../http/client-info';

/** OpenAPI security of authenticated routes: bearer token (mobile) or session cookie (web). */
export const AUTHENTICATED: { [scheme: string]: string[] }[] = [
  { bearerAuth: [] },
  { cookieAuth: [] },
];

export const OrgParamsSchema = z.object({
  orgId: UuidSchema.describe('Organization id (active organization of the request)'),
});

/**
 * Headers every /v1 route documents. Loose: other headers (authorization, cookie...) stay on the
 * request after validation.
 */
export const V1HeadersSchema = z.looseObject({
  [APP_VERSION_HEADER]: z
    .string()
    .optional()
    .describe('Mobile app version, e.g. 1.4.2 (captured; minimum versions are not enforced yet)'),
});

/** Headers of mutations: V1 headers plus the optional Idempotency-Key. */
export const MutationHeadersSchema = V1HeadersSchema.extend({
  [IDEMPOTENCY_KEY_HEADER]: UuidSchema.optional().describe(
    'Client-generated UUID that makes retries safe: an identical retry replays the stored ' +
      'response (header Idempotent-Replayed: true); the same key with a different request is a 409.',
  ),
});

/**
 * Headers of the commands an offline outbox may replay: mutation headers plus `X-Client-Sent-At`
 * (the device clock when it sent the request, so the server can correct device times in the body
 * for clock skew: `skewCorrectedOccurredAt`).
 */
export const CommandHeadersSchema = MutationHeadersSchema.extend({
  [CLIENT_SENT_AT_HEADER]: TimestampSchema.optional().describe(
    'Device clock when an offline outbox sent the request (ISO 8601). Marks an offline replay: ' +
      'device times in the body are corrected by the device clock offset.',
  ),
});

type Guard = (request: FastifyRequest) => Promise<void>;

/**
 * The preHandler guards of a route of the example module: the permission guard first (403
 * `forbidden`), then the `example` entitlement (403 `feature_not_enabled`). A new module writes
 * its own, with its feature key.
 */
export function exampleGuard(permissionGuard: Guard): Guard[] {
  return [permissionGuard, requireFeature('example')];
}

/** Non-paginated list response. Room for `nextCursor` later (additive change). */
export function listOf<T extends z.ZodType>(item: T) {
  return z.object({ items: z.array(item) });
}
