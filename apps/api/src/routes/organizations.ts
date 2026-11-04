import { OrganizationSchema, UpdateOrganizationSchema } from '@vime/contracts';
import { getOrganization, updateOrganization } from '@vime/platform';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { mutate } from '../context/idempotency';
import { requirePermission } from '../context/request-context';
import { problemResponses } from '../http/problem';
import { AUTHENTICATED, MutationHeadersSchema, OrgParamsSchema, V1HeadersSchema } from './common';

/** GET/PATCH /v1/orgs/:orgId. Any member reads the organization; changing it needs org.manage. */
export const organizationRoutes: FastifyPluginAsyncZod = async (app) => {
  const tags = ['organizations'];

  app.get(
    '',
    {
      schema: {
        tags,
        summary: 'Get the organization',
        security: AUTHENTICATED,
        params: OrgParamsSchema,
        headers: V1HeadersSchema,
        response: { 200: OrganizationSchema, ...problemResponses },
      },
    },
    async (request) => request.tenant((tx) => getOrganization(tx, request.auth.orgId)),
  );

  app.patch(
    '',
    {
      schema: {
        tags,
        summary: 'Update the organization (name, time zone, locale, settings)',
        description: '`settings` keys are merged into the stored settings. Requires org.manage.',
        security: AUTHENTICATED,
        params: OrgParamsSchema,
        headers: MutationHeadersSchema,
        body: UpdateOrganizationSchema,
        response: { 200: OrganizationSchema, ...problemResponses },
      },
      preHandler: requirePermission('org.manage'),
    },
    async (request, reply) =>
      mutate(request, reply, (tx, actor) => updateOrganization(tx, actor, request.body)),
  );
};
