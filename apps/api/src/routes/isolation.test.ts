import { closeDb } from '@vime/db';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bearer,
  buildTestApp,
  createOrg,
  createUser,
  signIn,
  type Credentials,
} from '../testing/helpers';

/*
 * Two-tenant isolation for every route group (CLAUDE.md rule 10). Two organizations with the same
 * kinds of data; the owner of A (who has every permission in A) must not see or touch anything of
 * B, whether by addressing B's organization or by sending B's ids under A's path. A new route
 * group adds its rows to `Seeded`, its requests to `routes` and its id routes to `byId`: the two
 * completeness checks fail until it does.
 */

interface Seeded {
  orgId: string;
  credentials: Credentials;
  membershipId: string;
  invitationId: string;
  noteId: string;
}

let app: FastifyInstance;
let a: Seeded;
let b: Seeded;

async function call(credentials: Credentials, options: InjectOptions) {
  return app.inject({ ...options, headers: { ...bearer(credentials), ...options.headers } });
}

async function seedTenant(label: string): Promise<Seeded> {
  const owner = await createUser(app, `Owner ${label}`);
  const orgId = await createOrg(owner.id, { name: `Tenant ${label}` });
  const credentials = await signIn(app, owner);
  const post = async (url: string, payload: unknown) => {
    const response = await call(credentials, {
      method: 'POST',
      url: `/v1/orgs/${orgId}${url}`,
      payload: payload as InjectOptions['payload'],
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json<{ id: string }>().id;
  };
  const invitationId = await post('/invitations', { roleKeys: ['member'] });
  const noteId = await post('/notes', { title: `Nota ${label}`, body: `Secreto ${label}` });
  const members = await call(credentials, { method: 'GET', url: `/v1/orgs/${orgId}/members` });
  const membershipId = members.json<{ items: { id: string }[] }>().items[0]?.id ?? '';
  return { orgId, credentials, membershipId, invitationId, noteId };
}

/** Every organization route, addressed at `orgId` with `target`'s ids (valid bodies). */
function routes(orgId: string, target: Seeded): Array<[string, InjectOptions]> {
  const base = `/v1/orgs/${orgId}`;
  return [
    ['organization: get', { method: 'GET', url: base }],
    ['organization: patch', { method: 'PATCH', url: base, payload: { name: 'Hijacked' } }],
    ['members: list', { method: 'GET', url: `${base}/members` }],
    [
      'members: patch',
      {
        method: 'PATCH',
        url: `${base}/members/${target.membershipId}`,
        payload: { roleKeys: ['member'] },
      },
    ],
    ['invitations: list', { method: 'GET', url: `${base}/invitations` }],
    [
      'invitations: create',
      { method: 'POST', url: `${base}/invitations`, payload: { roleKeys: ['member'] } },
    ],
    [
      'invitations: revoke',
      { method: 'DELETE', url: `${base}/invitations/${target.invitationId}` },
    ],
    ['activity: list', { method: 'GET', url: `${base}/activity` }],
    ['notes: list', { method: 'GET', url: `${base}/notes` }],
    ['notes: get', { method: 'GET', url: `${base}/notes/${target.noteId}` }],
    ['notes: create', { method: 'POST', url: `${base}/notes`, payload: { title: 'Hijacked' } }],
    [
      'notes: patch',
      { method: 'PATCH', url: `${base}/notes/${target.noteId}`, payload: { title: 'Hijacked' } },
    ],
    ['notes: delete', { method: 'DELETE', url: `${base}/notes/${target.noteId}` }],
  ];
}

/** `METHOD /v1/orgs/{orgId}/...` of every route above, as OpenAPI documents them. */
function routeTemplates(target: Seeded): string[] {
  return routes(target.orgId, target).map(([, options]) => {
    const url = String(options.url)
      .replace(`/v1/orgs/${target.orgId}`, '/v1/orgs/{orgId}')
      .replace(`/members/${target.membershipId}`, '/members/{membershipId}')
      .replace(`/invitations/${target.invitationId}`, '/invitations/{invitationId}')
      .replace(`/notes/${target.noteId}`, '/notes/{noteId}');
    return `${options.method} ${url}`;
  });
}

beforeAll(async () => {
  app = await buildTestApp();
  a = await seedTenant('A');
  b = await seedTenant('B');
});

afterAll(async () => {
  await app.close();
  await closeDb();
});

describe("a member of A addressing B's organization", () => {
  // Route names are known before seeding; the requests are built once B exists.
  const names = routes('', {} as Seeded).map(([name]) => name);

  it.each(names)('%s → 404 not_found', async (routeName) => {
    const [, options] = routes(b.orgId, b).find(([name]) => name === routeName) ?? [];
    if (!options) throw new Error(`no route ${routeName}`);
    const response = await call(a.credentials, options);
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'not_found', status: 404 });
  });

  it('covers every organization route the API documents', async () => {
    const spec = (await app.inject({ method: 'GET', url: '/openapi.json' })).json<{
      paths: Record<string, Record<string, unknown>>;
    }>();
    const documented = Object.entries(spec.paths)
      .filter(([path]) => path.startsWith('/v1/orgs/{orgId}'))
      .flatMap(([path, operations]) =>
        Object.keys(operations).map((method) => `${method.toUpperCase()} ${path}`),
      );
    expect(routeTemplates(b).sort()).toEqual(documented.sort());
  });

  it('gets the same 404 for an organization that does not exist', async () => {
    const response = await call(a.credentials, {
      method: 'GET',
      url: '/v1/orgs/01a10000-0000-7000-8000-000000000000/notes',
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'not_found' });
  });
});

describe("a member of A sending B's ids under A's organization", () => {
  const byId: Array<[string, (target: Seeded) => InjectOptions]> = [
    [
      'members: patch',
      (t) => ({
        method: 'PATCH',
        url: `/v1/orgs/${a.orgId}/members/${t.membershipId}`,
        payload: { roleKeys: ['member'] },
      }),
    ],
    [
      'invitations: revoke',
      (t) => ({ method: 'DELETE', url: `/v1/orgs/${a.orgId}/invitations/${t.invitationId}` }),
    ],
    ['notes: get', (t) => ({ method: 'GET', url: `/v1/orgs/${a.orgId}/notes/${t.noteId}` })],
    [
      'notes: patch',
      (t) => ({
        method: 'PATCH',
        url: `/v1/orgs/${a.orgId}/notes/${t.noteId}`,
        payload: { title: 'Hijacked' },
      }),
    ],
    ['notes: delete', (t) => ({ method: 'DELETE', url: `/v1/orgs/${a.orgId}/notes/${t.noteId}` })],
  ];

  it.each(byId)('%s → 404 not_found', async (_name, build) => {
    const response = await call(a.credentials, build(b));
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'not_found' });
  });

  it('covers every route that takes an entity id', () => {
    const entityIds = [b.membershipId, b.invitationId, b.noteId];
    const needed = routes(b.orgId, b)
      .filter(([, options]) => entityIds.some((id) => String(options.url).includes(id)))
      .map(([name]) => name);
    expect(byId.map(([name]) => name).sort()).toEqual(needed.sort());
  });

  it("lists only A's rows and A's activity", async () => {
    for (const list of ['members', 'invitations', 'notes', 'activity']) {
      const response = await call(a.credentials, {
        method: 'GET',
        url: `/v1/orgs/${a.orgId}/${list}`,
      });
      expect(response.statusCode).toBe(200);
      const body = JSON.stringify(response.json());
      for (const foreign of [b.membershipId, b.invitationId, b.noteId, 'Secreto B']) {
        expect(body).not.toContain(foreign);
      }
    }
    const activity = await call(a.credentials, {
      method: 'GET',
      url: `/v1/orgs/${a.orgId}/activity?entityType=note&entityId=${b.noteId}`,
    });
    expect(activity.json()).toEqual({ items: [], nextCursor: null });
  });

  it("left B's data untouched", async () => {
    const org = await call(b.credentials, { method: 'GET', url: `/v1/orgs/${b.orgId}` });
    expect(org.json()).toMatchObject({ name: 'Tenant B' });
    const note = await call(b.credentials, {
      method: 'GET',
      url: `/v1/orgs/${b.orgId}/notes/${b.noteId}`,
    });
    expect(note.json()).toMatchObject({ title: 'Nota B', body: 'Secreto B' });
    const invitations = await call(b.credentials, {
      method: 'GET',
      url: `/v1/orgs/${b.orgId}/invitations`,
    });
    expect(invitations.json()).toMatchObject({ items: [{ id: b.invitationId, revokedAt: null }] });
    const members = await call(b.credentials, {
      method: 'GET',
      url: `/v1/orgs/${b.orgId}/members`,
    });
    expect(members.json()).toMatchObject({ items: [{ id: b.membershipId, roleKeys: ['owner'] }] });
  });
});
