import { z } from 'zod';

/*
 * Platform enums. Each enum exports its values as a const tuple (usable by Drizzle
 * `text(..., { enum })` columns) plus a Zod schema and the inferred type. Domain modules keep their
 * own enums in their own contracts file (see `example.ts`).
 */

export const MEMBERSHIP_STATUSES = ['active', 'suspended'] as const;
export const MembershipStatusSchema = z.enum(MEMBERSHIP_STATUSES);
export type MembershipStatus = z.infer<typeof MembershipStatusSchema>;

/**
 * Origin of an activity event (ADR 012). `platform`: done by a platform administrator from the
 * platform console (modules, suspension; ADR 0015).
 */
export const ACTIVITY_SOURCES = [
  'web',
  'mobile',
  'webhook',
  'system',
  'import',
  'platform',
] as const;
export const ActivitySourceSchema = z.enum(ACTIVITY_SOURCES);
export type ActivitySource = z.infer<typeof ActivitySourceSchema>;

export const NOTIFICATION_CHANNELS = ['in_app', 'push', 'email'] as const;
export const NotificationChannelSchema = z.enum(NOTIFICATION_CHANNELS);
export type NotificationChannel = z.infer<typeof NotificationChannelSchema>;

/** Delivery status of a notification; reading is tracked separately via `read_at`. */
export const NOTIFICATION_STATUSES = ['pending', 'sent', 'failed'] as const;
export const NotificationStatusSchema = z.enum(NOTIFICATION_STATUSES);
export type NotificationStatus = z.infer<typeof NotificationStatusSchema>;

// ---------------------------------------------------------------------------
// ops flags (exception queue)
// ---------------------------------------------------------------------------

/**
 * Kinds of situations that need human judgement. Domain modules add their own kinds here; the
 * column has no CHECK, so adding one is a contracts change only.
 */
export const FLAG_KINDS = ['example_needs_review'] as const;
export const FlagKindSchema = z.enum(FLAG_KINDS);
export type FlagKind = z.infer<typeof FlagKindSchema>;

export const FLAG_SEVERITIES = ['info', 'warning', 'critical'] as const;
export const FlagSeveritySchema = z.enum(FLAG_SEVERITIES);
export type FlagSeverity = z.infer<typeof FlagSeveritySchema>;

export const FLAG_STATUSES = ['open', 'resolved', 'dismissed'] as const;
export const FlagStatusSchema = z.enum(FLAG_STATUSES);
export type FlagStatus = z.infer<typeof FlagStatusSchema>;
