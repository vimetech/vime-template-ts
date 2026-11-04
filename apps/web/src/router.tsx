import type { QueryClient } from '@tanstack/react-query';
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  lazyRouteComponent,
  redirect,
} from '@tanstack/react-router';
import {
  isSuspended,
  pickMembership,
  readStoredOrgId,
  storeOrgId,
  webMemberships,
} from './lib/active-org';
import { featureSet, landingSegment } from './lib/nav';
import { meQuery } from './lib/queries';
import { AppShell } from './routes/AppShell';
import {
  BootUntilRouted,
  NoAccessPage,
  NotFoundPage,
  SuspendedPage,
  RootLayout,
  RouteError,
  RoutePending,
} from './routes/RootLayout';

/*
 * Code-based route tree (no codegen). Every organization page lives under `/o/$orgId/…`: the
 * active organization travels in the URL (shareable links) and is remembered in localStorage. A
 * feature adds its route next to `notesRoute` (and its entry in lib/nav.ts); search params are
 * validated in the route so pages get typed, shareable state.
 */

export interface RouterContext {
  queryClient: QueryClient;
}

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: RootLayout,
  notFoundComponent: NotFoundPage,
});

/** `?redirect=` must be a path of this app (no open redirects). */
function safeRedirect(value: unknown): string | undefined {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//')
    ? value
    : undefined;
}

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  validateSearch: (search: Record<string, unknown>): { redirect?: string } => {
    const target = safeRedirect(search['redirect']);
    return target ? { redirect: target } : {};
  },
  beforeLoad: async ({ context, search }) => {
    // Already signed in: skip the form.
    const me = await context.queryClient.ensureQueryData(meQuery());
    if (me) throw redirect({ href: search.redirect ?? '/' });
  },
  // Its own chunk (with Better Auth behind it): most visits arrive already signed in.
  component: lazyRouteComponent(() => import('./routes/LoginPage'), 'LoginPage'),
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  beforeLoad: async ({ context }) => {
    const me = await context.queryClient.ensureQueryData(meQuery());
    if (!me) throw redirect({ to: '/login' });
    // Only organizations with at least one page on this website are candidates: landing on one
    // with none would hide the person's other organizations. A suspended one comes last: the
    // person may belong to others that work.
    const web = webMemberships(me.memberships);
    const membership = pickMembership(
      web.filter((m) => !isSuspended(m)),
      readStoredOrgId(),
    );
    if (membership) {
      throw redirect({ to: '/o/$orgId', params: { orgId: membership.organization.id } });
    }
    if (me.platformAdmin) throw redirect({ to: '/plataforma' });
    const suspended = pickMembership(web, readStoredOrgId());
    if (suspended) {
      throw redirect({ to: '/suspendida', search: { org: suspended.organization.id } });
    }
    throw redirect({ to: '/sin-acceso' });
  },
});

const noAccessRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/sin-acceso',
  component: NoAccessPage,
});

const suspendedRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/suspendida',
  validateSearch: (search: Record<string, unknown>): { org?: string } =>
    typeof search['org'] === 'string' ? { org: search['org'] } : {},
  component: SuspendedPage,
});

/** Platform console (ADR 0015): platform administrators only; anyone else goes home. */
const platformRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/plataforma',
  beforeLoad: async ({ context, location }) => {
    const me = await context.queryClient.ensureQueryData(meQuery());
    if (!me) throw redirect({ to: '/login', search: { redirect: location.href } });
    if (!me.platformAdmin) throw redirect({ to: '/' });
  },
  component: lazyRouteComponent(() => import('./features/platform/PlatformPage'), 'PlatformPage'),
});

export const orgRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/o/$orgId',
  beforeLoad: async ({ context, params, location }) => {
    const me = await context.queryClient.ensureQueryData(meQuery());
    if (!me) throw redirect({ to: '/login', search: { redirect: location.href } });
    const membership = me.memberships.find((m) => m.organization.id === params.orgId);
    if (!membership) throw redirect({ to: '/' });
    if (isSuspended(membership)) {
      throw redirect({ to: '/suspendida', search: { org: membership.organization.id } });
    }
    storeOrgId(membership.organization.id);
    return { membership };
  },
  component: AppShell,
});

const orgIndexRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: '/',
  beforeLoad: ({ context, params }) => {
    const segment = landingSegment(
      new Set(context.membership.permissions),
      featureSet(context.membership.features),
    );
    // No page here (e.g. picked in the switcher): the index route picks an organization that has
    // one, or shows "sin acceso" when none does. It never picks this one, so this cannot loop.
    if (!segment) throw redirect({ to: '/' });
    throw redirect({ to: `/o/$orgId/${segment}` as '/o/$orgId/notas', params });
  },
});

// --- The example feature -----------------------------------------------------------------------

export const notesRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: 'notas',
  component: lazyRouteComponent(() => import('./features/example/ExamplePage'), 'ExamplePage'),
});

// --- Settings ----------------------------------------------------------------------------------

const settingsRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: 'configuracion',
  component: lazyRouteComponent(() => import('./features/settings/SettingsPage'), 'SettingsPage'),
});

export const routeTree = rootRoute.addChildren([
  loginRoute,
  indexRoute,
  noAccessRoute,
  suspendedRoute,
  platformRoute,
  orgRoute.addChildren([orgIndexRoute, notesRoute, settingsRoute]),
]);

export function createAppRouter(queryClient: QueryClient) {
  return createRouter({
    routeTree,
    context: { queryClient },
    defaultPreload: 'intent',
    // Data freshness is TanStack Query's job; the router runs beforeLoad guards, and loaders only
    // start queries without waiting for them.
    defaultPreloadStaleTime: 0,
    // Never a blank page: index.html's skeleton until the first page, then a skeleton while a
    // route loads for longer than this, and a Spanish error screen with "Reintentar".
    InnerWrap: BootUntilRouted,
    defaultPendingComponent: RoutePending,
    defaultPendingMs: 150,
    defaultErrorComponent: RouteError,
    scrollRestoration: true,
  });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
