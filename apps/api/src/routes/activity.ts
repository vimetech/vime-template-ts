import { ActivityEventQuerySchema, ActivityEventSchema, page } from '@vime/contracts';
import { listActivity } from '@vime/platform';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { requirePermission } from '../context/request-context';
import { problemResponses } from '../http/problem';
import { AUTHENTICATED, OrgParamsSchema, V1HeadersSchema } from './common';

/** Audit trail (audit.read). */
export const activityRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/activity',
    {
      schema: {
        tags: ['activity'],
        summary: 'Activity events, newest first',
        description:
          'Optionally for one entity (`entityType` + `entityId`). Cursor pagination: pass ' +
          '`nextCursor` as `cursor` for the next page.',
        security: AUTHENTICATED,
        params: OrgParamsSchema,
        querystring: ActivityEventQuerySchema,
        headers: V1HeadersSchema,
        response: { 200: page(ActivityEventSchema), ...problemResponses },
      },
      preHandler: requirePermission('audit.read'),
    },
    async (request) => request.tenant((tx) => listActivity(tx, request.query)),
  );
};
