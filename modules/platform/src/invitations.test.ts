import { SYSTEM_ROLES, type Permission } from '@vime/contracts';
import { closeDb, withSystem, withTenant, type Tx } from '@vime/db';
import { ConflictError, ForbiddenError, newId } from '@vime/kernel';
import { eq } from 'drizzle-orm';
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { beginIdempotentRequest, completeIdempotentRequest } from './idempotency';
import {
  consumeInvitation,
  createInvitation,
  findCompletedRedemption,
  findRedeemableInvitationByCode,
  generateInvitationCode,
  hashInvitationCode,
  invitationRedeemActorKey,
  listInvitations,
  normalizeInvitationCode,
  revokeInvitation,
} from './invitations';
import { addMembership, resolveMembershipForUser, setMembershipStatus } from './memberships';
import { activityEvents, invitations, memberships } from './schema';
import {
  ALL_PERMISSIONS,
  TEST_INVITATION_CODE_KEY as KEY,
  createTestOrg,
  createTestUser,
  webActor,
  type TestUser,
} from './testing/fixtures';

afterAll(async () => {
  await closeDb();
});

describe('invitation codes', () => {
  it('are 8 Crockford base32 characters shown as XXXX-XXXX', () => {
    const codes = new Set(Array.from({ length: 200 }, () => generateInvitationCode()));
    expect(codes.size).toBe(200);
    for (const code of codes) {
      expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    }
  });

  it('normalize case, separators and look-alike letters', () => {
    expect(normalizeInvitationCode(' ab1o-ilxz ')).toBe('AB1011XZ');
    expect(normalizeInvitationCode('abcd efgh')).toBe('ABCDEFGH');
    expect(hashInvitationCode('abcd-efgh', KEY)).toBe(hashInvitationCode('ABCDEFGH', KEY));
  });

  it('hash with an HMAC under a server-side key (useless without the key)', () => {
    expect(hashInvitationCode('ABCD-EFGH', KEY)).toBe(
      createHmac('sha256', KEY).update('ABCDEFGH').digest('hex'),
    );
    expect(hashInvitationCode('ABCD-EFGH', `${KEY}-other`)).not.toBe(
      hashInvitationCode('ABCD-EFGH', KEY),
    );
    expect(() => hashInvitationCode('ABCD-EFGH', 'too-short')).toThrow(TypeError);
  });
});

describe('invitations (create, find, redeem)', () => {
  let owner: TestUser;
  let orgId: string;

  beforeAll(async () => {
    owner = await createTestUser('Owner');
    orgId = (await createTestOrg({ ownerUserId: owner.id })).id;
  });

  function asOwner<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return withTenant({ orgId, userId: owner.id }, fn);
  }

  it('stores only the hash of the code and returns the code once', async () => {
    const created = await asOwner((tx) =>
      createInvitation(
        tx,
        webActor(orgId, owner.id),
        { roleKeys: ['member'] },
        ALL_PERMISSIONS,
        KEY,
      ),
    );
    expect(created.code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    expect(created).toMatchObject({ roleKeys: ['member'], maxUses: 1 });
    expect(created.uses).toBe(0);
    const [row] = await asOwner((tx) =>
      tx.select().from(invitations).where(eq(invitations.id, created.id)),
    );
    expect(row?.codeHash).toBe(hashInvitationCode(created.code, KEY));
    expect(JSON.stringify(row)).not.toContain(normalizeInvitationCode(created.code));
    const listed = await asOwner((tx) => listInvitations(tx));
    expect(listed.find((item) => item.id === created.id)).not.toHaveProperty('code');
    // expires 72 hours later by default
    const hours = (Date.parse(created.expiresAt) - Date.parse(created.createdAt)) / 3_600_000;
    expect(hours).toBeCloseTo(72, 1);
  });

  it('redeems once: membership and uses + 1', async () => {
    const created = await asOwner((tx) =>
      createInvitation(
        tx,
        webActor(orgId, owner.id),
        { roleKeys: ['member'] },
        ALL_PERMISSIONS,
        KEY,
      ),
    );
    const typed = created.code.toLowerCase().replace('-', ' ');
    const found = await withSystem((tx) => findRedeemableInvitationByCode(tx, typed, KEY));
    expect(found).toMatchObject({
      id: created.id,
      organizationId: orgId,
      roleKeys: ['member'],
      uses: 0,
    });

    const member = await createTestUser('Rosa');
    const result = await withTenant({ orgId, userId: member.id }, (tx) =>
      consumeInvitation(
        tx,
        { orgId, userId: member.id, source: 'web' },
        { invitationId: created.id, userId: member.id },
      ),
    );
    expect(result.membershipCreated).toBe(true);
    expect(result.membership).toMatchObject({ roleKeys: ['member'] });
    expect(result.membership.permissions).toEqual(new Set(SYSTEM_ROLES.member.permissions));

    await withTenant({ orgId }, async (tx) => {
      const [invitation] = await tx
        .select()
        .from(invitations)
        .where(eq(invitations.id, created.id));
      expect(invitation?.uses).toBe(1);
      const resolved = await resolveMembershipForUser(tx, member.id, orgId);
      expect(resolved?.roleKeys).toEqual(['member']);
      const events = await tx
        .select({ eventType: activityEvents.eventType })
        .from(activityEvents)
        .where(eq(activityEvents.actorUserId, member.id));
      expect(events.map((e) => e.eventType).sort()).toEqual([
        'invitation.redeemed',
        'membership.created',
      ]);
    });

    // Used up: no longer found, and consuming again conflicts.
    expect(
      await withSystem((tx) => findRedeemableInvitationByCode(tx, created.code, KEY)),
    ).toBeNull();
    await expect(
      withTenant({ orgId, userId: member.id }, (tx) =>
        consumeInvitation(
          tx,
          { orgId, userId: member.id, source: 'web' },
          { invitationId: created.id, userId: member.id },
        ),
      ),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('merges roles into an existing membership', async () => {
    const created = await asOwner((tx) =>
      createInvitation(
        tx,
        webActor(orgId, owner.id),
        { roleKeys: ['manager'] },
        ALL_PERMISSIONS,
        KEY,
      ),
    );
    const result = await withTenant({ orgId, userId: owner.id }, (tx) =>
      consumeInvitation(tx, webActor(orgId, owner.id), {
        invitationId: created.id,
        userId: owner.id,
      }),
    );
    expect(result.membershipCreated).toBe(false);
    expect(result.membership.roleKeys).toEqual(['owner', 'manager']);
  });

  it('does not find expired, revoked or unknown codes', async () => {
    const now = new Date();
    const created = await asOwner((tx) =>
      createInvitation(
        tx,
        webActor(orgId, owner.id),
        { roleKeys: ['member'], expiresInHours: 1 },
        ALL_PERMISSIONS,
        KEY,
        now,
      ),
    );
    const later = new Date(now.getTime() + 2 * 3_600_000);
    expect(
      await withSystem((tx) => findRedeemableInvitationByCode(tx, created.code, KEY, later)),
    ).toBe(null);
    expect(
      await withSystem((tx) => findRedeemableInvitationByCode(tx, created.code, KEY, now)),
    ).not.toBeNull();

    await asOwner((tx) => revokeInvitation(tx, webActor(orgId, owner.id), created.id));
    expect(
      await withSystem((tx) => findRedeemableInvitationByCode(tx, created.code, KEY)),
    ).toBeNull();
    // Revoking twice is a no-op.
    const revoked = await asOwner((tx) =>
      revokeInvitation(tx, webActor(orgId, owner.id), created.id),
    );
    expect(revoked.revokedAt).not.toBeNull();

    expect(
      await withSystem((tx) => findRedeemableInvitationByCode(tx, 'ZZZZ-ZZZZ', KEY)),
    ).toBeNull();
    expect(await withSystem((tx) => findRedeemableInvitationByCode(tx, 'short', KEY))).toBeNull();
  });

  it('refuses roles beyond the creator permissions', async () => {
    const manager: ReadonlySet<Permission> = new Set(SYSTEM_ROLES.manager.permissions);
    await expect(
      asOwner((tx) =>
        createInvitation(tx, webActor(orgId, owner.id), { roleKeys: ['owner'] }, manager, KEY),
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      asOwner((tx) =>
        createInvitation(tx, webActor(orgId, owner.id), { roleKeys: ['member'] }, manager, KEY),
      ),
    ).resolves.toMatchObject({ roleKeys: ['member'] });
  });

  it('an invitation of another organization cannot be consumed here', async () => {
    const other = await createTestOrg();
    const created = await asOwner((tx) =>
      createInvitation(
        tx,
        webActor(orgId, owner.id),
        { roleKeys: ['member'] },
        ALL_PERMISSIONS,
        KEY,
      ),
    );
    const outsider = await createTestUser('Outsider');
    // The invitation is invisible in the other organization's transaction.
    await expect(
      withTenant({ orgId: other.id, userId: outsider.id }, (tx) =>
        consumeInvitation(tx, webActor(other.id, outsider.id), {
          invitationId: created.id,
          userId: outsider.id,
        }),
      ),
    ).rejects.toBeInstanceOf(ConflictError);
    const rows = await withSystem((tx) =>
      tx.select().from(memberships).where(eq(memberships.userId, outsider.id)),
    );
    expect(rows).toEqual([]);
  });
});

describe('invitations: security rules', () => {
  let owner: TestUser;
  let orgId: string;

  beforeAll(async () => {
    owner = await createTestUser('Owner');
    orgId = (await createTestOrg({ ownerUserId: owner.id })).id;
  });

  const ownerCtx = () => webActor(orgId, owner.id);

  function asOwner<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return withTenant({ orgId, userId: owner.id }, fn);
  }

  function invite(input: Parameters<typeof createInvitation>[2], grantor = ALL_PERMISSIONS) {
    return asOwner((tx) => createInvitation(tx, ownerCtx(), input, grantor, KEY));
  }

  async function findInvitation(code: string) {
    const found = await withSystem((tx) => findRedeemableInvitationByCode(tx, code, KEY));
    if (!found) throw new Error('invitation not found');
    return found;
  }

  it('refuses to redeem into a suspended membership, without taking a use', async () => {
    const admin = await createTestUser('Suspended admin');
    const membership = await asOwner((tx) =>
      addMembership(tx, ownerCtx(), { userId: admin.id, roleKeys: ['admin'] }),
    );
    await asOwner((tx) =>
      setMembershipStatus(tx, ownerCtx(), membership.membershipId, 'suspended', ALL_PERMISSIONS),
    );
    const created = await invite({ roleKeys: ['member'], maxUses: 20 });
    await expect(
      withTenant({ orgId, userId: admin.id }, (tx) =>
        consumeInvitation(tx, webActor(orgId, admin.id), {
          invitationId: created.id,
          userId: admin.id,
        }),
      ),
    ).rejects.toMatchObject({ code: 'conflict', message: 'The membership is suspended' });
    const [row] = await asOwner((tx) =>
      tx.select().from(memberships).where(eq(memberships.id, membership.membershipId)),
    );
    expect(row).toMatchObject({ status: 'suspended', roleKeys: ['admin'] });
    const [invitation] = await asOwner((tx) =>
      tx.select().from(invitations).where(eq(invitations.id, created.id)),
    );
    expect(invitation?.uses).toBe(0);
  });

  it('binds an invitation to a lowercase email', async () => {
    const created = await invite({ roleKeys: ['manager'], email: 'Ana.Manager@Example.com' });
    expect(created).toMatchObject({ email: 'ana.manager@example.com', maxUses: 1 });
    expect((await findInvitation(created.code)).email).toBe('ana.manager@example.com');
    const listed = await asOwner((tx) => listInvitations(tx));
    expect(listed.find((item) => item.id === created.id)?.email).toBe('ana.manager@example.com');
  });

  it('finds a completed redemption by code and Idempotency-Key while the code is valid', async () => {
    const created = await invite({ roleKeys: ['member'] });
    const key = newId();
    const ref = { actorKey: invitationRedeemActorKey(created.id), key };
    await withTenant({ orgId }, async (tx) => {
      await beginIdempotentRequest(tx, orgId, { ...ref, requestHash: 'hash-1' });
      await completeIdempotentRequest(tx, { ...ref, statusCode: 200, response: { ok: true } });
    });
    expect(await withSystem((tx) => findCompletedRedemption(tx, created.code, KEY, key))).toEqual({
      organizationId: orgId,
      invitationId: created.id,
      requestHash: 'hash-1',
      statusCode: 200,
      response: { ok: true },
    });
    expect(
      await withSystem((tx) => findCompletedRedemption(tx, created.code, KEY, newId())),
    ).toBeNull();
    await asOwner((tx) => revokeInvitation(tx, ownerCtx(), created.id));
    expect(
      await withSystem((tx) => findCompletedRedemption(tx, created.code, KEY, key)),
    ).toBeNull();
  });
});
