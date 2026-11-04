import { describe, expect, it } from 'vitest';
import { DEFAULT_WEB_DIST_DIR, loadEnv } from './env';

const VALID = {
  API_PUBLIC_URL: 'https://api.example.com/',
  WEB_ORIGIN: 'https://app.example.com',
  BETTER_AUTH_SECRET: 'x'.repeat(32),
  CREDENTIALS_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
  DATABASE_URL: 'postgres://vime_app:pw@localhost:5432/vime',
  DATABASE_URL_SYSTEM: 'postgres://vime_system:pw@localhost:5432/vime',
};

describe('loadEnv', () => {
  it('parses a valid environment with defaults', () => {
    const env = loadEnv(VALID);
    expect(env).toMatchObject({
      NODE_ENV: 'development',
      LOG_LEVEL: 'info',
      API_HOST: '0.0.0.0',
      API_PORT: 4000,
      API_PUBLIC_URL: 'https://api.example.com',
      WEB_ORIGIN: 'https://app.example.com',
      TRUST_PROXY: false,
    });
    expect(Object.isFrozen(env)).toBe(true);
  });

  it('coerces numbers and booleans, and treats empty strings as unset', () => {
    const env = loadEnv({
      ...VALID,
      API_PORT: '4100',
      TRUST_PROXY: 'true',
      LOG_LEVEL: '',
      RATE_LIMIT_GLOBAL: '3000',
    });
    expect(env.API_PORT).toBe(4100);
    expect(env.RATE_LIMIT_GLOBAL).toBe(3000);
    expect(loadEnv(VALID).RATE_LIMIT_GLOBAL).toBeUndefined();
    expect(env.TRUST_PROXY).toBe(true);
    expect(env.LOG_LEVEL).toBe('info');
  });

  it('names every invalid variable without echoing secret values', () => {
    const secret = 'short-secret';
    let message = '';
    try {
      loadEnv({
        ...VALID,
        BETTER_AUTH_SECRET: secret,
        CREDENTIALS_ENCRYPTION_KEY: 'bm90LTMyLWJ5dGVz',
        WEB_ORIGIN: 'nope',
        DATABASE_URL: undefined,
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('BETTER_AUTH_SECRET');
    expect(message).toContain('CREDENTIALS_ENCRYPTION_KEY');
    expect(message).toContain('WEB_ORIGIN');
    expect(message).toContain('DATABASE_URL');
    expect(message).not.toContain(secret);
  });

  it('refuses the example/CI secrets in production (they are public), accepts them elsewhere', () => {
    const published = {
      ...VALID,
      BETTER_AUTH_SECRET: 'dev-only-secret-change-me-0123456789abcdef',
      CREDENTIALS_ENCRYPTION_KEY: 'ZGV2LW9ubHkta2V5LWNoYW5nZS1tZS0wMTIzNDU2Nzg=',
    };
    expect(() => loadEnv({ ...published, NODE_ENV: 'production' })).toThrow(
      /CREDENTIALS_ENCRYPTION_KEY: must be 32 random bytes in production[\s\S]*BETTER_AUTH_SECRET/,
    );
    expect(() =>
      loadEnv({
        ...VALID,
        NODE_ENV: 'production',
        // The CI key decodes to ASCII text: refused as well.
        CREDENTIALS_ENCRYPTION_KEY: 'Y2ktb25seS1rZXktMDEyMzQ1Njc4OWFiY2RlZjAxMjM=',
      }),
    ).toThrow(/CREDENTIALS_ENCRYPTION_KEY/);
    for (const NODE_ENV of ['development', 'test'] as const) {
      expect(loadEnv({ ...published, NODE_ENV }).NODE_ENV).toBe(NODE_ENV);
    }
    // A random key and secret are fine in production.
    expect(loadEnv({ ...VALID, NODE_ENV: 'production' }).NODE_ENV).toBe('production');
  });

  it('accepts previous credential keys (rotation) and refuses published ones in production', () => {
    const previous = [
      Buffer.alloc(32, 2).toString('base64'),
      Buffer.alloc(32, 3).toString('base64'),
    ];
    expect(loadEnv(VALID).CREDENTIALS_ENCRYPTION_KEYS_PREVIOUS).toEqual([]);
    expect(
      loadEnv({ ...VALID, CREDENTIALS_ENCRYPTION_KEYS_PREVIOUS: ` ${previous.join(' , ')} ,` })
        .CREDENTIALS_ENCRYPTION_KEYS_PREVIOUS,
    ).toEqual(previous);
    expect(() =>
      loadEnv({ ...VALID, CREDENTIALS_ENCRYPTION_KEYS_PREVIOUS: 'bm90LTMyLWJ5dGVz' }),
    ).toThrow(/CREDENTIALS_ENCRYPTION_KEYS_PREVIOUS/);
    expect(() =>
      loadEnv({
        ...VALID,
        NODE_ENV: 'production',
        CREDENTIALS_ENCRYPTION_KEYS_PREVIOUS: 'ZGV2LW9ubHkta2V5LWNoYW5nZS1tZS0wMTIzNDU2Nzg=',
      }),
    ).toThrow(/CREDENTIALS_ENCRYPTION_KEYS_PREVIOUS\.0: must be 32 random bytes in production/);
  });

  it('listens on PORT when API_PORT is not set (Railway, Render, Fly)', () => {
    expect(loadEnv({ ...VALID, PORT: '8080' }).API_PORT).toBe(8080);
    expect(loadEnv({ ...VALID, PORT: '8080', API_PORT: '4100' }).API_PORT).toBe(4100);
    expect(loadEnv({ ...VALID, PORT: '' }).API_PORT).toBe(4000);
    expect(() => loadEnv({ ...VALID, PORT: 'eighty' })).toThrow(/API_PORT/);
  });

  it('reads the platform administrators as lowercase user ids, and refuses anything else', () => {
    expect(loadEnv(VALID).PLATFORM_ADMIN_USER_IDS).toEqual([]);
    const ids = '0199A000-0000-7000-8000-000000000001 , 0199a000-0000-7000-8000-000000000002,';
    expect(loadEnv({ ...VALID, PLATFORM_ADMIN_USER_IDS: ids }).PLATFORM_ADMIN_USER_IDS).toEqual([
      '0199a000-0000-7000-8000-000000000001',
      '0199a000-0000-7000-8000-000000000002',
    ]);
    expect(() => loadEnv({ ...VALID, PLATFORM_ADMIN_USER_IDS: 'admin@example.com' })).toThrow(
      /PLATFORM_ADMIN_USER_IDS/,
    );
  });

  it('serves the web build next to the bundle in production only, unless configured', () => {
    expect(DEFAULT_WEB_DIST_DIR).toMatch(/apps[\\/]web[\\/]dist$/);
    expect(loadEnv(VALID)).toMatchObject({ WEB_DIST_DIR: undefined });
    expect(loadEnv({ ...VALID, NODE_ENV: 'production' })).toMatchObject({
      WEB_DIST_DIR: DEFAULT_WEB_DIST_DIR,
    });
    expect(loadEnv({ ...VALID, NODE_ENV: 'production', WEB_DIST_DIR: '/srv/web' })).toMatchObject({
      WEB_DIST_DIR: '/srv/web',
    });
  });
});
