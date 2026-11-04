import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cx, focusRing } from './cx';
import { Icon, isIconName, type IconName } from './Icon';
import { Spinner } from './Spinner';

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost' | 'success' | 'soft';
export type ButtonSize = 'xs' | 'sm' | 'md' | 'lg';

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'border border-indigo-700/10 bg-indigo-600 text-white shadow-sm shadow-indigo-950/10 hover:bg-indigo-700 active:bg-indigo-800 dark:hover:bg-indigo-500 dark:active:bg-indigo-600',
  secondary:
    'border border-slate-300 bg-surface text-slate-700 shadow-xs hover:border-slate-400/80 hover:bg-slate-50 hover:text-slate-900 active:bg-slate-100',
  danger:
    'border border-rose-700/10 bg-rose-600 text-white shadow-sm shadow-rose-950/10 hover:bg-rose-700 active:bg-rose-800 dark:hover:bg-rose-500 dark:active:bg-rose-600',
  success:
    'border border-emerald-700/10 bg-emerald-600 text-white shadow-sm shadow-emerald-950/10 hover:bg-emerald-700 active:bg-emerald-800 dark:hover:bg-emerald-500 dark:active:bg-emerald-600',
  ghost:
    'border border-transparent bg-transparent text-slate-600 hover:bg-slate-100 hover:text-slate-900 active:bg-slate-200/70',
  soft: 'border border-transparent bg-indigo-50 text-indigo-700 hover:bg-indigo-100 active:bg-indigo-200/70',
};

/*
 * Heights: xs 28 px, sm 32 px, md 36 px (44 px on touch screens, the thumb's minimum), lg 44 px.
 */
const SIZES: Record<ButtonSize, string> = {
  xs: 'h-7 rounded-md px-2 text-xs gap-1',
  sm: 'h-8 rounded-lg px-3 text-sm gap-1.5',
  md: 'h-9 rounded-lg px-3.5 text-sm gap-2 pointer-coarse:min-h-11 pointer-coarse:px-4',
  lg: 'h-11 rounded-xl px-5 text-base gap-2',
};

const ICON_SIZES: Record<ButtonSize, string> = {
  xs: 'size-3.5',
  sm: 'size-4',
  md: 'size-4',
  lg: 'size-5',
};

const BASE = cx(
  'inline-flex shrink-0 items-center justify-center font-medium whitespace-nowrap select-none',
  'transition-[color,background-color,border-color,box-shadow] duration-150',
  'disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none',
  focusRing,
);

/** Classes of a button, also for links that look like buttons. */
export function buttonClass(variant: ButtonVariant = 'secondary', size: ButtonSize = 'md'): string {
  return cx(BASE, VARIANTS[variant], SIZES[size]);
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  /** Leading content: a node, or the name of a shared icon. */
  icon?: ReactNode | IconName;
  /** Trailing icon (a chevron, an external-link arrow). */
  trailingIcon?: IconName;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  icon,
  trailingIcon,
  className,
  children,
  disabled,
  type = 'button',
  ...rest
}: ButtonProps) {
  const leading = isIconName(icon) ? <Icon name={icon} className={ICON_SIZES[size]} /> : icon;
  return (
    <button
      type={type}
      className={cx(buttonClass(variant, size), className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <Spinner size="sm" /> : leading}
      {children}
      {trailingIcon ? <Icon name={trailingIcon} className={ICON_SIZES[size]} /> : null}
    </button>
  );
}

export interface IconButtonProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'children' | 'aria-label'
> {
  /** The button's accessible name (also its tooltip). */
  label: string;
  icon: IconName;
  variant?: ButtonVariant;
  /** sm: 32 px, md: 36 px; both grow to 44 px on touch screens. */
  size?: 'sm' | 'md';
}

/** A square button with only an icon; `label` names it for screen readers and tooltips. */
export function IconButton({
  label,
  icon,
  variant = 'ghost',
  size = 'md',
  className,
  type = 'button',
  title,
  ...rest
}: IconButtonProps) {
  return (
    <button
      type={type}
      aria-label={label}
      title={title ?? label}
      className={cx(
        BASE,
        VARIANTS[variant],
        'rounded-lg pointer-coarse:size-11',
        size === 'sm' ? 'size-8' : 'size-9',
        className,
      )}
      {...rest}
    >
      <Icon name={icon} className={size === 'sm' ? 'size-4' : 'size-[18px]'} />
    </button>
  );
}
