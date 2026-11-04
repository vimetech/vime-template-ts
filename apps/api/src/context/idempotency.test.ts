import { closeDb } from '@vime/db';
import { newId } from '@vime/kernel';
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
} from '../testing/helpers';

/*
 * Idempotency-Key on the mutations under /v1/orgs/:orgId, exercised through the example module
 * (notes): every domain module's routes go through the same `mutate()`.
 */

let app: FastifyInstance;
let orgId: string;
let owner: Credentials;
let manager: Credentials;

function createNote(
  credentials: Credentials,
  key: string | undefined,
  body: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
) {
  return app.inject({
    method: 'POST',
    url: `/v1/orgs/${orgId}/notes`,
    headers: {
      ...bearer(credentials),
      ...(key ? { 'idempotency-key': key } : {}),
      ...extraHeaders,
    },
    payload: body,
  });
}

async function countByTitle(title: string): Promise<number> {
  const response = await app.inject({
    method: 'GET',
    url: `/v1/orgs/${orgId}/notes?limit=200`,
    headers: bearer(owner),
  });
  return response.json<{ items: { title: string }[] }>().items.filter((n) => n.title === title)
    .length;
}

beforeAll(async () => {
  app = await buildTestApp();
  const ownerUser = await createUser(app, 'Owner');
  orgId = await createOrg(ownerUser.id, { name: 'Idempotency Org' });
  owner = await signIn(app, ownerUser);
  const managerUser = await createUser(app, 'Manager');
  await addMember(orgId, managerUser.id, ['manager']);
  manager = await signIn(app, managerUser);
});

afterAll(async () => {
  await app.close();
  await closeDb();
});

describe('Idempotency-Key', () => {
  it('replays the stored response for an identical retry and creates nothing new', async () => {
    const key = newId();
    const body = { title: 'IDEM-1', body: 'Nota idempotente' };
    const first = await createNote(owner, key, body);
    expect(first.statusCode).toBe(201);
    expect(first.headers['idempotent-replayed']).toBeUndefined();

    const retry = await createNote(owner, key, body);
    expect(retry.statusCode).toBe(201);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(retry.body).toBe(first.body);
    expect(await countByTitle('IDEM-1')).toBe(1);
  });

  it('answers 409 idempotency_conflict for the same key with a different body or route', async () => {
    const key = newId();
    const created = await createNote(owner, key, { title: 'IDEM-2', body: 'Uno' });
    expect(created.statusCode).toBe(201);
    const noteId = created.json<{ id: string }>().id;

    const otherBody = await createNote(owner, key, { title: 'IDEM-2', body: 'Otro' });
    expect(otherBody.statusCode).toBe(409);
    expect(otherBody.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(otherBody.json()).toMatchObject({ code: 'idempotency_conflict', status: 409 });

    const otherRoute = await app.inject({
      method: 'PATCH',
      url: `/v1/orgs/${orgId}/notes/${noteId}`,
      headers: { ...bearer(owner), 'idempotency-key': key },
      payload: { title: 'IDEM-2', body: 'Uno' },
    });
    expect(otherRoute.statusCode).toBe(409);
    expect(otherRoute.json()).toMatchObject({ code: 'idempotency_conflict' });
    expect(await countByTitle('IDEM-2')).toBe(1);
  });

  it('serializes concurrent identical requests: one runs, the other replays it', async () => {
    const key = newId();
    const body = { title: 'IDEM-3', body: 'Concurrente' };
    const [one, two] = await Promise.all([
      createNote(owner, key, body),
      createNote(owner, key, body),
    ]);
    expect([one.statusCode, two.statusCode]).toEqual([201, 201]);
    expect(one.body).toBe(two.body);
    expect(await countByTitle('IDEM-3')).toBe(1);
  });

  it('does not keep the key of a failed mutation, so the client can retry', async () => {
    const key = newId();
    // A mutation that fails inside the transaction (404 from the service) rolls back its key.
    const failed = await app.inject({
      method: 'PATCH',
      url: `/v1/orgs/${orgId}/notes/01a10000-0000-7000-8000-000000000000`,
      headers: { ...bearer(owner), 'idempotency-key': key },
      payload: { title: 'No existe' },
    });
    expect(failed.statusCode).toBe(404);
    expect(failed.json()).toMatchObject({ code: 'not_found' });

    // The same key on another request is a fresh request, not a conflict or a replay.
    const fixed = await createNote(owner, key, { title: 'IDEM-5', body: 'Corregido' });
    expect(fixed.statusCode).toBe(201);
    expect(fixed.headers['idempotent-replayed']).toBeUndefined();
  });

  it('scopes keys per actor (user)', async () => {
    const key = newId();
    expect((await createNote(owner, key, { title: 'IDEM-6', body: 'Owner' })).statusCode).toBe(201);
    // Same key from another user: their own request, not a replay or a conflict.
    const other = await createNote(manager, key, { title: 'IDEM-7', body: 'Manager' });
    expect(other.statusCode).toBe(201);
    expect(other.headers['idempotent-replayed']).toBeUndefined();
    expect(await countByTitle('IDEM-6')).toBe(1);
    expect(await countByTitle('IDEM-7')).toBe(1);
  });

  it('records the key on the audit event', async () => {
    const key = newId();
    const created = await createNote(owner, key, { title: 'IDEM-9', body: 'Auditada' });
    const noteId = created.json<{ id: string }>().id;
    const activity = await app.inject({
      method: 'GET',
      url: `/v1/orgs/${orgId}/activity?entityType=note&entityId=${noteId}`,
      headers: bearer(owner),
    });
    expect(activity.json()).toMatchObject({
      items: [{ eventType: 'note.created', idempotencyKey: key, requestId: expect.any(String) }],
    });
  });

  it('works for PATCH and DELETE', async () => {
    const created = await createNote(owner, undefined, { title: 'IDEM-PATCH', body: 'Antes' });
    const noteId = created.json<{ id: string }>().id;

    const patchKey = newId();
    const patch = () =>
      app.inject({
        method: 'PATCH',
        url: `/v1/orgs/${orgId}/notes/${noteId}`,
        headers: { ...bearer(owner), 'idempotency-key': patchKey },
        payload: { title: 'IDEM-PATCH renombrada' },
      });
    const first = await patch();
    const again = await patch();
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ title: 'IDEM-PATCH renombrada' });
    expect(again.statusCode).toBe(200);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.body).toBe(first.body);

    const deleteKey = newId();
    const remove = () =>
      app.inject({
        method: 'DELETE',
        url: `/v1/orgs/${orgId}/notes/${noteId}`,
        headers: { ...bearer(owner), 'idempotency-key': deleteKey },
      });
    const deleted = await remove();
    expect(deleted.statusCode).toBe(204);
    // The retry replays the 204 instead of answering 404 for the note that is already gone.
    const replayed = await remove();
    expect(replayed.statusCode).toBe(204);
    expect(replayed.headers['idempotent-replayed']).toBe('true');
    expect(await countByTitle('IDEM-PATCH renombrada')).toBe(0);
  });

  it('rejects a key that is not a UUID', async () => {
    const response = await createNote(owner, 'not-a-uuid', { title: 'IDEM-X', body: 'X' });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      code: 'validation_failed',
      errors: [{ path: 'headers.idempotency-key' }],
    });
  });
});
