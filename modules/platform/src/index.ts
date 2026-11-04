/**
 * @vime/platform: organizations, memberships and authorization data, invitations, entitlements,
 * audit trail, idempotency, exception flags, notifications and the job dispatcher port.
 *
 * Every service takes the `Tx` of a withTenant / withUser / withSystem transaction (it never opens
 * one itself), validates its input with @vime/contracts, writes an activity event in the same
 * transaction for each state change, and throws @vime/kernel DomainErrors. Tables live in
 * `@vime/platform/schema`.
 */
export type { ActorContext } from './context';
export { systemActor } from './context';
export {
  IdempotencyConflictError,
  IdempotencyInProgressError,
  isUniqueViolation,
  isForeignKeyViolation,
  isIntegrityViolation,
  rethrowReferenced,
  parseInput,
  pgError,
} from './errors';
export {
  SYNTHETIC_EMAIL_DOMAIN,
  syntheticStaffEmail,
  isSyntheticEmail,
  iso,
  isoOrNull,
} from './dto';
export { normalizeCsvHeader, csvRowErrorMessage, CsvCells, CsvRowError } from './csv';
export type { CsvRow } from './csv';

export { recordActivity, listActivity, skewCorrectedOccurredAt } from './audit';
export {
  listPlatformOrganizations,
  getPlatformOrganization,
  suspendOrganization,
  reactivateOrganization,
  isOrganizationSuspended,
} from './platform-admin';
export type { ActivityInput, ClientTimeInput } from './audit';

export {
  CreateOrganizationSchema,
  createOrganization,
  getOrganization,
  updateOrganization,
  listOrganizationIds,
} from './organizations';
export type { CreateOrganizationInput, CreateOrganizationOptions } from './organizations';

export {
  resolveMembershipForUser,
  listMyMemberships,
  listMembers,
  getMember,
  addMembership,
  updateMemberRoles,
  setMembershipStatus,
  assertCanGrantRoles,
} from './memberships';
export type { ResolvedMembership, AddMembershipInput } from './memberships';

export {
  organizationCanUseFeature,
  listEnabledFeatures,
  SetEntitlementSchema,
  setEntitlement,
} from './entitlements';
export type { Entitlement, SetEntitlementInput } from './entitlements';

export {
  generateInvitationCode,
  normalizeInvitationCode,
  hashInvitationCode,
  createInvitation,
  listInvitations,
  revokeInvitation,
  normalizeInvitationEmail,
  findRedeemableInvitationByCode,
  invitationRedeemActorKey,
  findCompletedRedemption,
  consumeInvitation,
} from './invitations';
export type {
  InvitationCodeKey,
  RedeemableInvitation,
  CompletedRedemption,
  ConsumeInvitationInput,
  ConsumedInvitation,
} from './invitations';

export {
  idempotencyActorKey,
  computeRequestHash,
  lookupIdempotentRequest,
  beginIdempotentRequest,
  completeIdempotentRequest,
  purgeIdempotencyKeys,
} from './idempotency';
export type {
  IdempotencyKeyRef,
  IdempotencyBegin,
  IdempotencyRecord,
  RequestHashKey,
} from './idempotency';

export {
  UpsertFlagSchema,
  upsertOpenFlag,
  ResolveFlagSchema,
  resolveFlag,
  listFlags,
} from './flags';
export type {
  OpsFlag,
  UpsertFlagInput,
  UpsertFlagResult,
  ResolveFlagInput,
  FlagFilter,
} from './flags';

export { JOB_NAMES, noteCreatedJob, RecordingJobDispatcher } from './jobs';
export type { JobName, JobData, JobRequest, JobDispatcher } from './jobs';

export {
  CreateNotificationSchema,
  NOTICE_DAYS,
  createNotification,
  listUnreadNotices,
  markNoticesRead,
} from './notifications';
export type {
  Notification,
  CreateNotificationInput,
  CreateNotificationResult,
} from './notifications';

export {
  CredentialCipher,
  CredentialDecryptionError,
  credentialKeyId,
  isWeakCredentialKey,
} from './credentials';
export type { EncryptedValue } from './credentials';
