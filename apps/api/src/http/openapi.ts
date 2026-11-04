import swagger from '@fastify/swagger';
import type { FastifyInstance } from 'fastify';
import { jsonSchemaTransform } from 'fastify-type-provider-zod';
import { AUTH_COOKIE_PREFIX } from '../auth/auth';
import type { ApiEnv } from '../env';

export const OPENAPI_PATH = '/openapi.json';

const DESCRIPTION = `REST API of VIME App (ADR 0002). Request and response bodies are the Zod schemas of
@vime/contracts.

- **Auth**: web uses the session cookie set by \`POST /auth/sign-in/email\`; mobile sends
  \`Authorization: Bearer <token>\` (token from sign-in or \`POST /auth/invite/redeem\`).
- **Organization**: organization-scoped routes live under \`/v1/orgs/{orgId}\`. Not being an active
  member of the organization is a 404.
- **Errors**: RFC 9457 \`application/problem+json\`; branch on \`code\`.
- **Idempotency**: every mutation accepts \`Idempotency-Key\` (UUID).
- **Versioning**: only additive changes within /v1.`;

/**
 * OpenAPI 3.1 document generated from the routes' Zod schemas (@fastify/swagger +
 * fastify-type-provider-zod), served at GET /openapi.json. Register before the routes it documents.
 */
export async function registerOpenApi(app: FastifyInstance, env: ApiEnv): Promise<void> {
  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: { title: 'VIME App API', version: '1.0.0', description: DESCRIPTION },
      servers: [{ url: env.API_PUBLIC_URL }],
      tags: [
        { name: 'auth', description: 'Sign-in and invitation codes (Better Auth)' },
        { name: 'me', description: 'The signed-in user' },
        {
          name: 'platform',
          description:
            'Platform console: organizations from outside (platform administrators only)',
        },
        { name: 'organizations' },
        { name: 'members' },
        { name: 'invitations' },
        { name: 'activity', description: 'Audit trail' },
        { name: 'notes', description: 'The example module' },
        { name: 'health' },
      ],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            description: 'Session token (mobile): `token` / `set-auth-token` of sign-in or redeem.',
          },
          cookieAuth: {
            type: 'apiKey',
            in: 'cookie',
            name: `${AUTH_COOKIE_PREFIX}.session_token`,
            description: 'Session cookie (web); `__Secure-` prefixed over HTTPS.',
          },
        },
      },
    },
    transform: jsonSchemaTransform,
  });

  app.get(OPENAPI_PATH, { schema: { hide: true } }, async () => app.swagger());
}
