import {
  FEATURES,
  SuspendOrganizationSchema,
  type PlatformEntitlement,
  type PlatformOrganization,
  type SuspendOrganization,
} from '@vime/contracts';
import type { Tx } from '@vime/db';
import { NotFoundError } from '@vime/kernel';
import { and, arrayContains, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { recordActivity } from './audit';
import type { ActorContext } from './context';
import { iso, isoOrNull, isSyntheticEmail } from './dto';
import { parseInput } from './errors';
import { memberships, organizationEntitlements, organizations, user } from './schema';

/*
 * Platform console (ADR 0015): organizations as a platform administrator sees them. Metadata only
 * (name, modules, owners, suspension), never operational data. Everything here
 * crosses organizations or writes what vime_app cannot (suspension), so it runs in withSystem, and
 * only behind the API's platform administrator guard.
 */

type OrganizationRow = typeof organizations.$inferSelect;

/** The organizations `ids` (all of them when omitted) as the console shows them, by name. */
async function loadPlatformOrganizations(
  systemTx: Tx,
  ids?: readonly string[],
): Promise<PlatformOrganization[]> {
  const rows: OrganizationRow[] = await systemTx
    .select()
    .from(organizations)
    .where(ids ? inArray(organizations.id, [...ids]) : undefined)
    .orderBy(asc(organizations.name), asc(organizations.id));
  if (rows.length === 0) {
    return [];
  }
  const orgIds = rows.map((row) => row.id);
  const [entitlements, owners] = await Promise.all([
    systemTx
      .select()
      .from(organizationEntitlements)
      .where(inArray(organizationEntitlements.organizationId, orgIds)),
    systemTx
      .select({ orgId: memberships.organizationId, name: user.name, email: user.email })
      .from(memberships)
      .innerJoin(user, eq(user.id, memberships.userId))
      .where(
        and(
          inArray(memberships.organizationId, orgIds),
          eq(memberships.status, 'active'),
          arrayContains(memberships.roleKeys, ['owner']),
        ),
      )
      .orderBy(asc(user.name)),
  ]);
  return rows.map((row) => {
    const own = new Map(
      entitlements
        .filter((e) => e.organizationId === row.id)
        .map((e) => [e.featureKey, e] as const),
    );
    const features: PlatformEntitlement[] = FEATURES.flatMap((featureKey) => {
      const entitlement = own.get(featureKey);
      return entitlement
        ? [
            {
              featureKey,
              enabled: entitlement.enabled,
              validUntil: isoOrNull(entitlement.validUntil),
            },
          ]
        : [];
    });
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      timezone: row.timezone,
      locale: row.locale,
      createdAt: iso(row.createdAt),
      suspendedAt: isoOrNull(row.suspendedAt),
      entitlements: features,
      owners: owners
        .filter((o) => o.orgId === row.id)
        .map((o) => ({ name: o.name, email: isSyntheticEmail(o.email) ? null : o.email })),
    };
  });
}

/**
 * Whether the platform suspended `orgId`. Works in withTenant of that organization (and in
 * withSystem); false when the organization is not visible.
 */
export async function isOrganizationSuspended(tx: Tx, orgId: string): Promise<boolean> {
  const [row] = await tx
    .select({ suspendedAt: organizations.suspendedAt })
    .from(organizations)
    .where(eq(organizations.id, orgId));
  return row?.suspendedAt != null;
}

/** Every organization, by name. Run in withSystem. */
export function listPlatformOrganizations(systemTx: Tx): Promise<PlatformOrganization[]> {
  return loadPlatformOrganizations(systemTx);
}

/** One organization. NotFoundError when it does not exist. Run in withSystem. */
export async function getPlatformOrganization(
  systemTx: Tx,
  orgId: string,
): Promise<PlatformOrganization> {
  const [organization] = await loadPlatformOrganizations(systemTx, [orgId]);
  if (!organization) {
    throw new NotFoundError('organization', orgId);
  }
  return organization;
}

/**
 * Suspends `actor.orgId`: from the next request (the API drops its membership cache) nobody can use
 * it, and its invitation codes cannot be redeemed. Nothing is deleted, so lifting it leaves
 * everything as it was. Already suspended: nothing changes (no event). Run in withSystem. Audited as
 * `organization.suspended` with the reason.
 */
export async function suspendOrganization(
  systemTx: Tx,
  actor: ActorContext,
  input: SuspendOrganization,
): Promise<void> {
  const { reason } = parseInput(SuspendOrganizationSchema, input);
  await assertOrganizationExists(systemTx, actor.orgId);
  const changed = await systemTx
    .update(organizations)
    .set({ suspendedAt: sql`now()` })
    .where(and(eq(organizations.id, actor.orgId), isNull(organizations.suspendedAt)))
    .returning({ id: organizations.id });
  if (changed.length > 0) {
    await recordActivity(systemTx, actor, {
      entityType: 'organization',
      entityId: actor.orgId,
      eventType: 'organization.suspended',
      payload: { reason },
    });
  }
}

/**
 * Lifts the suspension of `actor.orgId`. Not suspended: nothing changes (no event). Run in
 * withSystem. Audited as `organization.reactivated`.
 */
export async function reactivateOrganization(systemTx: Tx, actor: ActorContext): Promise<void> {
  const [row] = await systemTx
    .select({ suspendedAt: organizations.suspendedAt })
    .from(organizations)
    .where(eq(organizations.id, actor.orgId))
    .for('update');
  if (!row) {
    throw new NotFoundError('organization', actor.orgId);
  }
  if (!row.suspendedAt) {
    return;
  }
  await systemTx
    .update(organizations)
    .set({ suspendedAt: null })
    .where(eq(organizations.id, actor.orgId));
  await recordActivity(systemTx, actor, {
    entityType: 'organization',
    entityId: actor.orgId,
    eventType: 'organization.reactivated',
    payload: { suspendedAt: iso(row.suspendedAt) },
  });
}

async function assertOrganizationExists(systemTx: Tx, orgId: string): Promise<void> {
  const [row] = await systemTx
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.id, orgId));
  if (!row) {
    throw new NotFoundError('organization', orgId);
  }
}
