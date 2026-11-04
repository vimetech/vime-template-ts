import { index, integer, jsonb, primaryKey, text } from 'drizzle-orm/pg-core';
import { tenantTableWithoutId } from './_tenant';

/**
 * Idempotency-Key records (spec §6). `actor_key` identifies who sent the request (user or device),
 * `request_hash` the request (method, path, body). `status_code`/`response` are NULL while the
 * request is in progress. Purged after 30 days (`created_at`).
 */
export const idempotencyKeys = tenantTableWithoutId(
  'idempotency_keys',
  {
    actorKey: text('actor_key').notNull(),
    key: text('key').notNull(),
    requestHash: text('request_hash').notNull(),
    statusCode: integer('status_code'),
    response: jsonb('response').$type<unknown>(),
  },
  (t) => [
    primaryKey({ name: 'idempotency_keys_pk', columns: [t.organizationId, t.actorKey, t.key] }),
    index('idempotency_keys_created_at_idx').on(t.createdAt),
  ],
);
