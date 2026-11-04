import {
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { cx } from './cx';
import { Icon } from './Icon';

/*
 * Text controls: 36 px high on desktop, 44 px on touch screens, 16 px text on phones (iOS zooms
 * into smaller text on focus). The invalid state comes from `aria-invalid`, which `Field` sets.
 */
const control = cx(
  'block rounded-lg border border-slate-300 bg-surface px-3 text-base text-slate-900 shadow-xs sm:text-sm',
  'transition-[border-color,box-shadow] duration-150 placeholder:text-slate-400 hover:border-slate-400/80',
  'focus:border-indigo-500 focus:ring-3 focus:ring-indigo-500/20 focus:outline-none',
  'disabled:cursor-not-allowed disabled:border-slate-200 disabled:bg-slate-50 disabled:text-slate-500 disabled:shadow-none',
  'aria-[invalid=true]:border-rose-400 aria-[invalid=true]:focus:border-rose-500 aria-[invalid=true]:focus:ring-rose-500/20',
);

export interface ControlProps {
  id: string;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean;
  required?: boolean;
}

export interface FieldProps {
  label: ReactNode;
  hint?: ReactNode;
  error?: string | undefined;
  required?: boolean;
  className?: string;
  /** Receives the id and aria attributes to put on the control. */
  children: (props: ControlProps) => ReactNode;
}

/** Label + control + hint + error, wired with ids for screen readers. */
export function Field({ label, hint, error, required, className, children }: FieldProps) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;
  return (
    <div className={cx('flex flex-col gap-1.5', className)}>
      <label htmlFor={id} className="text-sm font-medium text-slate-700">
        {label}
        {required ? (
          <span aria-hidden="true" className="ml-0.5 text-rose-500">
            *
          </span>
        ) : null}
      </label>
      {children({
        id,
        ...(describedBy ? { 'aria-describedby': describedBy } : {}),
        ...(error ? { 'aria-invalid': true } : {}),
        ...(required ? { required: true } : {}),
      })}
      {hint ? (
        <p id={hintId} className="text-xs leading-relaxed text-slate-500">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="flex items-start gap-1 text-xs font-medium text-rose-600">
          <Icon name="alert-circle" className="mt-px size-3.5" strokeWidth={2} />
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Default control size unless the caller sets one: two `h-*` (or `w-*`) utilities on one element
 * would conflict, and Tailwind does not let the later class win.
 */
function sized(className: string | undefined, height = 'h-9 pointer-coarse:h-11'): string {
  const classes = className ?? '';
  return cx(!/(^|\s)h-/.test(classes) && height, !/(^|\s)w-/.test(classes) && 'w-full');
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cx(control, sized(className), className)} {...props} />;
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={cx(control, sized(className, ''), 'min-h-24 py-2 leading-relaxed', className)}
      {...props}
    />
  );
}

/** A native select (the phone's own picker) with the app's chevron. */
export function Select({ className, children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cx(
        control,
        sized(className),
        'select-chevron cursor-pointer appearance-none truncate pr-9',
        className,
      )}
      {...props}
    >
      {children}
    </select>
  );
}

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label: ReactNode;
  description?: ReactNode;
}

export function Checkbox({ label, description, className, id, ...props }: CheckboxProps) {
  const generated = useId();
  const inputId = id ?? generated;
  return (
    <div className={cx('flex items-start gap-2.5', className)}>
      <input
        id={inputId}
        type="checkbox"
        className={cx(
          'mt-0.5 size-4 shrink-0 cursor-pointer rounded border-slate-300 accent-indigo-600 pointer-coarse:size-5',
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600',
          'disabled:cursor-not-allowed',
        )}
        {...props}
      />
      <label htmlFor={inputId} className="cursor-pointer text-sm text-slate-700 select-none">
        {label}
        {description ? (
          <span className="mt-0.5 block text-xs text-slate-500">{description}</span>
        ) : null}
      </label>
    </div>
  );
}

/** Errors that belong to no visible field (form-level). */
export function FormErrors({ errors }: { errors: string[] }) {
  if (errors.length === 0) return null;
  return (
    <div
      role="alert"
      className="flex items-start gap-2.5 rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-3 text-sm text-rose-900"
    >
      <Icon name="alert-circle" className="mt-px size-4 text-rose-600" />
      <ul className={cx('flex-1', errors.length > 1 && 'list-inside list-disc')}>
        {errors.map((error) => (
          <li key={error}>{error}</li>
        ))}
      </ul>
    </div>
  );
}
