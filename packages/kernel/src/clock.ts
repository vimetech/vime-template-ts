/**
 * Source of the current instant. Domain code receives a Clock instead of calling `new Date()` so
 * that time-dependent rules (service dates, risk windows, reopen limits) are testable.
 */
export interface Clock {
  /** Current instant. Each call returns a fresh Date, so callers may mutate it safely. */
  now(): Date;
}

/** Clock backed by the system time. */
export const systemClock: Clock = {
  now: () => new Date(),
};

/** Clock frozen at `at` (a Date or an ISO 8601 date-time string). */
export function fixedClock(at: Date | string): Clock {
  const epochMs = toEpochMs(at);
  return { now: () => new Date(epochMs) };
}

/** Mutable clock for tests: starts at `start` and only moves when told to. */
export interface TestClock extends Clock {
  /** Jumps to `at` (forwards or backwards). */
  set(at: Date | string): void;
  /** Moves the clock by `ms` milliseconds (negative values move it backwards). */
  advance(ms: number): void;
}

export function testClock(start: Date | string): TestClock {
  let current = toEpochMs(start);
  return {
    now: () => new Date(current),
    set(at) {
      current = toEpochMs(at);
    },
    advance(ms) {
      if (!Number.isFinite(ms)) {
        throw new RangeError(`Cannot advance clock by a non-finite amount: ${ms}`);
      }
      current += ms;
    },
  };
}

function toEpochMs(at: Date | string): number {
  const epochMs = typeof at === 'string' ? Date.parse(at) : at.getTime();
  if (Number.isNaN(epochMs)) {
    throw new RangeError(`Invalid clock instant: ${String(at)}`);
  }
  return epochMs;
}
