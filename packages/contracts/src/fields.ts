import { z } from 'zod';
import { TimestampSchema } from './common';

/*
 * Field builders and checks shared by the module DTO files. Internal: not re-exported from the
 * package entry point.
 */

/** Trimmed, non-empty text of at most `max` characters. */
export const requiredText = (max: number) => z.string().trim().min(1).max(max);

/** Trimmed text of at most `max` characters (may be empty). */
export const optionalText = (max: number) => z.string().trim().max(max);

/** `created_at` / `updated_at` of a tenant row; `updatedAt` is null until the first update. */
export const timestamps = {
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema.nullable(),
};

/**
 * `start < end` for values whose text order is their time order (`HH:MM` local times, `YYYY-MM-DD`
 * local dates). True when either end is missing.
 */
export function isOrdered(
  start: string | null | undefined,
  end: string | null | undefined,
): boolean {
  return start == null || end == null || start < end;
}

/**
 * `start < end` for ISO timestamps, which may carry different UTC offsets (so their text order is
 * not their time order). True when either end is missing.
 */
export function isInstantBefore(
  start: string | null | undefined,
  end: string | null | undefined,
): boolean {
  return start == null || end == null || Date.parse(start) < Date.parse(end);
}

/** Whole days from `from` to `to` (valid `YYYY-MM-DD` dates; negative when `to` is earlier). */
export function daysBetween(from: string, to: string): number {
  return (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
}

/**
 * Adds the checks of an inclusive `from`..`to` local date range: `from <= to` and at most
 * `maxDays` days apart (list queries stay bounded).
 */
export function refineDateRange<T extends z.ZodType<{ from: string; to: string }>>(
  schema: T,
  maxDays: number,
) {
  return schema
    .refine((v) => v.from <= v.to, { message: 'from must not be after to', path: ['to'] })
    .refine((v) => daysBetween(v.from, v.to) <= maxDays, {
      message: `The range can span at most ${maxDays} days`,
      path: ['to'],
    });
}
