import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  LocalDateSchema,
  LocalTimeSchema,
  page,
  PageQuerySchema,
  TimestampSchema,
  TimeZoneSchema,
  UuidSchema,
} from './common';
import { FEATURES, FeatureKeySchema } from './features';
import { PROBLEM_CODES, PROBLEM_STATUS, ProblemCodeSchema, ProblemDetailsSchema } from './problem';

describe('LocalTimeSchema', () => {
  it.each(['00:00', '09:05', '11:00', '15:00', '23:59'])('accepts %s', (value) => {
    expect(LocalTimeSchema.parse(value)).toBe(value);
  });

  it.each(['24:00', '9:00', '12:60', '12:00:00', '1200', ' 12:00', '', '12:5', 'ab:cd'])(
    'rejects %j',
    (value) => {
      expect(LocalTimeSchema.safeParse(value).success).toBe(false);
    },
  );
});

describe('LocalDateSchema', () => {
  it('accepts calendar dates and rejects invalid ones', () => {
    expect(LocalDateSchema.parse('2026-03-08')).toBe('2026-03-08');
    expect(LocalDateSchema.parse('2028-02-29')).toBe('2028-02-29');
    for (const bad of ['2026-02-30', '2026-3-8', '2026-03-08T00:00:00Z', '']) {
      expect(LocalDateSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe('TimestampSchema', () => {
  it('requires an explicit offset or Z', () => {
    expect(TimestampSchema.safeParse('2026-10-04T15:00:00.000Z').success).toBe(true);
    expect(TimestampSchema.safeParse('2026-10-04T10:00:00-05:00').success).toBe(true);
    expect(TimestampSchema.safeParse('2026-10-04T10:00:00').success).toBe(false);
    expect(TimestampSchema.safeParse('2026-10-04').success).toBe(false);
  });
});

describe('TimeZoneSchema', () => {
  it.each(['America/Lima', 'America/New_York', 'Europe/Madrid', 'UTC'])('accepts %s', (tz) => {
    expect(TimeZoneSchema.parse(tz)).toBe(tz);
  });

  it.each(['Foo/Bar', 'Lima', '+05:00', '-0500', ''])('rejects %j', (tz) => {
    expect(TimeZoneSchema.safeParse(tz).success).toBe(false);
  });
});

describe('UuidSchema', () => {
  it('accepts v7 UUIDs and rejects malformed ids', () => {
    expect(UuidSchema.safeParse('01928f3e-7c3a-7b2e-9a6f-3c1d2e4f5a6b').success).toBe(true);
    expect(UuidSchema.safeParse('01928f3e7c3a7b2e9a6f3c1d2e4f5a6b').success).toBe(false);
    expect(UuidSchema.safeParse('not-a-uuid').success).toBe(false);
  });
});

describe('PageQuerySchema', () => {
  it('defaults the limit and coerces query strings', () => {
    expect(PageQuerySchema.parse({})).toEqual({ limit: 50 });
    expect(PageQuerySchema.parse({ limit: '10', cursor: 'abc' })).toEqual({
      limit: 10,
      cursor: 'abc',
    });
  });

  it.each(['0', '201', 'abc', '1.5', ''])('rejects limit %j', (limit) => {
    expect(PageQuerySchema.safeParse({ limit }).success).toBe(false);
  });
});

describe('page()', () => {
  const ItemSchema = z.object({ id: UuidSchema });
  const PageSchema = page(ItemSchema);

  it('round-trips a page and its last page', () => {
    const value = {
      items: [{ id: '01928f3e-7c3a-7b2e-9a6f-3c1d2e4f5a6b' }],
      nextCursor: 'opaque',
    };
    expect(PageSchema.parse(JSON.parse(JSON.stringify(value)))).toEqual(value);
    expect(PageSchema.parse({ items: [], nextCursor: null })).toEqual({
      items: [],
      nextCursor: null,
    });
  });

  it('validates the items', () => {
    expect(PageSchema.safeParse({ items: [{ id: 'x' }], nextCursor: null }).success).toBe(false);
    expect(PageSchema.safeParse({ items: [] }).success).toBe(false);
  });
});

describe('ProblemDetailsSchema', () => {
  it('round-trips a problem with extension members', () => {
    const problem = {
      type: 'https://errors.vime.ops/validation-failed',
      title: 'Validation failed',
      status: 400,
      detail: 'Body is invalid',
      instance: '/v1/properties',
      code: 'validation_failed',
      errors: [{ path: 'name', message: 'Required' }],
      requestId: 'req-1',
    };
    expect(ProblemDetailsSchema.parse(JSON.parse(JSON.stringify(problem)))).toEqual(problem);
  });

  it('tolerates codes unknown to this client version', () => {
    const parsed = ProblemDetailsSchema.parse({
      type: 'about:blank',
      title: 'Something new',
      status: 422,
      code: 'some_future_code',
    });
    expect(parsed.code).toBe('some_future_code');
    expect(ProblemCodeSchema.safeParse('some_future_code').success).toBe(false);
  });

  it('requires type, title, status and code', () => {
    expect(ProblemDetailsSchema.safeParse({ type: 'about:blank', status: 400 }).success).toBe(
      false,
    );
  });

  it('maps every code to an HTTP error status', () => {
    for (const code of PROBLEM_CODES) {
      expect(PROBLEM_STATUS[code]).toBeGreaterThanOrEqual(400);
      expect(PROBLEM_STATUS[code]).toBeLessThan(600);
    }
    expect(Object.keys(PROBLEM_STATUS).sort()).toEqual([...PROBLEM_CODES].sort());
  });
});

describe('FeatureKeySchema', () => {
  it('accepts the defined features only', () => {
    for (const f of FEATURES) expect(FeatureKeySchema.parse(f)).toBe(f);
    expect(FeatureKeySchema.safeParse('billing').success).toBe(false);
  });
});
