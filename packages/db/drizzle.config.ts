import { defineConfig } from 'drizzle-kit';
import { loadRootEnvFile } from './src/env';

/**
 * drizzle-kit configuration: one migrations folder and one journal for every module schema.
 *
 * Constraints:
 * - Run drizzle-kit from packages/db (`pnpm db:generate`). It resolves `schema` and `out` against
 *   the current directory.
 * - drizzle-kit loads this file and every schema file with its bundled tsx CommonJS loader. Schema
 *   files may import workspace packages (@vime/db, @vime/kernel, @vime/contracts), but nothing they
 *   import may use top-level await or depend on import.meta.
 * - The glob loads every .ts file in modules/<name>/src/schema/: keep only schema definitions
 *   there, with no tests and no side effects.
 * - Column names are written explicitly in snake_case. No `casing` option is set, here or on the
 *   runtime Drizzle instance.
 * - Never run `drizzle-kit push` against a shared database. Generate, review the SQL, then
 *   `pnpm db:migrate`.
 */
loadRootEnvFile();

const url = process.env.DATABASE_URL_OWNER;

export default defineConfig({
  dialect: 'postgresql',
  schema: '../../modules/*/src/schema/*.ts',
  out: './migrations',
  ...(url ? { dbCredentials: { url } } : {}),
  strict: true,
  verbose: true,
});
