import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';

/**
 * Database connection URLs. Each one belongs to a Postgres role (ADR 0004):
 *
 * - `DATABASE_URL`: `vime_app`. RLS enforced, not table owner. Used by withTenant and withUser.
 * - `DATABASE_URL_SYSTEM`: `vime_system`, which has BYPASSRLS. Used by withSystem only.
 * - `DATABASE_URL_OWNER`: `vime_owner`, which owns the schema. Used by migrations, never at runtime.
 * - `DATABASE_URL_ADMIN`: a superuser. Used by `pnpm db:bootstrap` only (local and CI).
 *
 * Each URL is read and validated lazily, on first use, so a process only needs the URLs it uses.
 * The API never needs DATABASE_URL_OWNER or DATABASE_URL_ADMIN.
 */
export const DATABASE_URL_KEYS = [
  'DATABASE_URL',
  'DATABASE_URL_SYSTEM',
  'DATABASE_URL_OWNER',
  'DATABASE_URL_ADMIN',
] as const;

export type DatabaseUrlKey = (typeof DATABASE_URL_KEYS)[number];

const PostgresUrlSchema = z.url({ protocol: /^postgres(ql)?$/ });

/**
 * Returns the validated connection URL stored in `env[key]`. Throws an Error naming the variable
 * when it is missing or is not a postgres:// URL. The message never includes the value, because
 * it contains a password.
 */
export function databaseUrl(key: DatabaseUrlKey, env: NodeJS.ProcessEnv = process.env): string {
  const value = env[key];
  if (value === undefined || value.trim() === '') {
    throw new Error(
      `${key} is not set. Copy .env.example to .env at the repository root, or set it in the environment.`,
    );
  }
  if (!PostgresUrlSchema.safeParse(value).success) {
    throw new Error(`${key} must be a postgres:// or postgresql:// URL.`);
  }
  return value;
}

/**
 * Loads `<repository root>/.env` into process.env if the file exists. Variables that are already set
 * take precedence, so CI can provide them directly. The repository root is the nearest ancestor of
 * `fromDir` that contains pnpm-workspace.yaml. Returns the loaded file path, or null if there is none.
 *
 * Only scripts, drizzle.config.ts and vitest configs call this. Library code never reads files.
 */
export function loadRootEnvFile(fromDir: string = process.cwd()): string | null {
  let dir = resolve(fromDir);
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) {
      const file = join(dir, '.env');
      if (!existsSync(file)) {
        return null;
      }
      process.loadEnvFile(file);
      return file;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}
