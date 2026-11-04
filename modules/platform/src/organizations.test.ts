import {
  PERMISSIONS,
  MeMembershipSchema,
  MemberSchema,
  OrganizationSchema,
  SYSTEM_ROLES,
  ActivityEventSchema,
  type Permission,
} from '@vime/contracts';
import { closeDb, withSystem, withTenant, withUser, type Tx } from '@vime/db';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError, newId } from '@vime/kernel';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listActivity, recordActivity, skewCorrectedOccurredAt } from './audit';
import { syntheticStaffEmail } from './dto';
import { listEnabledFeatures, organizationCanUseFeature, setEntitlement } from './entitlements';
import {
  addMembership,
  getMember,
  listMembers,
  listMyMemberships,
  resolveMembershipForUser,
  setMembershipStatus,
  updateMemberRoles,
} from './memberships';
import { createOrganization, getOrganization, updateOrganization } from './organizations';
import { activityEvents, memberships } from './schema';
import {
  ALL_PERMISSIONS,
  createTestOrg,
  createTestUser,
  uniqueSuffix,
  webActor,
  type TestUser,
} from './testing/fixtures';

afterAll(async () => {
  await closeDb();
});

function sqlInsertUser(id: string, name: string, email: string) {
  return sql`insert into "user" (id, name, email) values (${id}, ${name}, ${email})`;
}

const managerPermissions: ReadonlySet<Permission> = new Set(SYSTEM_ROLES.manager.permissions);

describe('organizations', () => {
  it('creates an organization with defaults, an owner and audit events', async () => {
    const owner = await createTestUser('Owner');
    const slug = `org-${uniqueSuffix()}`;
    const org = await withSystem((tx) =>
      createOrganization(tx, { name: 'Example Org', slug }, { ownerUserId: owner.id }),
    );
    expect(OrganizationSchema.parse(org)).toEqual(org);
    expect(org).toMatchObject({
      name: 'Example Org',
      slug,
      timezone: 'America/Lima',
      locale: 'es-PE',
      settings: { coordinationPhoneE164: null, disabledFunctions: [] },
      updatedAt: null,
    });
    const membership = await withUser(owner.id, (tx) =>
      resolveMembershipForUser(tx, owner.id, org.id),
    );
    expect(membership?.roleKeys).toEqual(['owner']);
    expect(membership?.permissions).toEqual(new Set(SYSTEM_ROLES.owner.permissions));

    const events = await withTenant({ orgId: org.id }, (tx) =>
      tx.select({ eventType: activityEvents.eventType }).from(activityEvents),
    );
    expect(events.map((e) => e.eventType).sort()).toEqual([
      'membership.created',
      'organization.created',
    ]);

    await expect(
      withSystem((tx) => createOrganization(tx, { name: 'Copy', slug })),
    ).rejects.toBeInstanceOf(ConflictError);
    await expect(
      withSystem((tx) => createOrganization(tx, { name: 'Bad', slug: 'Not A Slug' })),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('updates name and merges settings key by key, validated with contracts', async () => {
    const owner = await createTestUser('Owner');
    const org = await createTestOrg({ ownerUserId: owner.id });
    const ctx = webActor(org.id, owner.id);
    const updated = await withTenant({ orgId: org.id, userId: owner.id }, (tx) =>
      updateOrganization(tx, ctx, {
        name: 'Renamed',
        settings: { coordinationPhoneE164: '+51987654321' },
      }),
    );
    expect(updated.name).toBe('Renamed');
    expect(updated.settings).toEqual({
      coordinationPhoneE164: '+51987654321',
      disabledFunctions: [],
    });
    expect(updated.updatedAt).not.toBeNull();

    const again = await withTenant({ orgId: org.id, userId: owner.id }, (tx) =>
      updateOrganization(tx, ctx, { settings: { disabledFunctions: ['example_notes'] } }),
    );
    expect(again.settings).toMatchObject({
      coordinationPhoneE164: '+51987654321',
      disabledFunctions: ['example_notes'],
    });

    await expect(
      withTenant({ orgId: org.id }, (tx) =>
        updateOrganization(tx, ctx, { settings: { coordinationPhoneE164: '987654321' } }),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      withTenant({ orgId: org.id }, (tx) => updateOrganization(tx, ctx, { timezone: '+05:00' })),
    ).rejects.toBeInstanceOf(ValidationError);

    const other = await createTestOrg();
    await expect(
      withTenant({ orgId: org.id }, (tx) => getOrganization(tx, other.id)),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('never breaks on a stored function it does not know, and a change keeps only known ones', async () => {
    const owner = await createTestUser('Owner');
    const org = await createTestOrg({ ownerUserId: owner.id });
    const ctx = webActor(org.id, owner.id);
    const update = (settings: {
      disabledFunctions?: string[];
      coordinationPhoneE164?: string | null;
    }) =>
      withTenant({ orgId: org.id, userId: owner.id }, (tx) =>
        updateOrganization(tx, ctx, { settings }),
      );
    // A function removed from OPTIONAL_FUNCTIONS since it was turned off (or written by hand).
    await withSystem((tx) =>
      tx.execute(
        sql`UPDATE organizations SET settings = '{"disabledFunctions":["example_notes","gone"]}'::jsonb WHERE id = ${org.id}`,
      ),
    );
    const read = await withTenant({ orgId: org.id }, (tx) => getOrganization(tx, org.id));
    expect(read.settings.disabledFunctions).toEqual(['example_notes', 'gone']);
    const [mine] = await withUser(owner.id, (tx) => listMyMemberships(tx, owner.id));
    expect(mine?.organization.disabledFunctions).toEqual(['example_notes', 'gone']);
    // Another setting keeps the list as it is.
    expect((await update({ coordinationPhoneE164: null })).settings.disabledFunctions).toEqual([
      'example_notes',
      'gone',
    ]);
    // A client turning example_notes on sends 'gone' back as it found it: accepted, not kept.
    expect((await update({ disabledFunctions: ['gone'] })).settings.disabledFunctions).toEqual([]);
    // A value that is neither known nor stored is refused.
    for (const bad of [['gone'], ['example'], ['example_notes', 'typo']]) {
      await expect(update({ disabledFunctions: bad })).rejects.toBeInstanceOf(ValidationError);
    }
    expect(
      (await update({ disabledFunctions: ['example_notes'] })).settings.disabledFunctions,
    ).toEqual(['example_notes']);
  });
});

describe('memberships', () => {
  let owner: TestUser;
  let orgId: string;

  beforeAll(async () => {
    owner = await createTestUser('Owner Name', `owner-${uniqueSuffix()}@test.vime.invalid`);
    orgId = (await createTestOrg({ ownerUserId: owner.id })).id;
  });

  function asOwner<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return withTenant({ orgId, userId: owner.id }, fn);
  }

  it('lists members with name and email, hiding synthetic emails', async () => {
    const memberId = newId();
    await withSystem((tx) =>
      tx.execute(
        // Same shape as the inviteCode flow: synthetic email for a code-only user.
        sqlInsertUser(memberId, 'Rosa', syntheticStaffEmail(memberId)),
      ),
    );
    await asOwner((tx) =>
      addMembership(tx, webActor(orgId, owner.id), { userId: memberId, roleKeys: ['member'] }),
    );
    const members = await asOwner((tx) => listMembers(tx, orgId));
    for (const member of members) {
      expect(MemberSchema.parse(member)).toEqual(member);
    }
    expect(members.find((m) => m.userId === owner.id)).toMatchObject({
      name: 'Owner Name',
      email: owner.email,
      roleKeys: ['owner'],
      status: 'active',
    });
    expect(members.find((m) => m.userId === memberId)).toMatchObject({
      name: 'Rosa',
      email: null,
      roleKeys: ['member'],
    });
  });

  it('listMyMemberships returns contract-shaped entries with permissions', async () => {
    const mine = await withUser(owner.id, (tx) => listMyMemberships(tx, owner.id));
    expect(mine).toHaveLength(1);
    expect(MeMembershipSchema.parse(mine[0])).toEqual(mine[0]);
    // Every permission, in the canonical PERMISSIONS order.
    expect(mine[0]?.permissions).toEqual([...PERMISSIONS]);
  });

  it('updates roles within the grantor permissions only', async () => {
    const user = await createTestUser('Member');
    const added = await asOwner((tx) =>
      addMembership(tx, webActor(orgId, owner.id), { userId: user.id, roleKeys: ['member'] }),
    );
    const updated = await asOwner((tx) =>
      updateMemberRoles(
        tx,
        webActor(orgId, owner.id),
        added.membershipId,
        { roleKeys: ['manager'] },
        managerPermissions,
      ),
    );
    expect(updated.roleKeys).toEqual(['manager']);

    // A manager cannot grant owner (privilege escalation).
    await expect(
      asOwner((tx) =>
        updateMemberRoles(
          tx,
          webActor(orgId, owner.id),
          added.membershipId,
          { roleKeys: ['owner'] },
          managerPermissions,
        ),
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);

    const events = await asOwner((tx) =>
      tx.select().from(activityEvents).where(eq(activityEvents.entityId, added.membershipId)),
    );
    expect(events.map((e) => e.eventType).sort()).toEqual([
      'membership.created',
      'membership.roles_changed',
    ]);
    expect(events.find((e) => e.eventType === 'membership.roles_changed')?.payload).toEqual({
      from: ['member'],
      to: ['manager'],
    });
  });

  it('keeps at least one active owner', async () => {
    const soleOwner = await createTestUser('Sole');
    const org = await createTestOrg({ ownerUserId: soleOwner.id });
    const ctx = webActor(org.id, soleOwner.id);
    const membership = await withUser(soleOwner.id, (tx) =>
      resolveMembershipForUser(tx, soleOwner.id, org.id),
    );
    const membershipId = membership?.membershipId ?? '';
    await expect(
      withTenant({ orgId: org.id }, (tx) =>
        updateMemberRoles(tx, ctx, membershipId, { roleKeys: ['admin'] }, ALL_PERMISSIONS),
      ),
    ).rejects.toBeInstanceOf(ConflictError);
    await expect(
      withTenant({ orgId: org.id }, (tx) =>
        setMembershipStatus(tx, ctx, membershipId, 'suspended', ALL_PERMISSIONS),
      ),
    ).rejects.toBeInstanceOf(ConflictError);

    const second = await createTestUser('Second');
    await withTenant({ orgId: org.id }, (tx) =>
      addMembership(tx, ctx, { userId: second.id, roleKeys: ['owner'] }),
    );
    const demoted = await withTenant({ orgId: org.id }, (tx) =>
      updateMemberRoles(tx, ctx, membershipId, { roleKeys: ['admin'] }, ALL_PERMISSIONS),
    );
    expect(demoted.roleKeys).toEqual(['admin']);
  });

  it('serializes concurrent owner removals: one wins, the other is a conflict (no deadlock)', async () => {
    for (let round = 0; round < 8; round += 1) {
      const a = await createTestUser('Owner A');
      const b = await createTestUser('Owner B');
      const org = await createTestOrg({ ownerUserId: a.id });
      const ctx = webActor(org.id, a.id);
      const memberB = await withTenant({ orgId: org.id }, (tx) =>
        addMembership(tx, ctx, { userId: b.id, roleKeys: ['owner'] }),
      );
      const memberA = await withUser(a.id, (tx) => resolveMembershipForUser(tx, a.id, org.id));
      // A demotes B while B suspends A (both would leave the organization without an owner).
      const results = await Promise.allSettled([
        withTenant({ orgId: org.id, userId: a.id }, (tx) =>
          updateMemberRoles(
            tx,
            ctx,
            memberB.membershipId,
            { roleKeys: ['admin'] },
            ALL_PERMISSIONS,
          ),
        ),
        withTenant({ orgId: org.id, userId: b.id }, (tx) =>
          setMembershipStatus(
            tx,
            webActor(org.id, b.id),
            memberA?.membershipId ?? '',
            'suspended',
            ALL_PERMISSIONS,
          ),
        ),
      ]);
      const rejected = results.filter((result) => result.status === 'rejected');
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(ConflictError);
    }
  });

  it('a suspended membership no longer resolves', async () => {
    const user = await createTestUser('Member');
    const added = await asOwner((tx) =>
      addMembership(tx, webActor(orgId, owner.id), { userId: user.id, roleKeys: ['member'] }),
    );
    const suspended = await asOwner((tx) =>
      setMembershipStatus(
        tx,
        webActor(orgId, owner.id),
        added.membershipId,
        'suspended',
        ALL_PERMISSIONS,
      ),
    );
    expect(suspended.status).toBe('suspended');
    expect(
      await withUser(user.id, (tx) => resolveMembershipForUser(tx, user.id, orgId)),
    ).toBeNull();
    await asOwner((tx) =>
      setMembershipStatus(
        tx,
        webActor(orgId, owner.id),
        added.membershipId,
        'active',
        ALL_PERMISSIONS,
      ),
    );
    expect(
      await withUser(user.id, (tx) => resolveMembershipForUser(tx, user.id, orgId)),
    ).not.toBeNull();
    await expect(asOwner((tx) => getMember(tx, orgId, newId()))).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('unknown stored role keys grant nothing', async () => {
    const user = await createTestUser('Legacy');
    const added = await asOwner((tx) =>
      addMembership(tx, webActor(orgId, owner.id), { userId: user.id, roleKeys: ['member'] }),
    );
    await withSystem((tx) =>
      tx
        .update(memberships)
        .set({ roleKeys: ['member', 'retired_role'] })
        .where(eq(memberships.id, added.membershipId)),
    );
    const resolved = await withUser(user.id, (tx) => resolveMembershipForUser(tx, user.id, orgId));
    expect(resolved?.roleKeys).toEqual(['member']);
    expect(resolved?.permissions).toEqual(new Set(SYSTEM_ROLES.member.permissions));
  });
});

describe('entitlements', () => {
  it('is off by default; on when enabled and not expired', async () => {
    const org = await createTestOrg();
    const inOrg = <T>(fn: (tx: Tx) => Promise<T>) => withTenant({ orgId: org.id }, fn);
    expect(await inOrg((tx) => organizationCanUseFeature(tx, org.id, 'example'))).toBe(false);

    await withSystem((tx) =>
      setEntitlement(
        tx,
        { orgId: org.id, source: 'system' },
        { featureKey: 'example', enabled: true },
      ),
    );
    expect(await inOrg((tx) => organizationCanUseFeature(tx, org.id, 'example'))).toBe(true);
    expect(await inOrg((tx) => organizationCanUseFeature(tx, org.id, 'advanced_insights'))).toBe(
      false,
    );

    const until = new Date('2030-01-01T00:00:00Z');
    await withSystem((tx) =>
      setEntitlement(
        tx,
        { orgId: org.id, source: 'system' },
        {
          featureKey: 'advanced_insights',
          enabled: true,
          validUntil: until,
          limits: { maxProperties: 150 },
        },
      ),
    );
    expect(
      await inOrg((tx) => listEnabledFeatures(tx, org.id, new Date('2029-12-31T23:59:59Z'))),
    ).toEqual(['example', 'advanced_insights']);
    expect(
      await inOrg((tx) => organizationCanUseFeature(tx, org.id, 'advanced_insights', until)),
    ).toBe(false);

    await withSystem((tx) =>
      setEntitlement(
        tx,
        { orgId: org.id, source: 'system' },
        { featureKey: 'example', enabled: false },
      ),
    );
    expect(await inOrg((tx) => organizationCanUseFeature(tx, org.id, 'example'))).toBe(false);

    // Another organization's entitlement does not leak.
    const other = await createTestOrg();
    expect(
      await withTenant({ orgId: other.id }, (tx) =>
        organizationCanUseFeature(tx, org.id, 'advanced_insights'),
      ),
    ).toBe(false);
  });
});

describe('audit', () => {
  it('records every ADR 012 field and lists newest first with a cursor', async () => {
    const owner = await createTestUser('Auditor');
    const org = await createTestOrg({ ownerUserId: owner.id });
    const entityId = newId();
    const clientOccurredAt = new Date('2026-10-04T10:00:00Z');
    const occurredAt = new Date('2026-10-04T10:02:00Z');
    await withTenant({ orgId: org.id, userId: owner.id }, async (tx) => {
      for (let index = 0; index < 3; index += 1) {
        await recordActivity(
          tx,
          {
            orgId: org.id,
            source: 'mobile',
            userId: owner.id,
            requestId: `req-${index}`,
            idempotencyKey: `key-${index}`,
            clientOccurredAt,
            occurredAt,
          },
          { entityType: 'task', entityId, eventType: `task.step_${index}`, payload: { index } },
        );
      }
    });
    const firstPage = await withTenant({ orgId: org.id }, (tx) =>
      listActivity(tx, { entityType: 'task', entityId, limit: 2 }),
    );
    expect(firstPage.items.map((e) => e.eventType)).toEqual(['task.step_2', 'task.step_1']);
    expect(firstPage.nextCursor).not.toBeNull();
    const event = firstPage.items[0];
    expect(ActivityEventSchema.parse(event)).toEqual(event);
    expect(event).toMatchObject({
      actorUserId: owner.id,
      source: 'mobile',
      entityType: 'task',
      entityId,
      payload: { index: 2 },
      clientOccurredAt: clientOccurredAt.toISOString(),
      occurredAt: occurredAt.toISOString(),
      requestId: 'req-2',
      idempotencyKey: 'key-2',
    });
    const secondPage = await withTenant({ orgId: org.id }, (tx) =>
      listActivity(tx, {
        entityType: 'task',
        entityId,
        limit: 2,
        cursor: firstPage.nextCursor ?? '',
      }),
    );
    expect(secondPage.items.map((e) => e.eventType)).toEqual(['task.step_0']);
    expect(secondPage.nextCursor).toBeNull();
    await expect(
      withTenant({ orgId: org.id }, (tx) => listActivity(tx, { cursor: 'nope' })),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('corrects device clock skew and clamps to [notBefore, receivedAt]', () => {
    const receivedAt = new Date('2026-10-04T15:00:00Z');
    // The phone is 10 minutes behind.
    const corrected = skewCorrectedOccurredAt({
      clientOccurredAt: new Date('2026-10-04T14:40:00Z'),
      clientSentAt: new Date('2026-10-04T14:50:00Z'),
      receivedAt,
    });
    expect(corrected.toISOString()).toBe('2026-10-04T14:50:00.000Z');
    // A phone far in the future cannot produce an instant after reception.
    expect(
      skewCorrectedOccurredAt({
        clientOccurredAt: new Date('2026-10-04T16:00:00Z'),
        clientSentAt: new Date('2026-10-04T15:00:00Z'),
        receivedAt,
      }),
    ).toEqual(receivedAt);
    const notBefore = new Date('2026-10-04T14:00:00Z');
    expect(
      skewCorrectedOccurredAt({
        clientOccurredAt: new Date('2026-10-03T00:00:00Z'),
        clientSentAt: new Date('2026-10-04T15:00:00Z'),
        receivedAt,
        notBefore,
      }),
    ).toEqual(notBefore);
  });
});
