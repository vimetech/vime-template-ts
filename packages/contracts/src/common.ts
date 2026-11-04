import { z } from 'zod';

/** RFC 9562 UUID (we generate v7 server side; clients may send their own for client-created records). */
export const UuidSchema = z.uuid();
export type Uuid = z.infer<typeof UuidSchema>;

/** Calendar date without time zone, `YYYY-MM-DD` (e.g. a task's service date in the property's zone). */
export const LocalDateSchema = z.iso.date();
export type LocalDate = z.infer<typeof LocalDateSchema>;

/** Calendar month without time zone, `YYYY-MM` (e.g. the period a task cost is reported in). */
export const MonthSchema = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'Expected a month in YYYY-MM format' });
export type Month = z.infer<typeof MonthSchema>;

/** Wall-clock time without date or zone, 24h `HH:MM` (e.g. a property's default checkout time). */
export const LocalTimeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'Expected a 24h time in HH:MM format' });
export type LocalTime = z.infer<typeof LocalTimeSchema>;

/** Instant as an ISO 8601 date-time with `Z` or an explicit UTC offset. */
export const TimestampSchema = z.iso.datetime({ offset: true });
export type Timestamp = z.infer<typeof TimestampSchema>;

function isIanaTimeZone(value: string): boolean {
  // Intl also accepts raw offsets such as "+05:00"; operational dates need a named zone (DST rules).
  if (!/^[A-Za-z]/.test(value)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** IANA time zone name (e.g. `America/Lima`), validated against the runtime's Intl database. */
export const TimeZoneSchema = z
  .string()
  .min(1)
  .max(64)
  .refine(isIanaTimeZone, { message: 'Expected an IANA time zone name such as America/Lima' });
export type TimeZone = z.infer<typeof TimeZoneSchema>;

/** Locales with UI catalogs (packages/i18n). es-PE first, en second. */
export const LOCALES = ['es-PE', 'en'] as const;
export const LocaleSchema = z.enum(LOCALES);
export type Locale = z.infer<typeof LocaleSchema>;

/** Cursor pagination query (`?limit=50&cursor=...`). Query strings arrive as text, hence the coercion. */
export const PageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().min(1).max(512).optional(),
});
export type PageQuery = z.infer<typeof PageQuerySchema>;

/** Paginated list response: `nextCursor` is null on the last page. */
export function page<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    nextCursor: z.string().nullable(),
  });
}
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/** Free-form JSON object stored as jsonb (metadata, event payloads). */
export const JsonObjectSchema = z.record(z.string(), z.unknown());
export type JsonObject = z.infer<typeof JsonObjectSchema>;
