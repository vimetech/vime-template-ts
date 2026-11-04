import { useQuery } from '@tanstack/react-query';
import {
  Link,
  Outlet,
  useRouter,
  useRouterState,
  useSearch,
  type ErrorComponentProps,
} from '@tanstack/react-router';
import type { ReactElement, ReactNode } from 'react';
import { useT } from '../lib/i18n-hook';
import { BrandMark, Button, Icon, buttonClass, type IconName } from '../components/ui';
import { isSuspended } from '../lib/active-org';
import { problemText } from '../lib/problems';
import { meQuery } from '../lib/queries';
import { useSignOut } from '../lib/use-sign-out';

export function RootLayout() {
  const { t } = useT();
  return (
    <>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-lg focus:bg-surface focus:px-4 focus:py-2.5 focus:text-sm focus:font-medium focus:text-indigo-700 focus:shadow-pop focus:ring-2 focus:ring-indigo-600"
      >
        {t('shell.skipToContent')}
      </a>
      <Outlet />
    </>
  );
}

/** A full-page message outside the app shell (not found, no access). */
function StandalonePage({
  icon,
  title,
  body,
  children,
}: {
  icon: IconName;
  title: string;
  body: string;
  children: ReactNode;
}) {
  return (
    <main
      id="main"
      className="flex min-h-dvh flex-col items-center justify-center bg-[radial-gradient(60%_40%_at_50%_0%,var(--color-indigo-100),transparent)] px-6 py-16 text-center"
    >
      <BrandMark className="size-10" />
      <div className="mt-8 w-full max-w-md rounded-2xl border border-slate-200/80 bg-surface px-6 py-10 shadow-xl shadow-slate-900/5">
        <span className="mx-auto flex size-12 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600 ring-1 ring-indigo-100">
          <Icon name={icon} className="size-6" />
        </span>
        <h1 className="mt-5 text-xl font-semibold tracking-tight text-slate-900">{title}</h1>
        <p className="mt-2 text-sm leading-relaxed text-slate-500">{body}</p>
        <div className="mt-7 flex justify-center">{children}</div>
      </div>
    </main>
  );
}

export function NotFoundPage() {
  const { t } = useT();
  return (
    <StandalonePage
      icon="map-pin"
      title={t('states.notFoundTitle')}
      body={t('states.notFoundBody')}
    >
      <Link to="/" className={buttonClass('primary')}>
        <Icon name="home" className="size-4" />
        {t('actions.goHome')}
      </Link>
    </StandalonePage>
  );
}

// --- Loading and failure screens of the router -------------------------------------------------

/*
 * The skeletons repeat the boot skeleton of index.html (same markup, styled by the `.boot-*` CSS
 * there), so the hand-over from the static page to React and from one loading screen to the next
 * never jumps. Decorative only (`aria-hidden`): no `role="status"` next to the toasts' one.
 */

const NAV_BARS = ['boot-w60', 'boot-w50', 'boot-w60', 'boot-w40', 'boot-w50', 'boot-w60'];
const ROW_BARS = [
  ['boot-w40', 'boot-w60'],
  ['boot-w25', 'boot-w50'],
  ['boot-w40', 'boot-w60'],
  ['boot-w25', 'boot-w50'],
  ['boot-w40', 'boot-w60'],
] as const;

/** The page part of the skeleton: a title, a line, filter chips and a list. */
function PageSkeleton() {
  return (
    <div className="boot-page" aria-hidden="true">
      <span className="boot-bar boot-title" />
      <span className="boot-bar boot-w40" />
      <div className="boot-chips">
        <span className="boot-bar boot-chip" />
        <span className="boot-bar boot-chip" />
        <span className="boot-bar boot-chip" />
      </div>
      <div className="boot-card">
        {ROW_BARS.map(([title, line], index) => (
          <div key={index} className="boot-row">
            <span className="boot-bar boot-sq" />
            <span className="boot-lines">
              <span className={`boot-bar ${title}`} />
              <span className={`boot-bar ${line}`} />
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** The whole app's silhouette (sidebar or phone header, and a page), as in index.html. */
function BootSkeleton() {
  return (
    <div className="boot" aria-hidden="true">
      <div className="boot-side">
        <div className="boot-brand">
          <span className="boot-mark" />
          <span className="boot-bar boot-w50" />
        </div>
        <span className="boot-bar boot-org" />
        <div>
          {NAV_BARS.map((width, index) => (
            <span key={index} className="boot-item">
              <span className="boot-bar boot-ico" />
              <span className={`boot-bar ${width}`} />
            </span>
          ))}
        </div>
      </div>
      <div className="boot-main">
        <div className="boot-head">
          <span className="boot-mark" />
          <span className="boot-bar boot-w40" />
        </div>
        <PageSkeleton />
      </div>
    </div>
  );
}

/** Whether the app shell (sidebar, phone header) is on screen: the organization route loaded. */
function useShellShown(): boolean {
  return useRouterState({
    select: (state) =>
      state.matches.some((match) => match.routeId === '/o/$orgId' && match.status === 'success'),
  });
}

/**
 * Router `defaultPendingComponent` (a route's code or guard still loading after the pending delay):
 * inside the shell the page's skeleton, before it (first load, login) the whole app's.
 */
export function RoutePending(): ReactElement {
  return useShellShown() ? <PageSkeleton /> : <BootSkeleton />;
}

/**
 * Router `InnerWrap`: until the router presents its first matches, React would draw nothing over
 * index.html's skeleton; this keeps the same skeleton on screen instead.
 */
export function BootUntilRouted({ children }: { children: ReactNode }): ReactElement {
  const routed = useRouterState({ select: (state) => state.matches.length > 0 });
  return (
    <>
      {children}
      {routed ? null : <BootSkeleton />}
    </>
  );
}

/**
 * Router `defaultErrorComponent` (a guard or loader failed, a page crashed): what happened, in the
 * app's language, and "Reintentar", which runs the route again. Inside the shell it takes the
 * page's place; before it, it is a page of its own.
 */
export function RouteError({ error }: ErrorComponentProps): ReactElement {
  const { t } = useT();
  const router = useRouter();
  const inShell = useShellShown();
  const { message, detail } = problemText(t, error);
  const card = (
    <div
      role="alert"
      className="mx-auto w-full max-w-md rounded-2xl border border-slate-200/80 bg-surface px-6 py-10 text-center shadow-xl shadow-slate-900/5"
    >
      <span className="mx-auto flex size-12 items-center justify-center rounded-xl bg-rose-50 text-rose-600 ring-1 ring-rose-100">
        <Icon name="alert-circle" className="size-6" />
      </span>
      <p className="mt-5 text-lg font-semibold tracking-tight text-balance text-slate-900">
        {message}
      </p>
      {detail ? <p className="mt-2 text-xs break-words text-slate-500">{detail}</p> : null}
      <div className="mt-7 flex flex-wrap justify-center gap-2">
        <Button variant="primary" icon="refresh" onClick={() => void router.invalidate()}>
          {t('actions.retry')}
        </Button>
        <Link to="/" className={buttonClass()}>
          <Icon name="home" className="size-4" />
          {t('actions.goHome')}
        </Link>
      </div>
    </div>
  );
  if (inShell) return <div className="py-10">{card}</div>;
  return (
    <main
      id="main"
      className="flex min-h-dvh flex-col justify-center bg-[radial-gradient(60%_40%_at_50%_0%,var(--color-rose-100),transparent)] px-6 py-16"
    >
      {card}
    </main>
  );
}

/**
 * The organization of `?org=` (or the person's only one) is suspended by the platform (ADR 0015).
 * A person who belongs to others can switch to them from here.
 */
export function SuspendedPage() {
  const { t } = useT();
  const logout = useSignOut();
  const { org } = useSearch({ strict: false });
  const { data: me } = useQuery(meQuery());
  const name =
    me?.memberships.find((m) => m.organization.id === org)?.organization.name ??
    t('shell.organization');
  const others = me?.memberships.some((m) => m.organization.id !== org && !isSuspended(m));
  return (
    <StandalonePage
      icon="lock"
      title={t('states.suspendedTitle')}
      body={t('states.suspendedBody', { org: name })}
    >
      <div className="flex flex-wrap justify-center gap-2">
        {others ? (
          <Link to="/" className={buttonClass('primary')}>
            <Icon name="home" className="size-4" />
            {t('actions.goHome')}
          </Link>
        ) : null}
        <Button icon="log-out" loading={logout.pending} onClick={() => void logout.signOut()}>
          {t('shell.logout')}
        </Button>
      </div>
    </StandalonePage>
  );
}

/** Signed in, but no membership (or none with a web page to show), e.g. a cleaner. */
export function NoAccessPage() {
  const { t } = useT();
  const logout = useSignOut();
  return (
    <StandalonePage icon="lock" title={t('states.noAccessTitle')} body={t('states.noAccessBody')}>
      <Button icon="log-out" loading={logout.pending} onClick={() => void logout.signOut()}>
        {t('shell.logout')}
      </Button>
    </StandalonePage>
  );
}
