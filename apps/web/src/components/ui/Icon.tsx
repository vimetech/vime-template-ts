import type { ReactNode } from 'react';
import { cx } from './cx';

/*
 * Line icons of the web app: 24 × 24 grid, stroke in the current color, round caps. A string is
 * one path; anything else is SVG children. Decorative by default (`aria-hidden`); pass `label` when
 * the icon alone carries meaning.
 */
const ICONS = {
  // Navigation
  notes: (
    <>
      <rect x="4.5" y="3.5" width="15" height="17" rx="2" />
      <path d="M8.5 8.5h7M8.5 12h7M8.5 15.5h4" />
    </>
  ),
  grid: (
    <>
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
    </>
  ),
  checks:
    'M4 6.5l1.5 1.5L8 5.5M4 12.5l1.5 1.5L8 11.5M4 18.5l1.5 1.5L8 17.5M11.5 7h8.5M11.5 13h8.5M11.5 19h8.5',
  flag: 'M5 21V4.5M5 4.5c1.2-.8 2.4-1.1 3.6-1.1 2.6 0 4.2 1.7 6.8 1.7 1.2 0 2.4-.3 3.6-1v10c-1.2.7-2.4 1-3.6 1-2.6 0-4.2-1.7-6.8-1.7-1.2 0-2.4.3-3.6 1.1',
  wrench:
    'M14.7 6.3a4.2 4.2 0 0 0-5.6 5.3l-5.3 5.3a1.6 1.6 0 0 0 0 2.3l.1.1a1.6 1.6 0 0 0 2.3 0l5.3-5.3a4.2 4.2 0 0 0 5.3-5.6l-2.5 2.5-2.2-.6-.6-2.2z',
  repeat:
    'M3.5 12a8.5 8.5 0 0 1 14.6-5.9l2.4 2.4M20.5 3.5v5h-5M20.5 12a8.5 8.5 0 0 1-14.6 5.9l-2.4-2.4M3.5 20.5v-5h5',
  'calendar-check': (
    <>
      <rect x="3.5" y="5" width="17" height="15.5" rx="2.5" />
      <path d="M3.5 10h17M8 3v4M16 3v4M9 15l2 2 4-4" />
    </>
  ),
  plug: 'M9 3v5M15 3v5M6.5 8h11v3.5a5.5 5.5 0 0 1-11 0V8zM12 17v4',
  settings: (
    <>
      <path d="M4 7h9M17 7h3M4 17h3M11 17h9" />
      <circle cx="15" cy="7" r="2" />
      <circle cx="9" cy="17" r="2" />
    </>
  ),
  more: (
    <>
      <circle cx="5.5" cy="12" r="1.25" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.25" fill="currentColor" stroke="none" />
      <circle cx="18.5" cy="12" r="1.25" fill="currentColor" stroke="none" />
    </>
  ),

  // Actions and directions
  x: 'M6 6l12 12M18 6 6 18',
  check: 'M20 6.5 9.5 17 4 11.5',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  'chevron-left': 'M15 18l-6-6 6-6',
  'chevron-right': 'M9 18l6-6-6-6',
  'chevron-down': 'M6 9l6 6 6-6',
  'chevron-up': 'M18 15l-6-6-6 6',
  'chevrons-up-down': 'M8 9.5l4-4 4 4M8 14.5l4 4 4-4',
  'arrow-left': 'M19 12H5M11.5 18.5 5 12l6.5-6.5',
  'arrow-right': 'M5 12h14M12.5 5.5 19 12l-6.5 6.5',
  'external-link':
    'M14 4h6v6M20 4l-9 9M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10',
  'more-horizontal': (
    <>
      <circle cx="5.5" cy="12" r="1.25" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.25" fill="currentColor" stroke="none" />
      <circle cx="18.5" cy="12" r="1.25" fill="currentColor" stroke="none" />
    </>
  ),
  'more-vertical': (
    <>
      <circle cx="12" cy="5.5" r="1.25" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.25" fill="currentColor" stroke="none" />
      <circle cx="12" cy="18.5" r="1.25" fill="currentColor" stroke="none" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m20 20-4.2-4.2" />
    </>
  ),
  filter: 'M4 6h16M7 12h10M10 18h4',
  refresh:
    'M20 12a8 8 0 0 1-13.7 5.6L4 15.5M4 20v-4.5h4.5M4 12a8 8 0 0 1 13.7-5.6L20 8.5M20 4v4.5h-4.5',
  download: 'M12 3.5v12M7 11l5 5 5-5M4.5 20.5h15',
  upload: 'M12 16V4M7 8.5l5-5 5 5M4.5 20.5h15',
  printer: (
    <>
      <path d="M7 9V3.5h10V9M7 17.5H5a2 2 0 0 1-2-2V11a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v4.5a2 2 0 0 1-2 2h-2" />
      <rect x="7" y="14" width="10" height="7" rx="1" />
    </>
  ),
  send: 'M21 3 10.5 13.5M21 3l-6.5 18-4-7.5L3 9.5z',
  pencil: 'M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16zM13.5 6.5l4 4',
  trash: 'M4 7h16M9.5 7V4.5h5V7M6 7l1 13h10l1-13M10 11v5.5M14 11v5.5',
  copy: (
    <>
      <rect x="8.5" y="8.5" width="12" height="12" rx="2" />
      <path d="M15.5 8.5V5.5a2 2 0 0 0-2-2h-8a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h3" />
    </>
  ),
  'log-out': 'M9.5 20.5h-4a2 2 0 0 1-2-2v-13a2 2 0 0 1 2-2h4M15.5 16.5 20 12l-4.5-4.5M20 12H9.5',

  // Status and feedback
  'check-circle': (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m8.5 12.5 2.5 2.5 4.5-5" />
    </>
  ),
  'x-circle': (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m9.5 9.5 5 5M14.5 9.5l-5 5" />
    </>
  ),
  'alert-triangle':
    'M10.3 4.4 2.9 17.3A2 2 0 0 0 4.6 20.3h14.8a2 2 0 0 0 1.7-3L13.7 4.4a2 2 0 0 0-3.4 0zM12 9.5v4M12 17h.01',
  'alert-circle': (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5v5M12 16.5h.01" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5.5M12 7.5h.01" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3.2 2" />
    </>
  ),
  calendar: (
    <>
      <rect x="3.5" y="5" width="17" height="15.5" rx="2.5" />
      <path d="M3.5 10h17M8 3v4M16 3v4" />
    </>
  ),
  sparkles:
    'M11 3.5l1.7 4.8 4.8 1.7-4.8 1.7L11 16.5l-1.7-4.8L4.5 10l4.8-1.7zM18.5 14.5v5M16 17h5M5.5 16.5v3M4 18h3',
  eye: (
    <>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  'eye-off':
    'M3 3l18 18M10.6 5.6A9.6 9.6 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a16.7 16.7 0 0 1-2.6 3.4M6.6 6.6C3.9 8.3 2.5 12 2.5 12S6 18.5 12 18.5a9.3 9.3 0 0 0 5.4-1.7M9.9 9.9a3 3 0 0 0 4.2 4.2',
  lock: (
    <>
      <rect x="4.5" y="10.5" width="15" height="10" rx="2" />
      <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" />
    </>
  ),
  key: (
    <>
      <circle cx="8" cy="15" r="4.5" />
      <path d="M11.2 11.8 20 3M16.5 6.5 19 9M14 9l2 2" />
    </>
  ),

  // Things
  user: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4.5 20.5a7.5 7.5 0 0 1 15 0" />
    </>
  ),
  users: (
    <>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.8a3.5 3.5 0 0 1 0 6.4M18 14a6.5 6.5 0 0 1 3.5 6" />
    </>
  ),
  'user-plus': (
    <>
      <circle cx="9.5" cy="8" r="3.5" />
      <path d="M3 20a6.5 6.5 0 0 1 13 0M19 8v6M16 11h6" />
    </>
  ),
  home: 'M3.5 11 12 4l8.5 7M5.5 9.5V20h13V9.5M10 20v-5h4v5',
  building:
    'M4 21V5.5A1.5 1.5 0 0 1 5.5 4h7A1.5 1.5 0 0 1 14 5.5V21M14 9.5h4.5A1.5 1.5 0 0 1 20 11v10M2.5 21h19M7.5 8h3M7.5 12h3M7.5 16h3M17 14h.01M17 17.5h.01',
  'map-pin': (
    <>
      <path d="M12 21s-7-6.1-7-11.5a7 7 0 0 1 14 0C19 14.9 12 21 12 21z" />
      <circle cx="12" cy="9.5" r="2.5" />
    </>
  ),
  camera: (
    <>
      <path d="M14.5 4.5h-5L7.6 7H4.5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h15a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3.1z" />
      <circle cx="12" cy="13" r="3.5" />
    </>
  ),
  image: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <circle cx="9" cy="9.5" r="1.5" />
      <path d="m21 15.5-4.5-4.5L6 20" />
    </>
  ),
  phone:
    'M5 3.5h3.5l1.5 4.5-2.2 1.4a11 11 0 0 0 4.8 4.8L14 12l4.5 1.5V17a2 2 0 0 1-2 2A13.5 13.5 0 0 1 3 5.5a2 2 0 0 1 2-2z',
  mail: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2.5" />
      <path d="m3.5 7 8.5 6 8.5-6" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z" />
    </>
  ),
  list: 'M8.5 6.5h12M8.5 12h12M8.5 17.5h12M4 6.5h.01M4 12h.01M4 17.5h.01',
  coins: (
    <>
      <circle cx="9" cy="9" r="5.5" />
      <path d="M17.2 10.3a5.5 5.5 0 1 1-6.9 6.9M9 7v4M7.5 8.5h2.2" />
    </>
  ),
  bell: 'M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15zM10 20.5a2.2 2.2 0 0 0 4 0',

  // More glyphs
  'calendar-range': (
    <>
      <rect x="3.5" y="5" width="17" height="15.5" rx="2.5" />
      <path d="M3.5 10h17M8 3v4M16 3v4M7 14h6M11 17.5h6" />
    </>
  ),
  bolt: 'M13 2.5 5 13.5h6l-1 8 8-11h-6z',
  'user-x': (
    <>
      <circle cx="9.5" cy="8" r="3.5" />
      <path d="M3 20a6.5 6.5 0 0 1 13 0M17.5 8.5l4 4M21.5 8.5l-4 4" />
    </>
  ),
  hourglass:
    'M6.5 3.5h11M6.5 20.5h11M7.5 3.5c0 4 4.5 5.5 4.5 8.5s-4.5 4.5-4.5 8.5M16.5 3.5c0 4-4.5 5.5-4.5 8.5s4.5 4.5 4.5 8.5',
  pause: 'M9 6v12M15 6v12',
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof ICONS;

/** Every icon name (a gallery or a test can list them). */
export const ICON_NAMES = Object.keys(ICONS) as IconName[];

/** True for the name of an icon of this set. */
export function isIconName(value: unknown): value is IconName {
  return typeof value === 'string' && Object.hasOwn(ICONS, value);
}

export interface IconProps {
  name: IconName;
  /** Size and color utilities; defaults to `size-5`. */
  className?: string;
  strokeWidth?: number;
  /** Accessible name when the icon alone carries meaning; otherwise it is hidden from AT. */
  label?: string;
}

export function Icon({ name, className, strokeWidth = 1.75, label }: IconProps) {
  const glyph: ReactNode = ICONS[name];
  const classes = className ?? '';
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      focusable="false"
      className={cx('shrink-0', !/(^|\s)(size|h|w)-/.test(classes) && 'size-5', className)}
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
    >
      {typeof glyph === 'string' ? <path d={glyph} /> : glyph}
    </svg>
  );
}
