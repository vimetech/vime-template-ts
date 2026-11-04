import { closeDb } from '@vime/db';
import type { FastifyInstance } from 'fastify';
import type { AddressInfo } from 'node:net';
import { request as httpRequest } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, createUser, type TestUser } from '../testing/helpers';
import { isCanonicalAuthPath } from './routes';

/*
 * A real listening server with raw HTTP requests: app.inject (light-my-request) may normalize the
 * path, and the bug is precisely about paths that reach Better Auth un-normalized.
 */

const SIGN_IN_LIMIT = 3;

let app: FastifyInstance;
let port: number;
let user: TestUser;

interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
}

function raw(method: string, path: string, body?: unknown): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        headers: payload ? { 'content-type': 'application/json' } : {},
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers }));
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

beforeAll(async () => {
  app = await buildTestApp({ rateLimits: { signIn: SIGN_IN_LIMIT } });
  await app.listen({ host: '127.0.0.1', port: 0 });
  port = (app.server.address() as AddressInfo).port;
  user = await createUser(app, 'Path Tester');
});

afterAll(async () => {
  await app.close();
  await closeDb();
});

describe('isCanonicalAuthPath', () => {
  const base = 'http://localhost:4000';

  it('accepts canonical paths, with or without a query string', () => {
    expect(isCanonicalAuthPath('/auth/get-session', base)).toBe(true);
    expect(isCanonicalAuthPath('/auth/get-session?disableCookieCache=true', base)).toBe(true);
  });

  it('rejects paths that URL normalization would change', () => {
    for (const path of [
      '/auth/./sign-in/email',
      '/auth/x/../sign-in/email',
      '/auth/%2e/sign-in/email',
      '/auth/x/%2E%2E/invite/redeem',
      '/auth/x\\..\\invite/redeem',
      '/auth/sign-in/./email',
    ]) {
      expect(isCanonicalAuthPath(path, base), path).toBe(false);
    }
  });
});

describe('/auth/* on a real server', () => {
  it('answers 404 to non-canonical paths instead of reaching Better Auth', async () => {
    const credentials = { email: user.email, password: user.password };
    for (const path of [
      '/auth/./sign-in/email',
      '/auth/%2e/sign-in/email',
      '/auth/x/%2E%2E/sign-in/email',
      '/auth/x\\..\\sign-in/email',
      '/auth/sign-in/./email',
    ]) {
      const response = await raw('POST', path, credentials);
      expect(response.status, path).toBe(404);
      expect(response.headers['set-auth-token'], path).toBeUndefined();
    }
    for (const path of ['/auth/./invite/redeem', '/auth/x\\..\\invite/redeem']) {
      expect((await raw('POST', path, { code: 'ABCD-EFGH' })).status, path).toBe(404);
    }
    // Canonical paths through the wildcard still work.
    expect((await raw('GET', '/auth/ok')).status).toBe(200);
  });

  it('keeps the strict sign-in budget: no detour around it once exhausted', async () => {
    const wrong = { email: user.email, password: 'wrong-password' };
    const statuses: number[] = [];
    for (let attempt = 0; attempt <= SIGN_IN_LIMIT; attempt += 1) {
      statuses.push((await raw('POST', '/auth/sign-in/email', wrong)).status);
    }
    expect(statuses).toEqual([...Array<number>(SIGN_IN_LIMIT).fill(401), 429]);
    const detour = await raw('POST', '/auth/./sign-in/email', {
      email: user.email,
      password: user.password,
    });
    expect(detour.status).toBe(404);
    expect(detour.headers['set-auth-token']).toBeUndefined();
  });
});
