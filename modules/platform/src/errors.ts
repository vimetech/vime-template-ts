import { ConflictError, DomainError, ValidationError, type DomainErrorOptions } from '@vime/kernel';
import type { z } from 'zod';

/** Same Idempotency-Key, different request (spec §6). API: 409 `idempotency_conflict`. */
export class IdempotencyConflictError extends DomainError {
  override name = 'IdempotencyConflictError';
  declare readonly code: 'idempotency_conflict';

  constructor(options: DomainErrorOptions = {}) {
    super(
      'idempotency_conflict',
      'This Idempotency-Key was already used with a different request',
      options,
    );
  }
}

/** The first request with this Idempotency-Key has not finished. API: 409 `idempotency_in_progress`. */
export class IdempotencyInProgressError extends DomainError {
  override name = 'IdempotencyInProgressError';
  declare readonly code: 'idempotency_in_progress';

  constructor(options: DomainErrorOptions = {}) {
    super(
      'idempotency_in_progress',
      'A request with this Idempotency-Key is still in progress',
      options,
    );
  }
}

/** Parses service input with a @vime/contracts schema; throws ValidationError on failure. */
export function parseInput<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw ValidationError.fromZod(result.error);
  }
  return result.data;
}

interface PgErrorFields {
  code: string;
  constraint?: string;
  detail?: string;
}

/**
 * The Postgres error behind `error` (Drizzle wraps driver errors in DrizzleQueryError and keeps
 * the original as `cause`), or undefined when it is not a database error.
 */
export function pgError(error: unknown): PgErrorFields | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    const candidate = current as Error & Partial<PgErrorFields>;
    if (typeof candidate.code === 'string' && /^[0-9A-Z]{5}$/.test(candidate.code)) {
      return candidate as PgErrorFields;
    }
    current = candidate.cause;
  }
  return undefined;
}

/** SQLSTATE 23505, optionally for one constraint. */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const pg = pgError(error);
  return pg?.code === '23505' && (constraint === undefined || pg.constraint === constraint);
}

/** SQLSTATE 23503 (insert/update with a missing parent, or delete of a referenced row). */
export function isForeignKeyViolation(error: unknown): boolean {
  return pgError(error)?.code === '23503';
}

/** SQLSTATE class 23: any integrity constraint violation (not null, check, unique, foreign key). */
export function isIntegrityViolation(error: unknown): boolean {
  return pgError(error)?.code.startsWith('23') ?? false;
}

/**
 * Deleting `entity` failed because other rows still reference it. Maps the foreign key violation
 * to a ConflictError; any other error is rethrown unchanged.
 */
export function rethrowReferenced(error: unknown, entity: string, hint: string): never {
  if (isForeignKeyViolation(error)) {
    throw new ConflictError(`The ${entity} is still referenced by other records. ${hint}`, {
      cause: error,
    });
  }
  throw error;
}
