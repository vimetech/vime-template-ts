import type { ReactNode } from 'react';
import { cx } from './cx';

/**
 * Title of a page, its one-line description and its actions (the primary one last). On phones the
 * actions wrap under the title.
 */
export function PageHeader({
  title,
  description,
  actions,
  eyebrow,
  meta,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  /** A small line above the title (a section, a back link). */
  eyebrow?: ReactNode;
  /** Badges or facts next to the title. */
  meta?: ReactNode;
}) {
  return (
    <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end sm:justify-between sm:gap-x-6 md:mb-6">
      <div className="min-w-0">
        {eyebrow ? <div className="mb-1 text-sm text-slate-500">{eyebrow}</div> : null}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h1 className="text-[22px] leading-tight font-semibold tracking-tight text-slate-900 sm:text-2xl">
            {title}
          </h1>
          {meta ? <div className="flex flex-wrap items-center gap-1.5">{meta}</div> : null}
        </div>
        {description ? (
          <p className="mt-1 max-w-3xl text-sm leading-relaxed text-slate-500">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/** A white surface with an optional header (title, description, actions). */
export function Card({
  title,
  description,
  actions,
  children,
  className,
  flush = false,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  /** No padding around the content (a list or a table edge to edge). */
  flush?: boolean;
}) {
  return (
    <section className={cx('rounded-xl border border-slate-200 bg-surface shadow-card', className)}>
      {title || actions ? (
        <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-slate-100 px-4 py-3 sm:px-5">
          {title ? (
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
              {description ? (
                <p className="mt-0.5 text-xs leading-relaxed text-slate-500">{description}</p>
              ) : null}
            </div>
          ) : (
            <span />
          )}
          {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
        </header>
      ) : null}
      <div className={flush ? undefined : 'p-4 sm:p-5'}>{children}</div>
    </section>
  );
}

/** Label/value pairs in two columns. */
export function DefinitionList({ items }: { items: { label: ReactNode; value: ReactNode }[] }) {
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-5 gap-y-2 text-sm">
      {items.map((item, index) => (
        <div key={index} className="contents">
          <dt className="text-slate-500">{item.label}</dt>
          <dd className="min-w-0 text-slate-900">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
