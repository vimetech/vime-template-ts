import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  formatDuration,
  formatLocalDate,
  formatTime,
  formatTimeOnDay,
  instantFromLocal,
  localDateOf,
  minutesUntil,
  shiftDate,
  todayIn,
} from './time';

/*
 * Instants are formatted in the PROPERTY's zone, never the machine's. The machine zone is set to
 * Asia/Tokyo (UTC+9) on purpose: a result that leaked it would be off by many hours.
 */

const originalTz = process.env['TZ'];
beforeAll(() => {
  process.env['TZ'] = 'Asia/Tokyo';
});
afterAll(() => {
  process.env['TZ'] = originalTz;
});

const CHECKOUT = '2026-10-10T16:00:00.000Z';

describe('formatTime in the property time zone', () => {
  it('shows the same instant as Lima and New York wall times', () => {
    expect(formatTime(CHECKOUT, 'America/Lima')).toBe('11:00');
    expect(formatTime(CHECKOUT, 'America/New_York')).toBe('12:00'); // EDT, UTC-4
  });

  it('follows the DST change of New York but not Lima (no DST)', () => {
    const afterFallBack = '2026-11-02T16:00:00.000Z';
    expect(formatTime(afterFallBack, 'America/New_York')).toBe('11:00'); // EST, UTC-5
    expect(formatTime(afterFallBack, 'America/Lima')).toBe('11:00');
  });

  it('uses 24 h and ignores the machine zone', () => {
    expect(formatTime('2026-10-10T23:45:00.000Z', 'America/Lima')).toBe('18:45');
    expect(new Date(CHECKOUT).getHours()).not.toBe(11); // the machine (Tokyo) would say 01
  });
});

describe('formatTimeOnDay', () => {
  it('adds the date only when the local day differs from the service date', () => {
    const lateNight = '2026-10-11T04:30:00.000Z';
    expect(localDateOf(lateNight, 'America/Lima')).toBe('2026-10-10');
    expect(localDateOf(lateNight, 'America/New_York')).toBe('2026-10-11');
    expect(formatTimeOnDay(lateNight, 'America/Lima', '2026-10-10')).toBe('23:30');
    const ny = formatTimeOnDay(lateNight, 'America/New_York', '2026-10-10');
    expect(ny).toMatch(/00:30$/);
    expect(ny).toContain('11');
  });
});

describe('local dates are shown as-is', () => {
  it('never shifts a service date, whatever the zone', () => {
    expect(formatLocalDate('2026-10-04')).toMatch(/4 oct.? 2026/);
    process.env['TZ'] = 'Pacific/Kiritimati'; // UTC+14
    expect(formatLocalDate('2026-10-04')).toMatch(/4 oct.? 2026/);
    process.env['TZ'] = 'Pacific/Pago_Pago'; // UTC-11
    expect(formatLocalDate('2026-10-04')).toMatch(/4 oct.? 2026/);
    process.env['TZ'] = 'Asia/Tokyo';
  });

  it('computes today and tomorrow in the given zone', () => {
    const now = new Date('2026-10-11T03:00:00.000Z'); // 22:00 on the 10th in Lima
    expect(todayIn('America/Lima', now)).toBe('2026-10-10');
    expect(todayIn('Asia/Tokyo', now)).toBe('2026-10-11');
    expect(shiftDate('2026-10-31', 1)).toBe('2026-11-01');
  });
});

describe('local input → instant', () => {
  it('interprets a typed wall time in the property zone', () => {
    expect(instantFromLocal('2026-10-10', '11:00', 'America/Lima')).toBe(
      '2026-10-10T16:00:00.000Z',
    );
    expect(instantFromLocal('2026-10-10', '11:00', 'America/New_York')).toBe(
      '2026-10-10T15:00:00.000Z',
    );
  });
});

describe('durations', () => {
  it('formats minutes for the window countdown', () => {
    expect(formatDuration(45)).toBe('45 min');
    expect(formatDuration(125)).toBe('2 h 05 min');
    expect(formatDuration(-75)).toBe('1 h 15 min');
    expect(formatDuration(60 * 50)).toBe('2 d 2 h');
    expect(minutesUntil('2026-10-10T20:00:00.000Z', new Date('2026-10-10T18:30:00.000Z'))).toBe(90);
  });
});
