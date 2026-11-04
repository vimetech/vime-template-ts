import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';

/*
 * Settings shared by playwright.config.ts (servers) and the specs (URLs, credentials). The e2e
 * suite owns a DEDICATED database: it is dropped and prepared again on every run (prepare-db.mjs:
 * bootstrap, migrate, seed), so it never touches the development database. It runs from the
 * sources (tsx, Vite dev server) or, with E2E_USE_BUILD=1 (CI), from the builds, with the API
 * serving the web app itself (one origin, as in production).
 */

export const REPO_ROOT = resolve(import.meta.dirname, '../../../..');
export const WEB_DIR = resolve(REPO_ROOT, 'apps/web');
export const API_DIR = resolve(REPO_ROOT, 'apps/api');

/** Run the built bundles (`pnpm build`) instead of the sources. */
export const USE_BUILD = process.env['E2E_USE_BUILD'] === '1';

/**
 * One origin, as in production: the API serves the web app at `/` and itself under `/api`. With
 * the builds. From the sources, the web app runs on the Vite dev server (its own port, `/api`
 * proxied to the API).
 */
export const SINGLE_ORIGIN = USE_BUILD;

/** Ports of the servers the suite starts (it never reuses running ones: see the config). */
export const API_PORT = Number(process.env['E2E_API_PORT'] ?? 4000);
export const WEB_PORT = Number(process.env['E2E_WEB_PORT'] ?? 5173);

/** Public URL of the API (Better Auth; with one origin, the web app too). */
export const API_PUBLIC_URL = `http://localhost:${API_PORT}`;
/** The web app's origin (the API's WEB_ORIGIN must be exactly this). */
export const WEB_URL = SINGLE_ORIGIN ? API_PUBLIC_URL : `http://localhost:${WEB_PORT}`;

/** Build output the API serves. */
export const WEB_DIST_DIR = resolve(WEB_DIR, 'dist');

/** Password of the seeded users (`SEED_OWNER_PASSWORD` of the e2e seed). */
export const SEED_PASSWORD = 'vime-e2e-password';

/** The owner of the organization the specs work in (its session: auth.setup.ts). */
export const OWNER = { email: 'owner@acme.test', password: SEED_PASSWORD };

/** Slug of that organization (`acme` of the seed). */
export const ORG_SLUG = 'acme';

/** Signed-in owner (cookie), written by auth.setup.ts; under the git-ignored output dir. */
export const OWNER_STATE_PATH = resolve(WEB_DIR, 'test-results/.auth/owner.json');

/** Name of the dedicated database. prepare-db.mjs drops it, so it must end in `_e2e`. */
export const E2E_DATABASE = process.env['E2E_DATABASE_NAME'] ?? 'vime_e2e';

/** Values of `.env.example`, used when neither the environment nor the root `.env` has them. */
const DATABASE_DEFAULTS = {
  DATABASE_URL_ADMIN: 'postgres://postgres:postgres@localhost:5432/postgres',
  DATABASE_URL_OWNER: 'postgres://vime_owner:vime_owner@localhost:5432/vime',
  DATABASE_URL: 'postgres://vime_app:vime_app@localhost:5432/vime',
  DATABASE_URL_SYSTEM: 'postgres://vime_system:vime_system@localhost:5432/vime',
} as const;
type DatabaseKey = keyof typeof DATABASE_DEFAULTS;

function rootEnvFile(): Record<string, string | undefined> {
  const file = resolve(REPO_ROOT, '.env');
  return existsSync(file) ? parseEnv(readFileSync(file, 'utf8')) : {};
}

const fileEnv = rootEnvFile();

/** The environment wins over the root `.env`, which wins over the defaults (as in db scripts). */
function configured(key: DatabaseKey): string {
  return process.env[key] || fileEnv[key] || DATABASE_DEFAULTS[key];
}

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

/**
 * Connection URLs of the e2e database: the configured ones (same roles and passwords: the roles
 * are shared by every database of the cluster, and bootstrapping with other passwords would change
 * them for the development database too) with the database name replaced.
 */
export const databaseEnv: Record<DatabaseKey, string> = {
  DATABASE_URL_ADMIN: configured('DATABASE_URL_ADMIN'),
  DATABASE_URL_OWNER: withDatabase(configured('DATABASE_URL_OWNER'), E2E_DATABASE),
  DATABASE_URL: withDatabase(configured('DATABASE_URL'), E2E_DATABASE),
  DATABASE_URL_SYSTEM: withDatabase(configured('DATABASE_URL_SYSTEM'), E2E_DATABASE),
};

/**
 * Environment of the database preparation and the API process. Complete on its own (the API is
 * not started with the root `.env`), so a developer's `.env` cannot point the suite elsewhere; an
 * empty value counts as unset for the API.
 */
export const apiEnv: Record<string, string> = {
  ...databaseEnv,
  NODE_ENV: 'test',
  LOG_LEVEL: process.env['E2E_API_LOG_LEVEL'] ?? 'warn',
  API_PORT: String(API_PORT),
  PORT: '',
  API_PUBLIC_URL,
  WEB_ORIGIN: WEB_URL,
  // The published CI values, which the API accepts outside production.
  BETTER_AUTH_SECRET: 'ci-only-secret-0123456789abcdef0123456789',
  CREDENTIALS_ENCRYPTION_KEY: 'Y2ktb25seS1rZXktMDEyMzQ1Njc4OWFiY2RlZjAxMjM=',
  SEED_OWNER_PASSWORD: SEED_PASSWORD,
  WEB_DIST_DIR: SINGLE_ORIGIN ? WEB_DIST_DIR : '',
  // The whole suite (browsers, API clients) comes from one IP and runs in about a minute:
  // the production budget (600 a minute) would throttle it, not test anything.
  RATE_LIMIT_GLOBAL: '6000',
};
