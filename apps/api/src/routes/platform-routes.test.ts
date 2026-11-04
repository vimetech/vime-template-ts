import {
  InvitationListItemSchema,
  MemberSchema,
  NoteSchema,
  OrganizationSchema,
} from '@vime/contracts';
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
  type TestUser,
} from '../testing/helpers';

let app: FastifyInstance;
let owner: TestUser;
let credentials: Credentials;
let orgId: string;

function call(options: InjectOptions & { url: string }) {
  return app.inject({
    ...options,
    url: `/v1/orgs/${orgId}${options.url}`,
    headers: { ...bearer(credentials), ...options.headers },
  });
}

beforeAll(async () => {
  app = await buildTestApp();
  owner = await createUser(app, 'Olga Owner');
  orgId = await createOrg(owner.id, { name: 'Routes Org' });
  credentials = await signIn(app, owner);
});

afterAll(async () => {
  await app.close();
  await closeDb();
});

describe('organization', () => {
  it('reads and patches the organization (settings merged)', async () => {
    const before = OrganizationSchema.parse((await call({ method: 'GET', url: '' })).json());
    expect(before.settings).toEqual({ coordinationPhoneE164: null, disabledFunctions: [] });
    const patched = await call({
      method: 'PATCH',
      url: '',
      payload: { name: 'Routes Org SAC', timezone: 'America/Bogota' },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({
      name: 'Routes Org SAC',
      timezone: 'America/Bogota',
      settings: { coordinationPhoneE164: null, disabledFunctions: [] },
    });
    const bad = await call({ method: 'PATCH', url: '', payload: { timezone: 'Mars/Olympus' } });
    expect(bad.statusCode).toBe(400);
  });

  it('keeps the coordination WhatsApp and hands it to the apps through /me', async () => {
    const coordination = async () => {
      const me = await app.inject({ method: 'GET', url: '/v1/me', headers: bearer(credentials) });
      return me
        .json<{
          memberships: { organization: { id: string; coordinationPhoneE164?: unknown } }[];
        }>()
        .memberships.find((m) => m.organization.id === orgId)?.organization.coordinationPhoneE164;
    };
    expect(await coordination()).toBeNull();
    const set = await call({
      method: 'PATCH',
      url: '',
      payload: { settings: { coordinationPhoneE164: '+51987650099' } },
    });
    expect(set.json()).toMatchObject({
      settings: { coordinationPhoneE164: '+51987650099' },
    });
    expect(await coordination()).toBe('+51987650099');
    const bad = await call({
      method: 'PATCH',
      url: '',
      payload: { settings: { coordinationPhoneE164: '987650099' } },
    });
    expect(bad.statusCode).toBe(400);
    await call({
      method: 'PATCH',
      url: '',
      payload: { settings: { coordinationPhoneE164: null } },
    });
    expect(await coordination()).toBeNull();
  });

  it('turns optional functions off and on, and hands the list to the apps through /me', async () => {
    const otherOrgId = await createOrg(owner.id, { name: 'Routes Other Org' });
    const disabled = async (id = orgId) => {
      const me = await app.inject({ method: 'GET', url: '/v1/me', headers: bearer(credentials) });
      return me
        .json<{ memberships: { organization: { id: string; disabledFunctions?: unknown } }[] }>()
        .memberships.find((m) => m.organization.id === id)?.organization.disabledFunctions;
    };
    expect(await disabled()).toEqual([]);
    const off = await call({
      method: 'PATCH',
      url: '',
      payload: { settings: { disabledFunctions: ['example_notes'] } },
    });
    expect(off.statusCode).toBe(200);
    expect(off.json()).toMatchObject({ settings: { disabledFunctions: ['example_notes'] } });
    expect(await disabled()).toEqual(['example_notes']);
    // Another setting leaves the list as it is.
    const kept = await call({
      method: 'PATCH',
      url: '',
      payload: { settings: { coordinationPhoneE164: null } },
    });
    expect(kept.statusCode).toBe(200);
    expect(kept.json()).toMatchObject({ settings: { disabledFunctions: ['example_notes'] } });
    expect(await disabled()).toEqual(['example_notes']);
    // Only this organization: another one of the same owner keeps everything on.
    expect(await disabled(otherOrgId)).toEqual([]);
    for (const bad of [['example'], ['example_notes', 'example_notes'], 'example_notes']) {
      const response = await call({
        method: 'PATCH',
        url: '',
        payload: { settings: { disabledFunctions: bad } },
      });
      expect(response.statusCode).toBe(400);
    }
    await call({ method: 'PATCH', url: '', payload: { settings: { disabledFunctions: [] } } });
    expect(await disabled()).toEqual([]);
  });
});

describe('members and invitations', () => {
  it('lists members with names and emails', async () => {
    const response = await call({ method: 'GET', url: '/members' });
    const items = response.json<{ items: unknown[] }>().items.map((m) => MemberSchema.parse(m));
    expect(items).toEqual([
      expect.objectContaining({
        userId: owner.id,
        name: 'Olga Owner',
        email: owner.email,
        roleKeys: ['owner'],
      }),
    ]);
  });

  it('keeps the last owner (409 when demoting it)', async () => {
    const members = (await call({ method: 'GET', url: '/members' })).json<{
      items: { id: string }[];
    }>();
    const response = await call({
      method: 'PATCH',
      url: `/members/${members.items[0]?.id}`,
      payload: { roleKeys: ['admin'] },
    });
    expect(response.statusCode).toBe(409);
  });

  it('creates, lists (without codes) and revokes invitations', async () => {
    const created = await call({
      method: 'POST',
      url: '/invitations',
      payload: { roleKeys: ['member'] },
    });
    expect(created.statusCode).toBe(201);
    const invitation = created.json<{ id: string; code: string; maxUses: number }>();
    expect(invitation.code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    expect(invitation.maxUses).toBe(1);

    const list = (await call({ method: 'GET', url: '/invitations' })).json<{ items: unknown[] }>();
    const listed = list.items.map((item) => InvitationListItemSchema.parse(item));
    expect(listed.find((item) => item.id === invitation.id)).toBeDefined();
    expect(JSON.stringify(list)).not.toContain(invitation.code);

    const revoked = await call({ method: 'DELETE', url: `/invitations/${invitation.id}` });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json()).toMatchObject({ id: invitation.id, revokedAt: expect.any(String) });
  });
});

describe('notes (the example module)', () => {
  let noteId: string;

  it('creates a note with the contract defaults', async () => {
    const created = await call({
      method: 'POST',
      url: '/notes',
      payload: { title: 'Primera nota' },
    });
    expect(created.statusCode).toBe(201);
    const note = NoteSchema.parse(created.json());
    expect(note).toMatchObject({ title: 'Primera nota', body: '', createdBy: owner.id });
    noteId = note.id;
    const fetched = await call({ method: 'GET', url: `/notes/${noteId}` });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json()).toEqual(note);
    const bad = await call({ method: 'POST', url: '/notes', payload: { title: '' } });
    expect(bad.statusCode).toBe(400);
  });

  it('lists newest first with a cursor, patches and deletes', async () => {
    const second = await call({
      method: 'POST',
      url: '/notes',
      payload: { title: 'Segunda nota', body: 'Con cuerpo' },
    });
    expect(second.statusCode).toBe(201);
    const page = await call({ method: 'GET', url: '/notes?limit=1' });
    const first = page.json<{ items: { id: string }[]; nextCursor: string | null }>();
    expect(first.items.map((n) => n.id)).toEqual([second.json<{ id: string }>().id]);
    expect(first.nextCursor).toBe(first.items[0]?.id);
    const next = await call({ method: 'GET', url: `/notes?limit=1&cursor=${first.nextCursor}` });
    expect(next.json<{ items: { id: string }[] }>().items.map((n) => n.id)).toEqual([noteId]);

    const patched = await call({
      method: 'PATCH',
      url: `/notes/${noteId}`,
      payload: { body: 'Editada' },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({ id: noteId, title: 'Primera nota', body: 'Editada' });

    const removed = await call({ method: 'DELETE', url: `/notes/${noteId}` });
    expect(removed.statusCode).toBe(204);
    expect((await call({ method: 'GET', url: `/notes/${noteId}` })).statusCode).toBe(404);
    const activity = await call({
      method: 'GET',
      url: `/activity?entityType=note&entityId=${noteId}`,
    });
    expect(
      activity.json<{ items: { eventType: string }[] }>().items.map((e) => e.eventType),
    ).toEqual(['note.deleted', 'note.updated', 'note.created']);
  });
});

describe('activity', () => {
  it('pages through events newest first', async () => {
    const first = await call({ method: 'GET', url: '/activity?limit=2' });
    expect(first.statusCode).toBe(200);
    const page1 = first.json<{ items: { id: string }[]; nextCursor: string | null }>();
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).toBe(page1.items[1]?.id);
    const second = await call({
      method: 'GET',
      url: `/activity?limit=2&cursor=${page1.nextCursor}`,
    });
    const page2 = second.json<{ items: { id: string }[] }>();
    expect((page2.items[0]?.id ?? '') < (page1.items[1]?.id ?? '')).toBe(true);

    const invalidLimit = await call({ method: 'GET', url: '/activity?limit=1000' });
    expect(invalidLimit.statusCode).toBe(400);
  });
});
