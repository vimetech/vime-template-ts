import { permissionsForRoles, type Permission } from '@vime/contracts';
import { closeDb, withSystem } from '@vime/db';
import { setEntitlement, systemActor } from '@vime/platform';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addMember,
  bearer,
  buildTestApp,
  createOrg,
  createUser,
  signIn,
  type Credentials,
} from '../testing/helpers';
import {
  requireAuth,
  requireFeature,
  requirePermission,
  resolveMembership,
} from './request-context';

let app: FastifyInstance;
let orgId: string;
let owner: Credentials;
let manager: Credentials;
let member: Credentials;
let outsider: Credentials;

type InjectPayload = InjectOptions['payload'];

beforeAll(async () => {
  app = await buildTestApp();
  // Test-only routes behind the same hooks as /v1/orgs/:orgId (registered before the app is ready).
  await app.register(async (scope) => {
    scope.addHook('preValidation', requireAuth);
    scope.addHook('preHandler', resolveMembership);
    scope.get(
      '/test/orgs/:orgId/insights',
      { preHandler: requireFeature('advanced_insights') },
      async () => ({ ok: true }),
    );
    scope.get(
      '/test/orgs/:orgId/example-writes',
      { preHandler: [requireFeature('example'), requirePermission('note.write')] },
      async () => ({ ok: true }),
    );
  });

  const ownerUser = await createUser(app, 'Owner');
  orgId = await createOrg(ownerUser.id, { name: 'Guards Org' });
  owner = await signIn(app, ownerUser);

  const managerUser = await createUser(app, 'Manager');
  await addMember(orgId, managerUser.id, ['manager']);
  manager = await signIn(app, managerUser);

  const memberUser = await createUser(app, 'Member');
  await addMember(orgId, memberUser.id, ['member']);
  member = await signIn(app, memberUser);

  const outsiderUser = await createUser(app, 'Outsider');
  await createOrg(outsiderUser.id, { name: 'Outsider Org' });
  outsider = await signIn(app, outsiderUser);
});

afterAll(async () => {
  await app.close();
  await closeDb();
});

describe('requirePermission', () => {
  it('gives a member 403 forbidden on POST /notes (no note.write)', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/v1/orgs/${orgId}/notes`,
      headers: bearer(member),
      payload: { title: 'Nope' },
    });
    expect(response.statusCode).toBe(403);
    expect(response.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(response.json()).toMatchObject({
      code: 'forbidden',
      status: 403,
      details: { permission: 'note.write' },
    });
  });

  it('lets a member read the organization and the notes (note.read)', async () => {
    const org = await app.inject({
      method: 'GET',
      url: `/v1/orgs/${orgId}`,
      headers: bearer(member),
    });
    expect(org.statusCode).toBe(200);
    const notes = await app.inject({
      method: 'GET',
      url: `/v1/orgs/${orgId}/notes`,
      headers: bearer(member),
    });
    expect(notes.statusCode).toBe(200);
  });

  it('lets a manager write notes and manage members but not the organization', async () => {
    const create = await app.inject({
      method: 'POST',
      url: `/v1/orgs/${orgId}/notes`,
      headers: bearer(manager),
      payload: { title: 'Desde el manager' },
    });
    expect(create.statusCode).toBe(201);
    const members = await app.inject({
      method: 'GET',
      url: `/v1/orgs/${orgId}/members`,
      headers: bearer(manager),
    });
    expect(members.statusCode).toBe(200);
    const patch = await app.inject({
      method: 'PATCH',
      url: `/v1/orgs/${orgId}`,
      headers: bearer(manager),
      payload: { name: 'Nope' },
    });
    expect(patch.statusCode).toBe(403);
  });

  it('takes role changes into account on the next request (membership cache invalidated)', async () => {
    const user = await createUser(app, 'Promoted');
    const membershipId = await addMember(orgId, user.id, ['member']);
    const credentials = await signIn(app, user);
    const before = await app.inject({
      method: 'POST',
      url: `/v1/orgs/${orgId}/notes`,
      headers: bearer(credentials),
      payload: { title: 'Antes' },
    });
    expect(before.statusCode).toBe(403);

    const promote = await app.inject({
      method: 'PATCH',
      url: `/v1/orgs/${orgId}/members/${membershipId}`,
      headers: bearer(owner),
      payload: { roleKeys: ['manager'] },
    });
    expect(promote.statusCode).toBe(200);
    expect(promote.json()).toMatchObject({ id: membershipId, roleKeys: ['manager'] });

    const after = await app.inject({
      method: 'POST',
      url: `/v1/orgs/${orgId}/notes`,
      headers: bearer(credentials),
      payload: { title: 'Después' },
    });
    expect(after.statusCode).toBe(201);
  });

  it('prevents privilege escalation: a manager cannot invite owners', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/v1/orgs/${orgId}/invitations`,
      headers: bearer(manager),
      payload: { roleKeys: ['owner'] },
    });
    expect(response.statusCode).toBe(403);
  });
});

describe('membership resolution', () => {
  it('gives a signed-in non-member 404 (the organization is not revealed)', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/v1/orgs/${orgId}`,
      headers: bearer(outsider),
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'not_found' });
  });

  it('validates the organization id', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/orgs/not-a-uuid/notes',
      headers: bearer(owner),
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ errors: [{ path: 'params.orgId' }] });
  });
});

describe('requireFeature', () => {
  it('answers 403 feature_not_enabled while the entitlement is off', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/test/orgs/${orgId}/insights`,
      headers: bearer(owner),
    });
    expect(response.statusCode).toBe(403);
    expect(response.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(response.json()).toMatchObject({
      code: 'feature_not_enabled',
      status: 403,
      details: { feature: 'advanced_insights' },
    });
  });

  it('lets the request through once enabled, and blocks it again after valid_until', async () => {
    await withSystem((tx) =>
      setEntitlement(tx, systemActor(orgId), { featureKey: 'advanced_insights', enabled: true }),
    );
    const enabled = await app.inject({
      method: 'GET',
      url: `/test/orgs/${orgId}/insights`,
      headers: bearer(owner),
    });
    expect(enabled.statusCode).toBe(200);

    await withSystem((tx) =>
      setEntitlement(tx, systemActor(orgId), {
        featureKey: 'advanced_insights',
        enabled: true,
        validUntil: new Date(Date.now() - 60_000),
      }),
    );
    const expired = await app.inject({
      method: 'GET',
      url: `/test/orgs/${orgId}/insights`,
      headers: bearer(owner),
    });
    expect(expired.statusCode).toBe(403);
    expect(expired.json()).toMatchObject({ code: 'feature_not_enabled' });
  });

  it('needs both the feature and the permission', async () => {
    const asOwner = await app.inject({
      method: 'GET',
      url: `/test/orgs/${orgId}/example-writes`,
      headers: bearer(owner),
    });
    expect(asOwner.statusCode).toBe(200);
    const asMember = await app.inject({
      method: 'GET',
      url: `/test/orgs/${orgId}/example-writes`,
      headers: bearer(member),
    });
    expect(asMember.statusCode).toBe(403);
    expect(asMember.json()).toMatchObject({ code: 'forbidden' });
  });

  it('still resolves membership first (non-member → 404)', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/test/orgs/${orgId}/insights`,
      headers: bearer(outsider),
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('cookie-authenticated mutations (CSRF)', () => {
  it('rejects a foreign Origin and accepts the web app origin', async () => {
    const foreign = await app.inject({
      method: 'POST',
      url: `/v1/orgs/${orgId}/notes`,
      headers: { cookie: owner.cookie, origin: 'https://evil.example' },
      payload: { title: 'CSRF' },
    });
    expect(foreign.statusCode).toBe(403);
    expect(foreign.json()).toMatchObject({ code: 'forbidden' });

    const web = await app.inject({
      method: 'POST',
      url: `/v1/orgs/${orgId}/notes`,
      headers: { cookie: owner.cookie, origin: 'http://localhost:5173' },
      payload: { title: 'Desde la web' },
    });
    expect(web.statusCode).toBe(201);
  });
});

/*
 * Every guarded route of /v1/orgs/:orgId, with the permission its guard requires. Ids are random:
 * the guard runs before the handler. Bodies are valid, since validation runs before the guard.
 * The test asserts `details.permission`, which only the requirePermission guard sets (a service's
 * own escalation check answers 403 with `details.missingPermission` instead), so removing a guard
 * fails it even where the service would still refuse. A new route must be added to the table.
 */
const anyId = '0190f0f0-0000-7000-8000-000000000001';
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
/** One permission (requirePermission), or several (requireAnyPermission: any of them). */
type Guard = Permission | Permission[];
const GUARDED: [Guard, Method, string, unknown?, Record<string, string>?][] = [
  ['org.manage', 'PATCH', '', { name: 'Nope' }],
  ['member.manage', 'GET', '/members'],
  ['member.manage', 'PATCH', `/members/${anyId}`, { roleKeys: ['member'] }],
  ['member.manage', 'GET', '/invitations'],
  ['member.manage', 'POST', '/invitations', { roleKeys: ['member'] }],
  ['member.manage', 'DELETE', `/invitations/${anyId}`],
  ['audit.read', 'GET', '/activity'],
  // The example module.
  ['note.read', 'GET', '/notes'],
  ['note.read', 'GET', `/notes/${anyId}`],
  ['note.write', 'POST', '/notes', { title: 'Nope' }],
  ['note.write', 'PATCH', `/notes/${anyId}`, { title: 'Nope' }],
  ['note.write', 'DELETE', `/notes/${anyId}`],
];
/** Routes open to every member of the organization (no permission guard). */
const ANY_MEMBER = ['GET '];

/** The problem `details` of a denial by `guard`. */
function deniedDetails(guard: Guard): Record<string, unknown> {
  return Array.isArray(guard) ? { requiredAnyOf: guard } : { permission: guard };
}

describe('RBAC denials', () => {
  describe.each(['member', 'manager'] as const)('as a %s', (role) => {
    const granted = permissionsForRoles([role]);
    const denied = GUARDED.filter(([guard]) =>
      (Array.isArray(guard) ? guard : [guard]).every((permission) => !granted.has(permission)),
    );

    it.each(denied)('%s guards %s %s', async (guard, method, path, payload, headers) => {
      const credentials = { member, manager }[role];
      const response = await app.inject({
        method,
        url: `/v1/orgs/${orgId}${path}`,
        headers: { ...bearer(credentials), ...headers },
        ...(payload === undefined ? {} : { payload: payload as InjectPayload }),
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ code: 'forbidden', details: deniedDetails(guard) });
    });
  });

  it('covers every organization route (a new route must be added to the table)', async () => {
    const spec = (await app.inject({ method: 'GET', url: '/openapi.json' })).json<{
      paths: Record<string, Record<string, unknown>>;
    }>();
    const prefix = '/v1/orgs/{orgId}';
    const documented = Object.entries(spec.paths)
      .filter(([path]) => path.startsWith(prefix))
      .flatMap(([path, operations]) =>
        Object.keys(operations).map(
          (method) => `${method.toUpperCase()} ${path.slice(prefix.length)}`,
        ),
      );
    const tabled = [
      ...GUARDED.map(([, method, path]) => {
        const route = (path.split('?')[0] ?? path).replaceAll(anyId, '{id}');
        return `${method} ${route}`;
      }),
      ...ANY_MEMBER,
    ];
    const normalized = documented.map((route) => route.replace(/\{[A-Za-z]+Id\}/g, '{id}'));
    expect(normalized.sort()).toEqual(tabled.sort());
  });
});
