import { MeResponseSchema, ProblemDetailsSchema } from '@vime/contracts';
import { closeDb } from '@vime/db';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bearer,
  buildTestApp,
  cookieHeader,
  createOrg,
  createUser,
  signIn,
  type TestUser,
} from '../testing/helpers';

let app: FastifyInstance;
let owner: TestUser;
let orgId: string;

beforeAll(async () => {
  app = await buildTestApp();
  owner = await createUser(app, 'Olga Owner');
  orgId = await createOrg(owner.id, { name: 'Auth Test Org' });
});

afterAll(async () => {
  await app.close();
  await closeDb();
});

describe('email + password sign-in', () => {
  it('signs in, sets the session cookie and returns the bearer token', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/sign-in/email',
      payload: { email: owner.email, password: owner.password },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ token: string; user: { id: string; email: string } }>();
    expect(body.user.id).toBe(owner.id);
    expect(body.token).toEqual(expect.any(String));
    expect(response.headers['set-auth-token']).toEqual(expect.any(String));
    expect(cookieHeader(response)).toMatch(/^vime\.session_token=/);
    const setCookie = String(response.headers['set-cookie']);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
  });

  it('GET /v1/me works with the cookie (web) and with the bearer token (mobile)', async () => {
    const credentials = await signIn(app, owner);
    for (const headers of [{ cookie: credentials.cookie }, bearer(credentials)]) {
      const response = await app.inject({ method: 'GET', url: '/v1/me', headers });
      expect(response.statusCode).toBe(200);
      const me = MeResponseSchema.parse(response.json());
      expect(me.user).toEqual({ id: owner.id, name: 'Olga Owner', email: owner.email });
      const membership = me.memberships.find((m) => m.organization.id === orgId);
      expect(membership?.roleKeys).toEqual(['owner']);
      expect(membership?.permissions).toContain('org.manage');
      expect(membership?.organization.timezone).toBe('America/Lima');
    }
  });

  it('rejects a wrong password with a 401 problem (Better Auth code kept as authCode)', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/sign-in/email',
      payload: { email: owner.email, password: 'wrong-password' },
    });
    expect(response.statusCode).toBe(401);
    expect(response.headers['content-type']).toMatch(/^application\/problem\+json/);
    const problem = ProblemDetailsSchema.parse(response.json());
    expect(problem.code).toBe('unauthenticated');
    expect(problem['authCode']).toBe('INVALID_EMAIL_OR_PASSWORD');
    expect(response.headers['set-cookie']).toBeUndefined();
  });

  it('validates the sign-in body before Better Auth (problem+json)', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/sign-in/email',
      payload: { email: 'not-an-email', password: 'x' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      code: 'validation_failed',
      errors: [expect.objectContaining({ path: 'email' })],
    });
  });

  it('has public sign-up disabled', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/sign-up/email',
      payload: { email: `new-${owner.id}@api.test.invalid`, password: 'password-123', name: 'X' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'validation_failed' });
  });

  it('GET /auth/get-session returns the session for a bearer token', async () => {
    const credentials = await signIn(app, owner);
    const response = await app.inject({
      method: 'GET',
      url: '/auth/get-session',
      headers: bearer(credentials),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ user: { id: owner.id } });
  });

  it('sign-out ends the session: the token stops working', async () => {
    const credentials = await signIn(app, owner);
    const signOut = await app.inject({
      method: 'POST',
      url: '/auth/sign-out',
      headers: bearer(credentials),
      payload: {},
    });
    expect(signOut.statusCode).toBe(200);
    const me = await app.inject({ method: 'GET', url: '/v1/me', headers: bearer(credentials) });
    expect(me.statusCode).toBe(401);
  });
});

describe('unauthenticated requests', () => {
  it('get a 401 problem with WWW-Authenticate on /v1 routes', async () => {
    for (const url of ['/v1/me', `/v1/orgs/${orgId}/notes`]) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(401);
      expect(response.headers['www-authenticate']).toBe('Bearer');
      expect(response.json()).toMatchObject({ code: 'unauthenticated', status: 401 });
    }
  });

  it('reject an invalid bearer token', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: bearer('not-a-real-token'),
    });
    expect(response.statusCode).toBe(401);
  });
});
