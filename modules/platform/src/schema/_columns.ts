import { sql } from 'drizzle-orm';
import { check, timestamp, type AnyPgColumn, type CheckBuilder } from 'drizzle-orm/pg-core';

/* Column and constraint helpers shared by every schema file (no table imports here). */

/** `timestamptz` column (instants are always stored in UTC). */
export function timestamptz(name: string) {
  return timestamp(name, { withTimezone: true, mode: 'date' });
}

const ENUM_VALUE = /^[A-Za-z0-9_.-]+$/;

/**
 * `CHECK (<column> IN (...))` for a text column holding one of a closed set of values (the value
 * tuples of @vime/contracts). Enum-like columns are `text` + CHECK rather than Postgres enums, so
 * adding a value is a plain constraint swap in a migration.
 */
export function enumCheck(
  name: string,
  column: AnyPgColumn,
  values: readonly string[],
): CheckBuilder {
  for (const value of values) {
    if (!ENUM_VALUE.test(value)) {
      throw new Error(`enumCheck(${name}): unsupported value ${JSON.stringify(value)}`);
    }
  }
  const list = values.map((value) => `'${value}'`).join(', ');
  return check(name, sql.raw(`"${column.name}" in (${list})`));
}
