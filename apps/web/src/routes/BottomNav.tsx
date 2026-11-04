import { Link, useLocation } from '@tanstack/react-router';
import { useState } from 'react';
import { useT } from '../lib/i18n-hook';
import { Dialog, Icon, cx, focusRing } from '../components/ui';
import { splitBottomNav, type NavItem } from '../lib/nav';
import { navIcon } from './AppShell';
import { NAV_PATHS } from './nav-paths';

/*
 * Navigation of the web app on a phone (below `md`): a bar fixed to the bottom edge, in
 * reach of the thumb, with the first pages of the menu and the rest behind "Más" (a bottom sheet).
 * Desktop keeps the side navigation.
 */

/** Height of the bar above the safe area: pages with their own fixed bottom bar sit above it. */
export const BOTTOM_NAV_HEIGHT = '4rem';

export function BottomNav({ orgId, items }: { orgId: string; items: readonly NavItem[] }) {
  const { t } = useT();
  const location = useLocation();
  const [moreOpen, setMoreOpen] = useState(false);
  const { primary, more } = splitBottomNav(items);
  const segment = location.pathname.split('/')[3];
  const moreActive = more.some((item) => item.segment === segment);

  return (
    <>
      <nav
        aria-label={t('shell.mainNav')}
        className="no-print fixed inset-x-0 bottom-0 z-30 border-t border-slate-200/80 bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur-md backdrop-saturate-150 md:hidden"
      >
        <ul className="flex h-16">
          {primary.map((item) => (
            <li key={item.key} className="min-w-0 flex-1">
              <Link
                to={NAV_PATHS[item.key]}
                params={{ orgId }}
                className={cx(
                  tabClass,
                  'text-slate-500 data-[status=active]:text-indigo-700',
                  focusRing,
                )}
                activeOptions={{ includeSearch: false }}
              >
                <span className={cx(pillClass, 'group-data-[status=active]:bg-indigo-50')}>
                  <Icon name={navIcon(item.key)} className="size-[22px]" />
                </span>
                <span className="max-w-full truncate">{t(`nav.${item.key}`)}</span>
              </Link>
            </li>
          ))}
          {more.length > 0 ? (
            <li className="min-w-0 flex-1">
              <button
                type="button"
                onClick={() => setMoreOpen(true)}
                aria-haspopup="dialog"
                className={cx(
                  tabClass,
                  'w-full',
                  moreActive ? 'text-indigo-700' : 'text-slate-500',
                  focusRing,
                )}
              >
                <span className={cx(pillClass, moreActive && 'bg-indigo-50')}>
                  <Icon name="more" className="size-[22px]" />
                </span>
                <span className="max-w-full truncate">{t('nav.more')}</span>
              </button>
            </li>
          ) : null}
        </ul>
      </nav>
      <Dialog
        open={moreOpen}
        onClose={() => setMoreOpen(false)}
        title={t('nav.more')}
        placement="sheet"
        bodyClassName="px-2 py-2 sm:px-3"
      >
        <ul className="flex flex-col pb-2">
          {more.map((item) => (
            <li key={item.key}>
              <Link
                to={NAV_PATHS[item.key]}
                params={{ orgId }}
                onClick={() => setMoreOpen(false)}
                className={cx(
                  'group flex min-h-14 items-center gap-3.5 rounded-xl px-2.5 text-[15px] font-medium text-slate-800 transition-colors active:bg-slate-100',
                  'data-[status=active]:bg-indigo-50/70 data-[status=active]:text-indigo-800',
                  focusRing,
                )}
                activeOptions={{ includeSearch: false }}
              >
                <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-slate-100 text-slate-600 group-data-[status=active]:bg-indigo-600 group-data-[status=active]:text-white">
                  <Icon name={navIcon(item.key)} className="size-5" />
                </span>
                <span className="min-w-0 flex-1 truncate">{t(`nav.${item.key}`)}</span>
                <Icon
                  name="chevron-right"
                  className="size-4 text-slate-300 group-data-[status=active]:text-indigo-400"
                />
              </Link>
            </li>
          ))}
        </ul>
      </Dialog>
    </>
  );
}

const tabClass =
  'group flex h-full flex-col items-center justify-center gap-0.5 px-0.5 text-[11px] font-medium transition-colors';

/** The tinted pill behind the icon of the current page (iOS / Material style). */
const pillClass =
  'flex h-7 w-12 items-center justify-center rounded-full transition-colors duration-200';
