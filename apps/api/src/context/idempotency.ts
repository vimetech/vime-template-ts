import type { Tx } from '@vime/db';
import { ValidationError, isUuid } from '@vime/kernel';
import {
  beginIdempotentRequest,
  completeIdempotentRequest,
  computeRequestHash,
  idempotencyActorKey,
  type ActorContext,
} from '@vime/platform';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { hkdfSync } from 'node:crypto';
import { IDEMPOTENCY_KEY_HEADER, IDEMPOTENT_REPLAY_HEADER } from '../http/client-info';

/*
 * Idempotency-Key support for every mutation under /v1/orgs/:orgId (spec §6, architecture §9.3).
 *
 * Route handlers run their mutation through `mutate()`. With an `Idempotency-Key` header (UUID),
 * the key is claimed, the mutation runs and its response is stored, all in ONE withTenant
 * transaction (platform idempotency services):
 * - same key + same request (method, path, validated body) → the stored response is replayed with
 *   its status code and `Idempotent-Replayed: true`, without running the mutation again;
 * - same key + different request → 409 `idempotency_conflict`;
 * - same key while the first request is still running → the retry waits on the key's row lock and
 *   then replays (or 409 `idempotency_in_progress` if the first one was begun elsewhere).
 * A failed mutation rolls back, key included, so the client can retry it. Keys are scoped per
 * organization and actor (the user). The header is optional (web) but accepted on every mutation.
 */

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * HMAC key of the Idempotency-Key request hashes (`computeRequestHash`), derived from
 * BETTER_AUTH_SECRET so it lives outside the database: a request body can carry low-entropy
 * secrets (a door code, a Wi-Fi password, an invitation code) and a read of `idempotency_keys`
 * alone must not let anyone brute-force them. Rotating that secret only turns retries of requests
 * begun before the rotation into 409 `idempotency_conflict` (keys are short-lived).
 */
export function deriveRequestHashKey(secret: string): Buffer {
  return Buffer.from(hkdfSync('sha256', secret, '', 'vime:idempotency-request', 32));
}

/** An Idempotency-Key header value: null when absent, lowercase UUID, else a 400. */
export function parseIdempotencyKey(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string' || !isUuid(value)) {
    throw new ValidationError([
      { path: `headers.${IDEMPOTENCY_KEY_HEADER}`, message: 'Expected a UUID' },
    ]);
  }
  return value.toLowerCase();
}

/** The request's Idempotency-Key, or null. 400 when present but not a UUID. */
export function idempotencyKeyOf(request: FastifyRequest): string | null {
  return parseIdempotencyKey(request.headers[IDEMPOTENCY_KEY_HEADER]);
}

export interface MutateOptions<T> {
  /** Status of a fresh (not replayed) response. Default 200. */
  status?: number;
  /**
   * What to store for replays, from the fresh response body. Strip secrets that must never be
   * persisted (e.g. an invitation code shown once). Default: the body itself.
   */
  stored?: (body: T) => unknown;
  /**
   * Builds the replayed body from the stored one. Required when `stored` changes the shape; throw
   * here when the original response cannot be shown again.
   */
  replay?: (stored: unknown) => T;
}

/**
 * Runs `fn` in the request's tenant transaction with Idempotency-Key handling, sets the reply
 * status and returns the response body (return it from the handler). On a replay, the stored body
 * is returned (through `options.replay` when given): it is the response of an identical earlier
 * request, so it has the same shape.
 */
export async function mutate<T>(
  request: FastifyRequest,
  reply: FastifyReply,
  fn: (tx: Tx, actor: ActorContext) => Promise<T>,
  options: MutateOptions<T> = {},
): Promise<T> {
  const status = options.status ?? 200;
  const key = idempotencyKeyOf(request);
  const actor = request.actor;
  request.idempotencyHandled = true;
  if (key === null) {
    const body = await request.tenant((tx) => fn(tx, actor));
    reply.code(status);
    return body;
  }
  const ref = { actorKey: idempotencyActorKey(actor), key };
  const requestHash = computeRequestHash(
    { method: request.method, path: request.url, body: request.body },
    request.server.requestHashKey,
  );
  const outcome = await request.tenant(async (tx) => {
    const begin = await beginIdempotentRequest(tx, actor.orgId, { ...ref, requestHash });
    if (begin.status === 'replay') {
      const body = options.replay ? options.replay(begin.response) : (begin.response as T);
      return { replayed: true, statusCode: begin.statusCode, body };
    }
    const body = await fn(tx, actor);
    const stored = options.stored ? options.stored(body) : body;
    await completeIdempotentRequest(tx, { ...ref, statusCode: status, response: stored ?? null });
    return { replayed: false, statusCode: status, body };
  });
  if (outcome.replayed) {
    reply.header(IDEMPOTENT_REPLAY_HEADER, 'true');
  }
  reply.code(outcome.statusCode);
  return outcome.body;
}

/**
 * Safety net for the scope of mutation routes: logs an error when a successful mutation carried an
 * Idempotency-Key but its handler did not use `mutate()` (the key was silently ignored).
 */
export function registerIdempotencyCheck(app: FastifyInstance): void {
  app.addHook('onSend', async (request, reply, payload) => {
    if (
      MUTATING_METHODS.has(request.method) &&
      request.headers[IDEMPOTENCY_KEY_HEADER] !== undefined &&
      !request.idempotencyHandled &&
      reply.statusCode < 400
    ) {
      request.log.error(
        { route: request.routeOptions.url },
        'mutation route ignored the Idempotency-Key header (handler does not use mutate())',
      );
    }
    return payload;
  });
}
