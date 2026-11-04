import { ProblemDetailsSchema } from '@vime/contracts';
import { closeDb } from '@vime/db';
import { ConflictError, DomainError, PreconditionFailedError, ValidationError } from '@vime/kernel';
import type { FastifyInstance } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  bearer,
  buildTestApp,
  createOrg,
  createUser,
  signIn,
  testEnv,
  type Credentials,
  type TestUser,
} from '../testing/helpers';
import { NO_REPORTER, setErrorReporter, type ErrorTags } from './error-reporting';
import { problemForError } from './problem';

let app: FastifyInstance;
let orgId: string;
let user: TestUser;
let credentials: Credentials;

/** A missing note id (UUIDv7-shaped, so it passes params validation). */
const MISSING_NOTE_ID = '01a10000-0000-7000-8000-000000000000';

/** Test-only routes that fail in ways real routes should not. */
const failingRoutes: FastifyPluginAsyncZod = async (scope) => {
  scope.get('/test/boom', async () => {
    throw new Error('connect ECONNREFUSED password=hunter2');
  });
  scope.get(
    '/test/bad-response',
    { schema: { response: { 200: z.object({ id: z.uuid() }) } } },
    async () => ({ id: 'not-a-uuid' }) as { id: string },
  );
  scope.get('/test/precondition', async () => {
    throw new PreconditionFailedError('Checklist incomplete', [
      { key: 'bathroom.towels', reason: 'answer_required' },
    ]);
  });
};

beforeAll(async () => {
  app = await buildTestApp();
  await app.register(failingRoutes);
  user = await createUser(app, 'Problem Tester');
  orgId = await createOrg(user.id, { name: 'Problem Org' });
  credentials = await signIn(app, user);
});

afterAll(async () => {
  await app.close();
  await closeDb();
});

describe('problem+json responses', () => {
  it('describe body validation errors with field paths (RFC 9457 shape)', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/v1/orgs/${orgId}/notes`,
      headers: bearer(credentials),
      payload: { title: '' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.headers['content-type']).toBe('application/problem+json; charset=utf-8');
    const problem = ProblemDetailsSchema.parse(response.json());
    expect(problem).toMatchObject({
      type: 'https://errors.vime.ops/validation-failed',
      title: expect.any(String),
      status: 400,
      code: 'validation_failed',
      instance: `/v1/orgs/${orgId}/notes`,
      errors: [{ path: 'title', message: expect.any(String) }],
    });
    expect(problem['requestId']).toBe(response.headers['x-request-id']);
  });

  it('prefix query, params and header paths', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/v1/orgs/${orgId}/notes?limit=0&cursor=`,
      headers: bearer(credentials),
    });
    expect(response.statusCode).toBe(400);
    const paths = response.json<{ errors: { path: string }[] }>().errors.map((e) => e.path);
    expect(paths.sort()).toEqual(['query.cursor', 'query.limit']);
  });

  it('map service validation, conflicts and not found', async () => {
    // A ValidationError thrown by the service (not by the route schema): same shape, no prefix.
    const badCursor = await app.inject({
      method: 'GET',
      url: `/v1/orgs/${orgId}/notes?cursor=not-a-uuid`,
      headers: bearer(credentials),
    });
    expect(badCursor.statusCode).toBe(400);
    expect(badCursor.json()).toMatchObject({
      code: 'validation_failed',
      errors: [{ path: 'cursor', message: expect.any(String) }],
    });

    // A ConflictError from the service: the only owner cannot give up the owner role.
    const members = await app.inject({
      method: 'GET',
      url: `/v1/orgs/${orgId}/members`,
      headers: bearer(credentials),
    });
    const membershipId = members.json<{ items: { id: string }[] }>().items[0]?.id;
    const lastOwner = await app.inject({
      method: 'PATCH',
      url: `/v1/orgs/${orgId}/members/${membershipId}`,
      headers: bearer(credentials),
      payload: { roleKeys: ['member'] },
    });
    expect(lastOwner.statusCode).toBe(409);
    expect(lastOwner.json()).toMatchObject({
      code: 'conflict',
      detail: expect.stringContaining('owner'),
    });

    const missing = await app.inject({
      method: 'GET',
      url: `/v1/orgs/${orgId}/notes/${MISSING_NOTE_ID}`,
      headers: bearer(credentials),
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ code: 'not_found', details: { entity: 'note' } });
  });

  it('cover malformed JSON, unsupported media types and unknown routes', async () => {
    const malformed = await app.inject({
      method: 'POST',
      url: `/v1/orgs/${orgId}/notes`,
      headers: { ...bearer(credentials), 'content-type': 'application/json' },
      payload: '{"title":',
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toMatchObject({ code: 'validation_failed' });

    const xml = await app.inject({
      method: 'POST',
      url: `/v1/orgs/${orgId}/notes`,
      headers: { ...bearer(credentials), 'content-type': 'application/xml' },
      payload: '<note/>',
    });
    expect(xml.statusCode).toBe(415);
    expect(xml.headers['content-type']).toMatch(/^application\/problem\+json/);

    const unknown = await app.inject({ method: 'GET', url: '/v1/nothing-here' });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toMatchObject({
      code: 'not_found',
      type: 'https://errors.vime.ops/not-found',
    });
  });

  it('never leak internals on 500', async () => {
    for (const url of ['/test/boom', '/test/bad-response']) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(500);
      expect(response.body).not.toContain('hunter2');
      expect(response.body).not.toContain('ECONNREFUSED');
      expect(response.body).not.toContain('not-a-uuid');
      expect(response.json()).toMatchObject({
        code: 'internal',
        status: 500,
        requestId: expect.any(String),
      });
    }
  });

  it('report 500s to the error reporter with their tags, never 4xx', async () => {
    const captured: Array<{ error: unknown; tags: ErrorTags | undefined }> = [];
    setErrorReporter({
      enabled: true,
      capture: (error, tags) => captured.push({ error, tags }),
      flush: () => Promise.resolve(true),
    });
    try {
      const boom = await app.inject({ method: 'GET', url: '/test/boom' });
      await app.inject({ method: 'GET', url: '/test/precondition' });
      await app.inject({ method: 'GET', url: '/v1/orgs/not-a-uuid/notes' });
      expect(captured).toHaveLength(1);
      expect(captured[0]?.error).toBeInstanceOf(Error);
      expect(captured[0]?.tags).toEqual({
        method: 'GET',
        route: '/test/boom',
        request_id: boom.json<{ requestId: string }>().requestId,
        org_id: undefined,
      });
    } finally {
      setErrorReporter(NO_REPORTER);
    }
  });

  it('carry the unmet requirements of a precondition failure (422)', async () => {
    const response = await app.inject({ method: 'GET', url: '/test/precondition' });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      code: 'precondition_failed',
      missing: [{ key: 'bathroom.towels', reason: 'answer_required' }],
    });
  });
});

describe('problemForError', () => {
  it('maps deadlocks and serialization failures to a retryable 409, not a 500', () => {
    for (const code of ['40P01', '40001']) {
      const driverError = Object.assign(new Error('deadlock detected'), { code });
      const wrapped = new Error('Failed query', { cause: driverError });
      expect(problemForError(wrapped)).toMatchObject({
        code: 'conflict',
        status: 409,
        internal: false,
      });
    }
    expect(problemForError(Object.assign(new Error('x'), { code: '23505' }))).toMatchObject({
      code: 'internal',
      status: 500,
    });
  });

  it('maps domain errors by code, and unknown module codes to 422', () => {
    expect(problemForError(new ConflictError('x'))).toMatchObject({
      code: 'conflict',
      status: 409,
    });
    expect(problemForError(new ValidationError([{ path: 'a.b', message: 'bad' }]))).toMatchObject({
      status: 400,
      errors: [{ path: 'a.b', message: 'bad' }],
    });
    expect(problemForError(new DomainError('task_not_startable', 'Not yet'))).toMatchObject({
      code: 'task_not_startable',
      status: 422,
      internal: false,
    });
    expect(problemForError(new TypeError('boom'))).toMatchObject({
      code: 'internal',
      internal: true,
    });
  });
});

describe('request ids', () => {
  it('echo a safe incoming X-Request-Id and replace an unsafe one', async () => {
    const kept = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-request-id': 'edge-123.abc' },
    });
    expect(kept.headers['x-request-id']).toBe('edge-123.abc');
    const replaced = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-request-id': 'bad id\nwith newline' },
    });
    expect(replaced.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('rate limits', () => {
  it('answer 429 rate_limited with Retry-After, stricter on sign-in', async () => {
    const limited = await buildTestApp({ rateLimits: { signIn: 2, global: 5 } });
    try {
      const attempt = () =>
        limited.inject({
          method: 'POST',
          url: '/auth/sign-in/email',
          payload: { email: user.email, password: 'wrong-password' },
        });
      expect((await attempt()).statusCode).toBe(401);
      expect((await attempt()).statusCode).toBe(401);
      const blocked = await attempt();
      expect(blocked.statusCode).toBe(429);
      expect(blocked.headers['retry-after']).toEqual(expect.any(String));
      expect(blocked.headers['content-type']).toMatch(/^application\/problem\+json/);
      expect(blocked.json()).toMatchObject({ code: 'rate_limited', status: 429 });

      // The global budget applies to every other route (health is exempt).
      const statuses: number[] = [];
      for (let i = 0; i < 6; i += 1) {
        statuses.push((await limited.inject({ method: 'GET', url: '/v1/me' })).statusCode);
      }
      expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
      expect(statuses[5]).toBe(429);
      expect((await limited.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    } finally {
      await limited.close();
    }
  });

  it('takes the global budget from RATE_LIMIT_GLOBAL', async () => {
    const limited = await buildTestApp({
      env: testEnv({ RATE_LIMIT_GLOBAL: '2' }),
      rateLimits: { auth: 100, signIn: 100 },
    });
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 3; i += 1) {
        statuses.push((await limited.inject({ method: 'GET', url: '/v1/me' })).statusCode);
      }
      expect(statuses).toEqual([401, 401, 429]);
    } finally {
      await limited.close();
    }
  });
});
