import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { useT } from '../../lib/i18n-hook';
import { cx, focusRing } from './cx';
import { Icon, type IconName } from './Icon';

export type ToastTone = 'success' | 'error' | 'info';

interface ToastItem {
  id: number;
  tone: ToastTone;
  message: string;
  detail?: string | undefined;
}

interface ToastApi {
  show(tone: ToastTone, message: string, detail?: string): void;
  success(message: string, detail?: string): void;
  error(message: string, detail?: string): void;
  info(message: string, detail?: string): void;
}

const ToastContext = createContext<ToastApi | null>(null);

const TONES: Record<ToastTone, { icon: IconName; color: string; accent: string }> = {
  success: { icon: 'check-circle', color: 'text-emerald-600', accent: 'bg-emerald-500' },
  error: { icon: 'alert-circle', color: 'text-rose-600', accent: 'bg-rose-500' },
  info: { icon: 'info', color: 'text-sky-600', accent: 'bg-sky-500' },
};

let nextId = 1;

/**
 * Toast notifications in a polite live region (errors stay longer). Phones: under the header,
 * clear of the bottom navigation and of any bottom action bar. Desktop: bottom right.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const { t } = useT();
  const [items, setItems] = useState<ToastItem[]>([]);

  const dismiss = useCallback((id: number) => {
    setItems((current) => current.filter((item) => item.id !== id));
  }, []);

  const show = useCallback(
    (tone: ToastTone, message: string, detail?: string) => {
      const id = nextId++;
      setItems((current) => [...current.slice(-3), { id, tone, message, detail }]);
      setTimeout(() => dismiss(id), tone === 'error' ? 9000 : 5000);
    },
    [dismiss],
  );

  const value = useMemo<ToastApi>(
    () => ({
      show,
      success: (message, detail) => show('success', message, detail),
      error: (message, detail) => show('error', message, detail),
      info: (message, detail) => show('info', message, detail),
    }),
    [show],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        aria-live="polite"
        role="status"
        className={cx(
          'no-print pointer-events-none fixed inset-x-3 top-[calc(3.5rem+env(safe-area-inset-top))] z-50 flex flex-col items-center gap-2',
          'md:inset-x-auto md:top-auto md:right-6 md:bottom-6 md:w-96 md:flex-col-reverse md:items-stretch',
        )}
      >
        {items.map((item) => {
          const tone = TONES[item.tone];
          return (
            <div
              key={item.id}
              className="pointer-events-auto relative flex w-full max-w-md animate-toast-in items-start gap-3 overflow-hidden rounded-xl border border-slate-200/80 bg-surface/95 py-3 pr-2 pl-3.5 text-sm text-slate-900 shadow-pop backdrop-blur"
            >
              <span
                aria-hidden="true"
                className={cx('absolute inset-y-0 left-0 w-1', tone.accent)}
              />
              <Icon name={tone.icon} className={cx('mt-px size-5', tone.color)} />
              <div className="min-w-0 flex-1 py-px">
                <p className="font-medium">{item.message}</p>
                {item.detail ? (
                  <p className="mt-0.5 text-xs leading-relaxed text-slate-500">{item.detail}</p>
                ) : null}
              </div>
              <button
                type="button"
                className={cx(
                  '-my-1 flex size-8 shrink-0 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700 pointer-coarse:size-10',
                  focusRing,
                )}
                onClick={() => dismiss(item.id)}
                aria-label={t('actions.close')}
              >
                <Icon name="x" className="size-4" strokeWidth={2} />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const value = useContext(ToastContext);
  if (!value) throw new Error('useToast outside ToastProvider');
  return value;
}
