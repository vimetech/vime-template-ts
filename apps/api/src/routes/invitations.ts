import {
  CreateInvitationResponseSchema,
  CreateInvitationSchema,
  InvitationListItemSchema,
  UuidSchema,
} from '@vime/contracts';
import { ConflictError } from '@vime/kernel';
import { createInvitation, listInvitations, revokeInvitation } from '@vime/platform';
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

const InvitationParamsSchema = OrgParamsSchema.extend({ invitationId: UuidSchema });

/** Invitation codes (member.manage). Redeemed with POST /auth/invite/redeem. */
export const invitationRoutes: FastifyPluginAsyncZod = async (app) => {
  const tags = ['invitations'];
  const guard = requirePermission('member.manage');

  app.post(
    '/invitations',
    {
      schema: {
        tags,
        summary: 'Create an invitation code',
        description:
          'Returns the plaintext `code` (shown once; only its keyed hash is stored). The creator ' +
          'must hold every permission of the invited roles. Set `email` to invite someone who ' +
          'signs in with email + password. Replaying an Idempotency-Key is a 409: the code ' +
          'cannot be shown again.',
        security: AUTHENTICATED,
        params: OrgParamsSchema,
        headers: MutationHeadersSchema,
        body: CreateInvitationSchema,
        response: { 201: CreateInvitationResponseSchema, ...problemResponses },
      },
      preHandler: guard,
    },
    async (request, reply) =>
      mutate(
        request,
        reply,
        (tx, actor) =>
          createInvitation(
            tx,
            actor,
            request.body,
            request.auth.permissions,
            request.server.invitationCodeKey,
          ),
        {
          status: 201,
          // The plaintext code is never persisted, not even for Idempotency-Key replays.
          stored: ({ code: _code, ...rest }) => rest,
          replay: (stored) => {
            throw new ConflictError(
              'This invitation was already created and its code is shown only once. Revoke it ' +
                'and create a new one.',
              { details: { invitationId: (stored as { id?: unknown }).id } },
            );
          },
        },
      ),
  );

  app.get(
    '/invitations',
    {
      schema: {
        tags,
        summary: 'List invitations (newest first, without codes)',
        security: AUTHENTICATED,
        params: OrgParamsSchema,
        headers: V1HeadersSchema,
        response: { 200: listOf(InvitationListItemSchema), ...problemResponses },
      },
      preHandler: guard,
    },
    async (request) => ({ items: await request.tenant((tx) => listInvitations(tx)) }),
  );

  app.delete(
    '/invitations/:invitationId',
    {
      schema: {
        tags,
        summary: 'Revoke an invitation',
        description: 'Idempotent. Returns the revoked invitation.',
        security: AUTHENTICATED,
        params: InvitationParamsSchema,
        headers: MutationHeadersSchema,
        response: { 200: InvitationListItemSchema, ...problemResponses },
      },
      preHandler: guard,
    },
    async (request, reply) =>
      mutate(request, reply, (tx, actor) =>
        revokeInvitation(tx, actor, request.params.invitationId),
      ),
  );
};
