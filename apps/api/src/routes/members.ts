import { MemberSchema, UpdateMemberRolesSchema, UuidSchema } from '@vime/contracts';
import { listMembers, updateMemberRoles } from '@vime/platform';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { mutate } from '../context/idempotency';
import { requirePermission } from '../context/request-context';
import { problemResponses } from '../http/problem';
import {
  AUTHENTICATED,
  MutationHeadersSchema,
  OrgParamsSchema,
  V1HeadersSchema,
  listOf,
} from './common';

const MemberParamsSchema = OrgParamsSchema.extend({ membershipId: UuidSchema });

/** Members of the organization (member.manage). */
export const memberRoutes: FastifyPluginAsyncZod = async (app) => {
  const tags = ['members'];
  const guard = requirePermission('member.manage');

  app.get(
    '/members',
    {
      schema: {
        tags,
        summary: 'List members (active and suspended)',
        security: AUTHENTICATED,
        params: OrgParamsSchema,
        headers: V1HeadersSchema,
        response: { 200: listOf(MemberSchema), ...problemResponses },
      },
      preHandler: guard,
    },
    async (request) => ({
      items: await request.tenant((tx) => listMembers(tx, request.auth.orgId)),
    }),
  );

  app.patch(
    '/members/:membershipId',
    {
      schema: {
        tags,
        summary: "Replace a member's roles",
        description:
          'The caller must hold every permission of both the current and the new roles (no ' +
          'privilege escalation), and the organization keeps at least one active owner. Takes ' +
          'effect on the member’s next request.',
        security: AUTHENTICATED,
        params: MemberParamsSchema,
        headers: MutationHeadersSchema,
        body: UpdateMemberRolesSchema,
        response: { 200: MemberSchema, ...problemResponses },
      },
      preHandler: guard,
    },
    async (request, reply) => {
      const member = await mutate(request, reply, (tx, actor) =>
        updateMemberRoles(
          tx,
          actor,
          request.params.membershipId,
          request.body,
          request.auth.permissions,
        ),
      );
      request.server.membershipCache.invalidate(member.userId, request.auth.orgId);
      return member;
    },
  );
};
