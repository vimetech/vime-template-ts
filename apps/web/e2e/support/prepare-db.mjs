// @ts-check
/*
 * Prepares the dedicated e2e database before the API starts (first step of the API web server
 * command in playwright.config.ts: Playwright starts its web servers BEFORE globalSetup, and the
 * API refuses to boot without the migrated schema).
 *
 * 1. Drops the database named in DATABASE_URL_OWNER, which must end in `_e2e` (every run starts
 *    from the same seeded day; set E2E_KEEP_DB=1 to keep it, e.g. to inspect it after a run);
 * 2. `pnpm db:bootstrap` (roles, database, privileges), `pnpm db:migrate` and
 *    `pnpm --filter @vime/api seed`, all idempotent, with the e2e environment it receives.
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '../../../..');

/** @param {string} key */
function required(key) {
  const value = process.env[key];
  if (!value) throw new Error(`${key} is not set (playwright.config.ts passes it).`);
  return value;
}

const database = decodeURIComponent(new URL(required('DATABASE_URL_OWNER')).pathname.slice(1));
if (!/^[a-z0-9_]+_e2e$/.test(database)) {
  throw new Error(`Refusing to reset "${database}": the e2e database name must end in _e2e.`);
}

if (process.env['E2E_KEEP_DB'] !== '1') {
  // `pg` is a dependency of @vime/db, not of the web app: load it from there.
  const pg = createRequire(resolve(repoRoot, 'packages/db/package.json'))('pg');
  const client = new pg.Client({ connectionString: required('DATABASE_URL_ADMIN') });
  await client.connect();
  try {
    // FORCE ends leftover sessions (an API process killed by a previous run).
    await client.query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(database)} WITH (FORCE)`);
    console.log(`[e2e] dropped database ${database}`);
  } finally {
    await client.end();
  }
}

for (const args of [['db:bootstrap'], ['db:migrate'], ['--filter', '@vime/api', 'seed']]) {
  const started = Date.now();
  const result = spawnSync('pnpm', ['--silent', ...args], {
    cwd: repoRoot,
    env: process.env,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    throw new Error(`pnpm ${args.join(' ')} failed (exit ${result.status ?? result.signal})`);
  }
  console.log(`[e2e] pnpm ${args.join(' ')} done in ${Date.now() - started} ms`);
}
