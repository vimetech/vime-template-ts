import {
  CreateInvitationSchema,
  permissionsForRoles,
  type CreateInvitationResponse,
  type InvitationListItem,
  type Permission,
  type RoleKey,
} from '@vime/contracts';
import type { Tx } from '@vime/db';
import { ConflictError, NotFoundError, newId } from '@vime/kernel';
import { and, desc, eq, gt, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import { createHmac, randomBytes } from 'node:crypto';
import type { z } from 'zod';
import { recordActivity } from './audit';
import type { ActorContext } from './context';
import { iso, isoOrNull, knownRoleKeys } from './dto';
import { isUniqueViolation, parseInput } from './errors';
import { assertCanGrantRoles, type ResolvedMembership } from './memberships';
import { idempotencyKeys, invitations, memberships, organizations } from './schema';

/** Crockford base32: no I, L, O or U, so codes survive being read aloud or typed on a phone. */
const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LENGTH = 8;

/**
 * A new invitation code: 8 Crockford base32 characters (40 random bits) shown as `XXXX-XXXX`.
 * Short enough to dictate over WhatsApp; the redeem endpoint must be rate limited, and codes expire
 * and have a use limit.
 */
export function generateInvitationCode(): string {
  const bytes = randomBytes(5);
  let bits = 0n;
  for (const byte of bytes) {
    bits = (bits << 8n) | BigInt(byte);
  }
  let code = '';
  for (let index = CODE_LENGTH - 1; index >= 0; index -= 1) {
    code += CROCKFORD_ALPHABET[Number((bits >> BigInt(index * 5)) & 31n)];
  }
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/**
 * Canonical form of a typed code: uppercase, separators and spaces removed, and the Crockford
 * look-alikes mapped (I and L → 1, O → 0). `abcd-efgh`, `ABCD EFGH` and `ABCDEFGH` are the same code.
 */
export function normalizeInvitationCode(code: string): string {
  return code
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0');
}

/**
 * Server-side secret of the code hash (at least 32 bytes). It must never be stored in the database:
 * the API derives it from its own secret (see apps/api `deriveInvitationCodeKey`).
 */
export type InvitationCodeKey = string | Uint8Array;

const MIN_CODE_KEY_BYTES = 32;

/**
 * HMAC-SHA256 (hex) of the normalized code under `key`. Only this is stored
 * (`invitations.code_hash`). A plain hash would not do: a 40-bit code is brute-forced offline in
 * minutes from a database dump, whereas the HMAC is useless without the key.
 */
export function hashInvitationCode(code: string, key: InvitationCodeKey): string {
  const bytes = typeof key === 'string' ? Buffer.byteLength(key) : key.byteLength;
  if (bytes < MIN_CODE_KEY_BYTES) {
    throw new TypeError(`The invitation code key must have at least ${MIN_CODE_KEY_BYTES} bytes`);
  }
  return createHmac('sha256', key).update(normalizeInvitationCode(code)).digest('hex');
}

type InvitationRow = typeof invitations.$inferSelect;

function toInvitationListItem(row: InvitationRow): InvitationListItem {
  return {
    id: row.id,
    roleKeys: knownRoleKeys(row.roleKeys),
    email: row.email,
    expiresAt: iso(row.expiresAt),
    maxUses: row.maxUses,
    uses: row.uses,
    revokedAt: isoOrNull(row.revokedAt),
    createdBy: row.createdBy,
    createdAt: iso(row.createdAt),
  };
}

/**
 * Creates an invitation (`CreateInvitationSchema`) and returns it with its plaintext code; the code
 * is never retrievable again (only its HMAC under `codeKey` is stored). The creator (`ctx.userId`,
 * required) must hold every permission of the invited roles. `email` is stored lowercase.
 */
export async function createInvitation(
  tx: Tx,
  ctx: ActorContext,
  input: z.input<typeof CreateInvitationSchema>,
  grantorPermissions: ReadonlySet<Permission>,
  codeKey: InvitationCodeKey,
  now: Date = new Date(),
): Promise<CreateInvitationResponse> {
  const data = parseInput(CreateInvitationSchema, input);
  const createdBy = ctx.userId;
  if (!createdBy) {
    throw new TypeError('createInvitation requires ctx.userId (the creator)');
  }
  assertCanGrantRoles(grantorPermissions, data.roleKeys);
  const email = data.email === undefined ? null : normalizeInvitationEmail(data.email);
  const expiresAt = new Date(now.getTime() + data.expiresInHours * 3_600_000);

  // A 40-bit code collides with an existing hash only by extreme bad luck; retry in a savepoint.
  for (let attempt = 1; ; attempt += 1) {
    const code = generateInvitationCode();
    try {
      const row = await tx.transaction(async (sp) => {
        const [inserted] = await sp
          .insert(invitations)
          .values({
            id: newId(),
            organizationId: ctx.orgId,
            codeHash: hashInvitationCode(code, codeKey),
            email,
            roleKeys: data.roleKeys,
            expiresAt,
            maxUses: data.maxUses,
            createdBy,
          })
          .returning();
        return inserted;
      });
      if (!row) {
        throw new Error('Insert into invitations returned no row');
      }
      await recordActivity(tx, ctx, {
        entityType: 'invitation',
        entityId: row.id,
        eventType: 'invitation.created',
        payload: {
          roleKeys: data.roleKeys,
          email,
          expiresAt: expiresAt.toISOString(),
          maxUses: data.maxUses,
        },
      });
      return { ...toInvitationListItem(row), code };
    } catch (error) {
      if (attempt < 3 && isUniqueViolation(error, 'invitations_code_hash_unique')) {
        continue;
      }
      throw error;
    }
  }
}

/** Invitations of the current organization, newest first (without codes). */
export async function listInvitations(tx: Tx): Promise<InvitationListItem[]> {
  const rows = await tx.select().from(invitations).orderBy(desc(invitations.id));
  return rows.map(toInvitationListItem);
}

/** Revokes an invitation so it can no longer be redeemed. Idempotent. */
export async function revokeInvitation(
  tx: Tx,
  ctx: ActorContext,
  invitationId: string,
): Promise<InvitationListItem> {
  const [current] = await tx
    .select()
    .from(invitations)
    .where(eq(invitations.id, invitationId))
    .for('update');
  if (!current) {
    throw new NotFoundError('invitation', invitationId);
  }
  if (current.revokedAt !== null) {
    return toInvitationListItem(current);
  }
  const [row] = await tx
    .update(invitations)
    .set({ revokedAt: sql`now()` })
    .where(eq(invitations.id, invitationId))
    .returning();
  if (!row) {
    throw new NotFoundError('invitation', invitationId);
  }
  await recordActivity(tx, ctx, {
    entityType: 'invitation',
    entityId: invitationId,
    eventType: 'invitation.revoked',
    payload: {},
  });
  return toInvitationListItem(row);
}

/** Lowercase, trimmed: the form `invitations.email` is stored and compared in. */
export function normalizeInvitationEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** An invitation that can be redeemed now, as found by its code. */
export interface RedeemableInvitation {
  id: string;
  organizationId: string;
  roleKeys: RoleKey[];
  /** Lowercase email the invitation is bound to: only that user may redeem it. */
  email: string | null;
  expiresAt: Date;
  maxUses: number;
  uses: number;
}

/**
 * Finds the invitation for `code` if it can be redeemed now: not revoked, not expired, with uses
 * left and of an organization that is not suspended. Returns null otherwise (never says why: do
 * not help guessing). Run it through withSystem
 * (`systemTx`): the redeemer has no organization yet, and the lookup is by exact code hash only.
 */
export async function findRedeemableInvitationByCode(
  systemTx: Tx,
  code: string,
  codeKey: InvitationCodeKey,
  now: Date = new Date(),
): Promise<RedeemableInvitation | null> {
  if (normalizeInvitationCode(code).length !== CODE_LENGTH) {
    return null;
  }
  const [row] = await systemTx
    .select({ invitation: invitations })
    .from(invitations)
    .innerJoin(organizations, eq(organizations.id, invitations.organizationId))
    .where(
      and(
        eq(invitations.codeHash, hashInvitationCode(code, codeKey)),
        isNull(invitations.revokedAt),
        gt(invitations.expiresAt, now),
        lt(invitations.uses, invitations.maxUses),
        isNull(organizations.suspendedAt),
      ),
    );
  if (!row) {
    return null;
  }
  const { invitation } = row;
  return {
    id: invitation.id,
    organizationId: invitation.organizationId,
    roleKeys: knownRoleKeys(invitation.roleKeys),
    email: invitation.email,
    expiresAt: invitation.expiresAt,
    maxUses: invitation.maxUses,
    uses: invitation.uses,
  };
}

/**
 * Idempotency scope of redemptions (`idempotency_keys.actor_key`): the redeemer has no actor yet,
 * so keys are scoped per invitation.
 */
export function invitationRedeemActorKey(invitationId: string): string {
  return `invitation:${invitationId}`;
}

/** A completed redemption stored under an Idempotency-Key (see `findCompletedRedemption`). */
export interface CompletedRedemption {
  organizationId: string;
  invitationId: string;
  requestHash: string;
  statusCode: number;
  response: unknown;
}

/**
 * The completed redemption of `code` with Idempotency-Key `key`, while the invitation is still
 * valid (not revoked, not expired; it may be used up by that very redemption), or null. Lets a
 * client whose response was lost retry the redemption. Run it through withSystem.
 */
export async function findCompletedRedemption(
  systemTx: Tx,
  code: string,
  codeKey: InvitationCodeKey,
  key: string,
  now: Date = new Date(),
): Promise<CompletedRedemption | null> {
  if (normalizeInvitationCode(code).length !== CODE_LENGTH) {
    return null;
  }
  const [row] = await systemTx
    .select({
      organizationId: invitations.organizationId,
      invitationId: invitations.id,
      requestHash: idempotencyKeys.requestHash,
      statusCode: idempotencyKeys.statusCode,
      response: idempotencyKeys.response,
    })
    .from(invitations)
    .innerJoin(
      idempotencyKeys,
      and(
        eq(idempotencyKeys.organizationId, invitations.organizationId),
        eq(idempotencyKeys.actorKey, sql`'invitation:' || ${invitations.id}::text`),
        eq(idempotencyKeys.key, key),
      ),
    )
    .where(
      and(
        eq(invitations.codeHash, hashInvitationCode(code, codeKey)),
        isNull(invitations.revokedAt),
        gt(invitations.expiresAt, now),
        isNotNull(idempotencyKeys.statusCode),
      ),
    );
  if (!row || row.statusCode === null) {
    return null;
  }
  return { ...row, statusCode: row.statusCode };
}

export interface ConsumeInvitationInput {
  invitationId: string;
  /** The redeeming user (existing, or just created by the auth flow). */
  userId: string;
}

export interface ConsumedInvitation {
  membership: ResolvedMembership;
  /** False when the user was already a member (roles merged). */
  membershipCreated: boolean;
}

/**
 * Redeems an invitation for `userId`, in withTenant of the invitation's organization
 * (`ctx.orgId = invitation.organizationId`, `ctx.userId = userId`). In one transaction it:
 * takes one use (ConflictError if the invitation was revoked, expired or used up meanwhile),
 * creates the membership or merges the invited roles into the existing ACTIVE one (a suspended
 * membership is a ConflictError: only `setMembershipStatus` reactivates, under its grantor rule),
 * and audits everything. Any error rolls back the whole redemption, the use included.
 */
export async function consumeInvitation(
  tx: Tx,
  ctx: ActorContext,
  input: ConsumeInvitationInput,
): Promise<ConsumedInvitation> {
  const [invitation] = await tx
    .update(invitations)
    .set({ uses: sql`${invitations.uses} + 1` })
    .where(
      and(
        eq(invitations.id, input.invitationId),
        isNull(invitations.revokedAt),
        gt(invitations.expiresAt, sql`now()`),
        lt(invitations.uses, invitations.maxUses),
      ),
    )
    .returning();
  if (!invitation) {
    throw new ConflictError('The invitation is no longer valid', {
      details: { invitationId: input.invitationId },
    });
  }
  const invitedRoles = knownRoleKeys(invitation.roleKeys);

  const [existing] = await tx
    .select()
    .from(memberships)
    .where(and(eq(memberships.organizationId, ctx.orgId), eq(memberships.userId, input.userId)))
    .for('update');

  let membershipId: string;
  let roleKeys: RoleKey[];
  if (!existing) {
    membershipId = newId();
    roleKeys = invitedRoles;
    await tx.insert(memberships).values({
      id: membershipId,
      organizationId: ctx.orgId,
      userId: input.userId,
      roleKeys,
    });
  } else {
    if (existing.status !== 'active') {
      throw new ConflictError('The membership is suspended', {
        details: { membershipId: existing.id },
      });
    }
    membershipId = existing.id;
    roleKeys = [...new Set([...knownRoleKeys(existing.roleKeys), ...invitedRoles])];
    await tx.update(memberships).set({ roleKeys }).where(eq(memberships.id, membershipId));
  }

  await recordActivity(tx, ctx, {
    entityType: 'invitation',
    entityId: invitation.id,
    eventType: 'invitation.redeemed',
    payload: { userId: input.userId, membershipId, uses: invitation.uses },
  });
  await recordActivity(tx, ctx, {
    entityType: 'membership',
    entityId: membershipId,
    eventType: existing ? 'membership.updated' : 'membership.created',
    payload: existing
      ? {
          from: { roleKeys: existing.roleKeys, status: existing.status },
          to: { roleKeys, status: 'active' },
          invitationId: invitation.id,
        }
      : { userId: input.userId, roleKeys, invitationId: invitation.id },
  });

  return {
    membership: {
      membershipId,
      organizationId: ctx.orgId,
      userId: input.userId,
      roleKeys,
      permissions: permissionsForRoles(roleKeys),
      // Redeemable invitations are of organizations that are not suspended.
      organizationSuspended: false,
    },
    membershipCreated: !existing,
  };
}
