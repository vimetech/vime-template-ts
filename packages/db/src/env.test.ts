import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { databaseUrl, loadRootEnvFile } from './env';

describe('databaseUrl', () => {
  it('returns a valid postgres URL', () => {
    const url = 'postgres://vime_app:secret@localhost:5432/vime_dev';
    expect(databaseUrl('DATABASE_URL', { DATABASE_URL: url })).toBe(url);
    const alt = 'postgresql://vime_system:secret@db.internal/vime';
    expect(databaseUrl('DATABASE_URL_SYSTEM', { DATABASE_URL_SYSTEM: alt })).toBe(alt);
  });

  it.each([undefined, '', '   '])('throws naming the variable when it is %j', (value) => {
    expect(() => databaseUrl('DATABASE_URL_SYSTEM', { DATABASE_URL_SYSTEM: value })).toThrow(
      /DATABASE_URL_SYSTEM is not set/,
    );
  });

  it('rejects non-postgres URLs without echoing the value', () => {
    const run = () => databaseUrl('DATABASE_URL', { DATABASE_URL: 'mysql://u:hunter2@h/db' });
    expect(run).toThrow(/DATABASE_URL must be a postgres/);
    expect(run).not.toThrow(/hunter2/);
    expect(() => databaseUrl('DATABASE_URL', { DATABASE_URL: 'not a url' })).toThrow();
  });
});

describe('loadRootEnvFile', () => {
  const dirs: string[] = [];
  const makeDir = () => {
    const dir = mkdtempSync(join(tmpdir(), 'vime-db-env-'));
    dirs.push(dir);
    return dir;
  };

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
    delete process.env.VIME_DB_ENV_TEST_A;
    delete process.env.VIME_DB_ENV_TEST_B;
  });

  it('loads .env from the nearest workspace root without overriding existing variables', () => {
    const root = makeDir();
    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages: []\n');
    writeFileSync(
      join(root, '.env'),
      'VIME_DB_ENV_TEST_A=from-file\nVIME_DB_ENV_TEST_B=from-file\n',
    );
    const nested = join(root, 'packages', 'db');
    mkdirSync(nested, { recursive: true });
    process.env.VIME_DB_ENV_TEST_B = 'from-env';

    expect(loadRootEnvFile(nested)).toBe(join(root, '.env'));
    expect(process.env.VIME_DB_ENV_TEST_A).toBe('from-file');
    expect(process.env.VIME_DB_ENV_TEST_B).toBe('from-env');
  });

  it('returns null when the workspace root has no .env', () => {
    const root = makeDir();
    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages: []\n');
    expect(loadRootEnvFile(root)).toBeNull();
  });

  it('returns null outside a workspace', () => {
    expect(loadRootEnvFile(makeDir())).toBeNull();
  });
});
