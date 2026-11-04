import {
  CreateOwnerInvitationSchema,
  CreatePlatformOrganizationResponseSchema,
  CreatePlatformOrganizationSchema,
  FeatureKeySchema,
  OWNER_INVITATION_DAYS,
  OwnerInvitationSchema,
  PlatformOrganizationSchema,
  SetPlatformEntitlementSchema,
  SuspendOrganizationSchema,
  UuidSchema,
  permissionsForRoles,
  type OwnerInvitation,
} from '@vime/contracts';
import { withSystem, withTenant } from '@vime/db';
import { ConflictError, newId } from '@vime/kernel';
import {
  createInvitation,
  createOrganization,
  getPlatformOrganization,
  listPlatformOrganizations,
  reactivateOrganization,
  setEntitlement,
  suspendOrganization,
  type ActorContext,
} from '@vime/platform';
import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requirePlatformAdmin } from '../context/request-context';
import { problemResponses } from '../http/problem';
import { AUTHENTICATED, V1HeadersSchema, listOf } from './common';

/*
 * /v1/platform/*: the platform console (ADR 0015). Only the platform administrators
 * (PLATFORM_ADMIN_USER_IDS); anyone else gets 404. It manages organizations from outside (modules,
 * suspension, a new client and its first owner) and never reads their operational data.
 *
 * Writes are idempotent by nature instead of through the Idempotency-Key store (a tenant table,
 * and a new organization has no tenant yet): PUT/DELETE set a state, and a repeated POST of an
 * organization is a 409 on its slug. Every change is an activity event of the organization with
 * source `platform`.
 */

const OrgParamsSchema = z.object({ orgId: UuidSchema });
const EntitlementParamsSchema = OrgParamsSchema.extend({ featureKey: FeatureKeySchema });

/** Audit context of a platform administrator acting on `orgId`. */
function platformActor(request: FastifyRequest, orgId: string): ActorContext {
  return { orgId, source: 'platform', userId: request.user.id, requestId: request.id };
}

/**
 * An owner invitation for `email`, bound to it and single use. Run after the organization exists;
 * only while it has no active owner (a new organization, or one whose owner is gone): otherwise a
 * platform administrator could make themselves its owner without the organization's consent.
 */
async function inviteOwner(
  request: FastifyRequest,
  orgId: string,
  email: string,
): Promise<OwnerInvitation> {
  const actor = platformActor(request, orgId);
  const invitation = await withTenant({ orgId, userId: request.user.id }, async (tx) => {
    return createInvitation(
      tx,
      actor,
      {
        roleKeys: ['owner'],
        email,
        expiresInHours: OWNER_INVITATION_DAYS * 24,
        maxUses: 1,
      },
      permissionsForRoles(['owner']),
      request.server.invitationCodeKey,
    );
  });
  return {
    email: invitation.email ?? email,
    code: invitation.code,
    expiresAt: invitation.expiresAt,
  };
}

export const platformRoutes: FastifyPluginAsyncZod = async (app) => {
  const tags = ['platform'];
  app.addHook('preValidation', requirePlatformAdmin);

  app.get(
    '/organizations',
    {
      schema: {
        tags,
        summary: 'Every organization, with its modules, owners and suspension',
        description: 'Platform administrators only (404 for anyone else).',
        security: AUTHENTICATED,
        headers: V1HeadersSchema,
        response: { 200: listOf(PlatformOrganizationSchema), ...problemResponses },
      },
    },
    async () => ({ items: await withSystem((tx) => listPlatformOrganizations(tx)) }),
  );

  app.post(
    '/organizations',
    {
      schema: {
        tags,
        summary: 'A new client organization and its owner invitation',
        description:
          'Creates the organization with `features` enabled and an invitation for `ownerEmail` ' +
          'as owner (shown once): the owner redeems it on the ' +
          'web sign-in page with that email and a new password. 409 when the slug is taken.',
        security: AUTHENTICATED,
        headers: V1HeadersSchema,
        body: CreatePlatformOrganizationSchema,
        response: { 201: CreatePlatformOrganizationResponseSchema, ...problemResponses },
      },
    },
    async (request, reply) => {
      const body = request.body;
      const orgId = newId();
      await withSystem(async (tx) => {
        await createOrganization(
          tx,
          { name: body.name, slug: body.slug, timezone: body.timezone, locale: body.locale },
          {
            id: orgId,
            actor: { source: 'platform', userId: request.user.id, requestId: request.id },
          },
        );
        for (const featureKey of body.features) {
          await setEntitlement(tx, platformActor(request, orgId), { featureKey, enabled: true });
        }
      });
      const ownerInvitation = await inviteOwner(request, orgId, body.ownerEmail);
      const organization = await withSystem((tx) => getPlatformOrganization(tx, orgId));
      reply.code(201);
      return { organization, ownerInvitation };
    },
  );

  app.post(
    '/organizations/:orgId/owner-invitations',
    {
      schema: {
        tags,
        summary: 'A new owner invitation, for an organization without an active owner',
        description:
          'For an owner who lost the code or let it expire. 409 when the organization already ' +
          'has an active owner: from then on, its owners invite people themselves.',
        security: AUTHENTICATED,
        params: OrgParamsSchema,
        headers: V1HeadersSchema,
        body: CreateOwnerInvitationSchema,
        response: { 201: OwnerInvitationSchema, ...problemResponses },
      },
    },
    async (request, reply) => {
      const { orgId } = request.params;
      const organization = await withSystem((tx) => getPlatformOrganization(tx, orgId));
      if (organization.owners.length > 0) {
        throw new ConflictError('The organization already has an active owner');
      }
      const invitation = await inviteOwner(request, orgId, request.body.email);
      reply.code(201);
      return invitation;
    },
  );

  app.put(
    '/organizations/:orgId/entitlements/:featureKey',
    {
      schema: {
        tags,
        summary: 'Turn a module (feature entitlement) on or off',
        description:
          '`validUntil` (exclusive, optional) turns it off by itself at that instant. Takes effect ' +
          'on the next request of the organization.',
        security: AUTHENTICATED,
        params: EntitlementParamsSchema,
        headers: V1HeadersSchema,
        body: SetPlatformEntitlementSchema,
        response: { 200: PlatformOrganizationSchema, ...problemResponses },
      },
    },
    async (request) => {
      const { orgId, featureKey } = request.params;
      const { enabled, validUntil } = request.body;
      return withSystem(async (tx) => {
        await getPlatformOrganization(tx, orgId);
        await setEntitlement(tx, platformActor(request, orgId), {
          featureKey,
          enabled,
          validUntil: validUntil === null ? null : new Date(validUntil),
        });
        return getPlatformOrganization(tx, orgId);
      });
    },
  );

  app.put(
    '/organizations/:orgId/suspension',
    {
      schema: {
        tags,
        summary: 'Suspend an organization',
        description:
          'From the next request nobody can use it (members and support get 403 ' +
          '`organization_suspended`) and its invitation codes stop working. Nothing is deleted. ' +
          'Already suspended: nothing changes.',
        security: AUTHENTICATED,
        params: OrgParamsSchema,
        headers: V1HeadersSchema,
        body: SuspendOrganizationSchema,
        response: { 200: PlatformOrganizationSchema, ...problemResponses },
      },
    },
    async (request) => {
      const { orgId } = request.params;
      const organization = await withSystem(async (tx) => {
        await suspendOrganization(tx, platformActor(request, orgId), request.body);
        return getPlatformOrganization(tx, orgId);
      });
      app.membershipCache.clear();
      return organization;
    },
  );

  app.delete(
    '/organizations/:orgId/suspension',
    {
      schema: {
        tags,
        summary: 'Lift the suspension of an organization',
        description: 'Not suspended: nothing changes.',
        security: AUTHENTICATED,
        params: OrgParamsSchema,
        headers: V1HeadersSchema,
        response: { 200: PlatformOrganizationSchema, ...problemResponses },
      },
    },
    async (request) => {
      const { orgId } = request.params;
      const organization = await withSystem(async (tx) => {
        await reactivateOrganization(tx, platformActor(request, orgId));
        return getPlatformOrganization(tx, orgId);
      });
      app.membershipCache.clear();
      return organization;
    },
  );
};
