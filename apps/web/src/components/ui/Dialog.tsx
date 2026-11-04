import { useEffect, useId, useLayoutEffect, useRef, type ReactNode } from 'react';
import { useT } from '../../lib/i18n-hook';
import { cx, focusRing } from './cx';
import { Icon } from './Icon';

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  /** Actions pinned to the bottom edge (always in reach, above the phone's safe area). */
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  /** `side`: a drawer anchored to the right edge. `sheet`: anchored to the bottom (phones). */
  placement?: 'center' | 'side' | 'sheet';
  /** Shown before the title: an icon tile or an avatar. */
  icon?: ReactNode;
  /** Extra controls in the header, before the close button. */
  headerActions?: ReactNode;
  /** Padding of the scrolling body, replacing the default (e.g. `p-0` for edge-to-edge lists). */
  bodyClassName?: string;
}

const SIZES = {
  sm: 'sm:max-w-md',
  md: 'sm:max-w-lg',
  lg: 'sm:max-w-2xl',
  xl: 'sm:max-w-4xl',
} as const;

/*
 * Panel layout per placement. Phones (below `sm`): a centered dialog rises as a bottom sheet, a
 * side drawer fills the screen. The header (title + a 44 px close button) and the footer stay put
 * while the body scrolls.
 */
const PLACEMENTS = {
  center: (size: keyof typeof SIZES) =>
    cx(
      'mx-0 mt-auto mb-0 w-full max-w-none max-h-[92dvh] rounded-t-2xl animate-sheet-up',
      'sm:m-auto sm:w-[calc(100%-2rem)] sm:max-h-[85dvh] sm:rounded-2xl sm:animate-dialog-in',
      SIZES[size],
    ),
  side: () =>
    cx(
      'm-0 h-dvh max-h-dvh w-full max-w-none rounded-none animate-drawer-in',
      'sm:ml-auto sm:max-w-2xl sm:border-l sm:border-slate-200',
    ),
  sheet: () => 'mx-0 mt-auto mb-0 w-full max-w-none max-h-[92dvh] rounded-t-2xl animate-sheet-up',
};

/**
 * Modal dialog on the native `<dialog>` element: the browser traps focus, Esc closes it and the
 * rest of the page is inert. Content is mounted only while open, so forms start fresh each time.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
  placement = 'center',
  icon,
  headerActions,
  bodyClassName,
}: DialogProps) {
  const { t } = useT();
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    if (open && !element.open) {
      if (typeof element.showModal === 'function') element.showModal();
      else element.setAttribute('open', '');
    } else if (!open && element.open) {
      if (typeof element.close === 'function') element.close();
      else element.removeAttribute('open');
    }
  }, [open]);

  // Unmounted while still open (a dialog mounted only while needed): close it first, so the
  // browser returns focus to whatever opened it. A layout cleanup runs while the <dialog> is still
  // in the document; a passive one would run after React removed it, when nothing is restored.
  useLayoutEffect(() => {
    const element = ref.current;
    return () => {
      if (!element?.open) return;
      if (typeof element.close === 'function') element.close();
      else element.removeAttribute('open');
    };
  }, []);

  const side = placement === 'side';
  const sheet = placement === 'sheet';
  // A bottom sheet on phones: centered dialogs too, below `sm`.
  const grabber = sheet || placement === 'center';
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      onCancel={(event) => {
        event.preventDefault();
        // Escape on a dialog opened inside this one (a task drawer over an incident panel)
        // closes only that one: React passes its cancel event up the tree.
        if (event.target !== ref.current) return;
        onClose();
      }}
      onClick={(event) => {
        // Clicking the backdrop of a drawer or sheet closes it (forms in centered dialogs do
        // not, to avoid losing typed data).
        if ((side || sheet) && event.target === ref.current) onClose();
      }}
      className={cx(
        'overflow-hidden bg-surface p-0 text-slate-900 shadow-pop',
        'backdrop:bg-slate-950/40 backdrop:backdrop-blur-[2px] backdrop:animate-fade-in',
        // The home indicator's strip stays clear (bottom-anchored panels only).
        sheet ? 'pb-[env(safe-area-inset-bottom)]' : 'pb-[env(safe-area-inset-bottom)] sm:pb-0',
        side ? PLACEMENTS.side() : sheet ? PLACEMENTS.sheet() : PLACEMENTS.center(size),
      )}
    >
      {open ? (
        <div
          className={cx(
            'flex flex-col',
            side
              ? 'h-full'
              : sheet
                ? 'max-h-[calc(92dvh_-_env(safe-area-inset-bottom))]'
                : 'max-h-[calc(92dvh_-_env(safe-area-inset-bottom))] sm:max-h-[85dvh]',
          )}
        >
          {grabber ? (
            <span
              aria-hidden="true"
              className={cx(
                'mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-slate-300',
                !sheet && 'sm:hidden',
              )}
            />
          ) : null}
          <header
            className={cx(
              'flex shrink-0 items-start gap-3 border-b border-slate-200/80 bg-surface pr-2 pl-4 sm:pr-4 sm:pl-6',
              side
                ? 'pt-[max(0.625rem,env(safe-area-inset-top))] pb-2.5 sm:py-4'
                : sheet
                  ? 'pt-1.5 pb-2.5 sm:pb-4'
                  : 'pt-1.5 pb-2.5 sm:py-4',
            )}
          >
            {icon ? <div className="mt-1.5 shrink-0 sm:mt-0">{icon}</div> : null}
            <div className="min-w-0 flex-1 self-center py-1 sm:py-0">
              <h2
                id={titleId}
                className="text-[17px] leading-snug font-semibold tracking-tight text-slate-900 sm:text-base"
              >
                {title}
              </h2>
              {description ? (
                <p id={descriptionId} className="mt-0.5 text-sm text-slate-500">
                  {description}
                </p>
              ) : null}
            </div>
            {headerActions ? (
              <div className="flex shrink-0 items-center gap-1 self-center">{headerActions}</div>
            ) : null}
            {/* 44 px on phones: the one obvious way out of every overlay. */}
            <button
              type="button"
              onClick={onClose}
              className={cx(
                'flex size-11 shrink-0 items-center justify-center rounded-full text-slate-500 transition-colors',
                'bg-slate-100 hover:bg-slate-200 hover:text-slate-900 active:bg-slate-300/70',
                'sm:-my-1 sm:size-9 sm:bg-transparent sm:hover:bg-slate-100',
                focusRing,
              )}
              aria-label={t('actions.close')}
              title={t('actions.close')}
            >
              <Icon name="x" className="size-5" strokeWidth={2} />
            </button>
          </header>
          <div
            className={cx(
              'min-h-0 flex-1 overflow-y-auto overscroll-contain',
              bodyClassName ?? 'px-4 py-4 sm:px-6 sm:py-5',
            )}
          >
            {children}
          </div>
          {footer ? (
            <footer className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-slate-200/80 bg-surface px-4 py-3 max-sm:*:flex-1 sm:bg-slate-50/70 sm:px-6">
              {footer}
            </footer>
          ) : null}
        </div>
      ) : null}
    </dialog>
  );
}

/**
 * The action row of a form inside a dialog body: pinned to the bottom of the dialog while the body
 * scrolls, buttons full-width on phones. Use it as the last child of the form.
 */
export function DialogActions({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cx(
        // Sticky into the body's bottom padding (-bottom = -padding), flush with the dialog edge.
        'sticky -bottom-4 z-10 -mx-4 mt-1 -mb-4 flex flex-wrap items-center justify-end gap-2 border-t border-slate-200/80 bg-surface/95 px-4 py-3 backdrop-blur',
        'max-sm:*:flex-1 sm:-bottom-5 sm:-mx-6 sm:-mb-5 sm:bg-slate-50/95 sm:px-6',
        className,
      )}
    >
      {children}
    </div>
  );
}
