import type { FastifyInstance } from 'fastify';
import { registerIdempotencyCheck } from '../context/idempotency';
import { requireAuth, resolveMembership } from '../context/request-context';
import type { RateLimitSettings } from '../http/rate-limit';
import { activityRoutes } from './activity';
import { healthRoutes } from './health';
import { invitationRoutes } from './invitations';
import { meRoutes } from './me';
import { memberRoutes } from './members';
import { noteRoutes } from './notes';
import { organizationRoutes } from './organizations';
import { platformRoutes } from './platform';

/** Prefix of every organization-scoped route: the active organization travels in the path. */
export const ORG_PREFIX = '/orgs/:orgId';

export interface RegisterRoutesOptions {
  rateLimits: RateLimitSettings;
}

/**
 * Route groups (a domain module mounts its own group next to the platform ones, like `noteRoutes`):
 * - /health, /health/ready: public;
 * - /v1/*: `requireAuth` (session required; 401 before body validation errors);
 * - /v1/platform/*: plus `requirePlatformAdmin` (404 unless PLATFORM_ADMIN_USER_IDS has the user);
 * - /v1/orgs/:orgId/*: plus `resolveMembership` (404 without an active membership), then each
 *   route's own requirePermission / requireFeature guards.
 */
export async function registerRoutes(
  app: FastifyInstance,
  _options: RegisterRoutesOptions,
): Promise<void> {
  await app.register(healthRoutes);
  await app.register(
    async (v1) => {
      // preValidation, not onRequest: route-level onRequest hooks (rate limits) run after the
      // scope's onRequest hooks, and every request must be counted before any session lookup.
      v1.addHook('preValidation', requireAuth);
      await v1.register(meRoutes);
      // Platform console (ADR 0015): platform administrators only, 404 for anyone else.
      await v1.register(platformRoutes, { prefix: '/platform' });
      await v1.register(
        async (org) => {
          org.addHook('preHandler', resolveMembership);
          registerIdempotencyCheck(org);
          await org.register(organizationRoutes);
          await org.register(memberRoutes);
          await org.register(invitationRoutes);
          await org.register(activityRoutes);
          // The example module: every route also needs the `example` feature.
          await org.register(noteRoutes);
        },
        { prefix: ORG_PREFIX },
      );
    },
    { prefix: '/v1' },
  );
}
