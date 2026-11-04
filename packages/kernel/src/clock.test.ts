import { describe, expect, it } from 'vitest';
import { fixedClock, systemClock, testClock } from './clock';

describe('systemClock', () => {
  it('returns the current time', () => {
    const before = Date.now();
    const now = systemClock.now().getTime();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now());
  });
});

describe('fixedClock', () => {
  it('always returns the same instant', () => {
    const clock = fixedClock('2026-03-08T07:00:00Z');
    expect(clock.now().toISOString()).toBe('2026-03-08T07:00:00.000Z');
    expect(clock.now().toISOString()).toBe('2026-03-08T07:00:00.000Z');
  });

  it('is not affected by mutating the input or a returned Date', () => {
    const start = new Date('2026-10-04T12:00:00Z');
    const clock = fixedClock(start);
    start.setUTCFullYear(2000);
    clock.now().setUTCFullYear(1999);
    expect(clock.now().toISOString()).toBe('2026-10-04T12:00:00.000Z');
  });

  it('rejects invalid instants', () => {
    expect(() => fixedClock('not a date')).toThrow(RangeError);
    expect(() => fixedClock(new Date(Number.NaN))).toThrow(RangeError);
  });
});

describe('testClock', () => {
  it('advances and jumps on demand', () => {
    const clock = testClock('2026-10-04T12:00:00Z');
    expect(clock.now().toISOString()).toBe('2026-10-04T12:00:00.000Z');
    clock.advance(90 * 60_000);
    expect(clock.now().toISOString()).toBe('2026-10-04T13:30:00.000Z');
    clock.advance(-30 * 60_000);
    expect(clock.now().toISOString()).toBe('2026-10-04T13:00:00.000Z');
    clock.set(new Date('2027-01-01T00:00:00Z'));
    expect(clock.now().toISOString()).toBe('2027-01-01T00:00:00.000Z');
    clock.set('2026-01-01T00:00:00Z');
    expect(clock.now().toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('returns fresh Date objects', () => {
    const clock = testClock('2026-10-04T12:00:00Z');
    clock.now().setUTCHours(0);
    expect(clock.now().toISOString()).toBe('2026-10-04T12:00:00.000Z');
  });

  it('rejects invalid input', () => {
    expect(() => testClock('nope')).toThrow(RangeError);
    const clock = testClock('2026-10-04T12:00:00Z');
    expect(() => clock.advance(Number.NaN)).toThrow(RangeError);
    expect(() => clock.advance(Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => clock.set('nope')).toThrow(RangeError);
    expect(clock.now().toISOString()).toBe('2026-10-04T12:00:00.000Z');
  });
});
