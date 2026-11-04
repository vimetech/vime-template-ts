import { closeDb, withSystem, withTenant, withUser, type Tx } from '@vime/db';
import { rlsCatalogAudit } from '@vime/db/testing';
import { newId } from '@vime/kernel';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recordActivity } from './audit';
import { pgError } from './errors';
import { upsertOpenFlag } from './flags';
import { createInvitation } from './invitations';
import { addMembership, listMyMemberships } from './memberships';
import { createNotification } from './notifications';
import {
  activityEvents,
  invitations,
  memberships,
  notifications,
  opsFlags,
  organizationEntitlements,
  organizations,
  user,
} from './schema';
import {
  ALL_PERMISSIONS,
  TEST_INVITATION_CODE_KEY,
  createTestOrg,
  createTestUser,
  webActor,
  type TestUser,
} from './testing/fixtures';

afterAll(async () => {
  await closeDb();
});

/** Runs `fn` and returns the SQLSTATE it fails with. */
async function sqlState(fn: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await fn();
  } catch (error) {
    return pgError(error)?.code ?? `non-db error: ${String(error)}`;
  }
  throw new Error('Expected the statement to fail');
}

interface Tenant {
  orgId: string;
  owner: TestUser;
  flagId: string;
  invitationId: string;
  notificationId: string;
}

async function seedTenant(): Promise<Tenant> {
  const owner = await createTestUser('Owner');
  const org = await createTestOrg({ ownerUserId: owner.id });
  const ctx = webActor(org.id, owner.id);
  return withTenant({ orgId: org.id, userId: owner.id }, async (tx) => {
    const { flag } = await upsertOpenFlag(tx, ctx, {
      kind: 'example_needs_review',
      dedupeKey: `seed:${newId()}`,
      severity: 'info',
    });
    const invitation = await createInvitation(
      tx,
      ctx,
      { roleKeys: ['member'] },
      ALL_PERMISSIONS,
      TEST_INVITATION_CODE_KEY,
    );
    const { notification } = await createNotification(tx, ctx, {
      recipientUserId: owner.id,
      channel: 'in_app',
      templateKey: 'seed',
    });
    return {
      orgId: org.id,
      owner,
      flagId: flag.id,
      invitationId: invitation.id,
      notificationId: notification.id,
    };
  });
}

let a: Tenant;
let b: Tenant;

beforeAll(async () => {
  [a, b] = await Promise.all([seedTenant(), seedTenant()]);
});

function inA<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withTenant({ orgId: a.orgId, userId: a.owner.id }, fn);
}

describe('RLS catalog audit', () => {
  it('reports no violations after the migrations', async () => {
    expect(await rlsCatalogAudit()).toEqual([]);
  });
});

describe('two-tenant isolation (org A acting on org B)', () => {
  it('does not show B rows, even when selected by id', async () => {
    await inA(async (tx) => {
      expect(await tx.select().from(opsFlags).where(eq(opsFlags.id, b.flagId))).toEqual([]);
      expect(await tx.select().from(invitations).where(eq(invitations.id, b.invitationId))).toEqual(
        [],
      );
      expect(
        await tx.select().from(notifications).where(eq(notifications.id, b.notificationId)),
      ).toEqual([]);
      const visibleOrgs = await tx.select({ id: opsFlags.organizationId }).from(opsFlags);
      expect(new Set(visibleOrgs.map((row) => row.id))).toEqual(new Set([a.orgId]));
    });
  });

  it('updates and deletes 0 rows of B', async () => {
    await inA(async (tx) => {
      const updated = await tx
        .update(opsFlags)
        .set({ severity: 'critical' })
        .where(eq(opsFlags.id, b.flagId))
        .returning();
      expect(updated).toEqual([]);
      const deleted = await tx
        .delete(invitations)
        .where(eq(invitations.id, b.invitationId))
        .returning();
      expect(deleted).toEqual([]);
    });
    const [untouched] = await withSystem((tx) =>
      tx.select().from(opsFlags).where(eq(opsFlags.id, b.flagId)),
    );
    expect(untouched?.severity).toBe('info');
  });

  it('rejects inserting a row with organization_id = B (WITH CHECK)', async () => {
    const state = await sqlState(() =>
      inA((tx) =>
        tx.insert(opsFlags).values({
          id: newId(),
          organizationId: b.orgId,
          kind: 'example_needs_review',
          dedupeKey: 'intruder',
          severity: 'info',
        }),
      ),
    );
    expect(state).toBe('42501'); // new row violates row-level security policy
  });

  it('rejects moving an A row to B (WITH CHECK on update)', async () => {
    const state = await sqlState(() =>
      inA((tx) =>
        tx.update(opsFlags).set({ organizationId: b.orgId }).where(eq(opsFlags.id, a.flagId)),
      ),
    );
    expect(state).toBe('42501');
  });

  it('memberships and organizations of B are not visible in A', async () => {
    await inA(async (tx) => {
      const orgs = await tx.select({ id: organizations.id }).from(organizations);
      expect(orgs.map((row) => row.id)).toEqual([a.orgId]);
      const rows = await tx
        .select()
        .from(memberships)
        .where(eq(memberships.organizationId, b.orgId));
      expect(rows).toEqual([]);
    });
  });
});

describe('fail closed without context', () => {
  it('withUser (no organization) sees no tenant rows', async () => {
    const stranger = await createTestUser('Stranger');
    await withUser(stranger.id, async (tx) => {
      expect(await tx.select().from(opsFlags)).toEqual([]);
      expect(await tx.select().from(invitations)).toEqual([]);
      expect(await tx.select().from(notifications)).toEqual([]);
      expect(await tx.select().from(activityEvents)).toEqual([]);
      expect(await tx.select().from(organizations)).toEqual([]);
      expect(await tx.select().from(memberships)).toEqual([]);
    });
  });

  it('withTenant of an unknown organization sees no rows', async () => {
    await withTenant({ orgId: newId() }, async (tx) => {
      expect(await tx.select().from(opsFlags)).toEqual([]);
      expect(await tx.select().from(organizations)).toEqual([]);
    });
  });

  it('an unset context (empty settings) matches zero rows', async () => {
    await withTenant({ orgId: a.orgId }, async (tx) => {
      await tx.execute(sql`select set_config('app.org_id', '', true)`);
      expect(await tx.select().from(opsFlags)).toEqual([]);
    });
  });
});

describe('vime_app privileges', () => {
  it('activity_events is append-only: UPDATE and DELETE are denied', async () => {
    const eventId = await inA((tx) =>
      recordActivity(tx, webActor(a.orgId, a.owner.id), {
        entityType: 'ops_flag',
        entityId: a.flagId,
        eventType: 'ops_flag.tested',
      }),
    );
    expect(
      await sqlState(() =>
        inA((tx) =>
          tx
            .update(activityEvents)
            .set({ eventType: 'tampered' })
            .where(eq(activityEvents.id, eventId)),
        ),
      ),
    ).toBe('42501');
    expect(
      await sqlState(() =>
        inA((tx) => tx.delete(activityEvents).where(eq(activityEvents.id, eventId))),
      ),
    ).toBe('42501');
    const [event] = await inA((tx) =>
      tx.select().from(activityEvents).where(eq(activityEvents.id, eventId)),
    );
    expect(event?.eventType).toBe('ops_flag.tested');
  });

  it('organization_entitlements is read-only', async () => {
    expect(
      await sqlState(() =>
        inA((tx) =>
          tx
            .insert(organizationEntitlements)
            .values({ organizationId: a.orgId, featureKey: 'example', enabled: true }),
        ),
      ),
    ).toBe('42501');
    expect(
      await sqlState(() => inA((tx) => tx.update(organizationEntitlements).set({ enabled: true }))),
    ).toBe('42501');
    expect(await sqlState(() => inA((tx) => tx.delete(organizationEntitlements)))).toBe('42501');
    await expect(inA((tx) => tx.select().from(organizationEntitlements))).resolves.toEqual([]);
  });

  it('has no access to the Better Auth tables', async () => {
    expect(await sqlState(() => inA((tx) => tx.select().from(user)))).toBe('42501');
    expect(await sqlState(() => inA((tx) => tx.execute(sql`select count(*) from "session"`)))).toBe(
      '42501',
    );
  });

  it('cannot delete organizations', async () => {
    expect(
      await sqlState(() =>
        inA((tx) => tx.delete(organizations).where(eq(organizations.id, a.orgId))),
      ),
    ).toBe('42501');
  });

  it('edits its organization but can neither suspend it nor lift a suspension', async () => {
    await expect(
      inA((tx) =>
        tx.update(organizations).set({ name: 'Renamed' }).where(eq(organizations.id, a.orgId)),
      ),
    ).resolves.toBeDefined();
    expect(
      await sqlState(() =>
        inA((tx) =>
          tx.update(organizations).set({ suspendedAt: null }).where(eq(organizations.id, a.orgId)),
        ),
      ),
    ).toBe('42501');
  });
});

describe('memberships across organizations (withUser)', () => {
  it("shows a user's own memberships in every organization, and nobody else's", async () => {
    const shared = await createTestUser('Shared');
    const other = await createTestUser('Other');
    await withTenant({ orgId: a.orgId }, (tx) =>
      addMembership(tx, webActor(a.orgId), { userId: shared.id, roleKeys: ['manager'] }),
    );
    await withTenant({ orgId: b.orgId }, (tx) =>
      addMembership(tx, webActor(b.orgId), { userId: shared.id, roleKeys: ['member'] }),
    );
    await withTenant({ orgId: a.orgId }, (tx) =>
      addMembership(tx, webActor(a.orgId), { userId: other.id, roleKeys: ['admin'] }),
    );

    await withUser(shared.id, async (tx) => {
      const mine = await listMyMemberships(tx, shared.id);
      expect(new Set(mine.map((m) => m.organization.id))).toEqual(new Set([a.orgId, b.orgId]));
      const all = await tx.select().from(memberships);
      expect(all.every((row) => row.userId === shared.id)).toBe(true);
      expect(all).toHaveLength(2);
      const orgs = await tx.select({ id: organizations.id }).from(organizations);
      expect(new Set(orgs.map((row) => row.id))).toEqual(new Set([a.orgId, b.orgId]));
    });

    await withUser(other.id, async (tx) => {
      const mine = await listMyMemberships(tx, other.id);
      expect(mine.map((m) => m.organization.id)).toEqual([a.orgId]);
      expect(await tx.select().from(memberships).where(eq(memberships.userId, shared.id))).toEqual(
        [],
      );
      // Writes need the organization context, even on the user's own membership.
      const state = await sqlState(() =>
        tx
          .update(memberships)
          .set({ roleKeys: ['owner'] })
          .where(eq(memberships.userId, other.id)),
      );
      expect(state).toBe('42501');
    });
  });

  it('hides organizations whose only membership is suspended', async () => {
    const suspended = await createTestUser('Suspended');
    await withTenant({ orgId: a.orgId }, async (tx) => {
      await addMembership(tx, webActor(a.orgId), { userId: suspended.id, roleKeys: ['member'] });
      await tx
        .update(memberships)
        .set({ status: 'suspended' })
        .where(eq(memberships.userId, suspended.id));
    });
    await withUser(suspended.id, async (tx) => {
      expect(await tx.select().from(organizations)).toEqual([]);
      expect(await listMyMemberships(tx, suspended.id)).toEqual([]);
    });
  });
});
