import { cx } from './cx';

export function Spinner({
  size = 'md',
  label,
  className,
}: {
  size?: 'sm' | 'md' | 'lg';
  label?: string;
  className?: string;
}) {
  const dimension = size === 'sm' ? 'size-4' : size === 'lg' ? 'size-7' : 'size-5';
  return (
    <span
      role={label ? 'status' : undefined}
      className={cx('inline-flex items-center gap-2.5', className)}
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        fill="none"
        className={cx(dimension, 'shrink-0 animate-spin')}
      >
        <circle cx="12" cy="12" r="9.5" stroke="currentColor" strokeOpacity="0.2" strokeWidth="3" />
        <path
          d="M21.5 12A9.5 9.5 0 0 0 12 2.5"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
        />
      </svg>
      {label ? <span className="text-sm text-slate-500">{label}</span> : null}
    </span>
  );
}
