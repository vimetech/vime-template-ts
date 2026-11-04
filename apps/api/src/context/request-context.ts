import type { FeatureKey, Permission, RoleKey } from '@vime/contracts';
import { withTenant, withUser, type Tx } from '@vime/db';
import { ForbiddenError, NotFoundError, isUuid } from '@vime/kernel';
import {
  organizationCanUseFeature,
  resolveMembershipForUser,
  type ActorContext,
} from '@vime/platform';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Auth } from '../auth/auth';
import {
  APP_VERSION_HEADER,
  IDEMPOTENCY_KEY_HEADER,
  activitySourceFor,
  parseAppVersion,
} from '../http/client-info';
import {
  FeatureNotEnabledError,
  OrganizationSuspendedError,
  UnauthenticatedError,
} from '../http/problem';
import type { MembershipCache } from './membership-cache';

/** The signed-in user (Better Auth session), as the API uses it. */
export interface SessionUser {
  id: string;
  name: string;
  email: string;
  sessionId: string;
}

/** Authorization of the request inside `/v1/orgs/:orgId/*` (resolved per request, never stored). */
export interface RequestAuth {
  userId: string;
  orgId: string;
  membershipId: string;
  roleKeys: RoleKey[];
  permissions: ReadonlySet<Permission>;
}

declare module 'fastify' {
  interface FastifyInstance {
    betterAuth: Auth;
    membershipCache: MembershipCache;
    /** Origins allowed to send cookie-authenticated mutations (web app and the API itself). */
    trustedOrigins: ReadonlySet<string>;
    /** HMAC key of invitation codes (`deriveInvitationCodeKey`). */
    invitationCodeKey: Uint8Array;
    /** HMAC key of Idempotency-Key request hashes (`deriveRequestHashKey`). */
    requestHashKey: Uint8Array;
    /** User ids of the platform administrators (`PLATFORM_ADMIN_USER_IDS`, lowercase). */
    platformAdminUserIds: ReadonlySet<string>;
  }
  interface FastifyRequest {
    /** `X-App-Version` when well-formed (mobile), else null. Captured on every request. */
    appVersion: string | null;
    /** Set by `requireAuth`; null on public routes. */
    sessionUser: SessionUser | null;
    /** The signed-in user. Throws outside routes guarded by `requireAuth`. */
    readonly user: SessionUser;
    /** Set by `resolveMembership`. */
    memberAuth: RequestAuth | null;
    /** Membership authorization. Throws outside `/v1/orgs/:orgId/*`. */
    readonly auth: RequestAuth;
    /** Audit context of the request for module services (`ActorContext`). */
    readonly actor: ActorContext;
    /** `withTenant({ orgId, userId }, fn)` for the request's organization and user. */
    tenant<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
    /** Set by `mutate()` (idempotency bookkeeping). */
    idempotencyHandled: boolean;
  }
}

/** Fetch Headers from Node's incoming headers (for Better Auth's API). */
export function toFetchHeaders(source: FastifyRequest['headers']): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) {
      headers.append(name, item);
    }
  }
  return headers;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Request decorators and the hooks every request needs. Call once on the root instance. */
export function registerRequestContext(
  app: FastifyInstance,
  deps: {
    auth: Auth;
    membershipCache: MembershipCache;
    trustedOrigins: readonly string[];
    invitationCodeKey: Uint8Array;
    requestHashKey: Uint8Array;
    platformAdminUserIds?: readonly string[];
  },
): void {
  app.decorate('betterAuth', deps.auth);
  app.decorate('membershipCache', deps.membershipCache);
  app.decorate('trustedOrigins', new Set(deps.trustedOrigins));
  app.decorate('invitationCodeKey', deps.invitationCodeKey);
  app.decorate('requestHashKey', deps.requestHashKey);
  app.decorate(
    'platformAdminUserIds',
    new Set((deps.platformAdminUserIds ?? []).map((id) => id.toLowerCase())),
  );

  app.decorateRequest('appVersion', null);
  app.decorateRequest('sessionUser', null);
  app.decorateRequest('memberAuth', null);
  app.decorateRequest('idempotencyHandled', false);
  app.decorateRequest('user', {
    getter(this: FastifyRequest): SessionUser {
      if (!this.sessionUser) {
        throw new Error('request.user read on a route without the requireAuth hook');
      }
      return this.sessionUser;
    },
  });
  app.decorateRequest('auth', {
    getter(this: FastifyRequest): RequestAuth {
      if (!this.memberAuth) {
        throw new Error('request.auth read outside /v1/orgs/:orgId routes');
      }
      return this.memberAuth;
    },
  });
  app.decorateRequest('actor', {
    getter(this: FastifyRequest): ActorContext {
      const auth = this.auth;
      const key = this.headers[IDEMPOTENCY_KEY_HEADER];
      return {
        orgId: auth.orgId,
        source: activitySourceFor(this.appVersion),
        userId: auth.userId,
        requestId: this.id,
        idempotencyKey: typeof key === 'string' && isUuid(key) ? key.toLowerCase() : null,
      };
    },
  });
  app.decorateRequest('tenant', function tenant<
    T,
  >(this: FastifyRequest, fn: (tx: Tx) => Promise<T>): Promise<T> {
    const auth = this.auth;
    return withTenant({ orgId: auth.orgId, userId: auth.userId }, fn);
  });

  app.addHook('onRequest', async (request) => {
    request.appVersion = parseAppVersion(request.headers[APP_VERSION_HEADER]);
  });
}

/**
 * preValidation hook: requires a valid Better Auth session (cookie, or `Authorization: Bearer` through
 * the bearer plugin) and sets `request.user`. 401 `unauthenticated` otherwise.
 *
 * Cookie-authenticated mutations must not come from a foreign site: when the browser sends an
 * `Origin`, it must be the web app's (or the API's) origin. Bearer requests are not exposed to
 * CSRF (browsers never attach the header on their own).
 */
export async function requireAuth(request: FastifyRequest): Promise<void> {
  if (request.sessionUser) {
    return;
  }
  const result = await request.server.betterAuth.api.getSession({
    headers: toFetchHeaders(request.headers),
  });
  if (!result) {
    throw new UnauthenticatedError();
  }
  const origin = request.headers.origin;
  if (
    !SAFE_METHODS.has(request.method) &&
    request.headers.authorization === undefined &&
    typeof origin === 'string' &&
    !request.server.trustedOrigins.has(origin)
  ) {
    throw new ForbiddenError('Cross-site request rejected');
  }
  request.sessionUser = {
    id: result.user.id,
    name: result.user.name,
    email: result.user.email,
    sessionId: result.session.id,
  };
}

/**
 * preHandler hook for `/v1/orgs/:orgId/*`: resolves the user's ACTIVE membership in the
 * organization (cached ~30 s, see MembershipCache) and sets `request.auth`. No membership (or a
 * suspended one, or an organization that does not exist) is a 404 that does not reveal whether the
 * organization exists. A member of an organization the platform suspended gets 403
 * `organization_suspended` (ADR 0015).
 */
export async function resolveMembership(request: FastifyRequest): Promise<void> {
  const { orgId } = request.params as { orgId?: unknown };
  const user = request.user;
  if (typeof orgId !== 'string' || !isUuid(orgId)) {
    throw new NotFoundError('organization');
  }
  const membership = await request.server.membershipCache.get(user.id, orgId, () =>
    withUser(user.id, (tx) => resolveMembershipForUser(tx, user.id, orgId)),
  );
  if (!membership) {
    throw new NotFoundError('organization', orgId);
  }
  if (membership.organizationSuspended) {
    throw new OrganizationSuspendedError();
  }
  request.memberAuth = {
    userId: user.id,
    orgId: membership.organizationId,
    membershipId: membership.membershipId,
    roleKeys: membership.roleKeys,
    permissions: membership.permissions,
  };
}

/** preHandler guard: 403 `forbidden` unless the membership grants `permission`. */
export function requirePermission(permission: Permission) {
  return async function permissionGuard(request: FastifyRequest): Promise<void> {
    if (!request.auth.permissions.has(permission)) {
      throw new ForbiddenError(`This action requires the ${permission} permission`, {
        details: { permission },
      });
    }
  };
}

/**
 * preHandler guard: 403 `forbidden` unless the membership grants AT LEAST ONE of `permissions`
 * (scoped pairs such as `task.view.all` / `task.view.assigned`, where the service then applies the
 * scope). The problem's `details.requiredAnyOf` lists them.
 */
export function requireAnyPermission(...permissions: [Permission, ...Permission[]]) {
  return async function anyPermissionGuard(request: FastifyRequest): Promise<void> {
    if (!permissions.some((permission) => request.auth.permissions.has(permission))) {
      throw new ForbiddenError(`This action requires one of: ${permissions.join(', ')}`, {
        details: { requiredAnyOf: permissions },
      });
    }
  };
}

/**
 * preHandler guard: 403 `feature_not_enabled` unless the organization's entitlement for `feature`
 * is enabled and valid (`organizationCanUseFeature`). Module routes use it together with
 * requirePermission (both are needed: architecture §6).
 */
export function requireFeature(feature: FeatureKey) {
  return async function featureGuard(request: FastifyRequest): Promise<void> {
    const orgId = request.auth.orgId;
    const enabled = await request.tenant((tx) => organizationCanUseFeature(tx, orgId, feature));
    if (!enabled) {
      throw new FeatureNotEnabledError(feature);
    }
  };
}

/**
 * preValidation guard of `/v1/platform/*` (ADR 0015): only the platform administrators
 * (`PLATFORM_ADMIN_USER_IDS`). Anyone else gets a 404, so the console does not reveal it exists.
 */
export async function requirePlatformAdmin(request: FastifyRequest): Promise<void> {
  if (!request.server.platformAdminUserIds.has(request.user.id.toLowerCase())) {
    throw new NotFoundError('route');
  }
}
