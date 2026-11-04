import { describe, expect, it } from 'vitest';
import { isUuid, newId } from './ids';

describe('newId', () => {
  it('generates RFC 9562 version 7 UUIDs', () => {
    const id = newId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(isUuid(id)).toBe(true);
  });

  it('embeds the creation time in the first 48 bits', () => {
    const before = Date.now();
    const id = newId();
    const after = Date.now();
    const embeddedMs = parseInt(id.replaceAll('-', '').slice(0, 12), 16);
    expect(embeddedMs).toBeGreaterThanOrEqual(before);
    expect(embeddedMs).toBeLessThanOrEqual(after);
  });

  it('is unique and sorts in generation order', () => {
    const ids = Array.from({ length: 10_000 }, () => newId());
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(ids);
  });
});

describe('isUuid', () => {
  it('accepts canonical UUIDs of any version, case-insensitively', () => {
    expect(isUuid('0190f2a4-7c1e-7b3a-9d2e-4f5a6b7c8d9e')).toBe(true);
    expect(isUuid('0190F2A4-7C1E-7B3A-9D2E-4F5A6B7C8D9E')).toBe(true);
    expect(isUuid('3b241101-e2bb-4255-8caf-4136c566a962')).toBe(true); // v4 (client generated)
    expect(isUuid('00000000-0000-0000-0000-000000000000')).toBe(true);
  });

  it('rejects anything else', () => {
    for (const bad of [
      '',
      'not-a-uuid',
      '0190f2a47c1e7b3a9d2e4f5a6b7c8d9e',
      '{0190f2a4-7c1e-7b3a-9d2e-4f5a6b7c8d9e}',
      '0190f2a4-7c1e-7b3a-9d2e-4f5a6b7c8d9',
      '0190f2a4-7c1e-7b3a-9d2e-4f5a6b7c8d9e ',
      '0190f2a4-7c1e-0b3a-9d2e-4f5a6b7c8d9e', // version 0
      '0190f2a4-7c1e-7b3a-cd2e-4f5a6b7c8d9e', // wrong variant
    ]) {
      expect(isUuid(bad), bad).toBe(false);
    }
    expect(isUuid(undefined)).toBe(false);
    expect(isUuid(42)).toBe(false);
  });
});
