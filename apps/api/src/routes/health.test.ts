import { closeDb } from '@vime/db';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp } from '../testing/helpers';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp();
});

afterAll(async () => {
  await app.close();
  await closeDb();
});

describe('health', () => {
  it('reports liveness and database readiness without authentication', async () => {
    for (const url of ['/health', '/health/ready']) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: 'ok' });
      expect(response.headers['x-request-id']).toEqual(expect.any(String));
    }
  });

  it('sends security headers and CORS for the web origin only', async () => {
    const web = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'http://localhost:5173' },
    });
    expect(web.headers['x-content-type-options']).toBe('nosniff');
    expect(web.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(web.headers['access-control-allow-credentials']).toBe('true');

    const preflight = await app.inject({
      method: 'OPTIONS',
      url: '/v1/me',
      headers: {
        origin: 'http://localhost:5173',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'idempotency-key,content-type',
      },
    });
    expect(preflight.statusCode).toBe(204);
    expect(String(preflight.headers['access-control-allow-headers'])).toContain('idempotency-key');

    const foreign = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'https://evil.example' },
    });
    expect(foreign.headers['access-control-allow-origin']).toBeUndefined();
  });
});
