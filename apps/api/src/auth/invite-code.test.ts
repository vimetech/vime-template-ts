import { MeResponseSchema } from '@vime/contracts';
import { closeDb, withSystem, withTenant } from '@vime/db';
import { newId } from '@vime/kernel';
import { hashInvitationCode, setMembershipStatus } from '@vime/platform';
import {
  idempotencyKeys,
  invitations,
  memberships,
  user as userTable,
} from '@vime/platform/schema';
import { ALL_PERMISSIONS, uniqueSuffix, webActor } from '@vime/platform/testing';
import { and, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addMember,
  bearer,
  buildTestApp,
  createOrg,
  createUser,
  signIn,
  type Credentials,
  type TestUser,
} from '../testing/helpers';
import type { RedeemInvitationResponse } from './schemas';

let app: FastifyInstance;
let owner: TestUser;
let ownerCredentials: Credentials;
let orgId: string;

async function invite(
  body: Record<string, unknown>,
  credentials: Credentials = ownerCredentials,
  targetOrgId: string = orgId,
): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: `/v1/orgs/${targetOrgId}/invitations`,
    headers: bearer(credentials),
    payload: body,
  });
  expect(response.statusCode).toBe(201);
  return response.json<{ code: string }>().code;
}

async function redeem(payload: Record<string, unknown>, headers: Record<string, string> = {}) {
  return app.inject({ method: 'POST', url: '/auth/invite/redeem', payload, headers });
}

async function invitationRow(code: string) {
  const [row] = await withSystem((tx) =>
    tx
      .select()
      .from(invitations)
      .where(eq(invitations.codeHash, hashInvitationCode(code, app.invitationCodeKey))),
  );
  if (!row) throw new Error('invitation not found');
  return row;
}

async function usersNamed(name: string) {
  return withSystem((tx) => tx.select().from(userTable).where(eq(userTable.name, name)));
}

beforeAll(async () => {
  app = await buildTestApp();
  owner = await createUser(app, 'Owner');
  orgId = await createOrg(owner.id, { name: 'Invite Test Org' });
  ownerCredentials = await signIn(app, owner);
});

afterAll(async () => {
  await app.close();
  await closeDb();
});

describe('POST /auth/invite/redeem: code-only member without email', () => {
  let redeemed: RedeemInvitationResponse;

  beforeAll(async () => {
    const code = await invite({ roleKeys: ['member'] });
    // Codes are case- and separator-insensitive.
    const response = await redeem({
      code: code.toLowerCase().replace('-', ' '),
      name: 'Rosa Quispe',
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['set-auth-token']).toEqual(expect.any(String));
    expect(String(response.headers['set-cookie'])).toMatch(/vime\.session_token=/);
    redeemed = response.json<RedeemInvitationResponse>();
  });

  it('creates a passwordless user with the given name and a synthetic email', async () => {
    expect(redeemed.user.name).toBe('Rosa Quispe');
    expect(redeemed.user.email).toBeNull();
    const [row] = await withSystem((tx) =>
      tx.select().from(userTable).where(eq(userTable.id, redeemed.user.id)),
    );
    expect(row?.email).toBe(`u_${redeemed.user.id}@staff.invalid`);
  });

  it('creates the membership with the invited roles', () => {
    expect(redeemed.membership).toEqual({
      id: expect.any(String),
      organizationId: orgId,
      roleKeys: ['member'],
      created: true,
    });
  });

  it('returns a bearer token that works on /v1/me', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: bearer(redeemed.token),
    });
    expect(response.statusCode).toBe(200);
    const me = MeResponseSchema.parse(response.json());
    expect(me.user).toEqual({ id: redeemed.user.id, name: 'Rosa Quispe', email: null });
    expect(me.memberships).toHaveLength(1);
    expect(me.memberships[0]).toMatchObject({
      organization: { id: orgId },
      roleKeys: ['member'],
    });
  });

  it('audits the redemption', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/v1/orgs/${orgId}/activity?entityType=membership&entityId=${redeemed.membership.id}`,
      headers: bearer(ownerCredentials),
    });
    expect(response.statusCode).toBe(200);
    const events = response.json<{ items: { eventType: string; actorUserId: string }[] }>().items;
    expect(events.map((event) => event.eventType)).toEqual(['membership.created']);
    expect(events[0]?.actorUserId).toBe(redeemed.user.id);
  });
});

describe('POST /auth/invite/redeem: suspended members', () => {
  it('refuses a suspended member (409), keeping the suspension, the roles and the use', async () => {
    const admin = await createUser(app, 'Suspended admin');
    const membershipId = await addMember(orgId, admin.id, ['admin']);
    await withTenant({ orgId }, (tx) =>
      setMembershipStatus(
        tx,
        webActor(orgId, owner.id),
        membershipId,
        'suspended',
        ALL_PERMISSIONS,
      ),
    );
    const code = await invite({ roleKeys: ['member'], maxUses: 20 });
    for (const response of [
      await redeem({ code }, bearer(await signIn(app, admin))),
      await redeem({ code, email: admin.email, password: admin.password }),
    ]) {
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        code: 'conflict',
        detail: 'The membership is suspended',
      });
    }
    const [row] = await withTenant({ orgId }, (tx) =>
      tx.select().from(memberships).where(eq(memberships.id, membershipId)),
    );
    expect(row).toMatchObject({ status: 'suspended', roleKeys: ['admin'] });
    expect((await invitationRow(code)).uses).toBe(0);
  });
});

describe('POST /auth/invite/redeem: invalid codes', () => {
  it('rejects unknown, used-up and revoked codes alike (400 on `code`)', async () => {
    const used = await invite({ roleKeys: ['member'] });
    expect((await redeem({ code: used })).statusCode).toBe(200);

    const revoked = await invite({ roleKeys: ['member'] });
    const list = await app.inject({
      method: 'GET',
      url: `/v1/orgs/${orgId}/invitations`,
      headers: bearer(ownerCredentials),
    });
    const newest = list.json<{ items: { id: string }[] }>().items[0];
    const revoke = await app.inject({
      method: 'DELETE',
      url: `/v1/orgs/${orgId}/invitations/${newest?.id}`,
      headers: bearer(ownerCredentials),
    });
    expect(revoke.statusCode).toBe(200);

    for (const code of ['ZZZZ-ZZZZ', used, revoked]) {
      const response = await redeem({ code });
      expect(response.statusCode).toBe(400);
      expect(response.headers['content-type']).toMatch(/^application\/problem\+json/);
      expect(response.json()).toMatchObject({
        code: 'validation_failed',
        errors: [{ path: 'code', message: 'Invalid or expired invitation code' }],
      });
    }
  });

  it('validates the body (a password requires an email)', async () => {
    const response = await redeem({ code: 'ABCD-EFGH', password: 'password-123' });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      errors: [expect.objectContaining({ path: 'password' })],
    });
  });

  it('lets only one of two concurrent redemptions of a single-use code win', async () => {
    const code = await invite({ roleKeys: ['member'] });
    const name = `Race ${uniqueSuffix()}`;
    const responses = await Promise.all([redeem({ code, name }), redeem({ code, name })]);
    const statuses = responses.map((r) => r.statusCode).sort();
    // The loser either finds the code used up (400) or loses the race to consume it (409).
    expect([
      [200, 400],
      [200, 409],
    ]).toContainEqual(statuses);
    const users = await withSystem((tx) =>
      tx.select().from(userTable).where(eq(userTable.name, name)),
    );
    expect(users).toHaveLength(1);
  });

  it('deletes the user it created when the invitation is used up before it is consumed', async () => {
    const code = await invite({ roleKeys: ['member'] });
    const name = `Lost race ${uniqueSuffix()}`;
    const invitationId = (await invitationRow(code)).id;

    let pending: ReturnType<typeof redeem> | undefined;
    await withSystem(async (tx) => {
      // Hold the invitation row: the redemption finds the code and creates its user, then waits
      // for this lock in consumeInvitation. Use up the invitation meanwhile.
      await tx.execute(sql`select id from invitations where id = ${invitationId} for update`);
      const [xact] = (
        await tx.execute<{ xid: string }>(sql`select pg_current_xact_id()::text as xid`)
      ).rows;
      pending = redeem({ code, name });
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const waiting = await withSystem((other) =>
          other.execute<{ n: number }>(
            sql`select count(*)::int as n from pg_locks
                where locktype = 'transactionid' and not granted
                  and transactionid::text = ${xact?.xid ?? ''}`,
          ),
        );
        if ((waiting.rows[0]?.n ?? 0) > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      await tx
        .update(invitations)
        .set({ uses: sql`${invitations.maxUses}` })
        .where(eq(invitations.id, invitationId));
    });
    const response = await pending;
    expect(response?.statusCode).toBe(409);
    expect(response?.json()).toMatchObject({ code: 'conflict' });
    const users = await withSystem((tx) =>
      tx.select().from(userTable).where(eq(userTable.name, name)),
    );
    expect(users).toHaveLength(0);
  });
});

describe('POST /auth/invite/redeem: users with email', () => {
  it('creates an email + password user (invitation bound to that email) who can sign in', async () => {
    const email = `manager-${uniqueSuffix()}@api.test.invalid`;
    const code = await invite({ roleKeys: ['manager'], email: email.toUpperCase() });
    const response = await redeem({ code, email, password: 'manager-password', name: 'Mara' });
    expect(response.statusCode).toBe(200);
    const body = response.json<RedeemInvitationResponse>();
    expect(body.user).toMatchObject({ name: 'Mara', email });
    expect(body.membership.roleKeys).toEqual(['manager']);

    const credentials = await signIn(app, {
      id: body.user.id,
      name: 'Mara',
      email,
      password: 'manager-password',
    });
    const me = await app.inject({ method: 'GET', url: '/v1/me', headers: bearer(credentials) });
    expect(me.json()).toMatchObject({ user: { email } });
  });

  it('requires the password of an existing email (401), then joins that user', async () => {
    const existing = await createUser(app, 'Existing');
    const code = await invite({ roleKeys: ['manager'] });
    const wrong = await redeem({ code, email: existing.email, password: 'wrong-password' });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json()).toMatchObject({ code: 'unauthenticated' });
    // An email without a password is refused up front (it would create a user that can never
    // sign in).
    const noPassword = await redeem({ code, email: existing.email });
    expect(noPassword.statusCode).toBe(400);
    expect(noPassword.json()).toMatchObject({
      errors: [expect.objectContaining({ path: 'password' })],
    });

    const right = await redeem({ code, email: existing.email, password: existing.password });
    expect(right.statusCode).toBe(200);
    expect(right.json()).toMatchObject({
      user: { id: existing.id },
      membership: { roleKeys: ['manager'], created: true },
    });
  });
});

describe('POST /auth/invite/redeem: emails nobody proved', () => {
  it('never creates a user with a real email from a code that is not bound to it', async () => {
    const code = await invite({ roleKeys: ['member'], maxUses: 10 });
    const email = `david-${uniqueSuffix()}@davidcompany.test.invalid`;
    const response = await redeem({ code, email, password: 'attacker-pw', name: 'David' });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      errors: [{ path: 'email', message: 'This invitation is not for this email' }],
    });
    const squatted = await withSystem((tx) =>
      tx.select().from(userTable).where(eq(userTable.email, email)),
    );
    expect(squatted).toHaveLength(0);
    expect((await invitationRow(code)).uses).toBe(0);
  });

  it('lets only the invited email redeem an invitation bound to it', async () => {
    const email = `bound-${uniqueSuffix()}@api.test.invalid`;
    const code = await invite({ roleKeys: ['manager'], email });
    const other = await createUser(app, 'Someone else');
    for (const response of [
      await redeem({ code }),
      await redeem({ code, email: other.email, password: other.password }),
      await redeem({ code }, bearer(await signIn(app, other))),
    ]) {
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        errors: [expect.objectContaining({ path: 'email' })],
      });
    }
    const right = await redeem({ code, email, password: 'bound-password' });
    expect(right.statusCode).toBe(200);
    expect(right.json()).toMatchObject({
      user: { email },
      membership: { roleKeys: ['manager'] },
    });
  });
});

describe('POST /auth/invite/redeem: Idempotency-Key', () => {
  it('replays a lost response with a new session, without taking another use', async () => {
    const code = await invite({ roleKeys: ['member'] });
    const key = newId();
    const first = await redeem({ code }, { 'idempotency-key': key });
    expect(first.statusCode).toBe(200);
    const original = first.json<RedeemInvitationResponse>();

    const retry = await redeem({ code }, { 'idempotency-key': key });
    expect(retry.statusCode).toBe(200);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(retry.headers['set-auth-token']).toEqual(expect.any(String));
    const replayed = retry.json<RedeemInvitationResponse>();
    expect(replayed.user).toEqual(original.user);
    expect(replayed.membership).toEqual(original.membership);
    expect(replayed.token).not.toBe(original.token);
    const me = await app.inject({ method: 'GET', url: '/v1/me', headers: bearer(replayed.token) });
    expect(me.json()).toMatchObject({ user: { id: original.user.id } });
    expect((await invitationRow(code)).uses).toBe(1);

    // No session token is ever stored for replays.
    const [stored] = await withSystem((tx) =>
      tx
        .select()
        .from(idempotencyKeys)
        .where(and(eq(idempotencyKeys.organizationId, orgId), eq(idempotencyKeys.key, key))),
    );
    expect(JSON.stringify(stored?.response)).not.toContain(original.token);

    // Without the key, or with another one, the used-up code is just invalid.
    expect((await redeem({ code })).statusCode).toBe(400);
    expect((await redeem({ code }, { 'idempotency-key': newId() })).statusCode).toBe(400);
    // The same key with a different request is a conflict.
    const conflict = await redeem({ code, name: 'Someone else' }, { 'idempotency-key': key });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ code: 'idempotency_conflict' });
    expect((await redeem({ code }, { 'idempotency-key': 'not-a-uuid' })).statusCode).toBe(400);
  });

  it('makes the replay of a password redemption prove the password again', async () => {
    const email = `retry-${uniqueSuffix()}@api.test.invalid`;
    const code = await invite({ roleKeys: ['manager'], email });
    const key = newId();
    const body = { code, email, password: 'retry-password' };
    expect((await redeem(body, { 'idempotency-key': key })).statusCode).toBe(200);
    const wrong = await redeem({ ...body, password: 'wrong-password' }, { 'idempotency-key': key });
    expect(wrong.statusCode).toBe(401);
    const right = await redeem(body, { 'idempotency-key': key });
    expect(right.statusCode).toBe(200);
    expect(right.headers['idempotent-replayed']).toBe('true');
  });

  it('replays to a concurrent duplicate of a multi-use code, deleting the user it made', async () => {
    const code = await invite({ roleKeys: ['member'], maxUses: 5 });
    const key = newId();
    const name = `Twin ${uniqueSuffix()}`;
    const responses = await Promise.all([
      redeem({ code, name }, { 'idempotency-key': key }),
      redeem({ code, name }, { 'idempotency-key': key }),
    ]);
    expect(responses.map((r) => r.statusCode)).toEqual([200, 200]);
    const [a, b] = responses.map((r) => r.json<RedeemInvitationResponse>());
    expect(a?.user.id).toBe(b?.user.id);
    expect(await usersNamed(name)).toHaveLength(1);
    expect((await invitationRow(code)).uses).toBe(1);
  });
});

describe('POST /v1/orgs/:orgId/invitations: the code is never stored', () => {
  it('keeps the code out of the idempotency record and refuses to replay it (409)', async () => {
    const key = newId();
    const create = () =>
      app.inject({
        method: 'POST',
        url: `/v1/orgs/${orgId}/invitations`,
        headers: { ...bearer(ownerCredentials), 'idempotency-key': key },
        payload: { roleKeys: ['member'], expiresInHours: 720, maxUses: 100 },
      });
    const first = await create();
    expect(first.statusCode).toBe(201);
    const { code, id } = first.json<{ code: string; id: string }>();
    const [stored] = await withSystem((tx) =>
      tx
        .select()
        .from(idempotencyKeys)
        .where(and(eq(idempotencyKeys.organizationId, orgId), eq(idempotencyKeys.key, key))),
    );
    expect(stored?.response).toMatchObject({ id });
    expect(stored?.response).not.toHaveProperty('code');
    expect(JSON.stringify(stored?.response)).not.toContain(code);

    const replay = await create();
    expect(replay.statusCode).toBe(409);
    expect(replay.json()).toMatchObject({ code: 'conflict', details: { invitationId: id } });
    expect(replay.body).not.toContain(code);
  });
});

describe('POST /auth/invite/redeem: signed-in users', () => {
  it('joins the signed-in user to another organization, and merges roles when already a member', async () => {
    const otherOwner = await createUser(app, 'Other owner');
    const otherOrgId = await createOrg(otherOwner.id, { name: 'Other Org' });
    const otherCredentials = await signIn(app, otherOwner);

    const notesUrl = `/v1/orgs/${otherOrgId}/notes`;
    const before = await app.inject({
      method: 'GET',
      url: notesUrl,
      headers: bearer(ownerCredentials),
    });
    expect(before.statusCode).toBe(404);

    const first = await invite({ roleKeys: ['manager'] }, otherCredentials, otherOrgId);
    const joined = await redeem({ code: first }, bearer(ownerCredentials));
    expect(joined.statusCode).toBe(200);
    expect(joined.json()).toMatchObject({
      user: { id: owner.id },
      membership: { organizationId: otherOrgId, roleKeys: ['manager'], created: true },
    });

    const second = await invite({ roleKeys: ['member'] }, otherCredentials, otherOrgId);
    const again = await redeem({ code: second }, bearer(ownerCredentials));
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({
      user: { id: owner.id },
      membership: { roleKeys: ['manager', 'member'], created: false },
    });

    // The cached "not a member" was invalidated: the new organization is usable right away.
    const after = await app.inject({
      method: 'GET',
      url: notesUrl,
      headers: bearer(ownerCredentials),
    });
    expect(after.statusCode).toBe(200);
  });
});
