import { v7 as uuidv7, validate as uuidValidate } from 'uuid';

/**
 * Generates a new UUIDv7 (RFC 9562): time-ordered, so ids created later sort after earlier ones
 * (lexicographically and as Postgres `uuid`), which keeps B-tree inserts append-mostly.
 */
export function newId(): string {
  return uuidv7();
}

/**
 * True when `value` is a UUID string in canonical 8-4-4-4-12 hex form (any RFC 9562 version 1-8,
 * plus the nil and max UUIDs). Case-insensitive. Clients may send their own UUIDs for client-created
 * records (attachments, incidents, checklist results), so this does not require version 7.
 */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && uuidValidate(value);
}
