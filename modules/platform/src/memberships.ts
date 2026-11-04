import {
  MembershipStatusSchema,
  OrganizationSettingsSchema,
  PERMISSIONS,
  ROLE_KEYS,
  RoleKeySchema,
  UpdateMemberRolesSchema,
  permissionsForRoles,
  type MeMembership,
  type Member,
  type MembershipStatus,
  type Permission,
  type RoleKey,
} from '@vime/contracts';
import type { Tx } from '@vime/db';
import { ConflictError, ForbiddenError, NotFoundError, newId } from '@vime/kernel';
import { and, arrayContains, asc, eq, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { recordActivity } from './audit';
import type { ActorContext } from './context';
import { iso, isoOrNull, isSyntheticEmail, knownRoleKeys } from './dto';
import { isUniqueViolation, parseInput } from './errors';
import { isOrganizationSuspended } from './platform-admin';
import { memberships, organizations } from './schema';

/** A user's active membership in one organization, with its effective permissions. */
export interface ResolvedMembership {
  membershipId: string;
  organizationId: string;
  userId: string;
  roleKeys: RoleKey[];
  /** Union of the permissions of `roleKeys` (unknown stored role keys grant nothing). */
  permissions: ReadonlySet<Permission>;
  /**
   * The platform suspended the organization (ADR 0015): the membership exists but grants nothing
   * until the suspension is lifted. The API answers 403 `organization_suspended`.
   */
  organizationSuspended: boolean;
}

/**
 * The ACTIVE membership of `userId` in `orgId`, or null (no membership, or a suspended
 * membership). Works in withTenant of that organization and in withUser of that user.
 * Authorization is resolved per request from this (never stored in the session).
 */
export async function resolveMembershipForUser(
  tx: Tx,
  userId: string,
  orgId: string,
): Promise<ResolvedMembership | null> {
  const [found] = await tx
    .select({ row: memberships, suspendedAt: organizations.suspendedAt })
    .from(memberships)
    .innerJoin(organizations, eq(organizations.id, memberships.organizationId))
    .where(
      and(
        eq(memberships.organizationId, orgId),
        eq(memberships.userId, userId),
        eq(memberships.status, 'active'),
      ),
    );
  if (!found) {
    return null;
  }
  const { row } = found;
  const roleKeys = knownRoleKeys(row.roleKeys);
  return {
    membershipId: row.id,
    organizationId: row.organizationId,
    userId: row.userId,
    roleKeys,
    permissions: permissionsForRoles(roleKeys),
    organizationSuspended: found.suspendedAt !== null,
  };
}

/** Permissions in the canonical PERMISSIONS order (stable responses). */
function sortedPermissions(permissions: ReadonlySet<Permission>): Permission[] {
  return PERMISSIONS.filter((permission) => permissions.has(permission));
}

/**
 * The user's active memberships in every organization, for "me" and the organization switcher.
 * Run in withUser(userId): RLS shows the user's own memberships and the organizations they belong
 * to (inside withTenant only the current organization would be visible).
 */
export async function listMyMemberships(tx: Tx, userId: string): Promise<MeMembership[]> {
  const rows = await tx
    .select({ membership: memberships, organization: organizations })
    .from(memberships)
    .innerJoin(organizations, eq(organizations.id, memberships.organizationId))
    .where(and(eq(memberships.userId, userId), eq(memberships.status, 'active')))
    .orderBy(asc(organizations.name), asc(organizations.id));
  return rows.map(({ membership, organization }) => {
    const roleKeys = knownRoleKeys(membership.roleKeys);
    const settings = OrganizationSettingsSchema.safeParse(organization.settings).data;
    return {
      organization: {
        id: organization.id,
        name: organization.name,
        slug: organization.slug,
        timezone: organization.timezone,
        locale: organization.locale,
        coordinationPhoneE164: settings?.coordinationPhoneE164 ?? null,
        disabledFunctions: settings?.disabledFunctions ?? [],
        suspended: organization.suspendedAt !== null,
      },
      roleKeys,
      permissions: sortedPermissions(permissionsForRoles(roleKeys)),
    };
  });
}

export interface MemberProfile extends Record<string, unknown> {
  user_id: string;
  name: string;
  email: string;
}

/**
 * Name and email of the current organization's members. vime_app has no access to the Better Auth
 * `user` table; `app.organization_member_profiles()` (SECURITY DEFINER) returns just these columns,
 * just for members of app.current_org_id().
 */
export async function memberProfiles(tx: Tx): Promise<Map<string, MemberProfile>> {
  const result = await tx.execute<MemberProfile>(
    sql`select user_id, name, email from app.organization_member_profiles()`,
  );
  return new Map(result.rows.map((row) => [row.user_id, row]));
}

type MembershipRow = typeof memberships.$inferSelect;

function toMember(row: MembershipRow, profile: MemberProfile | undefined): Member {
  const email = profile?.email ?? null;
  return {
    id: row.id,
    userId: row.userId,
    name: profile?.name ?? '',
    // Users that sign in with an invitation code only have a synthetic email: not a real address.
    email: email === null || isSyntheticEmail(email) ? null : email,
    roleKeys: knownRoleKeys(row.roleKeys),
    status: row.status,
    createdAt: iso(row.createdAt),
    updatedAt: isoOrNull(row.updatedAt),
  };
}

/** Members (active and suspended) of `orgId`, oldest first. Run in withTenant of `orgId`. */
export async function listMembers(tx: Tx, orgId: string): Promise<Member[]> {
  // The memberships policy also shows the acting user's memberships in other organizations:
  // filter by organization explicitly.
  const rows = await tx
    .select()
    .from(memberships)
    .where(eq(memberships.organizationId, orgId))
    .orderBy(asc(memberships.id));
  const profiles = await memberProfiles(tx);
  return rows.map((row) => toMember(row, profiles.get(row.userId)));
}

/** One member of `orgId`; NotFoundError if absent. Run in withTenant of `orgId`. */
export async function getMember(tx: Tx, orgId: string, membershipId: string): Promise<Member> {
  const row = await findMembership(tx, orgId, membershipId);
  const profiles = await memberProfiles(tx);
  return toMember(row, profiles.get(row.userId));
}

async function findMembership(
  tx: Tx,
  orgId: string,
  membershipId: string,
  forUpdate = false,
): Promise<MembershipRow> {
  const query = tx
    .select()
    .from(memberships)
    .where(and(eq(memberships.organizationId, orgId), eq(memberships.id, membershipId)));
  const [row] = forUpdate ? await query.for('update') : await query;
  if (!row) {
    throw new NotFoundError('membership', membershipId);
  }
  return row;
}

/**
 * Throws ForbiddenError unless every permission of `roleKeys` is held by the grantor. Prevents
 * privilege escalation: whoever manages members can only grant (or take away) roles that are within
 * their own permissions; e.g. an ops_manager cannot make anyone an owner.
 */
export function assertCanGrantRoles(
  grantorPermissions: ReadonlySet<Permission>,
  roleKeys: readonly string[],
): void {
  for (const permission of permissionsForRoles(roleKeys)) {
    if (!grantorPermissions.has(permission)) {
      throw new ForbiddenError(`Granting these roles requires the ${permission} permission`, {
        details: { missingPermission: permission },
      });
    }
  }
}

/**
 * Locks the organization's active owner rows in id order. Every change that can remove an owner
 * (demotion, suspension) takes these locks first, before locking its target row, so concurrent
 * changes run one after the other instead of deadlocking (two demotions that each locked their own
 * target and then waited for the other's would abort with SQLSTATE 40P01). The second one then sees
 * the first one's result and gets the "last owner" ConflictError.
 */
async function lockActiveOwners(tx: Tx, orgId: string): Promise<void> {
  await tx
    .select({ id: memberships.id })
    .from(memberships)
    .where(
      and(
        eq(memberships.organizationId, orgId),
        eq(memberships.status, 'active'),
        arrayContains(memberships.roleKeys, ['owner']),
      ),
    )
    .orderBy(asc(memberships.id))
    .for('update');
}

/**
 * Throws ConflictError if `membershipId` is the organization's last active owner. Call it only
 * after `lockActiveOwners`.
 */
async function assertAnotherActiveOwner(tx: Tx, orgId: string, membershipId: string) {
  const others = await tx
    .select({ id: memberships.id })
    .from(memberships)
    .where(
      and(
        eq(memberships.organizationId, orgId),
        ne(memberships.id, membershipId),
        eq(memberships.status, 'active'),
        arrayContains(memberships.roleKeys, ['owner']),
      ),
    );
  if (others.length === 0) {
    throw new ConflictError('The organization must keep at least one active owner');
  }
}

const AddMembershipSchema = z.object({
  userId: z.uuid(),
  roleKeys: z.array(RoleKeySchema).min(1).max(ROLE_KEYS.length),
});
export type AddMembershipInput = z.input<typeof AddMembershipSchema>;

/**
 * Adds a user to the organization (seeds, platform administration). Members normally join by
 * redeeming an invitation (`consumeInvitation`). Throws ConflictError if the user is already a
 * member.
 */
export async function addMembership(
  tx: Tx,
  ctx: ActorContext,
  input: AddMembershipInput,
): Promise<ResolvedMembership> {
  const data = parseInput(AddMembershipSchema, input);
  const id = newId();
  const roleKeys = [...new Set(data.roleKeys)];
  try {
    await tx.insert(memberships).values({
      id,
      organizationId: ctx.orgId,
      userId: data.userId,
      roleKeys,
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictError('The user is already a member', { cause: error });
    }
    throw error;
  }
  await recordActivity(tx, ctx, {
    entityType: 'membership',
    entityId: id,
    eventType: 'membership.created',
    payload: { userId: data.userId, roleKeys },
  });
  return {
    membershipId: id,
    organizationId: ctx.orgId,
    userId: data.userId,
    roleKeys,
    permissions: permissionsForRoles(roleKeys),
    organizationSuspended: await isOrganizationSuspended(tx, ctx.orgId),
  };
}

/**
 * Replaces a member's roles (`UpdateMemberRolesSchema`). The grantor must hold every permission of
 * both the current and the new roles, and the organization keeps at least one active owner.
 */
export async function updateMemberRoles(
  tx: Tx,
  ctx: ActorContext,
  membershipId: string,
  input: z.input<typeof UpdateMemberRolesSchema>,
  grantorPermissions: ReadonlySet<Permission>,
): Promise<Member> {
  const { roleKeys } = parseInput(UpdateMemberRolesSchema, input);
  await lockActiveOwners(tx, ctx.orgId);
  const current = await findMembership(tx, ctx.orgId, membershipId, true);
  assertCanGrantRoles(grantorPermissions, current.roleKeys);
  assertCanGrantRoles(grantorPermissions, roleKeys);
  const sameRoles =
    current.roleKeys.length === roleKeys.length &&
    roleKeys.every((key) => current.roleKeys.includes(key));
  if (sameRoles) {
    return getMember(tx, ctx.orgId, membershipId);
  }
  if (
    current.status === 'active' &&
    current.roleKeys.includes('owner') &&
    !roleKeys.includes('owner')
  ) {
    await assertAnotherActiveOwner(tx, ctx.orgId, membershipId);
  }
  await tx
    .update(memberships)
    .set({ roleKeys })
    .where(and(eq(memberships.organizationId, ctx.orgId), eq(memberships.id, membershipId)));
  await recordActivity(tx, ctx, {
    entityType: 'membership',
    entityId: membershipId,
    eventType: 'membership.roles_changed',
    payload: { from: current.roleKeys, to: roleKeys },
  });
  return getMember(tx, ctx.orgId, membershipId);
}

/**
 * Suspends or reactivates a membership. A suspended membership resolves to null, so access ends on
 * the next request. Same grantor rule as `updateMemberRoles`; the last active owner cannot be
 * suspended.
 */
export async function setMembershipStatus(
  tx: Tx,
  ctx: ActorContext,
  membershipId: string,
  status: MembershipStatus,
  grantorPermissions: ReadonlySet<Permission>,
): Promise<Member> {
  const nextStatus = parseInput(MembershipStatusSchema, status);
  await lockActiveOwners(tx, ctx.orgId);
  const current = await findMembership(tx, ctx.orgId, membershipId, true);
  assertCanGrantRoles(grantorPermissions, current.roleKeys);
  if (current.status === nextStatus) {
    return getMember(tx, ctx.orgId, membershipId);
  }
  if (nextStatus === 'suspended' && current.roleKeys.includes('owner')) {
    await assertAnotherActiveOwner(tx, ctx.orgId, membershipId);
  }
  await tx
    .update(memberships)
    .set({ status: nextStatus })
    .where(and(eq(memberships.organizationId, ctx.orgId), eq(memberships.id, membershipId)));
  await recordActivity(tx, ctx, {
    entityType: 'membership',
    entityId: membershipId,
    eventType: nextStatus === 'suspended' ? 'membership.suspended' : 'membership.reactivated',
    payload: {},
  });
  return getMember(tx, ctx.orgId, membershipId);
}
