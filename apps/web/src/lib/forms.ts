import type { AppT } from './i18n-hook';
import type { z } from 'zod';
import { ApiProblem } from './api';

/** Field path (`items.0.zoneId`) → message. The empty path holds form-level errors. */
export type FieldErrors = Record<string, string>;

/** Localized message for a Zod issue raised by a contracts schema (client-side shape check). */
function issueMessage(t: AppT, issue: z.core.$ZodIssue): string {
  switch (issue.code) {
    case 'too_small':
      return issue.origin === 'string' && issue.minimum === 1
        ? t('validation.required')
        : t('validation.tooSmall', { min: String(issue.minimum) });
    case 'too_big':
      return t('validation.tooBig', { max: String(issue.maximum) });
    case 'invalid_type':
      return issue.input === undefined || issue.input === null
        ? t('validation.required')
        : t('validation.invalid');
    default:
      return t('validation.invalid');
  }
}

/** Client-side validation with a contracts schema: the parsed value, or field errors. */
export function validateWith<S extends z.ZodType>(
  t: AppT,
  schema: S,
  value: unknown,
): { ok: true; data: z.output<S> } | { ok: false; errors: FieldErrors } {
  const parsed = schema.safeParse(value);
  if (parsed.success) return { ok: true, data: parsed.data };
  const errors: FieldErrors = {};
  for (const issue of parsed.error.issues) {
    const path = issue.path.map(String).join('.');
    errors[path] ??= issueMessage(t, issue);
  }
  return { ok: false, errors };
}

/** Field errors of a `validation_failed` problem (server-side), keyed like `validateWith`. */
export function problemFieldErrors(error: unknown): FieldErrors {
  if (!(error instanceof ApiProblem)) return {};
  const errors: FieldErrors = {};
  for (const item of error.errors) errors[item.path] ??= item.message;
  return errors;
}

/** `''` → null, else the number (NaN stays NaN so the schema reports it). */
export function numberOrNull(value: string): number | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : Number(trimmed.replace(',', '.'));
}

/** `''` → null, else the trimmed text. */
export function textOrNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}
