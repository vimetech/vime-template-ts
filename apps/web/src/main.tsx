import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ToastProvider } from './components/ui';
import { initI18n, loadLocale, storedLocale } from './i18n';
import '@fontsource-variable/inter';
import '@fontsource-variable/manrope';
import './index.css';
import { pickMembership, readStoredOrgId, webMemberships } from './lib/active-org';
import { preload } from './lib/lazy';
import { featureSet, landingSegment } from './lib/nav';
import { PresentationProvider } from './lib/presentation';
import { isUnauthenticated } from './lib/problems';
import { keys, meQuery, shouldRetryQuery } from './lib/queries';
import { createAppRouter } from './router';
import { startTheme } from './lib/theme';

const locale = storedLocale();
const i18n = initI18n(locale);
document.documentElement.lang = locale;
startTheme();

/** A 401 anywhere (session expired or revoked): back to the login, then to where the user was. */
function onApiError(error: unknown): void {
  if (!isUnauthenticated(error)) return;
  queryClient.setQueryData(keys.me, null);
  const { pathname, href } = router.state.location;
  if (pathname !== '/login') {
    void router.navigate({ to: '/login', search: { redirect: href } });
  }
}

const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: onApiError }),
  mutationCache: new MutationCache({ onError: onApiError }),
  defaultOptions: {
    queries: { staleTime: 30_000, retry: shouldRetryQuery, refetchOnWindowFocus: true },
    // Mutations retry inside the API client, with the same Idempotency-Key.
    mutations: { retry: 0 },
  },
});

const router = createAppRouter(queryClient);

/** `/o/<org>/notas`, the usual landing page (organization ids are lowercase UUIDs). */
const NOTES_PATH = /^\/o\/([0-9a-f-]{36})\/notas\/?$/;
/** `/` and `/o/<org>`: they redirect to the person's landing page (the notes for almost everyone). */
const LANDING_PATH = /^\/(?:o\/([0-9a-f-]{36})\/?)?$/;

/**
 * Startup without waits in a row: the router would ask for /v1/me only once it runs, then load the
 * landing page's code. Here both start now, in parallel. `/v1/me` reuses index.html's preload; a
 * 401 goes through `onApiError` like any other (to the login, as the router's guard would).
 */
function warmUp(): void {
  void queryClient.prefetchQuery(meQuery());
  const { pathname } = window.location;
  // The router's own import of the page then finds the code loaded (or on its way).
  const loadNotes = () => preload(() => import('./features/example/ExamplePage'));
  if (NOTES_PATH.test(pathname)) {
    loadNotes();
    return;
  }
  const landing = LANDING_PATH.exec(pathname);
  if (!landing) return;
  // Only once /v1/me (already preloaded) says the person lands on the notes: a signed-out visitor
  // or someone whose first page is another one does not download it.
  void queryClient
    .fetchQuery(meQuery())
    .then((me) => {
      if (!me) return;
      const orgId = landing[1];
      const membership = orgId
        ? me.memberships.find((m) => m.organization.id === orgId)
        : pickMembership(webMemberships(me.memberships), readStoredOrgId());
      if (!membership) return;
      const segment = landingSegment(
        new Set(membership.permissions),
        featureSet(membership.features),
      );
      if (segment === 'notas') loadNotes();
    })
    .catch(() => undefined);
}

warmUp();

const root = document.getElementById('root');
if (!root) throw new Error('Root element not found');

function render(element: HTMLElement): void {
  createRoot(element).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <PresentationProvider>
          <ToastProvider>
            <RouterProvider router={router} />
          </ToastProvider>
        </PresentationProvider>
      </QueryClientProvider>
    </StrictMode>,
  );
}

// English is its own chunk: render once it is in, so the first paint is already in English.
if (locale === 'es-PE') {
  render(root);
} else {
  void loadLocale(locale)
    .then(() => i18n.changeLanguage(locale))
    .finally(() => render(root));
}
