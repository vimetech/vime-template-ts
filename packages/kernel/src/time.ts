import { TZDate, tzOffset } from '@date-fns/tz';
import { differenceInMinutes } from 'date-fns';
import { z } from 'zod';
import { ValidationError } from './errors';

/**
 * Time model (CLAUDE.md rule 6):
 * - Instants are `Date` objects (stored as `timestamptz`, UTC).
 * - Operational dates (`service_date`, arrival/departure dates) are `LocalDate` values
 *   (`YYYY-MM-DD`) interpreted in a property's IANA time zone.
 * - Wall-clock times (default check-in/out, staff day start/end) are `LocalTime` values (`HH:MM`).
 * Nothing here assumes a particular zone; every zone-dependent function takes it explicitly.
 *
 * Error policy: `parse*` functions validate untrusted input and throw `ValidationError`. The other
 * functions expect already-validated values and throw `RangeError` on invalid arguments (a bug).
 *
 * DST policy for turning a local date + wall time into an instant (`localDateTimeToInstant`):
 * - Nonexistent wall time (spring-forward gap, e.g. 02:30 on 2026-03-08 in America/New_York):
 *   shifted forward to the first valid instant, i.e. the transition itself (03:00 EDT).
 * - Ambiguous wall time (fall-back overlap, e.g. 01:30 on 2026-11-01 in America/New_York):
 *   resolved to the earlier (first) occurrence (01:30 EDT, not 01:30 EST).
 */

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/** Calendar date without zone, `YYYY-MM-DD` (calendar-valid: no 2026-02-29). */
export const LocalDateSchema = z.iso.date().brand<'LocalDate'>();
export type LocalDate = z.output<typeof LocalDateSchema>;

const LOCAL_TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

/** Wall-clock time without date or zone, 24h `HH:MM` (00:00-23:59). */
export const LocalTimeSchema = z
  .string()
  .regex(LOCAL_TIME_PATTERN, { message: 'Expected a 24h time in HH:MM format' })
  .brand<'LocalTime'>();
export type LocalTime = z.output<typeof LocalTimeSchema>;

/** IANA time zone name such as `America/Lima` (raw UTC offsets are rejected). */
export const TimeZoneSchema = z
  .string()
  .refine(isValidTimeZone, { message: 'Expected an IANA time zone name such as America/Lima' });

/** Day of week, 0 = Sunday … 6 = Saturday (same convention as `Date#getDay` and Postgres `dow`). */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

const MIDNIGHT = LocalTimeSchema.parse('00:00');

// ---------------------------------------------------------------------------------------------
// Guards and parsers
// ---------------------------------------------------------------------------------------------

export function isLocalDate(value: unknown): value is LocalDate {
  return LocalDateSchema.safeParse(value).success;
}

export function isLocalTime(value: unknown): value is LocalTime {
  return typeof value === 'string' && LOCAL_TIME_PATTERN.test(value);
}

/** Parses an untrusted `YYYY-MM-DD` string. Throws `ValidationError` when invalid. */
export function parseLocalDate(value: string): LocalDate {
  if (!isLocalDate(value)) {
    throw new ValidationError([
      { path: '', message: 'Expected a calendar date in YYYY-MM-DD format' },
    ]);
  }
  return value;
}

/**
 * Parses an untrusted wall-clock time. Accepts `HH:MM`, and also `HH:MM:SS[.fff]` when the seconds
 * are zero (the text form of a Postgres `time` column); the result is always `HH:MM`.
 * Throws `ValidationError` when invalid.
 */
export function parseLocalTime(value: string): LocalTime {
  const match = /^(\d{2}:\d{2})(?::00(?:\.0+)?)?$/.exec(value);
  const hhmm = match?.[1];
  if (hhmm === undefined || !isLocalTime(hhmm)) {
    throw new ValidationError([{ path: '', message: 'Expected a 24h time in HH:MM format' }]);
  }
  return hhmm;
}

const knownTimeZones = new Set<string>();

/**
 * True when `value` is a time zone name the runtime's Intl database knows (IANA names and their
 * aliases, case-insensitively, e.g. `America/Lima`, `UTC`). Raw offsets such as `+05:00` are
 * rejected: operational dates need a named zone that carries the DST rules.
 */
export function isValidTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 64 || !/^[A-Za-z]/.test(value)) {
    return false;
  }
  if (knownTimeZones.has(value)) {
    return true;
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
  } catch {
    return false;
  }
  knownTimeZones.add(value);
  return true;
}

// ---------------------------------------------------------------------------------------------
// Instant <-> local date/time in a zone
// ---------------------------------------------------------------------------------------------

/** The local calendar date of `instant` in `timeZone` (e.g. the service date of a checkout). */
export function toLocalDate(instant: Date, timeZone: string): LocalDate {
  const local = inZone(instant, timeZone);
  return formatLocalDate(local.getFullYear(), local.getMonth() + 1, local.getDate());
}

/** The local wall-clock time of `instant` in `timeZone`, truncated to the minute. */
export function localTimeOf(instant: Date, timeZone: string): LocalTime {
  const local = inZone(instant, timeZone);
  const value = `${pad2(local.getHours())}:${pad2(local.getMinutes())}`;
  if (!isLocalTime(value)) {
    throw new RangeError(`Cannot represent local time ${value}`);
  }
  return value;
}

/**
 * The instant at which the wall clock in `timeZone` reads `date` `time`
 * (e.g. a reservation's effective checkout: departure date + checkout time in the property zone).
 *
 * DST: a nonexistent wall time (spring-forward gap) yields the first valid instant after the gap
 * (the transition itself); an ambiguous wall time (fall-back overlap) yields the earlier occurrence.
 */
export function localDateTimeToInstant(date: LocalDate, time: LocalTime, timeZone: string): Date {
  assertLocalTime(time);
  assertTimeZone(timeZone);
  // The wall clock reading expressed as if it were UTC; the instant is `wall - offset`.
  const wall = epochDayOf(date) * DAY_MS + minutesOfDay(time) * MINUTE_MS;
  // A zone changes offset at most once around a given wall time in practice, so the offsets in
  // effect a day before and a day after are the only candidates (same approach as Temporal).
  const offsetBefore = offsetMsAt(timeZone, wall - DAY_MS);
  const offsetAfter = offsetMsAt(timeZone, wall + DAY_MS);
  const candidates = [wall - offsetBefore, wall - offsetAfter].filter(
    (instant) => instant + offsetMsAt(timeZone, instant) === wall,
  );
  if (candidates.length > 0) {
    // One candidate: unambiguous. Two: fall-back overlap, the earlier instant wins.
    return new Date(Math.min(...candidates));
  }
  // Spring-forward gap: the transition lies between reading the wall time with the new offset
  // (still before the transition) and reading it with the old offset (already after it).
  return new Date(transitionInstant(timeZone, wall - offsetAfter, wall - offsetBefore));
}

/**
 * The first instant of `date` in `timeZone` (local midnight, or the end of the DST gap in zones
 * where midnight itself is skipped, e.g. America/Santiago on the first Sunday of September).
 * The day's exclusive end is `startOfLocalDay(addDays(date, 1), timeZone)`.
 */
export function startOfLocalDay(date: LocalDate, timeZone: string): Date {
  return localDateTimeToInstant(date, MIDNIGHT, timeZone);
}

// ---------------------------------------------------------------------------------------------
// Calendar arithmetic on local dates (zone-independent)
// ---------------------------------------------------------------------------------------------

/** `date` plus `days` calendar days (`days` may be negative). */
export function addDays(date: LocalDate, days: number): LocalDate {
  if (!Number.isSafeInteger(days)) {
    throw new RangeError(`addDays expects an integer number of days, got ${days}`);
  }
  const result = new Date((epochDayOf(date) + days) * DAY_MS);
  return formatLocalDate(result.getUTCFullYear(), result.getUTCMonth() + 1, result.getUTCDate());
}

/** Number of calendar days from `b` to `a`, i.e. `a - b` (positive when `a` is later). */
export function diffDays(a: LocalDate, b: LocalDate): number {
  return epochDayOf(a) - epochDayOf(b);
}

/** Sort comparator: negative when `a` is earlier, 0 when equal, positive when `a` is later. */
export function compareLocalDates(a: LocalDate, b: LocalDate): -1 | 0 | 1 {
  assertLocalDate(a);
  assertLocalDate(b);
  // Fixed-width YYYY-MM-DD strings sort chronologically.
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Day of week of `date`, 0 = Sunday … 6 = Saturday. */
export function weekdayOf(date: LocalDate): Weekday {
  return new Date(epochDayOf(date) * DAY_MS).getUTCDay() as Weekday;
}

/**
 * Whole minutes elapsed from `from` to `to` (negative when `to` is earlier), truncated toward
 * zero like date-fns `differenceInMinutes`. Real elapsed time: a DST change does not distort it.
 */
export function minutesBetween(from: Date, to: Date): number {
  assertInstant(from);
  assertInstant(to);
  return differenceInMinutes(to, from);
}

// ---------------------------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------------------------

function inZone(instant: Date, timeZone: string): TZDate {
  assertInstant(instant);
  assertTimeZone(timeZone);
  return new TZDate(instant.getTime(), timeZone);
}

/** UTC offset of `timeZone` at the instant `epochMs`, in milliseconds (positive east of UTC). */
function offsetMsAt(timeZone: string, epochMs: number): number {
  const minutes = tzOffset(timeZone, new Date(epochMs));
  if (Number.isNaN(minutes)) {
    throw new RangeError(`Cannot resolve the UTC offset of time zone ${timeZone}`);
  }
  // Historical offsets can include seconds (fractional minutes); round away float noise.
  return Math.round(minutes * MINUTE_MS);
}

/**
 * Binary search for the first instant in (`from`, `to`] whose offset equals the offset at `to`.
 * Requires a single offset change between `from` and `to`.
 */
function transitionInstant(timeZone: string, from: number, to: number): number {
  if (!(from < to)) {
    throw new RangeError(`Unexpected offset transition in time zone ${timeZone}`);
  }
  const target = offsetMsAt(timeZone, to);
  let lo = from;
  let hi = to;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (offsetMsAt(timeZone, mid) === target) {
      hi = mid;
    } else {
      lo = mid;
    }
  }
  return hi;
}

/** Days since 1970-01-01 (negative before). */
function epochDayOf(date: LocalDate): number {
  assertLocalDate(date);
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  // setUTCFullYear avoids Date.UTC's mapping of years 0-99 to 1900-1999.
  const utcMidnight = new Date(0);
  utcMidnight.setUTCFullYear(year, month - 1, day);
  return Math.round(utcMidnight.getTime() / DAY_MS);
}

function minutesOfDay(time: LocalTime): number {
  const [hours, minutes] = time.split(':').map(Number) as [number, number];
  return hours * 60 + minutes;
}

function formatLocalDate(year: number, month: number, day: number): LocalDate {
  const value = `${String(year).padStart(4, '0')}-${pad2(month)}-${pad2(day)}`;
  if (!isLocalDate(value)) {
    throw new RangeError(`Date outside the supported range 0000-01-01..9999-12-31: ${value}`);
  }
  return value;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function assertLocalDate(value: string): void {
  if (!isLocalDate(value)) {
    throw new RangeError(`Invalid local date: ${JSON.stringify(value)}`);
  }
}

function assertLocalTime(value: string): void {
  if (!isLocalTime(value)) {
    throw new RangeError(`Invalid local time: ${JSON.stringify(value)}`);
  }
}

function assertTimeZone(value: string): void {
  if (!isValidTimeZone(value)) {
    throw new RangeError(`Invalid time zone: ${JSON.stringify(value)}`);
  }
}

function assertInstant(value: Date): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new RangeError('Invalid instant');
  }
}
