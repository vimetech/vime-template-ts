import {
  isFunctionOn,
  type FeatureKey,
  type MeMembership,
  type MeOrganization,
  type OptionalFunction,
  type Permission,
} from '@vime/contracts';
import { useQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { createContext, useContext, useMemo } from 'react';
import { featureSet, hasFeature } from './nav';
import { meQuery } from './queries';

export interface OrgContext {
  orgId: string;
  organization: MeOrganization;
  membership: MeMembership;
  permissions: ReadonlySet<Permission>;
  /** Features (entitlements) of the organization; null when `/v1/me` did not say (all shown). */
  features: ReadonlySet<FeatureKey> | null;
  can(permission: Permission): boolean;
  canAny(...permissions: Permission[]): boolean;
  /** The organization has the feature on (true when unknown; the API enforces it). */
  hasFeature(feature: FeatureKey): boolean;
  /**
   * The organization has the optional function on: its own choice in Configuración, for hiding UI
   * only (true when unknown).
   */
  functionOn(fn: OptionalFunction): boolean;
}

/**
 * The active organization of the current `/o/$orgId/*` page, or null while it is not known (signed
 * out, membership removed). The layout renders pages only when it is known.
 */
export function useOrgOrNull(): OrgContext | null {
  const { orgId } = useParams({ strict: false }) as { orgId?: string };
  const { data: me } = useQuery(meQuery());
  return useMemo(() => {
    const membership = me?.memberships.find((m) => m.organization.id === orgId);
    if (!orgId || !membership) return null;
    const permissions = new Set<Permission>(membership.permissions);
    const features = featureSet(membership.features);
    return {
      orgId,
      organization: membership.organization,
      membership,
      permissions,
      features,
      can: (permission) => permissions.has(permission),
      canAny: (...required) => required.some((permission) => permissions.has(permission)),
      hasFeature: (feature) => hasFeature(features, feature),
      functionOn: (fn) => isFunctionOn(membership.organization.disabledFunctions, fn),
    };
  }, [me, orgId]);
}

const OrgReactContext = createContext<OrgContext | null>(null);

/** Provided by the organization layout once the membership is known. */
export const OrgProvider = OrgReactContext.Provider;

/**
 * The active organization for pages under the organization layout. It comes from the layout (not
 * from the query cache), so a page never sees a half-signed-out state while the layout unmounts it.
 */
export function useOrg(): OrgContext {
  const org = useContext(OrgReactContext);
  if (!org) throw new Error('useOrg() outside the organization layout');
  return org;
}
