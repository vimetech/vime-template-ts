import {
  addDays,
  localDateTimeToInstant,
  parseLocalDate,
  parseLocalTime,
  toLocalDate,
} from '@vime/kernel';

/*
 * Display of dates and times. Rule: an INSTANT is always shown in the time zone of the record it
 * belongs to (the organization's `timezone` from the payload), never in the browser's zone. A
 * LOCAL DATE (`YYYY-MM-DD`) is shown as-is: it is formatted at UTC midnight with
 * `timeZone: 'UTC'`, so no zone can move it to another day.
 */

export const DEFAULT_FORMAT_LOCALE = 'es-PE';

type Instant = string | Date | number;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(
  locale: string,
  timeZone: string,
  options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  const key = `${locale}|${timeZone}|${JSON.stringify(options)}`;
  let cached = formatters.get(key);
  if (!cached) {
    cached = new Intl.DateTimeFormat(locale, { ...options, timeZone });
    formatters.set(key, cached);
  }
  return cached;
}

function toDate(instant: Instant): Date {
  return instant instanceof Date ? instant : new Date(instant);
}

/** `HH:MM` (24 h) of an instant in `timeZone`. */
export function formatTime(
  instant: Instant,
  timeZone: string,
  locale = DEFAULT_FORMAT_LOCALE,
): string {
  const parts = formatter(locale, timeZone, {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(toDate(instant));
  const hour = parts.find((p) => p.type === 'hour')?.value ?? '00';
  const minute = parts.find((p) => p.type === 'minute')?.value ?? '00';
  return `${hour}:${minute}`;
}

/** Short date of an instant in `timeZone`, e.g. `dom 4 oct`. */
export function formatShortDate(
  instant: Instant,
  timeZone: string,
  locale = DEFAULT_FORMAT_LOCALE,
): string {
  return formatter(locale, timeZone, { weekday: 'short', day: 'numeric', month: 'short' })
    .format(toDate(instant))
    .replace(/,/g, '');
}

/** Date and time of an instant in `timeZone`, e.g. `dom 4 oct 11:00`. */
export function formatDateTime(
  instant: Instant,
  timeZone: string,
  locale = DEFAULT_FORMAT_LOCALE,
): string {
  return `${formatShortDate(instant, timeZone, locale)} ${formatTime(instant, timeZone, locale)}`;
}

/** The local date (`YYYY-MM-DD`) of an instant in `timeZone`. */
export function localDateOf(instant: Instant, timeZone: string): string {
  return toLocalDate(toDate(instant), timeZone);
}

/**
 * Time of an instant, with its short date in front when its local date (in `timeZone`) is not
 * `referenceDate`: `15:00` on the service date, `mar 6 oct 15:00` on another day.
 */
export function formatTimeOnDay(
  instant: Instant,
  timeZone: string,
  referenceDate: string,
  locale = DEFAULT_FORMAT_LOCALE,
): string {
  return localDateOf(instant, timeZone) === referenceDate
    ? formatTime(instant, timeZone, locale)
    : formatDateTime(instant, timeZone, locale);
}

/** A local date as-is, e.g. `2026-10-04` → `dom 4 oct 2026` (never shifted by a zone). */
export function formatLocalDate(
  date: string,
  locale = DEFAULT_FORMAT_LOCALE,
  options: Intl.DateTimeFormatOptions = {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  },
): string {
  return formatter(locale, 'UTC', options)
    .format(new Date(`${date}T00:00:00Z`))
    .replace(/,/g, '');
}

/** Today's local date in `timeZone`. */
export function todayIn(timeZone: string, now: Date = new Date()): string {
  return toLocalDate(now, timeZone);
}

/** `date` plus `days` calendar days. */
export function shiftDate(date: string, days: number): string {
  return addDays(parseLocalDate(date), days);
}

/** Whole minutes from `now` to `instant` (negative when it already passed). */
export function minutesUntil(instant: Instant, now: Date = new Date()): number {
  return Math.floor((toDate(instant).getTime() - now.getTime()) / 60_000);
}

/** `125` → `2 h 05 min`, `45` → `45 min` (absolute value; the caller says before/after). */
export function formatDuration(minutes: number): string {
  const total = Math.abs(Math.trunc(minutes));
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  if (hours === 0) return `${rest} min`;
  if (hours >= 48) {
    const days = Math.floor(hours / 24);
    return `${days} d ${hours % 24} h`;
  }
  return `${hours} h ${String(rest).padStart(2, '0')} min`;
}

/** Local date + wall time in `timeZone` → ISO instant (for inputs typed in that zone). */
export function instantFromLocal(date: string, time: string, timeZone: string): string {
  return localDateTimeToInstant(parseLocalDate(date), parseLocalTime(time), timeZone).toISOString();
}

/** An instant as `{ date, time }` in `timeZone` (to prefill date/time inputs). */
export function localPartsOf(instant: Instant, timeZone: string): { date: string; time: string } {
  return { date: localDateOf(instant, timeZone), time: formatTime(instant, timeZone, 'en-GB') };
}

/** Every IANA zone the browser knows (for time zone selects), with `current` always included. */
export function timeZoneOptions(current?: string): string[] {
  const supported =
    typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
  const zones = new Set<string>(supported);
  for (const zone of ['America/Lima', 'America/Bogota', 'America/Santiago', 'America/New_York']) {
    zones.add(zone);
  }
  if (current) zones.add(current);
  return [...zones].sort();
}

/** `HH:MM:SS` of an instant in `timeZone` (refresh indicators). */
export function formatClock(
  instant: Instant,
  timeZone: string,
  locale = DEFAULT_FORMAT_LOCALE,
): string {
  const parts = formatter(locale, timeZone, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(toDate(instant));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? '00';
  return `${part('hour')}:${part('minute')}:${part('second')}`;
}
