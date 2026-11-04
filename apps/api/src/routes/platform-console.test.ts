import {
  ActivityEventSchema,
  CreatePlatformOrganizationResponseSchema,
  MeResponseSchema,
  OwnerInvitationSchema,
  PlatformOrganizationSchema,
  ProblemDetailsSchema,
} from '@vime/contracts';
import { closeDb } from '@vime/db';
import { uniqueSuffix } from '@vime/platform/testing';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bearer,
  buildTestApp,
  createOrg,
  createUser,
  signIn,
  testEnv,
  type Credentials,
} from '../testing/helpers';

/*
 * Platform console (ADR 0015): platform administrators manage organizations from outside
 * (modules, suspension, a new client and its first owner) without becoming members, and without
 * reaching their operational data.
 */

let app: FastifyInstance;
let admin: Credentials;
let adminId: string;
let ownerA: Credentials;
let ownerB: Credentials;
let orgA: string;
let orgB: string;

function platform(credentials: Credentials, options: InjectOptions & { url: string }) {
  return app.inject({
    ...options,
    url: `/v1/platform${options.url}`,
    headers: { ...bearer(credentials), ...options.headers },
  });
}

function inOrg(credentials: Credentials, orgId: string, options: InjectOptions & { url: string }) {
  return app.inject({
    ...options,
    url: `/v1/orgs/${orgId}${options.url}`,
    headers: { ...bearer(credentials), ...options.headers },
  });
}

async function me(credentials: Credentials) {
  return MeResponseSchema.parse(
    (await app.inject({ method: 'GET', url: '/v1/me', headers: bearer(credentials) })).json(),
  );
}

async function events(credentials: Credentials, orgId: string, query: string) {
  return (await inOrg(credentials, orgId, { method: 'GET', url: `/activity?${query}` }))
    .json<{ items: unknown[] }>()
    .items.map((item) => ActivityEventSchema.parse(item));
}

beforeAll(async () => {
  // Users first: the platform administrators are server configuration, read at start.
  const setup = await buildTestApp();
  const adminUser = await createUser(setup, 'Plataforma VIME');
  const ownerAUser = await createUser(setup, 'Owner Ana');
  const ownerBUser = await createUser(setup, 'Owner Beto');
  orgA = await createOrg(ownerAUser.id, { name: 'Console Org A' });
  orgB = await createOrg(ownerBUser.id, { name: 'Console Org B' });
  await setup.close();

  adminId = adminUser.id;
  app = await buildTestApp({ env: testEnv({ PLATFORM_ADMIN_USER_IDS: adminUser.id }) });
  admin = await signIn(app, adminUser);
  ownerA = await signIn(app, ownerAUser);
  ownerB = await signIn(app, ownerBUser);
});

afterAll(async () => {
  await app.close();
  await closeDb();
});

describe('who sees the console', () => {
  it('is 404 for anyone but a platform administrator, and 401 without a session', async () => {
    expect((await platform(ownerA, { method: 'GET', url: '/organizations' })).statusCode).toBe(404);
    const suspend = await platform(ownerA, {
      method: 'PUT',
      url: `/organizations/${orgB}/suspension`,
      payload: { reason: 'x' },
    });
    expect(suspend.statusCode).toBe(404);
    expect((await inOrg(ownerB, orgB, { method: 'GET', url: '' })).statusCode).toBe(200);
    expect(
      (await app.inject({ method: 'GET', url: '/v1/platform/organizations' })).statusCode,
    ).toBe(401);
  });

  it('marks the administrator in /me, who is a member of nothing', async () => {
    expect(await me(admin)).toMatchObject({ platformAdmin: true, memberships: [] });
    expect((await me(ownerA)).platformAdmin).toBe(false);
  });

  it('lists organizations with their modules and owners, but does not let the admin in', async () => {
    const response = await platform(admin, { method: 'GET', url: '/organizations' });
    expect(response.statusCode).toBe(200);
    const items = response
      .json<{ items: unknown[] }>()
      .items.map((item) => PlatformOrganizationSchema.parse(item));
    expect(items.find((o) => o.id === orgA)).toMatchObject({
      name: 'Console Org A',
      suspendedAt: null,
      entitlements: [{ featureKey: 'example', enabled: true, validUntil: null }],
      owners: [{ name: 'Owner Ana' }],
    });
    // The console is not a membership: the organization's data stays out of reach.
    expect((await inOrg(admin, orgA, { method: 'GET', url: '/notes' })).statusCode).toBe(404);
  });
});

describe('modules', () => {
  it('turns a module off and on, audited as platform', async () => {
    const off = await platform(admin, {
      method: 'PUT',
      url: `/organizations/${orgA}/entitlements/example`,
      payload: { enabled: false },
    });
    expect(off.statusCode).toBe(200);
    expect(PlatformOrganizationSchema.parse(off.json()).entitlements).toEqual([
      { featureKey: 'example', enabled: false, validUntil: null },
    ]);
    const notes = await inOrg(ownerA, orgA, { method: 'GET', url: '/notes' });
    expect(notes.statusCode).toBe(403);
    expect(ProblemDetailsSchema.parse(notes.json()).code).toBe('feature_not_enabled');
    // The other organization is untouched.
    expect((await inOrg(ownerB, orgB, { method: 'GET', url: '/notes' })).statusCode).toBe(200);

    const on = await platform(admin, {
      method: 'PUT',
      url: `/organizations/${orgA}/entitlements/example`,
      payload: { enabled: true },
    });
    expect(on.statusCode).toBe(200);
    expect((await inOrg(ownerA, orgA, { method: 'GET', url: '/notes' })).statusCode).toBe(200);

    const trail = await events(ownerA, orgA, `entityType=organization&entityId=${orgA}`);
    expect(
      trail
        .filter((e) => e.eventType === 'entitlement.set' && e.source === 'platform')
        .map((e) => [e.actorUserId, e.payload['enabled']]),
    ).toEqual(
      expect.arrayContaining([
        [adminId, false],
        [adminId, true],
      ]),
    );
  });

  it('is 404 for an organization that does not exist', async () => {
    const response = await platform(admin, {
      method: 'PUT',
      url: '/organizations/01a10000-0000-7000-8000-0000000000ff/entitlements/advanced_insights',
      payload: { enabled: true },
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('suspension', () => {
  it('closes the organization to its members until lifted, and only that one', async () => {
    const suspended = await platform(admin, {
      method: 'PUT',
      url: `/organizations/${orgA}/suspension`,
      payload: { reason: 'Falta de pago' },
    });
    expect(suspended.statusCode).toBe(200);
    expect(PlatformOrganizationSchema.parse(suspended.json()).suspendedAt).not.toBeNull();

    const blocked = await inOrg(ownerA, orgA, { method: 'GET', url: '' });
    expect(blocked.statusCode).toBe(403);
    expect(ProblemDetailsSchema.parse(blocked.json()).code).toBe('organization_suspended');
    expect((await me(ownerA)).memberships.find((m) => m.organization.id === orgA)).toMatchObject({
      organization: { suspended: true },
    });
    // Outsiders still get the usual 404, and the other organization works.
    expect((await inOrg(ownerB, orgA, { method: 'GET', url: '' })).statusCode).toBe(404);
    expect((await inOrg(ownerB, orgB, { method: 'GET', url: '' })).statusCode).toBe(200);
    // Idempotent: suspending again changes nothing.
    expect(
      (
        await platform(admin, {
          method: 'PUT',
          url: `/organizations/${orgA}/suspension`,
          payload: { reason: 'Otra vez' },
        })
      ).statusCode,
    ).toBe(200);

    const lifted = await platform(admin, {
      method: 'DELETE',
      url: `/organizations/${orgA}/suspension`,
    });
    expect(lifted.statusCode).toBe(200);
    expect(PlatformOrganizationSchema.parse(lifted.json()).suspendedAt).toBeNull();
    expect((await inOrg(ownerA, orgA, { method: 'GET', url: '' })).statusCode).toBe(200);

    const trail = await events(ownerA, orgA, `entityType=organization&entityId=${orgA}`);
    expect(
      trail
        .filter((e) => e.eventType.startsWith('organization.') && e.source === 'platform')
        .map((e) => [e.eventType, e.payload['reason'] ?? null])
        .sort(),
    ).toEqual([
      ['organization.reactivated', null],
      ['organization.suspended', 'Falta de pago'],
    ]);
  });

  it('stops invitation codes of a suspended organization', async () => {
    const invited = await inOrg(ownerB, orgB, {
      method: 'POST',
      url: '/invitations',
      payload: { roleKeys: ['manager'] },
    });
    expect(invited.statusCode).toBe(201);
    const { code } = invited.json<{ code: string }>();
    await platform(admin, {
      method: 'PUT',
      url: `/organizations/${orgB}/suspension`,
      payload: { reason: 'Prueba' },
    });
    const redeem = () =>
      app.inject({ method: 'POST', url: '/auth/invite/redeem', payload: { code } });
    expect((await redeem()).statusCode).toBe(400);
    await platform(admin, { method: 'DELETE', url: `/organizations/${orgB}/suspension` });
    expect((await redeem()).statusCode).toBe(200);
  });
});

describe('a new client', () => {
  const slug = `cliente-${uniqueSuffix()}`;
  const ownerEmail = `duenio-${uniqueSuffix()}@platform.test.invalid`;
  let created: ReturnType<typeof CreatePlatformOrganizationResponseSchema.parse>;

  it('creates the organization with its modules and an owner invitation', async () => {
    const response = await platform(admin, {
      method: 'POST',
      url: '/organizations',
      payload: {
        name: 'Cliente Nuevo',
        slug,
        timezone: 'America/Mexico_City',
        ownerEmail,
        features: ['example', 'advanced_insights'],
      },
    });
    expect(response.statusCode).toBe(201);
    created = CreatePlatformOrganizationResponseSchema.parse(response.json());
    expect(created.organization).toMatchObject({
      name: 'Cliente Nuevo',
      slug,
      timezone: 'America/Mexico_City',
      suspendedAt: null,
      owners: [],
      entitlements: [
        { featureKey: 'example', enabled: true },
        { featureKey: 'advanced_insights', enabled: true },
      ],
    });
    expect(created.ownerInvitation.email).toBe(ownerEmail);
    expect(created.ownerInvitation.code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/);

    const again = await platform(admin, {
      method: 'POST',
      url: '/organizations',
      payload: { name: 'Otro', slug, timezone: 'America/Lima', ownerEmail },
    });
    expect(again.statusCode).toBe(409);
  });

  it('lets the owner in with the code, and then stops issuing owner invitations', async () => {
    const orgId = created.organization.id;
    // A lost code can be replaced while nobody owns the organization.
    const replacement = await platform(admin, {
      method: 'POST',
      url: `/organizations/${orgId}/owner-invitations`,
      payload: { email: ownerEmail },
    });
    expect(replacement.statusCode).toBe(201);
    const { code } = OwnerInvitationSchema.parse(replacement.json());

    const redeemed = await app.inject({
      method: 'POST',
      url: '/auth/invite/redeem',
      payload: { code, email: ownerEmail, password: `pw-${uniqueSuffix()}`, name: 'Dueña' },
    });
    expect(redeemed.statusCode).toBe(200);
    const newOwner: Credentials = { token: redeemed.json<{ token: string }>().token, cookie: '' };

    const owner = await me(newOwner);
    expect(owner.memberships).toEqual([
      expect.objectContaining({
        organization: expect.objectContaining({ id: orgId, suspended: false }),
        roleKeys: ['owner'],
        features: ['example', 'advanced_insights'],
      }),
    ]);
    // The modules enabled at creation work from the start.
    const notes = await inOrg(newOwner, orgId, { method: 'GET', url: '/notes' });
    expect(notes.statusCode).toBe(200);
    expect(notes.json()).toEqual({ items: [], nextCursor: null });

    // With an owner, the console can no longer hand out ownership.
    const blocked = await platform(admin, {
      method: 'POST',
      url: `/organizations/${orgId}/owner-invitations`,
      payload: { email: 'otro@platform.test.invalid' },
    });
    expect(blocked.statusCode).toBe(409);
  });
});
