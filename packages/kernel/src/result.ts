/** Successful outcome. */
export interface Ok<T> {
  readonly ok: true;
  readonly value: T;
}

/** Failed outcome. */
export interface Err<E> {
  readonly ok: false;
  readonly error: E;
}

/**
 * Outcome of an operation that can fail in an expected way (e.g. a rejected state transition).
 * Narrow with `if (result.ok)`. Unexpected failures should still throw.
 */
export type Result<T, E> = Ok<T> | Err<E>;

export function ok(): Ok<void>;
export function ok<T>(value: T): Ok<T>;
export function ok<T>(value?: T): Ok<T | undefined> {
  return { ok: true, value };
}

export function err<E>(error: E): Err<E> {
  return { ok: false, error };
}

/**
 * Exhaustiveness check for discriminated unions: the call only type-checks when every case has been
 * handled; reaching it at runtime throws.
 */
export function assertNever(value: never, message?: string): never {
  throw new Error(message ?? `Unexpected value: ${describe(value)}`);
}

function describe(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
