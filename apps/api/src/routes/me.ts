import { MeResponseSchema, type MeResponse } from '@vime/contracts';
import { withTenant, withUser } from '@vime/db';
import { isSyntheticEmail, listEnabledFeatures, listMyMemberships } from '@vime/platform';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { problemResponses } from '../http/problem';
import { AUTHENTICATED, V1HeadersSchema } from './common';

/** GET /v1/me: the signed-in user and their active memberships (organization switcher). */
export const meRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/me',
    {
      schema: {
        tags: ['me'],
        summary: 'The signed-in user and their active memberships',
        description:
          'Permissions and features (the entitlements each organization can use now) are ' +
          'returned for hiding UI only; the API always enforces them. `email` is null for users ' +
          'that sign in with invitation codes only. `platformAdmin` says whether the user sees ' +
          'the platform console.',
        security: AUTHENTICATED,
        headers: V1HeadersSchema,
        response: { 200: MeResponseSchema, ...problemResponses },
      },
    },
    async (request): Promise<MeResponse> => {
      const user = request.user;
      const mine = await withUser(user.id, (tx) => listMyMemberships(tx, user.id));
      // Entitlements are tenant rows: read in each organization's own transaction (the user is
      // an active member of each, a handful at most).
      const memberships = await Promise.all(
        mine.map(async (membership) => ({
          ...membership,
          features: await withTenant({ orgId: membership.organization.id, userId: user.id }, (tx) =>
            listEnabledFeatures(tx, membership.organization.id),
          ),
        })),
      );
      return {
        user: {
          id: user.id,
          name: user.name,
          email: isSyntheticEmail(user.email) ? null : user.email,
        },
        memberships,
        platformAdmin: request.server.platformAdminUserIds.has(user.id.toLowerCase()),
      };
    },
  );
};
