import { tzOffset, tzScan } from '@date-fns/tz';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ValidationError } from './errors';
import {
  LocalDateSchema,
  LocalTimeSchema,
  TimeZoneSchema,
  addDays,
  compareLocalDates,
  diffDays,
  isLocalDate,
  isLocalTime,
  isValidTimeZone,
  localDateTimeToInstant,
  localTimeOf,
  minutesBetween,
  parseLocalDate,
  parseLocalTime,
  startOfLocalDay,
  toLocalDate,
  weekdayOf,
} from './time';
import type { LocalDate, LocalTime } from './time';

const LIMA = 'America/Lima';
const NEW_YORK = 'America/New_York';
const SANTIAGO = 'America/Santiago';
const UTC = 'UTC';

const d = (value: string): LocalDate => parseLocalDate(value);
const t = (value: string): LocalTime => parseLocalTime(value);
const at = (iso: string): Date => new Date(iso);
const instant = (date: string, time: string, zone: string): string =>
  localDateTimeToInstant(d(date), t(time), zone).toISOString();

describe('parsers and guards', () => {
  it('accepts calendar-valid YYYY-MM-DD dates only', () => {
    expect(parseLocalDate('2026-10-04')).toBe('2026-10-04');
    expect(parseLocalDate('2024-02-29')).toBe('2024-02-29');
    expect(parseLocalDate('2000-02-29')).toBe('2000-02-29');
    for (const bad of [
      '2026-02-29',
      '1900-02-29',
      '2026-13-01',
      '2026-04-31',
      '2026-00-10',
      '2026-1-01',
      '26-01-01',
      '2026-01-01T00:00:00Z',
      ' 2026-01-01',
      '',
    ]) {
      expect(isLocalDate(bad), bad).toBe(false);
      expect(() => parseLocalDate(bad), bad).toThrow(ValidationError);
    }
    expect(isLocalDate(20260101)).toBe(false);
  });

  it('accepts HH:MM times and zero-second Postgres time text', () => {
    expect(parseLocalTime('00:00')).toBe('00:00');
    expect(parseLocalTime('23:59')).toBe('23:59');
    expect(parseLocalTime('15:00:00')).toBe('15:00');
    expect(parseLocalTime('11:30:00.000000')).toBe('11:30');
    for (const bad of ['24:00', '7:00', '07:0', '12:60', '15:00:30', '15:00:00.5', '1500', '']) {
      expect(() => parseLocalTime(bad), bad).toThrow(ValidationError);
    }
    expect(isLocalTime('15:00')).toBe(true);
    expect(isLocalTime('15:00:00')).toBe(false);
    expect(isLocalTime(1500)).toBe(false);
  });

  it('reports a ValidationError with a root issue', () => {
    try {
      parseLocalDate('2026-02-30');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).code).toBe('validation_failed');
      expect((error as ValidationError).issues).toEqual([
        { path: '', message: expect.any(String) },
      ]);
    }
  });

  it('validates IANA time zones and rejects raw offsets', () => {
    for (const zone of [LIMA, NEW_YORK, SANTIAGO, UTC, 'Europe/Madrid', 'Asia/Kathmandu']) {
      expect(isValidTimeZone(zone), zone).toBe(true);
    }
    for (const bad of ['', 'Mars/Olympus_Mons', '+05:00', '-0300', 'America/Lima ', 42, null]) {
      expect(isValidTimeZone(bad), String(bad)).toBe(false);
    }
  });

  it('exposes Zod schemas with the same rules', () => {
    expect(LocalDateSchema.safeParse('2026-10-04').success).toBe(true);
    expect(LocalDateSchema.safeParse('2026-02-29').success).toBe(false);
    expect(LocalTimeSchema.safeParse('08:15').success).toBe(true);
    expect(LocalTimeSchema.safeParse('08:15:00').success).toBe(false);
    expect(TimeZoneSchema.safeParse(SANTIAGO).success).toBe(true);
    expect(TimeZoneSchema.safeParse('+01:00').success).toBe(false);
  });

  it('rejects invalid arguments in computations with RangeError', () => {
    expect(() => toLocalDate(at('2026-01-01T00:00:00Z'), 'Nope/Nowhere')).toThrow(RangeError);
    expect(() => toLocalDate(new Date(Number.NaN), LIMA)).toThrow(RangeError);
    expect(() => localDateTimeToInstant('2026-02-30' as LocalDate, t('10:00'), LIMA)).toThrow(
      RangeError,
    );
    expect(() => localDateTimeToInstant(d('2026-02-03'), '25:00' as LocalTime, LIMA)).toThrow(
      RangeError,
    );
    expect(() => addDays(d('2026-01-01'), 1.5)).toThrow(RangeError);
    expect(() => addDays(d('9999-12-31'), 1)).toThrow(RangeError);
    expect(() => minutesBetween(new Date(Number.NaN), new Date())).toThrow(RangeError);
  });
});

describe('UTC', () => {
  it('maps wall time one-to-one', () => {
    expect(instant('2026-10-04', '10:15', UTC)).toBe('2026-10-04T10:15:00.000Z');
    expect(toLocalDate(at('2026-10-04T23:59:59.999Z'), UTC)).toBe('2026-10-04');
    expect(toLocalDate(at('2026-10-05T00:00:00Z'), UTC)).toBe('2026-10-05');
    expect(localTimeOf(at('2026-10-04T10:15:59.999Z'), UTC)).toBe('10:15');
    expect(startOfLocalDay(d('2026-10-04'), UTC).toISOString()).toBe('2026-10-04T00:00:00.000Z');
  });
});

describe('America/Lima (UTC-5, no DST)', () => {
  it('converts local check-in/out times to instants', () => {
    expect(instant('2026-07-15', '11:00', LIMA)).toBe('2026-07-15T16:00:00.000Z');
    expect(instant('2026-01-15', '15:00', LIMA)).toBe('2026-01-15T20:00:00.000Z');
    expect(startOfLocalDay(d('2026-10-04'), LIMA).toISOString()).toBe('2026-10-04T05:00:00.000Z');
  });

  it('derives the local date of late-evening instants', () => {
    // 23:30 in Lima is already the next day in UTC.
    expect(toLocalDate(at('2026-10-05T04:30:00Z'), LIMA)).toBe('2026-10-04');
    expect(localTimeOf(at('2026-10-05T04:30:00Z'), LIMA)).toBe('23:30');
    expect(toLocalDate(at('2026-10-05T05:00:00Z'), LIMA)).toBe('2026-10-05');
    expect(toLocalDate(at('2027-01-01T04:59:59Z'), LIMA)).toBe('2026-12-31');
  });

  it('has 24-hour days all year round', () => {
    const start = startOfLocalDay(d('2026-03-08'), LIMA);
    const end = startOfLocalDay(d('2026-03-09'), LIMA);
    expect(minutesBetween(start, end)).toBe(24 * 60);
  });
});

describe('America/New_York (northern DST)', () => {
  it('uses EST in winter and EDT in summer', () => {
    expect(instant('2026-01-15', '11:00', NEW_YORK)).toBe('2026-01-15T16:00:00.000Z');
    expect(instant('2026-07-15', '11:00', NEW_YORK)).toBe('2026-07-15T15:00:00.000Z');
  });

  it('shifts a nonexistent wall time (spring-forward gap) to the first valid instant', () => {
    // 2026-03-08: clocks jump from 02:00 EST to 03:00 EDT (07:00Z).
    expect(instant('2026-03-08', '01:59', NEW_YORK)).toBe('2026-03-08T06:59:00.000Z');
    expect(instant('2026-03-08', '02:00', NEW_YORK)).toBe('2026-03-08T07:00:00.000Z');
    expect(instant('2026-03-08', '02:30', NEW_YORK)).toBe('2026-03-08T07:00:00.000Z');
    expect(instant('2026-03-08', '02:59', NEW_YORK)).toBe('2026-03-08T07:00:00.000Z');
    expect(instant('2026-03-08', '03:00', NEW_YORK)).toBe('2026-03-08T07:00:00.000Z');
    expect(instant('2026-03-08', '03:30', NEW_YORK)).toBe('2026-03-08T07:30:00.000Z');
    const shifted = localDateTimeToInstant(d('2026-03-08'), t('02:30'), NEW_YORK);
    expect(toLocalDate(shifted, NEW_YORK)).toBe('2026-03-08');
    expect(localTimeOf(shifted, NEW_YORK)).toBe('03:00');
  });

  it('resolves an ambiguous wall time (fall-back overlap) to the earlier occurrence', () => {
    // 2026-11-01: clocks go back from 02:00 EDT to 01:00 EST (06:00Z); 01:00-01:59 happens twice.
    expect(instant('2026-11-01', '00:59', NEW_YORK)).toBe('2026-11-01T04:59:00.000Z');
    expect(instant('2026-11-01', '01:00', NEW_YORK)).toBe('2026-11-01T05:00:00.000Z');
    expect(instant('2026-11-01', '01:30', NEW_YORK)).toBe('2026-11-01T05:30:00.000Z');
    expect(instant('2026-11-01', '01:59', NEW_YORK)).toBe('2026-11-01T05:59:00.000Z');
    expect(instant('2026-11-01', '02:00', NEW_YORK)).toBe('2026-11-01T07:00:00.000Z');
    // Both occurrences read 01:30 on the local clock.
    expect(localTimeOf(at('2026-11-01T05:30:00Z'), NEW_YORK)).toBe('01:30');
    expect(localTimeOf(at('2026-11-01T06:30:00Z'), NEW_YORK)).toBe('01:30');
    expect(toLocalDate(at('2026-11-01T06:30:00Z'), NEW_YORK)).toBe('2026-11-01');
  });

  it('has 23-hour and 25-hour days on transition dates', () => {
    const minutesInDay = (date: string) =>
      minutesBetween(
        startOfLocalDay(d(date), NEW_YORK),
        startOfLocalDay(addDays(d(date), 1), NEW_YORK),
      );
    expect(minutesInDay('2026-03-08')).toBe(23 * 60);
    expect(minutesInDay('2026-11-01')).toBe(25 * 60);
    expect(minutesInDay('2026-11-02')).toBe(24 * 60);
    expect(startOfLocalDay(d('2026-03-08'), NEW_YORK).toISOString()).toBe(
      '2026-03-08T05:00:00.000Z',
    );
    expect(startOfLocalDay(d('2026-03-09'), NEW_YORK).toISOString()).toBe(
      '2026-03-09T04:00:00.000Z',
    );
  });

  it('derives local dates around midnight on transition dates', () => {
    expect(toLocalDate(at('2026-03-08T04:59:59Z'), NEW_YORK)).toBe('2026-03-07');
    expect(toLocalDate(at('2026-03-08T05:00:00Z'), NEW_YORK)).toBe('2026-03-08');
    expect(toLocalDate(at('2026-11-02T04:59:59Z'), NEW_YORK)).toBe('2026-11-01');
    expect(toLocalDate(at('2026-11-02T05:00:00Z'), NEW_YORK)).toBe('2026-11-02');
  });
});

describe('America/Santiago (southern DST, transitions at midnight)', () => {
  it('uses -03 in the southern summer and -04 in winter', () => {
    expect(instant('2026-01-15', '10:00', SANTIAGO)).toBe('2026-01-15T13:00:00.000Z');
    expect(instant('2026-07-15', '10:00', SANTIAGO)).toBe('2026-07-15T14:00:00.000Z');
  });

  it('starts the day at 01:00 when DST skips midnight', () => {
    // 2026-09-06: clocks jump from 00:00 -04 to 01:00 -03 (04:00Z).
    const start = startOfLocalDay(d('2026-09-06'), SANTIAGO);
    expect(start.toISOString()).toBe('2026-09-06T04:00:00.000Z');
    expect(toLocalDate(start, SANTIAGO)).toBe('2026-09-06');
    expect(localTimeOf(start, SANTIAGO)).toBe('01:00');
    expect(toLocalDate(new Date(start.getTime() - 1), SANTIAGO)).toBe('2026-09-05');
    expect(instant('2026-09-06', '00:30', SANTIAGO)).toBe('2026-09-06T04:00:00.000Z');
    expect(instant('2026-09-06', '01:30', SANTIAGO)).toBe('2026-09-06T04:30:00.000Z');
    expect(minutesBetween(start, startOfLocalDay(d('2026-09-07'), SANTIAGO))).toBe(23 * 60);
  });

  it('resolves the repeated 23:xx hour to the earlier occurrence when DST ends', () => {
    // 2026-04-05 00:00 -03 becomes 2026-04-04 23:00 -04 (03:00Z); 23:00-23:59 on 04-04 happens twice.
    expect(instant('2026-04-04', '22:59', SANTIAGO)).toBe('2026-04-05T01:59:00.000Z');
    expect(instant('2026-04-04', '23:30', SANTIAGO)).toBe('2026-04-05T02:30:00.000Z');
    expect(localTimeOf(at('2026-04-05T03:30:00Z'), SANTIAGO)).toBe('23:30');
    expect(toLocalDate(at('2026-04-05T03:30:00Z'), SANTIAGO)).toBe('2026-04-04');
    expect(startOfLocalDay(d('2026-04-05'), SANTIAGO).toISOString()).toBe(
      '2026-04-05T04:00:00.000Z',
    );
    expect(
      minutesBetween(
        startOfLocalDay(d('2026-04-04'), SANTIAGO),
        startOfLocalDay(d('2026-04-05'), SANTIAGO),
      ),
    ).toBe(25 * 60);
  });
});

describe('calendar arithmetic', () => {
  it('adds days across month and year boundaries', () => {
    expect(addDays(d('2026-01-31'), 1)).toBe('2026-02-01');
    expect(addDays(d('2026-02-28'), 1)).toBe('2026-03-01');
    expect(addDays(d('2024-02-28'), 1)).toBe('2024-02-29');
    expect(addDays(d('2024-02-29'), 1)).toBe('2024-03-01');
    expect(addDays(d('2026-12-31'), 1)).toBe('2027-01-01');
    expect(addDays(d('2027-01-01'), -1)).toBe('2026-12-31');
    expect(addDays(d('2026-03-01'), -1)).toBe('2026-02-28');
    expect(addDays(d('2026-10-04'), 0)).toBe('2026-10-04');
    expect(addDays(d('2026-01-01'), 365)).toBe('2027-01-01');
    expect(addDays(d('2024-01-01'), 366)).toBe('2025-01-01');
    // Calendar arithmetic is unaffected by DST transitions in any zone.
    expect(addDays(d('2026-03-07'), 1)).toBe('2026-03-08');
    expect(addDays(d('0099-12-31'), 1)).toBe('0100-01-01');
  });

  it('counts calendar days between dates', () => {
    expect(diffDays(d('2026-03-01'), d('2026-02-28'))).toBe(1);
    expect(diffDays(d('2024-03-01'), d('2024-02-28'))).toBe(2);
    expect(diffDays(d('2027-01-01'), d('2026-01-01'))).toBe(365);
    expect(diffDays(d('2025-01-01'), d('2024-01-01'))).toBe(366);
    expect(diffDays(d('2026-10-03'), d('2026-10-04'))).toBe(-1);
    expect(diffDays(d('2026-10-04'), d('2026-10-04'))).toBe(0);
  });

  it('compares local dates chronologically', () => {
    expect(compareLocalDates(d('2026-10-04'), d('2026-10-05'))).toBe(-1);
    expect(compareLocalDates(d('2026-10-04'), d('2026-10-04'))).toBe(0);
    expect(compareLocalDates(d('2027-01-01'), d('2026-12-31'))).toBe(1);
    expect([d('2026-12-01'), d('2026-02-10'), d('2025-12-31')].sort(compareLocalDates)).toEqual([
      '2025-12-31',
      '2026-02-10',
      '2026-12-01',
    ]);
  });

  it('returns the weekday with 0 = Sunday', () => {
    expect(weekdayOf(d('2026-10-04'))).toBe(0); // Sunday
    expect(weekdayOf(d('2026-10-05'))).toBe(1); // Monday
    expect(weekdayOf(d('2026-10-10'))).toBe(6); // Saturday
    expect(weekdayOf(d('2000-01-01'))).toBe(6); // Saturday
    expect(weekdayOf(d('1969-12-31'))).toBe(3); // Wednesday (before the epoch)
  });

  it('measures whole elapsed minutes between instants', () => {
    expect(minutesBetween(at('2026-10-04T10:00:00Z'), at('2026-10-04T11:30:00Z'))).toBe(90);
    expect(minutesBetween(at('2026-10-04T10:00:00Z'), at('2026-10-04T10:00:59Z'))).toBe(0);
    expect(minutesBetween(at('2026-10-04T11:30:00Z'), at('2026-10-04T10:00:00Z'))).toBe(-90);
    expect(minutesBetween(at('2026-10-04T10:00:59Z'), at('2026-10-04T10:00:00Z'))).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------
// Property tests
// ---------------------------------------------------------------------------------------------

const ZONES = [
  LIMA,
  NEW_YORK,
  SANTIAGO,
  UTC,
  'Europe/London',
  'Europe/Berlin',
  'Australia/Sydney',
  'Australia/Lord_Howe', // 30-minute DST shift
  'Pacific/Auckland',
  'Pacific/Chatham', // +12:45 / +13:45
  'America/St_Johns', // -03:30 / -02:30
  'Asia/Kolkata', // +05:30, no DST
  'Asia/Kathmandu', // +05:45, no DST
  'America/Sao_Paulo',
] as const;

const zoneArb = fc.constantFrom(...ZONES);

// Dates 2000-01-01 .. 2099-12-31, generated as an offset from a fixed epoch day.
const localDateArb = fc
  .integer({ min: 0, max: 36_524 })
  .map((offset) => addDays(d('2000-01-01'), offset));

const localTimeArb = fc
  .tuple(fc.integer({ min: 0, max: 23 }), fc.integer({ min: 0, max: 59 }))
  .map(([hours, minutes]) =>
    t(`${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`),
  );

function wallClock(at: Date, zone: string): string {
  return `${toLocalDate(at, zone)}T${localTimeOf(at, zone)}`;
}

/**
 * Brute-force oracle, independent of the algorithm under test: every instant whose wall clock in
 * `zone` reads `date time`. Tries every UTC offset on a quarter-hour grid (-12:00..+14:00; all
 * offsets of the zones under test are multiples of 15 minutes) and keeps `wall - offset` when the
 * zone really uses that offset at that instant. Empty for a DST-gap time; two instants for an
 * ambiguous (fall-back) time.
 */
function instantsShowing(date: LocalDate, time: LocalTime, zone: string): number[] {
  const wall = Date.parse(`${date}T${time}:00Z`);
  const matches: number[] = [];
  for (let offsetMinutes = -12 * 60; offsetMinutes <= 14 * 60; offsetMinutes += 15) {
    const candidate = wall - offsetMinutes * 60_000;
    if (tzOffset(zone, new Date(candidate)) === offsetMinutes) {
      matches.push(candidate);
    }
  }
  return matches.sort((a, b) => a - b);
}

describe('properties', () => {
  it('round-trips local date and time through an instant (gap times excluded)', () => {
    fc.assert(
      fc.property(localDateArb, localTimeArb, zoneArb, (date, time, zone) => {
        const expected = instantsShowing(date, time, zone);
        fc.pre(expected.length > 0);
        const result = localDateTimeToInstant(date, time, zone);
        expect(toLocalDate(result, zone)).toBe(date);
        expect(localTimeOf(result, zone)).toBe(time);
        // Earliest matching instant (relevant for ambiguous times).
        expect(result.getTime()).toBe(expected[0]);
      }),
      { numRuns: 2000 },
    );
  });

  it('round-trips the exact wall times around every DST transition', () => {
    const transitions = ZONES.flatMap((zone) =>
      tzScan(zone, {
        start: new Date('2020-01-01T00:00:00Z'),
        end: new Date('2031-01-01T00:00:00Z'),
      })
        .filter((change) => change.change !== 0)
        .map((change) => ({ zone, at: change.date })),
    );
    expect(transitions.length).toBeGreaterThan(50);
    const transitionArb = fc.constantFrom(...transitions);
    fc.assert(
      fc.property(
        transitionArb,
        fc.integer({ min: -180, max: 180 }),
        ({ zone, at: transitionAt }, minutes) => {
          const probe = new Date(transitionAt.getTime() + minutes * 60_000);
          const date = toLocalDate(probe, zone);
          const time = localTimeOf(probe, zone);
          const result = localDateTimeToInstant(date, time, zone);
          expect(toLocalDate(result, zone)).toBe(date);
          expect(localTimeOf(result, zone)).toBe(time);
          // Ambiguous times resolve to the earlier occurrence.
          expect(result.getTime()).toBe(instantsShowing(date, time, zone)[0]);
          expect(result.getTime()).toBeLessThanOrEqual(probe.getTime());
        },
      ),
      { numRuns: 2000 },
    );
  });

  it('maps every gap time to the first instant after the gap', () => {
    const gaps = gapWallTimes();
    expect(gaps.length).toBeGreaterThan(100);
    fc.assert(
      fc.property(fc.constantFrom(...gaps), ({ date, time, zone }) => {
        expect(instantsShowing(date, time, zone)).toEqual([]);
        const result = localDateTimeToInstant(date, time, zone);
        const before = new Date(result.getTime() - 1);
        // The result is the transition: the wall clock jumps from before to after the requested time.
        expect(wallClock(before, zone) < `${date}T${time}`).toBe(true);
        expect(wallClock(result, zone) > `${date}T${time}`).toBe(true);
      }),
      { numRuns: 1000 },
    );
  });

  it('starts each local day at an instant whose previous millisecond belongs to the day before', () => {
    fc.assert(
      fc.property(localDateArb, zoneArb, (date, zone) => {
        const start = startOfLocalDay(date, zone);
        expect(toLocalDate(start, zone)).toBe(date);
        expect(toLocalDate(new Date(start.getTime() - 1), zone)).toBe(addDays(date, -1));
      }),
      { numRuns: 2000 },
    );
  });

  it('keeps addDays and diffDays consistent', () => {
    fc.assert(
      fc.property(localDateArb, fc.integer({ min: -1000, max: 1000 }), (date, days) => {
        const shifted = addDays(date, days);
        expect(diffDays(shifted, date)).toBe(days);
        expect(addDays(shifted, -days)).toBe(date);
        expect(compareLocalDates(shifted, date)).toBe(Math.sign(days));
        expect(weekdayOf(shifted)).toBe((((weekdayOf(date) + days) % 7) + 7) % 7);
        expect(isLocalDate(shifted)).toBe(true);
      }),
      { numRuns: 2000 },
    );
  });

  it('crosses month and year boundaries one day at a time', () => {
    fc.assert(
      fc.property(localDateArb, (date) => {
        const next = addDays(date, 1);
        const [year, month, day] = date.split('-').map(Number) as [number, number, number];
        const [nextYear, nextMonth, nextDay] = next.split('-').map(Number) as [
          number,
          number,
          number,
        ];
        if (nextDay !== 1) {
          expect([nextYear, nextMonth, nextDay]).toEqual([year, month, day + 1]);
        } else if (nextMonth !== 1) {
          expect([nextYear, nextMonth]).toEqual([year, month + 1]);
        } else {
          expect([nextYear, month, day]).toEqual([year + 1, 12, 31]);
        }
      }),
      { numRuns: 2000 },
    );
  });
});

/**
 * Every wall time (minute resolution) that falls inside a spring-forward gap in 2024-2027 for the
 * zones under test. Candidates are taken from the three hours around each forward transition found
 * by tzScan and kept only when neither the old nor the new offset shows them.
 */
function gapWallTimes(): Array<{ date: LocalDate; time: LocalTime; zone: string }> {
  const gaps: Array<{ date: LocalDate; time: LocalTime; zone: string }> = [];
  for (const zone of ZONES) {
    const changes = tzScan(zone, {
      start: new Date('2024-01-01T00:00:00Z'),
      end: new Date('2028-01-01T00:00:00Z'),
    });
    for (const change of changes.filter((c) => c.change > 0)) {
      const oldOffsetMs = (change.offset - change.change) * 60_000;
      const newOffsetMs = change.offset * 60_000;
      // Wall clock (read as UTC) two hours before the scanned change, under the old offset.
      const firstWall = change.date.getTime() - 2 * 3_600_000 + oldOffsetMs;
      for (let minute = 0; minute <= 180; minute++) {
        const wallMs = firstWall + minute * 60_000;
        const wall = new Date(wallMs).toISOString();
        const date = d(wall.slice(0, 10));
        const time = t(wall.slice(11, 16));
        // A gap time is shown by neither the old nor the new offset.
        const shown = [wallMs - oldOffsetMs, wallMs - newOffsetMs].some(
          (candidate) => wallClock(new Date(candidate), zone) === `${date}T${time}`,
        );
        if (!shown) {
          gaps.push({ date, time, zone });
        }
      }
    }
  }
  return gaps;
}
