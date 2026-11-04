import { NOTIFICATION_CHANNELS, NOTIFICATION_STATUSES } from '@vime/contracts';
import { index, jsonb, text, unique, uuid } from 'drizzle-orm/pg-core';
import { enumCheck, tenantTable, timestamptz } from './_tenant';
import { user } from './auth';

/**
 * A notice to one person through one channel. The text comes from `template_key` + `params`
 * (packages/i18n). `dedupe_key` (unique per organization when set) keeps a burst of re-derivations
 * from notifying the same thing twice.
 */
export const notifications = tenantTable(
  'notifications',
  {
    recipientUserId: uuid('recipient_user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    channel: text('channel', { enum: NOTIFICATION_CHANNELS }).notNull(),
    templateKey: text('template_key').notNull(),
    params: jsonb('params').$type<Record<string, unknown>>().notNull().default({}),
    status: text('status', { enum: NOTIFICATION_STATUSES }).notNull().default('pending'),
    sentAt: timestamptz('sent_at'),
    readAt: timestamptz('read_at'),
    dedupeKey: text('dedupe_key'),
  },
  (t) => [
    unique('notifications_organization_id_dedupe_key_unique').on(t.organizationId, t.dedupeKey),
    index('notifications_organization_id_recipient_user_id_idx').on(
      t.organizationId,
      t.recipientUserId,
      t.createdAt,
    ),
    enumCheck('notifications_channel_check', t.channel, NOTIFICATION_CHANNELS),
    enumCheck('notifications_status_check', t.status, NOTIFICATION_STATUSES),
  ],
);
