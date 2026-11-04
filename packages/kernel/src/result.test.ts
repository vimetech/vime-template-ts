import { describe, expect, it } from 'vitest';
import { assertNever, err, ok } from './result';
import type { Result } from './result';

function divide(a: number, b: number): Result<number, 'division_by_zero'> {
  return b === 0 ? err('division_by_zero') : ok(a / b);
}

describe('Result', () => {
  it('narrows on the ok discriminant', () => {
    const success = divide(6, 3);
    expect(success).toEqual({ ok: true, value: 2 });
    if (success.ok) {
      expect(success.value).toBe(2);
    }
    const failure = divide(1, 0);
    expect(failure).toEqual({ ok: false, error: 'division_by_zero' });
    if (!failure.ok) {
      expect(failure.error).toBe('division_by_zero');
    }
  });

  it('supports void results', () => {
    const done: Result<void, string> = ok();
    expect(done).toEqual({ ok: true, value: undefined });
  });
});

describe('assertNever', () => {
  type Shape = { kind: 'circle'; r: number } | { kind: 'square'; side: number };

  function area(shape: Shape): number {
    switch (shape.kind) {
      case 'circle':
        return Math.PI * shape.r ** 2;
      case 'square':
        return shape.side ** 2;
      default:
        return assertNever(shape);
    }
  }

  it('is unreachable for handled cases and throws for unexpected runtime values', () => {
    expect(area({ kind: 'square', side: 2 })).toBe(4);
    expect(() => area({ kind: 'triangle' } as unknown as Shape)).toThrow(
      'Unexpected value: {"kind":"triangle"}',
    );
    expect(() => assertNever(undefined as never, 'Unknown task status')).toThrow(
      'Unknown task status',
    );
  });
});
