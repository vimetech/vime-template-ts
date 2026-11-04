import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import * as contracts from './index';

function isZodEnum(value: unknown): value is z.ZodEnum {
  return value instanceof z.ZodEnum;
}

/** snake_case keys, or the es-PE locale. */
const ENUM_VALUE = /^[a-z][a-z0-9_.-]*$|^es-PE$/;

/** Every `XxxSchema` built with z.enum, found through the public entry point. */
const enumSchemas: Array<[string, z.ZodEnum]> = [];
for (const [name, value] of Object.entries(contracts as Record<string, unknown>)) {
  if (name.endsWith('Schema') && isZodEnum(value)) {
    enumSchemas.push([name, value]);
  }
}

describe('enums', () => {
  it('exports the platform enums', () => {
    const names = enumSchemas.map(([name]) => name);
    for (const expected of [
      'FlagKindSchema',
      'FlagSeveritySchema',
      'FlagStatusSchema',
      'NotificationChannelSchema',
      'NotificationStatusSchema',
      'ActivitySourceSchema',
      'MembershipStatusSchema',
      'FeatureKeySchema',
      'PermissionSchema',
      'RoleKeySchema',
      'LocaleSchema',
    ]) {
      expect(names).toContain(expected);
    }
  });

  it.each(enumSchemas)('%s has unique snake_case values', (_name, schema) => {
    const values = schema.options as string[];
    expect(values.length).toBeGreaterThan(0);
    expect(new Set(values).size).toBe(values.length);
    for (const value of values) {
      expect(value).toMatch(ENUM_VALUE);
      expect(schema.parse(value)).toBe(value);
    }
    expect(schema.safeParse('__unknown__').success).toBe(false);
  });

  it('keeps the spec values for the exception queue', () => {
    expect(contracts.FLAG_STATUSES).toEqual(['open', 'resolved', 'dismissed']);
    expect(contracts.FLAG_SEVERITIES).toEqual(['info', 'warning', 'critical']);
  });
});
