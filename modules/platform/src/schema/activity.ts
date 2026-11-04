import { ACTIVITY_SOURCES } from '@vime/contracts';
import { index, jsonb, text, uuid } from 'drizzle-orm/pg-core';
import { enumCheck, tenantTable, timestamptz } from './_tenant';

/**
 * Append-only audit trail (ADR 012), written in the same transaction as the state change.
 * vime_app has UPDATE and DELETE revoked (custom migration `0001_platform_policies`). Actors and
 * the entity are plain ids without foreign keys: the entity is polymorphic, and history must
 * survive deletions. List an organization's events by `id` (UUIDv7, so creation order) through the
 * `(organization_id, id)` unique index.
 */
export const activityEvents = tenantTable(
  'activity_events',
  {
    actorUserId: uuid('actor_user_id'),
    source: text('source', { enum: ACTIVITY_SOURCES }).notNull(),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    eventType: text('event_type').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    /** Raw device clock (offline replays). */
    clientOccurredAt: timestamptz('client_occurred_at'),
    /** When it happened: skew-corrected device time, or the server time. */
    occurredAt: timestamptz('occurred_at').notNull().defaultNow(),
    /** When the server recorded it. */
    recordedAt: timestamptz('recorded_at').notNull().defaultNow(),
    requestId: text('request_id'),
    idempotencyKey: text('idempotency_key'),
  },
  (t) => [
    index('activity_events_entity_idx').on(
      t.organizationId,
      t.entityType,
      t.entityId,
      t.recordedAt,
    ),
    enumCheck('activity_events_source_check', t.source, ACTIVITY_SOURCES),
  ],
);
