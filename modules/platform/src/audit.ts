import {
  ActivityEventQuerySchema,
  type ActivityEvent,
  type ActivityEventQuery,
  type Page,
} from '@vime/contracts';
import type { Tx } from '@vime/db';
import { newId, ValidationError, isUuid } from '@vime/kernel';
import { and, desc, eq, lt } from 'drizzle-orm';
import type { z } from 'zod';
import type { ActorContext } from './context';
import { iso, isoOrNull } from './dto';
import { parseInput } from './errors';
import { activityEvents } from './schema';

/** What happened to which entity. The actor and request fields come from the ActorContext. */
export interface ActivityInput {
  /** Stable lowercase entity name, e.g. `note`, `membership`, `organization`. */
  entityType: string;
  entityId: string;
  /** `<entity>.<verb>`, e.g. `note.created`, `membership.roles_changed`. */
  eventType: string;
  /** JSON-serializable details (changes, reasons). */
  payload?: Record<string, unknown>;
}

/**
 * Appends an activity event (ADR 012) in the caller's transaction, so the audit record commits or
 * rolls back with the state change it describes. Stores every ADR 012 field: actor (user),
 * source, entity, event type, payload, client_occurred_at, occurred_at (the
 * skew-corrected instant, or now), recorded_at (now), request_id and idempotency_key.
 * Returns the event id.
 */
export async function recordActivity(
  tx: Tx,
  ctx: ActorContext,
  event: ActivityInput,
): Promise<string> {
  const id = newId();
  await tx.insert(activityEvents).values({
    id,
    organizationId: ctx.orgId,
    actorUserId: ctx.userId ?? null,
    source: ctx.source,
    entityType: event.entityType,
    entityId: event.entityId,
    eventType: event.eventType,
    payload: event.payload ?? {},
    clientOccurredAt: ctx.clientOccurredAt ?? null,
    ...(ctx.occurredAt ? { occurredAt: ctx.occurredAt } : {}),
    requestId: ctx.requestId ?? null,
    idempotencyKey: ctx.idempotencyKey ?? null,
  });
  return id;
}

type ActivityEventRow = typeof activityEvents.$inferSelect;

function toActivityEvent(row: ActivityEventRow): ActivityEvent {
  return {
    id: row.id,
    actorUserId: row.actorUserId,
    source: row.source,
    entityType: row.entityType,
    entityId: row.entityId,
    eventType: row.eventType,
    payload: row.payload,
    clientOccurredAt: isoOrNull(row.clientOccurredAt),
    occurredAt: iso(row.occurredAt),
    recordedAt: iso(row.recordedAt),
    requestId: row.requestId,
    idempotencyKey: row.idempotencyKey,
  };
}

/**
 * The organization's activity, newest first, optionally for one entity. Ids are UUIDv7, so id order
 * is recording order; the cursor is the id of the last event of the previous page.
 */
export async function listActivity(
  tx: Tx,
  query: z.input<typeof ActivityEventQuerySchema> = {},
): Promise<Page<ActivityEvent>> {
  const { limit, cursor, entityType, entityId }: ActivityEventQuery = parseInput(
    ActivityEventQuerySchema,
    query,
  );
  if (cursor !== undefined && !isUuid(cursor)) {
    throw new ValidationError([{ path: 'cursor', message: 'Invalid cursor' }]);
  }
  const rows = await tx
    .select()
    .from(activityEvents)
    .where(
      and(
        entityType === undefined ? undefined : eq(activityEvents.entityType, entityType),
        entityId === undefined ? undefined : eq(activityEvents.entityId, entityId),
        cursor === undefined ? undefined : lt(activityEvents.id, cursor),
      ),
    )
    .orderBy(desc(activityEvents.id))
    .limit(limit + 1);
  const items = rows.slice(0, limit).map(toActivityEvent);
  const last = items.at(-1);
  return { items, nextCursor: rows.length > limit && last ? last.id : null };
}

export interface ClientTimeInput {
  /** When the device says the action happened (its own clock). */
  clientOccurredAt: Date;
  /** When the device says it sent the request (`X-Client-Sent-At`, same clock). */
  clientSentAt: Date;
  /** When the server received the request. */
  receivedAt: Date;
  /** Lower bound, e.g. the entity's created_at: an action cannot precede its subject. */
  notBefore?: Date;
}

/**
 * Corrects a device timestamp for clock skew (spec §6): `offset = receivedAt - clientSentAt`,
 * `occurredAt = clientOccurredAt + offset`, clamped to `[notBefore, receivedAt]`. The raw device time
 * is still stored as `client_occurred_at`.
 */
export function skewCorrectedOccurredAt(input: ClientTimeInput): Date {
  const offset = input.receivedAt.getTime() - input.clientSentAt.getTime();
  let corrected = input.clientOccurredAt.getTime() + offset;
  if (input.notBefore !== undefined) {
    corrected = Math.max(corrected, input.notBefore.getTime());
  }
  corrected = Math.min(corrected, input.receivedAt.getTime());
  return new Date(corrected);
}
