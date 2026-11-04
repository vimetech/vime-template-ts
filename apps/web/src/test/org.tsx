import {
  isFunctionOn,
  type FeatureKey,
  type MeMembership,
  type OptionalFunction,
  type Permission,
} from '@vime/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { ToastProvider } from '../components/ui';
import { OrgProvider, type OrgContext } from '../lib/org';
import { PresentationProvider } from '../lib/presentation';

export const ORG_ID = '01928f3e-7c3a-7b2e-9a6f-0000000000aa';

/** An organization context for component tests (no router, no /v1/me). */
export function orgContext(
  permissions: readonly Permission[],
  features: readonly FeatureKey[] | null = null,
  disabledFunctions: readonly OptionalFunction[] = [],
): OrgContext {
  const set = new Set(permissions);
  const featureSet = features === null ? null : new Set(features);
  const membership = {
    organization: {
      id: ORG_ID,
      name: 'Acme',
      slug: 'acme',
      timezone: 'America/Lima',
      locale: 'es-PE',
      disabledFunctions: [...disabledFunctions],
    },
    roleKeys: [],
    permissions: [...permissions],
    ...(features === null ? {} : { features: [...features] }),
  } satisfies MeMembership;
  return {
    orgId: ORG_ID,
    organization: membership.organization,
    membership,
    permissions: set,
    features: featureSet,
    can: (p) => set.has(p),
    canAny: (...ps) => ps.some((p) => set.has(p)),
    hasFeature: (f) => featureSet === null || featureSet.has(f),
    functionOn: (fn) => isFunctionOn(disabledFunctions, fn),
  };
}

export function testQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: 0 } },
  });
}

/** Renders `ui` inside the providers of an organization page. */
export function renderWithOrg(
  ui: ReactNode,
  options: {
    permissions?: readonly Permission[];
    features?: readonly FeatureKey[] | null;
    disabledFunctions?: readonly OptionalFunction[];
    presentation?: boolean;
    queryClient?: QueryClient;
  } = {},
) {
  const queryClient = options.queryClient ?? testQueryClient();
  const result = render(
    <QueryClientProvider client={queryClient}>
      <PresentationProvider initial={options.presentation ?? false}>
        <ToastProvider>
          <OrgProvider
            value={orgContext(
              options.permissions ?? [],
              options.features ?? null,
              options.disabledFunctions ?? [],
            )}
          >
            {ui}
          </OrgProvider>
        </ToastProvider>
      </PresentationProvider>
    </QueryClientProvider>,
  );
  return { ...result, queryClient };
}
