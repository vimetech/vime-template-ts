import type {
  HTMLAttributes,
  ReactNode,
  TableHTMLAttributes,
  TdHTMLAttributes,
  ThHTMLAttributes,
} from 'react';
import { cx } from './cx';

/**
 * A table in a rounded white frame that scrolls sideways when it is wider than the page (never
 * clipped). The header row sticks while the frame scrolls vertically: give it a height with
 * `maxHeight` (e.g. `max-h-[70dvh]`) to get that.
 */
export function Table({
  className,
  children,
  caption,
  maxHeight,
  containerClassName,
  ...props
}: TableHTMLAttributes<HTMLTableElement> & {
  caption?: ReactNode;
  /** Height limit of the frame (a `max-h-*` class): it scrolls inside, header row pinned. */
  maxHeight?: string;
  containerClassName?: string;
}) {
  return (
    <div
      className={cx(
        'overflow-x-auto overscroll-x-contain rounded-xl border border-slate-200 bg-surface shadow-card',
        maxHeight && cx('overflow-y-auto', maxHeight),
        containerClassName,
      )}
    >
      <table className={cx('w-full border-collapse text-sm', className)} {...props}>
        {caption ? <caption className="sr-only">{caption}</caption> : null}
        {children}
      </table>
    </div>
  );
}

export function THead({ children }: { children: ReactNode }) {
  return (
    <thead className="sticky top-0 z-10 bg-slate-50/95 text-left text-xs font-medium text-slate-500 backdrop-blur-sm">
      {children}
    </thead>
  );
}

export function TBody({ children }: { children: ReactNode }) {
  return <tbody className="divide-y divide-slate-100">{children}</tbody>;
}

export function Tr({ className, ...props }: HTMLAttributes<HTMLTableRowElement>) {
  return (
    <tr
      className={cx('align-top transition-colors [tbody_&]:hover:bg-slate-50/70', className)}
      {...props}
    />
  );
}

export function Th({ className, ...props }: ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      scope="col"
      className={cx(
        'px-3 py-2.5 font-medium whitespace-nowrap shadow-[inset_0_-1px_0_var(--color-slate-200)] first:pl-4 last:pr-4',
        className,
      )}
      {...props}
    />
  );
}

export function Td({ className, ...props }: TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={cx('px-3 py-3 first:pl-4 last:pr-4', className)} {...props} />;
}
