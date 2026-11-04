import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import * as contracts from './index';

/*
 * The API generates OpenAPI from these schemas (fastify-type-provider-zod → z.toJSONSchema), so
 * every exported schema must be representable as JSON Schema (no transforms, no z.custom).
 */
const schemas = Object.entries(contracts as Record<string, unknown>).filter(
  ([name, value]) => name.endsWith('Schema') && value instanceof z.ZodType,
) as Array<[string, z.ZodType]>;

describe('JSON Schema generation', () => {
  it('finds the exported schemas', () => {
    expect(schemas.length).toBeGreaterThan(50);
  });

  it.each(schemas)('%s converts for requests and responses', (_name, schema) => {
    expect(() => z.toJSONSchema(schema, { io: 'input' })).not.toThrow();
    expect(() => z.toJSONSchema(schema, { io: 'output' })).not.toThrow();
  });

  it('converts paginated responses', () => {
    expect(() => z.toJSONSchema(contracts.page(contracts.NoteSchema))).not.toThrow();
  });
});
