import {
  ACTIVITY_SOURCES,
  FEATURES,
  FLAG_KINDS,
  FLAG_SEVERITIES,
  FLAG_STATUSES,
  MEMBERSHIP_STATUSES,
  OPTIONAL_FUNCTIONS,
  PROBLEM_CODES,
  ROLE_KEYS,
} from '@vime/contracts';
import { commonEn, commonEsPE, webEn, webEsPE } from '@vime/i18n';
import { describe, expect, it } from 'vitest';
import { NAV_KEYS } from './lib/nav';

function keyPaths(value: unknown, prefix = ''): string[] {
  if (typeof value === 'string') return [prefix];
  return Object.entries(value as Record<string, unknown>)
    .flatMap(([key, child]) => keyPaths(child, prefix ? `${prefix}.${key}` : key))
    .sort();
}

function placeholders(value: unknown, prefix = ''): Record<string, string[]> {
  if (typeof value === 'string') {
    return { [prefix]: [...value.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1] as string).sort() };
  }
  return Object.assign(
    {},
    ...Object.entries(value as Record<string, unknown>).map(([key, child]) =>
      placeholders(child, prefix ? `${prefix}.${key}` : key),
    ),
  ) as Record<string, string[]>;
}

describe('catalogs', () => {
  it('es-PE and en have exactly the same keys and placeholders', () => {
    expect(keyPaths(webEn)).toEqual(keyPaths(webEsPE));
    expect(keyPaths(commonEn)).toEqual(keyPaths(commonEsPE));
    expect(placeholders(webEn)).toEqual(placeholders(webEsPE));
    expect(placeholders(commonEn)).toEqual(placeholders(commonEsPE));
  });

  it('labels every value of the shared enums', () => {
    const enums: [keyof typeof commonEsPE, readonly string[]][] = [
      ['roleKey', ROLE_KEYS],
      ['membershipStatus', MEMBERSHIP_STATUSES],
      ['feature', FEATURES],
      ['flagKind', FLAG_KINDS],
      ['flagSeverity', FLAG_SEVERITIES],
      ['flagStatus', FLAG_STATUSES],
      ['activitySource', ACTIVITY_SOURCES],
      ['problem', PROBLEM_CODES],
    ];
    for (const [group, values] of enums) {
      const labels = commonEsPE[group] as Record<string, string>;
      for (const value of values) {
        expect(labels[value], `${group}.${value}`).toBeTypeOf('string');
      }
    }
  });

  it('labels every navigation entry and every optional function', () => {
    for (const key of NAV_KEYS) {
      expect(webEsPE.nav[key], `nav.${key}`).toBeTypeOf('string');
    }
    for (const fn of OPTIONAL_FUNCTIONS) {
      expect(webEsPE.settings.functions.items[fn].label, `functions.${fn}`).toBeTypeOf('string');
    }
  });
});
