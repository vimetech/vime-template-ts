import type { ReactNode } from 'react';
import { cx } from './cx';
import { Icon, type IconName } from './Icon';

export type BadgeTone = 'gray' | 'red' | 'amber' | 'green' | 'blue' | 'indigo' | 'violet' | 'sky';

/* Tinted pills: the color says the meaning without shouting. */
const SOFT: Record<BadgeTone, string> = {
  gray: 'bg-slate-100/80 text-slate-700 ring-slate-500/20',
  red: 'bg-rose-50 text-rose-700 ring-rose-600/20',
  amber: 'bg-amber-50 text-amber-800 ring-amber-600/25',
  green: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  blue: 'bg-blue-50 text-blue-700 ring-blue-600/20',
  indigo: 'bg-indigo-50 text-indigo-700 ring-indigo-600/20',
  violet: 'bg-violet-50 text-violet-700 ring-violet-600/20',
  sky: 'bg-sky-50 text-sky-700 ring-sky-600/20',
};

/* Solid fills: only for what needs action now (blocked, critical). */
const SOLID: Record<BadgeTone, string> = {
  gray: 'bg-slate-600 text-white ring-slate-600 dark:text-slate-950',
  red: 'bg-rose-600 text-white ring-rose-600',
  amber: 'bg-amber-400 text-amber-950 ring-amber-400',
  green: 'bg-emerald-600 text-white ring-emerald-600',
  blue: 'bg-blue-600 text-white ring-blue-600',
  indigo: 'bg-indigo-600 text-white ring-indigo-600',
  violet: 'bg-violet-600 text-white ring-violet-600',
  sky: 'bg-sky-600 text-white ring-sky-600',
};

const DOTS: Record<BadgeTone, string> = {
  gray: 'bg-slate-400',
  red: 'bg-rose-500',
  amber: 'bg-amber-500',
  green: 'bg-emerald-500',
  blue: 'bg-blue-500',
  indigo: 'bg-indigo-500',
  violet: 'bg-violet-500',
  sky: 'bg-sky-500',
};

export interface BadgeProps {
  tone?: BadgeTone;
  solid?: boolean;
  /** A small status dot before the text. */
  dot?: boolean;
  /** A shared icon before the text (instead of the dot). */
  icon?: IconName;
  children: ReactNode;
  className?: string;
  title?: string;
}

export function Badge({
  tone = 'gray',
  solid = false,
  dot = false,
  icon,
  children,
  className,
  title,
}: BadgeProps) {
  return (
    <span
      title={title}
      className={cx(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs leading-4 font-medium whitespace-nowrap ring-1 ring-inset',
        solid ? SOLID[tone] : SOFT[tone],
        className,
      )}
    >
      {icon ? (
        <Icon name={icon} className="-ml-0.5 size-3.5" strokeWidth={2} />
      ) : dot ? (
        <span
          aria-hidden="true"
          className={cx('size-1.5 shrink-0 rounded-full', solid ? 'bg-current' : DOTS[tone])}
        />
      ) : null}
      {children}
    </span>
  );
}
