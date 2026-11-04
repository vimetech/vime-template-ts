import { z } from 'zod';
import { LocaleSchema, TimeZoneSchema, TimestampSchema, UuidSchema } from './common';
import { FEATURES, FeatureKeySchema } from './features';
import { requiredText } from './fields';
import { SlugSchema } from './platform';

/*
 * Platform console (ADR 0015): what a platform administrator (`PLATFORM_ADMIN_USER_IDS`) manages
 * across organizations under `/v1/platform/*`. Metadata only: never an organization's operational
 * data.
 */

/** Days an owner invitation from the console stays valid. */
export const OWNER_INVITATION_DAYS = 14;

/** One feature entitlement of an organization (`organization_entitlements`). */
export const PlatformEntitlementSchema = z.object({
  featureKey: FeatureKeySchema,
  enabled: z.boolean(),
  /** Exclusive end; null = no end. A past date means the feature is off. */
  validUntil: TimestampSchema.nullable(),
});
export type PlatformEntitlement = z.infer<typeof PlatformEntitlementSchema>;

/** An organization as the platform console lists it. */
export const PlatformOrganizationSchema = z.object({
  id: UuidSchema,
  name: z.string(),
  slug: z.string(),
  timezone: TimeZoneSchema,
  locale: LocaleSchema,
  createdAt: TimestampSchema,
  /** Null while active. Suspended: every request inside it answers 403 `organization_suspended`. */
  suspendedAt: TimestampSchema.nullable(),
  /** Rows of `organization_entitlements` in FEATURES order (a feature without a row is off). */
  entitlements: z.array(PlatformEntitlementSchema),
  /** Active owners, to know who to talk to. Empty until the owner redeems the invitation. */
  owners: z.array(z.object({ name: z.string(), email: z.email().nullable() })),
});
export type PlatformOrganization = z.infer<typeof PlatformOrganizationSchema>;

/** POST /v1/platform/organizations: a new client organization and its owner's invitation. */
export const CreatePlatformOrganizationSchema = z.object({
  name: requiredText(200),
  slug: SlugSchema,
  timezone: TimeZoneSchema,
  locale: LocaleSchema.default('es-PE'),
  ownerEmail: z.email().max(254),
  /** Features enabled from the start. */
  features: z
    .array(FeatureKeySchema)
    .max(FEATURES.length)
    .default(['example'])
    .refine((list) => new Set(list).size === list.length, { message: 'Repeated feature' }),
});
export type CreatePlatformOrganization = z.input<typeof CreatePlatformOrganizationSchema>;

/**
 * An owner invitation, bound to the email: the owner redeems it on the web sign-in page («¿Te
 * invitaron por correo?») with that email, the code and a new password. The code is shown once.
 */
export const OwnerInvitationSchema = z.object({
  email: z.email(),
  code: z.string(),
  expiresAt: TimestampSchema,
});
export type OwnerInvitation = z.infer<typeof OwnerInvitationSchema>;

export const CreatePlatformOrganizationResponseSchema = z.object({
  organization: PlatformOrganizationSchema,
  ownerInvitation: OwnerInvitationSchema,
});
export type CreatePlatformOrganizationResponse = z.infer<
  typeof CreatePlatformOrganizationResponseSchema
>;

/** POST /v1/platform/organizations/:orgId/owner-invitations: a new code for an owner. */
export const CreateOwnerInvitationSchema = z.object({
  email: z.email().max(254),
});
export type CreateOwnerInvitation = z.infer<typeof CreateOwnerInvitationSchema>;

/** PUT /v1/platform/organizations/:orgId/entitlements/:featureKey. */
export const SetPlatformEntitlementSchema = z.object({
  enabled: z.boolean(),
  validUntil: TimestampSchema.nullable().default(null),
});
export type SetPlatformEntitlement = z.input<typeof SetPlatformEntitlementSchema>;

/** PUT /v1/platform/organizations/:orgId/suspension. The reason goes to the activity log. */
export const SuspendOrganizationSchema = z.object({
  reason: requiredText(500),
});
export type SuspendOrganization = z.infer<typeof SuspendOrganizationSchema>;
