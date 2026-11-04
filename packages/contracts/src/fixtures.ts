import { expect } from 'vitest';
import type { z } from 'zod';

/*
 * Test data shared by the contract tests. Internal: not re-exported from the package entry point.
 */

export const ID_1 = '01928f3e-7c3a-7b2e-9a6f-3c1d2e4f5a6b';
export const ID_2 = '01928f3e-7c3a-7b2e-9a6f-3c1d2e4f5a6c';
export const ID_3 = '01928f3e-7c3a-7b2e-9a6f-3c1d2e4f5a6d';
export const NOW = '2026-10-10T15:00:00.000Z';

/** Serializes to JSON and parses back: the response must survive the wire unchanged. */
export function roundTrip<T extends z.ZodType>(schema: T, value: z.output<T>): void {
  expect(schema.parse(JSON.parse(JSON.stringify(value)))).toEqual(value);
}
