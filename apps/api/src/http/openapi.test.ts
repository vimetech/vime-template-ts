import { closeDb } from '@vime/db';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp } from '../testing/helpers';

interface Operation {
  tags?: string[];
  security?: unknown[];
  parameters?: { name: string; in: string }[];
  requestBody?: { content: Record<string, unknown> };
  responses: Record<string, unknown>;
}
interface OpenApiDocument {
  openapi: string;
  paths: Record<string, Record<string, Operation>>;
  components: { securitySchemes: Record<string, unknown> };
}

let app: FastifyInstance;
let doc: OpenApiDocument;

beforeAll(async () => {
  app = await buildTestApp();
  const response = await app.inject({ method: 'GET', url: '/openapi.json' });
  expect(response.statusCode).toBe(200);
  doc = response.json<OpenApiDocument>();
});

afterAll(async () => {
  await app.close();
  await closeDb();
});

describe('GET /openapi.json', () => {
  it('is an OpenAPI 3.1 document with the platform routes', () => {
    expect(doc.openapi).toBe('3.1.0');
    // Exactly what the API registers: a new route group adds its paths here.
    expect(Object.keys(doc.paths).sort()).toEqual(
      [
        '/health',
        '/health/ready',
        '/auth/sign-in/email',
        '/auth/invite/redeem',
        '/v1/me',
        '/v1/platform/organizations',
        '/v1/platform/organizations/{orgId}/owner-invitations',
        '/v1/platform/organizations/{orgId}/entitlements/{featureKey}',
        '/v1/platform/organizations/{orgId}/suspension',
        '/v1/orgs/{orgId}',
        '/v1/orgs/{orgId}/members',
        '/v1/orgs/{orgId}/members/{membershipId}',
        '/v1/orgs/{orgId}/invitations',
        '/v1/orgs/{orgId}/invitations/{invitationId}',
        '/v1/orgs/{orgId}/notes',
        '/v1/orgs/{orgId}/notes/{noteId}',
        '/v1/orgs/{orgId}/activity',
      ].sort(),
    );
    expect(Object.keys(doc.paths).some((path) => path.includes('*'))).toBe(false);
    expect(doc.paths['/openapi.json']).toBeUndefined();
    expect(Object.keys(doc.components.securitySchemes).sort()).toEqual([
      'bearerAuth',
      'cookieAuth',
    ]);
  });

  it('documents the notes route from the contracts schemas', () => {
    const list = doc.paths['/v1/orgs/{orgId}/notes']?.['get'];
    expect(list?.tags).toEqual(['notes']);
    expect(list?.parameters?.map((p) => `${p.in}:${p.name}`)).toEqual(
      expect.arrayContaining(['path:orgId', 'query:limit', 'query:cursor']),
    );
    expect(JSON.stringify(list?.responses['200'])).toContain('createdBy');
    expect(Object.keys(list?.responses ?? {})).toEqual(expect.arrayContaining(['200', '4XX']));

    const create = doc.paths['/v1/orgs/{orgId}/notes']?.['post'];
    expect(create?.tags).toEqual(['notes']);
    expect(create?.parameters?.map((p) => `${p.in}:${p.name}`)).toContain('header:idempotency-key');
    expect(create?.requestBody?.content).toHaveProperty('application/json');
    // The body is CreateNoteSchema: `title` required, `body` optional with a default.
    const body = JSON.stringify(create?.requestBody?.content['application/json']);
    expect(body).toContain('"title"');
    expect(body).toContain('"body"');
    expect(body).toMatch(/"required":\["title"\]/);
    expect(create?.responses).toHaveProperty('201');

    const remove = doc.paths['/v1/orgs/{orgId}/notes/{noteId}']?.['delete'];
    expect(remove?.parameters?.map((p) => `${p.in}:${p.name}`)).toEqual(
      expect.arrayContaining(['path:orgId', 'path:noteId', 'header:idempotency-key']),
    );
    expect(remove?.responses).toHaveProperty('204');
  });

  it('marks public routes as unauthenticated', () => {
    expect(doc.paths['/health']?.['get']?.security).toEqual([]);
    expect(doc.paths['/auth/invite/redeem']?.['post']?.security).toEqual([]);
    expect(doc.paths['/v1/me']?.['get']?.security).toEqual([
      { bearerAuth: [] },
      { cookieAuth: [] },
    ]);
  });
});
