import type { ReactNode } from 'react';
import { useT } from '../../lib/i18n-hook';
import { ApiProblem } from '../../lib/api';
import { problemText } from '../../lib/problems';
import { Button } from './Button';
import { cx } from './cx';
import { Icon, type IconName } from './Icon';
import { Spinner } from './Spinner';

/** A placeholder bar that shimmers while its content loads (size it with classes). */
export function Skeleton({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cx(
        'block animate-shimmer rounded-md bg-[linear-gradient(90deg,var(--color-slate-200)_0%,var(--color-slate-100)_50%,var(--color-slate-200)_100%)] bg-[length:200%_100%]',
        className ?? 'h-4 w-full',
      )}
    />
  );
}

/**
 * Something is loading. `spinner` (default): a centered spinner with its label. `skeleton`: a few
 * shimmering rows shaped like a list (the label stays for screen readers).
 */
export function LoadingState({
  label,
  variant = 'spinner',
  rows = 4,
  className,
}: {
  label?: string;
  variant?: 'spinner' | 'skeleton';
  rows?: number;
  className?: string;
}) {
  const { t } = useT();
  const text = label ?? t('states.loading');
  if (variant === 'skeleton') {
    return (
      <div
        role="status"
        className={cx(
          'flex flex-col divide-y divide-slate-100 rounded-xl border border-slate-200 bg-surface shadow-card',
          className,
        )}
      >
        <span className="sr-only">{text}</span>
        {Array.from({ length: rows }, (_, index) => (
          <div key={index} className="flex items-center gap-3 px-4 py-3.5">
            <Skeleton className="size-9 shrink-0 rounded-lg" />
            <div className="flex flex-1 flex-col gap-2">
              <Skeleton className={cx('h-3.5', index % 2 === 0 ? 'w-2/5' : 'w-1/3')} />
              <Skeleton className={cx('h-3', index % 2 === 0 ? 'w-3/5' : 'w-1/2')} />
            </div>
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className={cx('flex items-center justify-center py-16 text-indigo-600', className)}>
      <Spinner size="lg" label={text} />
    </div>
  );
}

/**
 * Nothing to show yet: what this place is for and what to do next. `children` (or `hint`) is the
 * explanation; `action` the next step (a button).
 */
export function EmptyState({
  title,
  children,
  hint,
  icon,
  action,
  bare = false,
  className,
}: {
  title: ReactNode;
  children?: ReactNode;
  hint?: ReactNode;
  icon?: IconName;
  action?: ReactNode;
  /** No frame (inside a card that already has one). */
  bare?: boolean;
  className?: string;
}) {
  const body = children ?? hint;
  return (
    <div
      className={cx(
        'flex flex-col items-center px-6 text-center',
        bare
          ? 'py-10'
          : 'rounded-xl border border-dashed border-slate-300 bg-surface/70 py-12 sm:py-14',
        className,
      )}
    >
      {icon ? (
        <span className="mb-4 flex size-12 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600 ring-1 ring-indigo-100">
          <Icon name={icon} className="size-6" />
        </span>
      ) : null}
      <p className="text-[15px] font-semibold text-slate-900">{title}</p>
      {body ? (
        <div className="mt-1.5 max-w-md text-sm leading-relaxed text-slate-500">{body}</div>
      ) : null}
      {action ? <div className="mt-5 flex flex-wrap justify-center gap-2">{action}</div> : null}
    </div>
  );
}

/** A failed request: localized message by problem code, server detail, missing requirements. */
export function ProblemAlert({ error, compact = false }: { error: unknown; compact?: boolean }) {
  const { t } = useT();
  const { message, detail } = problemText(t, error);
  const problem = error instanceof ApiProblem ? error : null;
  return (
    <div
      role="alert"
      className={cx(
        'flex items-start gap-2.5 rounded-xl border border-rose-200 bg-rose-50 text-sm text-rose-900',
        compact ? 'px-3 py-2' : 'px-3.5 py-3',
      )}
    >
      <Icon name="alert-circle" className="mt-px size-4 text-rose-600" strokeWidth={2} />
      <div className="min-w-0 flex-1">
        <p className="font-medium">{message}</p>
        {!compact && detail ? <p className="mt-0.5 text-xs text-rose-800">{detail}</p> : null}
        {problem && problem.missing.length > 0 ? (
          <ul className="mt-1 list-inside list-disc text-xs">
            {problem.missing.map((item) => (
              <li key={`${item.key}-${item.reason}`}>
                {item.key}: {item.reason}
              </li>
            ))}
          </ul>
        ) : null}
        {!compact && problem && problem.errors.length > 0 ? (
          <ul className="mt-1 list-inside list-disc text-xs">
            {problem.errors.map((item) => (
              <li key={`${item.path}-${item.message}`}>
                {item.path ? <code>{item.path}</code> : null} {item.message}
              </li>
            ))}
          </ul>
        ) : null}
        {!compact && problem?.requestId ? (
          <p className="mt-1 text-[11px] text-rose-700/80">
            {t('states.requestId', { id: problem.requestId })}
          </p>
        ) : null}
      </div>
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const { t } = useT();
  return (
    <div className="flex flex-col items-start gap-3 py-6">
      <ProblemAlert error={error} />
      {onRetry ? (
        <Button size="sm" icon="refresh" onClick={onRetry}>
          {t('actions.retry')}
        </Button>
      ) : null}
    </div>
  );
}
