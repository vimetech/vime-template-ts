import type { Tx } from '@vime/db';
import { ConflictError, NotFoundError } from '@vime/kernel';
import { and, eq, lt } from 'drizzle-orm';
import { createHmac } from 'node:crypto';
import { z } from 'zod';
import { IdempotencyConflictError, IdempotencyInProgressError, parseInput } from './errors';
import { idempotencyKeys } from './schema';

/*
 * Idempotency-Key support (spec §6, architecture §9.3). Records live per (organization, actor, key):
 * - same key + same request → the stored response is replayed without running the handler again;
 * - same key + different request → IdempotencyConflictError (409);
 * - same key while the first request has not completed → IdempotencyInProgressError (409).
 *
 * Intended use: begin, run the mutation and complete in the SAME withTenant transaction. A
 * concurrent retry with the same key then blocks on the primary key until the first transaction
 * commits, and replays its response; if the first one rolls back, nothing was stored and the retry
 * runs normally. (Begin in its own committed transaction only if the handler must survive a crash
 * mid-way; then a concurrent retry sees "in progress".) These records are request bookkeeping, not
 * business state, so they are not audited in activity_events.
 */

const KeyRefSchema = z.object({
  /** Who sent it: `idempotencyActorKey()`. */
  actorKey: z.string().min(1).max(200),
  /** The Idempotency-Key header value. */
  key: z.string().min(1).max(200),
});
export type IdempotencyKeyRef = z.input<typeof KeyRefSchema>;

/** Actor part of the idempotency scope: the device when known (offline outbox), else the user. */
export function idempotencyActorKey(actor: { userId?: string | null; deviceId?: string | null }) {
  if (actor.deviceId) return `device:${actor.deviceId}`;
  if (actor.userId) return `user:${actor.userId}`;
  throw new TypeError('idempotencyActorKey needs a userId or a deviceId');
}

/** JSON with object keys sorted at every level, so equal bodies hash equally. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, nested: unknown) => {
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      return Object.fromEntries(
        Object.entries(nested as Record<string, unknown>).sort(([a], [b]) =>
          a < b ? -1 : a > b ? 1 : 0,
        ),
      );
    }
    return nested;
  });
}

/**
 * Server-side secret of the request hash (at least 32 bytes). Never stored in the database: the API
 * derives it from its own secret (see apps/api `deriveRequestHashKey`).
 */
export type RequestHashKey = string | Uint8Array;

const MIN_REQUEST_HASH_KEY_BYTES = 32;

/**
 * HMAC-SHA256 (hex) identifying a request: method, path and canonical JSON body, under `key`.
 * Keyed on purpose: bodies can carry low-entropy secrets (a 4-digit door code, a short Wi-Fi
 * password, an invitation code) and a plain hash next to the request path would let anyone with a
 * read of `idempotency_keys` brute-force them offline; without the key the digest reveals nothing.
 */
export function computeRequestHash(
  request: { method: string; path: string; body?: unknown },
  key: RequestHashKey,
): string {
  const bytes = typeof key === 'string' ? Buffer.byteLength(key) : key.byteLength;
  if (bytes < MIN_REQUEST_HASH_KEY_BYTES) {
    throw new TypeError(
      `The request hash key must have at least ${MIN_REQUEST_HASH_KEY_BYTES} bytes`,
    );
  }
  const payload = canonicalJson([request.method.toUpperCase(), request.path, request.body ?? null]);
  return createHmac('sha256', key).update(payload).digest('hex');
}

export type IdempotencyRecord = typeof idempotencyKeys.$inferSelect;

/** The stored record for (current organization, actorKey, key), or null. */
export async function lookupIdempotentRequest(
  tx: Tx,
  ref: IdempotencyKeyRef,
): Promise<IdempotencyRecord | null> {
  const { actorKey, key } = parseInput(KeyRefSchema, ref);
  const [row] = await tx
    .select()
    .from(idempotencyKeys)
    .where(and(eq(idempotencyKeys.actorKey, actorKey), eq(idempotencyKeys.key, key)));
  return row ?? null;
}

export type IdempotencyBegin =
  { status: 'started' } | { status: 'replay'; statusCode: number; response: unknown };

/**
 * Claims `key` for this request. Returns `started` when the caller should run the mutation (and then
 * `completeIdempotentRequest`), or `replay` with the stored response of an identical earlier request.
 * Throws IdempotencyConflictError for a different request with the same key, and
 * IdempotencyInProgressError while the first request has not completed.
 */
export async function beginIdempotentRequest(
  tx: Tx,
  orgId: string,
  input: IdempotencyKeyRef & { requestHash: string },
): Promise<IdempotencyBegin> {
  const { actorKey, key } = parseInput(KeyRefSchema, input);
  const requestHash = parseInput(z.string().min(1).max(128), input.requestHash);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    // Blocks while another open transaction holds the same key, then sees its committed row.
    const inserted = await tx
      .insert(idempotencyKeys)
      .values({ organizationId: orgId, actorKey, key, requestHash })
      .onConflictDoNothing()
      .returning({ key: idempotencyKeys.key });
    if (inserted.length > 0) {
      return { status: 'started' };
    }
    const existing = await lookupIdempotentRequest(tx, { actorKey, key });
    if (!existing) {
      continue; // Purged between the insert and the lookup: claim it again.
    }
    if (existing.requestHash !== requestHash) {
      throw new IdempotencyConflictError();
    }
    if (existing.statusCode === null) {
      throw new IdempotencyInProgressError();
    }
    return { status: 'replay', statusCode: existing.statusCode, response: existing.response };
  }
  throw new IdempotencyInProgressError();
}

/**
 * Stores the response of a request started with `beginIdempotentRequest`. NotFoundError if it was
 * never begun; ConflictError if it was already completed.
 */
export async function completeIdempotentRequest(
  tx: Tx,
  input: IdempotencyKeyRef & { statusCode: number; response: unknown },
): Promise<void> {
  const { actorKey, key } = parseInput(KeyRefSchema, input);
  const statusCode = parseInput(z.number().int().min(100).max(599), input.statusCode);
  const where = and(eq(idempotencyKeys.actorKey, actorKey), eq(idempotencyKeys.key, key));
  const [current] = await tx.select().from(idempotencyKeys).where(where).for('update');
  if (!current) {
    throw new NotFoundError('idempotency_key', key);
  }
  if (current.statusCode !== null) {
    throw new ConflictError('This idempotent request was already completed');
  }
  await tx
    .update(idempotencyKeys)
    .set({ statusCode, response: input.response ?? null })
    .where(where);
}

/** Deletes records created before `olderThan` (30-day retention). Returns how many were deleted. */
export async function purgeIdempotencyKeys(tx: Tx, olderThan: Date): Promise<number> {
  const deleted = await tx
    .delete(idempotencyKeys)
    .where(lt(idempotencyKeys.createdAt, olderThan))
    .returning({ key: idempotencyKeys.key });
  return deleted.length;
}
