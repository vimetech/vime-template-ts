import { closeDb, withSystem, withTenant, type Tx } from '@vime/db';
import { ConflictError, NotFoundError, newId } from '@vime/kernel';
import { and, eq } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IdempotencyConflictError, IdempotencyInProgressError } from './errors';
import {
  beginIdempotentRequest,
  completeIdempotentRequest,
  computeRequestHash,
  idempotencyActorKey,
  lookupIdempotentRequest,
  purgeIdempotencyKeys,
} from './idempotency';
import { idempotencyKeys } from './schema';
import { createTestOrg } from './testing/fixtures';

const KEY = 'test-request-hash-key-of-at-least-32-bytes';

afterAll(async () => {
  await closeDb();
});

describe('computeRequestHash', () => {
  it('ignores object key order and method case, but not values, paths or array order', () => {
    const base = computeRequestHash(
      { method: 'post', path: '/v1/x', body: { a: 1, b: { c: 2 } } },
      KEY,
    );
    expect(
      computeRequestHash({ method: 'POST', path: '/v1/x', body: { b: { c: 2 }, a: 1 } }, KEY),
    ).toBe(base);
    expect(
      computeRequestHash({ method: 'POST', path: '/v1/x', body: { a: 2, b: { c: 2 } } }, KEY),
    ).not.toBe(base);
    expect(
      computeRequestHash({ method: 'POST', path: '/v1/y', body: { a: 1, b: { c: 2 } } }, KEY),
    ).not.toBe(base);
    expect(computeRequestHash({ method: 'POST', path: '/v1/x', body: [1, 2] }, KEY)).not.toBe(
      computeRequestHash({ method: 'POST', path: '/v1/x', body: [2, 1] }, KEY),
    );
  });

  it('is keyed: not a plain SHA-256 of the request, different per key, and needs a long key', () => {
    const request = { method: 'PUT', path: '/v1/x/access', body: { doorCode: '4821' } };
    const hash = computeRequestHash(request, KEY);
    const plain = createHash('sha256')
      .update(JSON.stringify(['PUT', '/v1/x/access', { doorCode: '4821' }]))
      .digest('hex');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toBe(plain);
    expect(computeRequestHash(request, `${KEY}-other`)).not.toBe(hash);
    expect(() => computeRequestHash(request, 'too-short')).toThrow(TypeError);
  });

  it('builds actor keys from the device first, then the user', () => {
    expect(idempotencyActorKey({ userId: 'u', deviceId: 'd' })).toBe('device:d');
    expect(idempotencyActorKey({ userId: 'u' })).toBe('user:u');
    expect(() => idempotencyActorKey({})).toThrow(TypeError);
  });
});

describe('idempotency keys', () => {
  let orgId: string;
  const actorKey = `user:${newId()}`;
  const hashA = computeRequestHash(
    { method: 'POST', path: '/v1/tasks/1/start', body: { a: 1 } },
    KEY,
  );
  const hashB = computeRequestHash(
    { method: 'POST', path: '/v1/tasks/1/start', body: { a: 2 } },
    KEY,
  );

  beforeAll(async () => {
    orgId = (await createTestOrg()).id;
  });

  function inOrg<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return withTenant({ orgId }, fn);
  }

  it('starts, completes, then replays the same request', async () => {
    const key = newId();
    const begin = await inOrg(async (tx) => {
      const started = await beginIdempotentRequest(tx, orgId, {
        actorKey,
        key,
        requestHash: hashA,
      });
      await completeIdempotentRequest(tx, {
        actorKey,
        key,
        statusCode: 201,
        response: { id: 'task-1', status: 'in_progress' },
      });
      return started;
    });
    expect(begin).toEqual({ status: 'started' });

    const replay = await inOrg((tx) =>
      beginIdempotentRequest(tx, orgId, { actorKey, key, requestHash: hashA }),
    );
    expect(replay).toEqual({
      status: 'replay',
      statusCode: 201,
      response: { id: 'task-1', status: 'in_progress' },
    });
  });

  it('rejects the same key with a different request (409 idempotency_conflict)', async () => {
    const key = newId();
    await inOrg(async (tx) => {
      await beginIdempotentRequest(tx, orgId, { actorKey, key, requestHash: hashA });
      await completeIdempotentRequest(tx, { actorKey, key, statusCode: 200, response: null });
    });
    await expect(
      inOrg((tx) => beginIdempotentRequest(tx, orgId, { actorKey, key, requestHash: hashB })),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it('rejects a retry while the first request is in progress (409 idempotency_in_progress)', async () => {
    const key = newId();
    // Begun in its own committed transaction and never completed.
    await inOrg((tx) => beginIdempotentRequest(tx, orgId, { actorKey, key, requestHash: hashA }));
    await expect(
      inOrg((tx) => beginIdempotentRequest(tx, orgId, { actorKey, key, requestHash: hashA })),
    ).rejects.toBeInstanceOf(IdempotencyInProgressError);
    // A different body is still a conflict, not "in progress".
    await expect(
      inOrg((tx) => beginIdempotentRequest(tx, orgId, { actorKey, key, requestHash: hashB })),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it('a concurrent retry waits for the first transaction and replays its response', async () => {
    const key = newId();
    let releaseFirst!: () => void;
    const firstMayCommit = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstBegun!: () => void;
    const firstHasBegun = new Promise<void>((resolve) => {
      firstBegun = resolve;
    });

    const first = inOrg(async (tx) => {
      const begin = await beginIdempotentRequest(tx, orgId, { actorKey, key, requestHash: hashA });
      firstBegun();
      await firstMayCommit;
      await completeIdempotentRequest(tx, { actorKey, key, statusCode: 201, response: { n: 1 } });
      return begin;
    });
    await firstHasBegun;
    const second = inOrg((tx) =>
      beginIdempotentRequest(tx, orgId, { actorKey, key, requestHash: hashA }),
    );
    // Give the second transaction time to block on the primary key, then let the first commit.
    await new Promise((resolve) => setTimeout(resolve, 200));
    releaseFirst();
    await expect(first).resolves.toEqual({ status: 'started' });
    await expect(second).resolves.toEqual({
      status: 'replay',
      statusCode: 201,
      response: { n: 1 },
    });
  });

  it('a rolled-back first attempt leaves nothing behind', async () => {
    const key = newId();
    await expect(
      inOrg(async (tx) => {
        await beginIdempotentRequest(tx, orgId, { actorKey, key, requestHash: hashA });
        throw new Error('handler failed');
      }),
    ).rejects.toThrow('handler failed');
    await expect(
      inOrg((tx) => beginIdempotentRequest(tx, orgId, { actorKey, key, requestHash: hashA })),
    ).resolves.toEqual({ status: 'started' });
  });

  it('scopes keys per actor and per organization', async () => {
    const key = newId();
    await inOrg((tx) => beginIdempotentRequest(tx, orgId, { actorKey, key, requestHash: hashA }));
    await expect(
      inOrg((tx) =>
        beginIdempotentRequest(tx, orgId, {
          actorKey: `device:${newId()}`,
          key,
          requestHash: hashB,
        }),
      ),
    ).resolves.toEqual({ status: 'started' });
    const otherOrg = (await createTestOrg()).id;
    await expect(
      withTenant({ orgId: otherOrg }, (tx) =>
        beginIdempotentRequest(tx, otherOrg, { actorKey, key, requestHash: hashB }),
      ),
    ).resolves.toEqual({ status: 'started' });
    // The other organization's record is invisible here.
    const mine = await inOrg((tx) => lookupIdempotentRequest(tx, { actorKey, key }));
    expect(mine?.requestHash).toBe(hashA);
  });

  it('completing twice or without beginning fails', async () => {
    const key = newId();
    await expect(
      inOrg((tx) =>
        completeIdempotentRequest(tx, { actorKey, key, statusCode: 200, response: {} }),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    await inOrg(async (tx) => {
      await beginIdempotentRequest(tx, orgId, { actorKey, key, requestHash: hashA });
      await completeIdempotentRequest(tx, { actorKey, key, statusCode: 200, response: {} });
    });
    await expect(
      inOrg((tx) =>
        completeIdempotentRequest(tx, { actorKey, key, statusCode: 200, response: {} }),
      ),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('purges records older than the cutoff', async () => {
    const oldKey = newId();
    const newKey = newId();
    await inOrg(async (tx) => {
      await beginIdempotentRequest(tx, orgId, { actorKey, key: oldKey, requestHash: hashA });
      await beginIdempotentRequest(tx, orgId, { actorKey, key: newKey, requestHash: hashA });
    });
    const longAgo = new Date(Date.now() - 40 * 24 * 3_600_000);
    await withSystem((tx) =>
      tx
        .update(idempotencyKeys)
        .set({ createdAt: longAgo })
        .where(and(eq(idempotencyKeys.organizationId, orgId), eq(idempotencyKeys.key, oldKey))),
    );
    const cutoff = new Date(Date.now() - 30 * 24 * 3_600_000);
    const purged = await inOrg((tx) => purgeIdempotencyKeys(tx, cutoff));
    expect(purged).toBe(1);
    expect(await inOrg((tx) => lookupIdempotentRequest(tx, { actorKey, key: oldKey }))).toBeNull();
    expect(
      await inOrg((tx) => lookupIdempotentRequest(tx, { actorKey, key: newKey })),
    ).not.toBeNull();
  });
});
