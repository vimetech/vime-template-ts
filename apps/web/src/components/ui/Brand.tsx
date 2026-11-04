import { cx } from './cx';

/*
 * Lodava's provisional brand (docs/brand): the kit has no approved logo or symbol yet, so the mark
 * is typographic. Replace both components with the master SVG once it is approved.
 */

/** Compact mark for tight spots: a lowercase "l" with the Teal dot on a Midnight tile. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      aria-hidden="true"
      focusable="false"
      className={cx('shrink-0', className ?? 'size-8')}
    >
      <rect width="32" height="32" rx="9" fill="#152f3c" />
      <rect
        x="0.5"
        y="0.5"
        width="31"
        height="31"
        rx="8.5"
        fill="none"
        stroke="white"
        strokeOpacity="0.12"
      />
      <rect x="11.5" y="7" width="4.2" height="18" rx="2.1" fill="#ffffff" />
      <circle cx="21.2" cy="22.9" r="2.6" fill="#25bda7" />
    </svg>
  );
}

/**
 * The wordmark "lodava." in Manrope, ink-colored with the Teal dot. `name` is read by screen
 * readers ("Lodava").
 */
export function BrandWordmark({
  name,
  className,
  tone = 'ink',
}: {
  name: string;
  className?: string;
  /** `light`: white letters (on Midnight). */
  tone?: 'ink' | 'light';
}) {
  return (
    <span
      role="img"
      aria-label={name}
      className={cx(
        'font-display leading-none font-extrabold tracking-[-0.04em] select-none',
        tone === 'light' ? 'text-white' : 'text-slate-900',
        className ?? 'text-[22px]',
      )}
    >
      lodava<span className="text-indigo-400">.</span>
    </span>
  );
}

/** Initials of a name (first and last word): "Rocío Vargas" → "RV". */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const first = words[0]?.charAt(0) ?? '';
  const last = words.length > 1 ? (words[words.length - 1]?.charAt(0) ?? '') : '';
  return (first + last).toUpperCase() || '?';
}

const AVATAR_SIZES = {
  sm: 'size-7 text-[11px]',
  md: 'size-8 text-xs',
  lg: 'size-10 text-sm',
} as const;

/**
 * A person's initials in a circle. Pass a name already masked by `usePresentation()` (the
 * initials of a hidden surname would reveal it).
 */
export function Avatar({
  name,
  size = 'md',
  className,
}: {
  name: string;
  size?: keyof typeof AVATAR_SIZES;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cx(
        'inline-flex shrink-0 items-center justify-center rounded-full bg-linear-to-br from-indigo-100 to-indigo-200 font-semibold text-indigo-700 ring-1 ring-indigo-600/10 select-none',
        AVATAR_SIZES[size],
        className,
      )}
    >
      {initialsOf(name)}
    </span>
  );
}
