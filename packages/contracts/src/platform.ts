import { z } from 'zod';
import {
  JsonObjectSchema,
  LocaleSchema,
  PageQuerySchema,
  TimestampSchema,
  TimeZoneSchema,
  UuidSchema,
} from './common';
import {
  ActivitySourceSchema,
  FlagKindSchema,
  FlagSeveritySchema,
  FlagStatusSchema,
  MembershipStatusSchema,
} from './enums';
import { FeatureKeySchema } from './features';
import { PermissionSchema, ROLE_KEYS, RoleKeySchema } from './permissions';
import { optionalText, requiredText, timestamps } from './fields';

/*
 * Platform DTOs (organizations, members, invitations, audit trail, the exception queue and CSV
 * import results).
 *
 * Conventions:
 * - `XxxSchema` is the response shape. Nullable columns are always present, as `null` when empty.
 * - `CreateXxxSchema` is a POST body: defaults are applied while parsing.
 * - `UpdateXxxSchema` is a PATCH body: every field optional, `null` clears a nullable field, and no
 *   defaults are applied (an omitted field keeps its current value).
 * - Put-replace collections (`{ items: [...] }`) replace the whole set in one request.
 */

/** Better Auth owns user ids; to us they are opaque strings. */
export const UserIdSchema = z.string().min(1).max(64);

export const SlugSchema = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message: 'Expected lowercase letters, digits and dashes',
  });

/** E.164 phone number: `+`, country code and subscriber number, 7 to 15 digits, no spaces. */
export const PhoneE164Schema = z.string().regex(/^\+[1-9]\d{6,14}$/, {
  message: 'Expected an E.164 phone number such as +51987654321',
});

const RoleKeysSchema = z
  .array(RoleKeySchema)
  .min(1)
  .max(ROLE_KEYS.length)
  .refine((keys) => new Set(keys).size === keys.length, { message: 'Duplicate role keys' });

// ---------------------------------------------------------------------------
// Organizations
// ---------------------------------------------------------------------------

/**
 * Functions an organization can turn off when they are only noise for it. Unlike features
 * (entitlements), which the platform enables, they are the organization's own choice
 * (`org.manage`, in settings) and are on by default: a function added here is on for every
 * organization until it turns it off. Turning one off only hides it in the apps (it is not an
 * authorization) and keeps its data. A domain module adds its optional functions here.
 */
export const OPTIONAL_FUNCTIONS = ['example_notes'] as const;
export const OptionalFunctionSchema = z.enum(OPTIONAL_FUNCTIONS);
export type OptionalFunction = z.infer<typeof OptionalFunctionSchema>;

/**
 * A list of turned-off functions. Plain strings so that a function this build does not know (a
 * newer server, one removed since) never breaks the settings or `/me`: readers ignore unknown
 * values (`isFunctionOn`), and a client that changes the list sends back the ones it does not
 * know as it found them.
 */
const DisabledFunctionsSchema = z.array(z.string().min(1).max(64)).max(50);

/** Whether `fn` is on, given an organization's turned-off functions (all on when unknown). */
export function isFunctionOn(
  disabledFunctions: readonly string[] | null | undefined,
  fn: OptionalFunction,
): boolean {
  return !(disabledFunctions ?? []).includes(fn);
}

const organizationSettingsFields = {
  /** Phone of whoever coordinates the organization (shown to members). Null: none. */
  coordinationPhoneE164: PhoneE164Schema.nullable(),
  /**
   * The optional functions the organization turned off (`OPTIONAL_FUNCTIONS`); empty: all on. A
   * change sends the whole list; the server accepts a value it does not know only if it was
   * already stored (a function removed since), and keeps the known ones.
   */
  disabledFunctions: DisabledFunctionsSchema.refine((fns) => new Set(fns).size === fns.length, {
    message: 'Duplicate functions',
  }),
};

/** `organizations.settings` (jsonb). Parse stored values with this schema to fill defaults. */
export const OrganizationSettingsSchema = z.object({
  coordinationPhoneE164: organizationSettingsFields.coordinationPhoneE164.default(null),
  /** May hold values this build does not know: read it with `isFunctionOn`. */
  disabledFunctions: DisabledFunctionsSchema.default([]),
});
export type OrganizationSettings = z.infer<typeof OrganizationSettingsSchema>;

export const OrganizationSchema = z.object({
  id: UuidSchema,
  name: z.string(),
  slug: z.string(),
  timezone: TimeZoneSchema,
  locale: LocaleSchema,
  settings: OrganizationSettingsSchema,
  ...timestamps,
});
export type Organization = z.infer<typeof OrganizationSchema>;

/** PATCH /organization. `settings` is merged key by key into the stored settings. */
export const UpdateOrganizationSchema = z.object({
  name: requiredText(200).optional(),
  timezone: TimeZoneSchema.optional(),
  locale: LocaleSchema.optional(),
  settings: z.object(organizationSettingsFields).partial().optional(),
});
export type UpdateOrganization = z.infer<typeof UpdateOrganizationSchema>;

// ---------------------------------------------------------------------------
// Me (current user and memberships)
// ---------------------------------------------------------------------------

export const MeOrganizationSchema = z.object({
  id: UuidSchema,
  name: z.string(),
  slug: z.string(),
  timezone: TimeZoneSchema,
  locale: LocaleSchema,
  /** `settings.coordinationPhoneE164`. Optional for clients' cached copies. */
  coordinationPhoneE164: PhoneE164Schema.nullish(),
  /**
   * `settings.disabledFunctions`, for hiding UI only (`isFunctionOn`); it may name functions this
   * client does not know. Optional for clients' cached copies (all on).
   */
  disabledFunctions: DisabledFunctionsSchema.optional(),
  /**
   * The platform suspended the organization (ADR 0015): every request inside it answers 403
   * `organization_suspended`. Optional for clients' cached copies (not suspended).
   */
  suspended: z.boolean().optional(),
});
export type MeOrganization = z.infer<typeof MeOrganizationSchema>;

export const MeMembershipSchema = z.object({
  organization: MeOrganizationSchema,
  roleKeys: z.array(RoleKeySchema),
  /** Effective permissions, for hiding UI only. The server always enforces authorization. */
  permissions: z.array(PermissionSchema),
  /**
   * Features (entitlements) the organization can use now, for hiding UI only (e.g. a module's
   * sections). The API always sends it; optional for clients' cached copies.
   */
  features: z.array(FeatureKeySchema).optional(),
});
export type MeMembership = z.infer<typeof MeMembershipSchema>;

export const MeResponseSchema = z.object({
  user: z.object({
    id: UserIdSchema,
    name: z.string(),
    /** Absent for users that signed in with an invitation code only (synthetic email). */
    email: z.email().nullish(),
  }),
  /** Active memberships only. */
  memberships: z.array(MeMembershipSchema),
  /**
   * The user is a platform administrator (`PLATFORM_ADMIN_USER_IDS`): the web shows the platform
   * console (ADR 0015). Optional for clients' cached copies (false).
   */
  platformAdmin: z.boolean().optional(),
});
export type MeResponse = z.infer<typeof MeResponseSchema>;

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

export const MemberSchema = z.object({
  /** Membership id. */
  id: UuidSchema,
  userId: UserIdSchema,
  name: z.string(),
  email: z.email().nullable(),
  roleKeys: z.array(RoleKeySchema),
  status: MembershipStatusSchema,
  ...timestamps,
});
export type Member = z.infer<typeof MemberSchema>;

export const UpdateMemberRolesSchema = z.object({
  roleKeys: RoleKeysSchema,
});
export type UpdateMemberRoles = z.infer<typeof UpdateMemberRolesSchema>;

// ---------------------------------------------------------------------------
// Invitations
// ---------------------------------------------------------------------------

export const CreateInvitationSchema = z
  .object({
    roleKeys: RoleKeysSchema,
    /**
     * Binds the invitation to this email (people who sign in with email + password). Only the user
     * with this email can redeem it, and only such an invitation creates a new user with a real
     * email. Single use.
     */
    email: z.email().max(254).optional(),
    expiresInHours: z
      .number()
      .int()
      .min(1)
      .max(24 * 30)
      .default(72),
    maxUses: z.number().int().min(1).max(100).default(1),
  })
  .refine((v) => v.email === undefined || v.maxUses === 1, {
    message: 'An invitation for an email can be used only once',
    path: ['maxUses'],
  });
export type CreateInvitation = z.infer<typeof CreateInvitationSchema>;

/** Invitation as listed. The code is never returned again after creation (only its hash is stored). */
export const InvitationListItemSchema = z.object({
  id: UuidSchema,
  roleKeys: z.array(RoleKeySchema),
  /** The email the invitation is bound to (lowercase), or null for a code anyone can redeem. */
  email: z.email().nullable(),
  expiresAt: TimestampSchema,
  maxUses: z.number().int(),
  uses: z.number().int(),
  revokedAt: TimestampSchema.nullable(),
  createdBy: UserIdSchema,
  createdAt: TimestampSchema,
});
export type InvitationListItem = z.infer<typeof InvitationListItemSchema>;

/** Response of POST /invitations: the only time the plaintext code is returned. */
export const CreateInvitationResponseSchema = InvitationListItemSchema.extend({
  code: z.string(),
});
export type CreateInvitationResponse = z.infer<typeof CreateInvitationResponseSchema>;

/**
 * Redeem an invitation code. A code-only redeemer sends only the code (and optionally a name).
 * Otherwise email + password go together: an existing user proves the email with its password; a
 * new user with that email is created only by an invitation bound to it (`CreateInvitation.email`).
 */
export const RedeemInvitationRequestSchema = z
  .object({
    code: requiredText(64),
    name: requiredText(100).optional(),
    email: z.email().optional(),
    password: z.string().min(8).max(128).optional(),
  })
  .refine((v) => (v.password === undefined) === (v.email === undefined), {
    message: 'Email and password must be sent together',
    path: ['password'],
  });
export type RedeemInvitationRequest = z.infer<typeof RedeemInvitationRequestSchema>;

// ---------------------------------------------------------------------------
// Activity events (audit trail, ADR 012)
// ---------------------------------------------------------------------------

export const ActivityEventSchema = z.object({
  id: UuidSchema,
  actorUserId: UserIdSchema.nullable(),
  source: ActivitySourceSchema,
  entityType: z.string(),
  entityId: UuidSchema,
  eventType: z.string(),
  payload: JsonObjectSchema,
  /** Raw device clock (offline replays); `occurredAt` is the skew-corrected instant. */
  clientOccurredAt: TimestampSchema.nullable(),
  occurredAt: TimestampSchema,
  recordedAt: TimestampSchema,
  requestId: z.string().nullable(),
  idempotencyKey: z.string().nullable(),
});
export type ActivityEvent = z.infer<typeof ActivityEventSchema>;

export const ActivityEventQuerySchema = PageQuerySchema.extend({
  entityType: requiredText(64).optional(),
  entityId: UuidSchema.optional(),
});
export type ActivityEventQuery = z.infer<typeof ActivityEventQuerySchema>;

// ---------------------------------------------------------------------------
// Ops flags (exception queue)
// ---------------------------------------------------------------------------

/** A situation that needs human judgement. At most one OPEN flag per (kind, situation). */
export const OpsFlagSchema = z.object({
  id: UuidSchema,
  kind: FlagKindSchema,
  severity: FlagSeveritySchema,
  status: FlagStatusSchema,
  /** The entity the situation is about, when it is about one (a module's row), or null. */
  entityType: z.string().nullable(),
  entityId: UuidSchema.nullable(),
  /** Context of the situation. */
  details: JsonObjectSchema,
  resolvedAt: TimestampSchema.nullable(),
  /** User who resolved or dismissed it. */
  resolvedBy: UserIdSchema.nullable(),
  ...timestamps,
});
export type OpsFlag = z.infer<typeof OpsFlagSchema>;

/** GET /flags query, newest first. Defaults to the open flags (the queue). */
export const ListFlagsQuerySchema = z.object({
  status: FlagStatusSchema.default('open'),
  kind: FlagKindSchema.optional(),
  entityType: requiredText(64).optional(),
  entityId: UuidSchema.optional(),
});
export type ListFlagsQuery = z.infer<typeof ListFlagsQuerySchema>;

/** POST /flags/:id/resolve: closes an open flag. `note` goes to the audit trail. */
export const ResolveFlagSchema = z.object({
  status: FlagStatusSchema.extract(['resolved', 'dismissed']),
  note: optionalText(2000).optional(),
});
export type ResolveFlag = z.infer<typeof ResolveFlagSchema>;

// ---------------------------------------------------------------------------
// CSV import
// ---------------------------------------------------------------------------

export const CsvImportErrorSchema = z.object({
  /** 1-based line number in the file, header included (the first data row is 2). */
  row: z.number().int().min(1),
  message: z.string(),
});
export type CsvImportError = z.infer<typeof CsvImportErrorSchema>;

export const CsvImportResultSchema = z.object({
  created: z.number().int().min(0),
  updated: z.number().int().min(0),
  errors: z.array(CsvImportErrorSchema),
});
export type CsvImportResult = z.infer<typeof CsvImportResultSchema>;
