import { SUPPORTED_LOCALES, type SupportedLocale } from '@vime/i18n/locales';
import { useQuery } from '@tanstack/react-query';
import { Link, Navigate, Outlet, useLocation, useNavigate } from '@tanstack/react-router';
import { lazy, Suspense, useState } from 'react';
import { useT } from '../lib/i18n-hook';
import {
  Avatar,
  BrandMark,
  BrandWordmark,
  Dialog,
  ErrorState,
  Icon,
  Select,
  Spinner,
  buttonClass,
  cx,
  focusRing,
  type IconName,
} from '../components/ui';
import { changeLocale } from '../i18n';
import {
  NAV_ITEMS,
  canOpen,
  featureSet,
  visibleNavItems,
  type NavItem,
  type NavKey,
} from '../lib/nav';
import { OrgProvider, useOrg, useOrgOrNull } from '../lib/org';
import { usePresentation } from '../lib/presentation';
import { THEME_PREFERENCES, useThemePreference, type ThemePreference } from '../lib/theme';
import { meQuery } from '../lib/queries';
import { useSignOut } from '../lib/use-sign-out';
import { BottomNav } from './BottomNav';
import { NAV_PATHS } from './nav-paths';

/**
 * Only the account dialog shows it: its own chunk, with Better Auth behind it. If that code cannot
 * be loaded (offline, or a new version was deployed meanwhile) the dialog says so and offers a
 * reload, instead of the error taking over the whole page.
 */
const ChangePasswordForm = lazy(() =>
  import('../features/account/ChangePasswordForm').then(
    (module) => ({ default: module.ChangePasswordForm }),
    (error: unknown) => ({
      default: () => <ErrorState error={error} onRetry={() => window.location.reload()} />,
    }),
  ),
);

/** The interface language (es-PE or English), remembered by the browser. */
function LanguageSelect({ className }: { className?: string }) {
  const { t, i18n } = useT();
  return (
    <Select
      value={i18n.language}
      // A failed load (offline) leaves the language as it was; the select follows i18n.language.
      onChange={(event) =>
        void changeLocale(event.target.value as SupportedLocale).catch(() => undefined)
      }
      {...(className ? { className } : {})}
    >
      {SUPPORTED_LOCALES.map((locale) => (
        <option key={locale} value={locale}>
          {t(`shell.locales.${locale === 'es-PE' ? 'esPE' : 'en'}`)}
        </option>
      ))}
    </Select>
  );
}

/** Light, dark or the system's theme, remembered by the browser. */
function ThemeSelect() {
  const { t } = useT();
  const [preference, setPreference] = useThemePreference();
  return (
    <Select
      value={preference}
      onChange={(event) => setPreference(event.target.value as ThemePreference)}
    >
      {THEME_PREFERENCES.map((option) => (
        <option key={option} value={option}>
          {t(`shell.themes.${option}`)}
        </option>
      ))}
    </Select>
  );
}

/** Groups of the side navigation: the work first, then the setup pages. */
const SETUP_KEYS: ReadonlySet<NavKey> = new Set(['settings']);

/** Glyph of each entry (the icon catalog in components/ui/Icon.tsx). */
export function navIcon(key: NavKey): IconName {
  return key;
}

/** Layout of every organization page: side navigation (desktop) or header + bottom bar (phones). */
export function AppShell() {
  const org = useOrgOrNull();
  const { data: me } = useQuery(meQuery());
  if (!org) {
    // Signed out (the login navigation is under way) or no longer a member: leave the org.
    return me ? <Navigate to="/" replace /> : null;
  }
  return (
    <OrgProvider value={org}>
      <Shell />
    </OrgProvider>
  );
}

function Shell() {
  const { t } = useT();
  const { orgId, permissions, features } = useOrg();
  const presentation = usePresentation();
  const [accountOpen, setAccountOpen] = useState(false);
  const { data: me } = useQuery(meQuery());
  const items = visibleNavItems(permissions, features);
  const openAccount = () => setAccountOpen(true);

  return (
    <div className="flex min-h-dvh">
      <Sidebar items={items} onOpenAccount={openAccount} />
      <div className="flex min-w-0 flex-1 flex-col">
        <PhoneHeader onOpenAccount={openAccount} />
        {presentation.enabled ? (
          <div
            role="status"
            className="no-print flex items-center gap-3 border-b border-amber-200 bg-amber-50 px-4 py-1.5 text-xs font-medium text-amber-900 md:justify-center md:py-2"
          >
            <Icon name="eye-off" className="size-4 text-amber-600" />
            <span className="min-w-0 flex-1 leading-snug md:flex-none">
              {t('presentation.banner')}
            </span>
            <button
              type="button"
              onClick={() => presentation.setEnabled(false)}
              className={cx(
                'shrink-0 rounded-full bg-amber-100 px-3 py-1.5 font-semibold text-amber-900 ring-1 ring-amber-600/20 ring-inset hover:bg-amber-200',
                focusRing,
              )}
            >
              {t('presentation.turnOff')}
            </button>
          </div>
        ) : null}
        {/* Bottom padding: the phone's bottom navigation covers the end of the page. */}
        <main
          id="main"
          className="min-w-0 flex-1 p-4 pb-[calc(5rem+env(safe-area-inset-bottom))] md:px-6 md:py-6 lg:px-8 lg:py-7"
        >
          <div className="mx-auto w-full max-w-[100rem]">
            <Outlet />
          </div>
        </main>
      </div>
      <BottomNav orgId={orgId} items={items} />
      <Dialog
        open={accountOpen}
        onClose={() => setAccountOpen(false)}
        title={t('shell.account')}
        description={me ? (presentation.email(me.user.email ?? null) ?? undefined) : undefined}
        icon={me ? <Avatar name={presentation.person(me.user.name)} size="lg" /> : undefined}
        size="sm"
      >
        {accountOpen ? (
          <div className="flex flex-col gap-6">
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium text-slate-700">{t('shell.language')}</span>
              <LanguageSelect />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium text-slate-700">{t('shell.theme')}</span>
              <ThemeSelect />
            </label>
            {me?.platformAdmin ? (
              <Link to="/plataforma" className={buttonClass()}>
                <Icon name="settings" className="size-4" />
                {t('shell.platformConsole')}
              </Link>
            ) : null}
            <div className="border-t border-slate-100 pt-5">
              <Suspense
                fallback={
                  <div className="flex justify-center py-10 text-indigo-600">
                    <Spinner />
                  </div>
                }
              >
                <ChangePasswordForm onDone={() => setAccountOpen(false)} />
              </Suspense>
            </div>
          </div>
        ) : null}
      </Dialog>
    </div>
  );
}

/** The organization: a switcher when the user belongs to several, else its name. */
function OrgSwitcher({ compact = false }: { compact?: boolean }) {
  const { t } = useT();
  const { orgId, organization } = useOrg();
  const { data: me } = useQuery(meQuery());
  const navigate = useNavigate();
  const location = useLocation();

  async function switchOrganization(nextOrgId: string) {
    const next = me?.memberships.find((m) => m.organization.id === nextOrgId);
    if (!next) return;
    // Stay on the same section when the other membership can see it.
    const segment = location.pathname.split('/')[3];
    const item = NAV_ITEMS.find((candidate) => candidate.segment === segment);
    if (item && canOpen(item, new Set(next.permissions), featureSet(next.features))) {
      await navigate({ to: NAV_PATHS[item.key], params: { orgId: nextOrgId } });
    } else {
      await navigate({ to: '/o/$orgId', params: { orgId: nextOrgId } });
    }
  }

  const several = me !== undefined && me !== null && me.memberships.length > 1;

  if (compact) {
    return several ? (
      <Select
        aria-label={t('shell.organization')}
        value={orgId}
        onChange={(event) => void switchOrganization(event.target.value)}
        className="h-10 w-auto max-w-full min-w-0 border-transparent! bg-transparent! pl-1.5! text-base! font-semibold shadow-none! hover:bg-slate-100!"
      >
        {me.memberships.map((m) => (
          <option key={m.organization.id} value={m.organization.id}>
            {m.organization.name}
          </option>
        ))}
      </Select>
    ) : (
      <span className="truncate px-1.5 text-[15px] font-semibold text-slate-900">
        {organization.name}
      </span>
    );
  }

  const tile = (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute top-1/2 left-2 flex size-7 -translate-y-1/2 items-center justify-center rounded-md bg-slate-900 text-xs font-semibold text-white dark:text-slate-950"
    >
      {organization.name.trim().charAt(0).toUpperCase() || '?'}
    </span>
  );
  return (
    <div className="relative">
      {tile}
      {several ? (
        <Select
          aria-label={t('shell.organization')}
          value={orgId}
          onChange={(event) => void switchOrganization(event.target.value)}
          className="h-11 border-slate-200! bg-slate-50! pl-11! text-sm! font-semibold shadow-none! hover:bg-slate-100!"
        >
          {me.memberships.map((m) => (
            <option key={m.organization.id} value={m.organization.id}>
              {m.organization.name}
            </option>
          ))}
        </Select>
      ) : (
        <div className="flex h-11 items-center rounded-lg border border-slate-200 bg-slate-50 pr-3 pl-11 text-sm font-semibold text-slate-900">
          <span className="truncate">{organization.name}</span>
        </div>
      )}
    </div>
  );
}

/** Desktop navigation: brand, organization, pages with icons, then presentation mode and account. */
function Sidebar({
  items,
  onOpenAccount,
}: {
  items: readonly NavItem[];
  onOpenAccount: () => void;
}) {
  const { t } = useT();
  const { orgId } = useOrg();
  const groups = [
    { key: 'work' as const, items: items.filter((item) => !SETUP_KEYS.has(item.key)) },
    { key: 'setup' as const, items: items.filter((item) => SETUP_KEYS.has(item.key)) },
  ].filter((group) => group.items.length > 0);

  return (
    <aside className="no-print sticky top-0 hidden h-dvh w-60 shrink-0 flex-col border-r border-slate-200 bg-surface md:flex lg:w-64">
      <div className="flex h-16 shrink-0 items-center px-4">
        <Link
          to="/o/$orgId"
          params={{ orgId }}
          className={cx('-m-1 flex items-center rounded-lg p-1 pl-1.5', focusRing)}
        >
          <BrandWordmark name={t('common:appName')} />
        </Link>
      </div>
      <div className="shrink-0 px-3">
        <OrgSwitcher />
      </div>
      <nav
        aria-label={t('shell.mainNav')}
        className="min-h-0 flex-1 overflow-y-auto px-3 pt-2 pb-4"
      >
        {groups.map((group) => (
          <div key={group.key} className="mt-4 first:mt-3">
            <p
              id={`nav-group-${group.key}`}
              className="px-2.5 pb-1.5 text-[11px] font-semibold tracking-wider text-slate-400 uppercase"
            >
              {t(`shell.navGroups.${group.key}`)}
            </p>
            <ul aria-labelledby={`nav-group-${group.key}`} className="flex flex-col gap-0.5">
              {group.items.map((item) => (
                <li key={item.key}>
                  <Link
                    to={NAV_PATHS[item.key]}
                    params={{ orgId }}
                    className={cx(
                      'group flex h-9 items-center gap-3 rounded-lg px-2.5 text-sm font-medium text-slate-600 transition-colors',
                      'hover:bg-slate-100 hover:text-slate-900',
                      'data-[status=active]:bg-indigo-50 data-[status=active]:text-indigo-700',
                      focusRing,
                    )}
                    activeOptions={{ includeSearch: false }}
                  >
                    <Icon
                      name={navIcon(item.key)}
                      className="size-[18px] text-slate-400 transition-colors group-hover:text-slate-500 group-data-[status=active]:text-indigo-600 dark:group-data-[status=active]:text-indigo-400"
                    />
                    <span className="min-w-0 flex-1 truncate">{t(`nav.${item.key}`)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>
      <div className="flex shrink-0 flex-col gap-1 border-t border-slate-200 p-3">
        <PresentationToggle />
        <div className="flex items-center gap-1">
          <AccountButton onOpen={onOpenAccount} />
          <SignOutButton />
        </div>
      </div>
    </aside>
  );
}

/** Phones (below `md`): brand, organization, presentation mode, account and sign-out. */
function PhoneHeader({ onOpenAccount }: { onOpenAccount: () => void }) {
  const { t } = useT();
  const { orgId, organization } = useOrg();
  return (
    <header className="no-print sticky top-0 z-30 flex h-12 items-center gap-0.5 border-b border-slate-200/80 bg-surface/95 pr-1 pl-1.5 backdrop-blur-md backdrop-saturate-150 md:hidden">
      <Link
        to="/o/$orgId"
        params={{ orgId }}
        aria-label={t('shell.home', { name: organization.name })}
        className={cx('flex size-11 shrink-0 items-center justify-center rounded-xl', focusRing)}
      >
        <BrandMark className="size-7" />
      </Link>
      <div className="flex min-w-0 flex-1 items-center">
        <OrgSwitcher compact />
      </div>
      <PresentationToggle compact />
      <AccountButton compact onOpen={onOpenAccount} />
      <SignOutButton compact />
    </header>
  );
}

/** "Modo presentación": a switch in the sidebar, an eye button in the phone header. */
function PresentationToggle({ compact = false }: { compact?: boolean }) {
  const { t } = useT();
  const presentation = usePresentation();
  const on = presentation.enabled;
  const toggle = () => presentation.setEnabled(!on);
  if (compact) {
    return (
      <button
        type="button"
        aria-pressed={on}
        title={t('presentation.toggleHint')}
        onClick={toggle}
        className={cx(
          'flex size-11 shrink-0 items-center justify-center rounded-full transition-colors',
          on
            ? 'bg-amber-100 text-amber-700 ring-1 ring-amber-500/30 ring-inset'
            : 'text-slate-500 hover:bg-slate-100 hover:text-slate-900',
          focusRing,
        )}
      >
        <Icon name={on ? 'eye-off' : 'eye'} className="size-[22px]" />
        {/* Phones show only the eye; the name stays for screen readers and getByRole. */}
        <span className="sr-only">{t('presentation.toggle')}</span>
      </button>
    );
  }
  return (
    <button
      type="button"
      aria-pressed={on}
      title={t('presentation.toggleHint')}
      onClick={toggle}
      className={cx(
        'flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-sm font-medium transition-colors',
        on
          ? 'bg-amber-50 text-amber-900'
          : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900',
        focusRing,
      )}
    >
      <Icon
        name={on ? 'eye-off' : 'eye'}
        className={cx('size-4', on ? 'text-amber-600' : 'text-slate-400')}
      />
      <span className="flex-1 truncate text-left text-[13px] lg:text-sm">
        {t('presentation.toggle')}
      </span>
      <span
        aria-hidden="true"
        className={cx(
          'relative h-5 w-8 shrink-0 rounded-full transition-colors',
          on ? 'bg-amber-500' : 'bg-slate-200',
        )}
      >
        <span
          className={cx(
            'absolute top-0.5 left-0.5 size-4 rounded-full bg-white shadow-sm transition-transform',
            on && 'translate-x-3',
          )}
        />
      </span>
    </button>
  );
}

/** Opens "Mi cuenta" (language, password). Its name carries the user's (masked) name. */
function AccountButton({ compact = false, onOpen }: { compact?: boolean; onOpen: () => void }) {
  const { t } = useT();
  const presentation = usePresentation();
  const { data: me } = useQuery(meQuery());
  if (!me) return null;
  const name = presentation.person(me.user.name);
  const email = presentation.email(me.user.email ?? null);
  const label = t('shell.accountOf', { name });
  if (compact) {
    return (
      <button
        type="button"
        onClick={onOpen}
        title={t('shell.account')}
        aria-label={label}
        className={cx(
          'flex size-11 shrink-0 items-center justify-center rounded-full hover:bg-slate-100',
          focusRing,
        )}
      >
        <Avatar name={name} size="sm" />
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={onOpen}
      title={t('shell.account')}
      aria-label={label}
      className={cx(
        'flex min-w-0 flex-1 items-center gap-2.5 rounded-lg p-1.5 text-left transition-colors hover:bg-slate-100',
        focusRing,
      )}
    >
      <Avatar name={name} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-slate-900">{name}</span>
        {email ? <span className="block truncate text-xs text-slate-500">{email}</span> : null}
      </span>
    </button>
  );
}

function SignOutButton({ compact = false }: { compact?: boolean }) {
  const { t } = useT();
  const logout = useSignOut();
  return (
    <button
      type="button"
      onClick={() => void logout.signOut()}
      disabled={logout.pending}
      aria-busy={logout.pending || undefined}
      title={t('shell.logout')}
      className={cx(
        'flex shrink-0 items-center justify-center text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900 disabled:opacity-60',
        compact ? 'size-11 rounded-full' : 'size-9 rounded-lg',
        focusRing,
      )}
    >
      {logout.pending ? (
        <Spinner size="sm" />
      ) : (
        <Icon name="log-out" className={compact ? 'size-[22px]' : 'size-[18px]'} />
      )}
      <span className="sr-only">{t('shell.logout')}</span>
    </button>
  );
}
