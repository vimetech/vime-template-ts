import { JsonObjectSchema, NotificationChannelSchema } from '@vime/contracts';
import type { Tx } from '@vime/db';
import { newId } from '@vime/kernel';
import { and, desc, eq, gte, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { recordActivity } from './audit';
import type { ActorContext } from './context';
import { parseInput } from './errors';
import { notifications } from './schema';

export type Notification = typeof notifications.$inferSelect;

export const CreateNotificationSchema = z.object({
  recipientUserId: z.uuid(),
  channel: NotificationChannelSchema,
  /** i18n template key (packages/i18n), e.g. `note.created`. */
  templateKey: z.string().min(1).max(200),
  params: JsonObjectSchema.default({}),
  /** Unique per organization: a second notification with the same key is not created. */
  dedupeKey: z.string().min(1).max(500).nullish(),
});
export type CreateNotificationInput = z.input<typeof CreateNotificationSchema>;

export interface CreateNotificationResult {
  notification: Notification;
  /** False when a notification with the same dedupe key already existed (it is returned instead). */
  created: boolean;
}

/**
 * Inserts a notification (status `pending`) in the caller's transaction, deduplicated by
 * `dedupeKey`. Delivery (push, ...) happens in a worker job after commit, never inside the
 * transaction. Audited as `notification.created` when created.
 */
export async function createNotification(
  tx: Tx,
  ctx: ActorContext,
  input: CreateNotificationInput,
): Promise<CreateNotificationResult> {
  const data = parseInput(CreateNotificationSchema, input);
  const [row] = await tx
    .insert(notifications)
    .values({
      id: newId(),
      organizationId: ctx.orgId,
      recipientUserId: data.recipientUserId,
      channel: data.channel,
      templateKey: data.templateKey,
      params: data.params,
      dedupeKey: data.dedupeKey ?? null,
    })
    .onConflictDoNothing({ target: [notifications.organizationId, notifications.dedupeKey] })
    .returning();
  if (!row) {
    const [existing] = await tx
      .select()
      .from(notifications)
      .where(eq(notifications.dedupeKey, data.dedupeKey ?? ''));
    if (!existing) {
      throw new Error('Notification insert conflicted but no notification has its dedupe key');
    }
    return { notification: existing, created: false };
  }
  await recordActivity(tx, ctx, {
    entityType: 'notification',
    entityId: row.id,
    eventType: 'notification.created',
    payload: {
      channel: row.channel,
      templateKey: row.templateKey,
      recipientUserId: row.recipientUserId,
      dedupeKey: row.dedupeKey,
    },
  });
  return { notification: row, created: true };
}

/** How far back a user's unread in-app notices are listed. */
export const NOTICE_DAYS = 14;

/**
 * A user's UNREAD `in_app` notices of the last `NOTICE_DAYS` days, newest first (at most `limit`).
 */
export async function listUnreadNotices(
  tx: Tx,
  userId: string,
  now: Date,
  limit = 50,
): Promise<Notification[]> {
  const since = new Date(now.getTime() - NOTICE_DAYS * 24 * 60 * 60 * 1000);
  return tx
    .select()
    .from(notifications)
    .where(
      and(
        eq(notifications.recipientUserId, userId),
        eq(notifications.channel, 'in_app'),
        isNull(notifications.readAt),
        gte(notifications.createdAt, since),
      ),
    )
    .orderBy(desc(notifications.createdAt), desc(notifications.id))
    .limit(limit);
}

/**
 * Marks these notices of the user as read. Ids of other people, or already read, are ignored, so
 * it is idempotent. Returns how many changed. Reading a notice is not a business state change: no
 * activity event.
 */
export async function markNoticesRead(
  tx: Tx,
  userId: string,
  ids: readonly string[],
  now: Date,
): Promise<number> {
  if (ids.length === 0) return 0;
  const rows = await tx
    .update(notifications)
    .set({ readAt: now })
    .where(
      and(
        inArray(notifications.id, [...ids]),
        eq(notifications.recipientUserId, userId),
        isNull(notifications.readAt),
      ),
    )
    .returning({ id: notifications.id });
  return rows.length;
}
