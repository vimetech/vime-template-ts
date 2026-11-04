import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Client } from 'pg';
import { databaseUrl } from './env';

/** packages/db/migrations: the single migrations folder and journal for every module schema. */
export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../migrations', import.meta.url));

/** Drizzle's default bookkeeping table (schema `drizzle`, owned by vime_owner). */
const JOURNAL_TABLE = 'drizzle.__drizzle_migrations';

export interface MigrateOptions {
  migrationsFolder?: string;
  /** Receives progress lines. Defaults to console.log. */
  log?: (line: string) => void;
}

/** A migration of the journal, with what drizzle records for it once applied. */
export interface JournalMigration {
  tag: string;
  /** SHA-256 of the .sql file (`__drizzle_migrations.hash`). */
  hash: string;
  /** The journal's `when` (`__drizzle_migrations.created_at`). */
  when: number;
}

/** A row of `drizzle.__drizzle_migrations`, in application (id) order. */
export interface AppliedMigration {
  hash: string;
  createdAt: number;
}

/** The migrations of `migrationsFolder`'s journal, hashed exactly as drizzle's migrator does. */
export function readJournal(migrationsFolder: string = MIGRATIONS_FOLDER): JournalMigration[] {
  const journal = JSON.parse(
    readFileSync(join(migrationsFolder, 'meta', '_journal.json'), 'utf8'),
  ) as { entries: { tag: string }[] };
  return readMigrationFiles({ migrationsFolder }).map((migration, index) => ({
    tag: journal.entries[index]?.tag ?? `#${index}`,
    hash: migration.hash,
    when: migration.folderMillis,
  }));
}

/**
 * Checks the migrations a database applied against the journal and returns the tags still pending.
 * The applied ones must be the journal's first entries, in order, with the same hash and `when`.
 * Anything else means committed migrations were edited or regenerated after this database applied
 * them: drizzle would then re-run them (or skip changes) against a schema they do not match, so
 * this throws, naming the offending migrations, and asks for a reset.
 */
export function pendingMigrations(
  applied: readonly AppliedMigration[],
  journal: readonly JournalMigration[],
): string[] {
  const rewritten: string[] = [];
  applied.forEach((row, index) => {
    const expected = journal[index];
    if (!expected) {
      rewritten.push(`#${index + 1} (not in the journal)`);
    } else if (row.hash !== expected.hash || row.createdAt !== expected.when) {
      rewritten.push(expected.tag);
    }
  });
  if (rewritten.length > 0) {
    throw new Error(
      `Migrations were rewritten since this database was migrated (${rewritten.join(', ')}). ` +
        'Committed migrations are immutable once applied; for a development database, reset ' +
        'it: drop the database, then pnpm db:bootstrap && pnpm db:migrate.',
    );
  }
  return journal.slice(applied.length).map((migration) => migration.tag);
}

async function readApplied(client: Client): Promise<AppliedMigration[]> {
  const table = await client.query<{ exists: boolean }>(
    'select to_regclass($1) is not null as exists',
    [JOURNAL_TABLE],
  );
  if (!table.rows[0]?.exists) {
    return [];
  }
  const result = await client.query<{ hash: string; created_at: string }>(
    `select hash, created_at from ${JOURNAL_TABLE} order by id`,
  );
  return result.rows.map((row) => ({ hash: row.hash, createdAt: Number(row.created_at) }));
}

async function countApplied(client: Client): Promise<number> {
  // Two queries: Postgres resolves table names at parse time, so the count cannot be guarded by a
  // CASE in the same statement.
  const table = await client.query<{ exists: boolean }>(
    'select to_regclass($1) is not null as exists',
    [JOURNAL_TABLE],
  );
  if (!table.rows[0]?.exists) {
    return 0;
  }
  const result = await client.query<{ applied: number }>(
    `select count(*)::int as applied from ${JOURNAL_TABLE}`,
  );
  return result.rows[0]?.applied ?? 0;
}

/**
 * Applies pending migrations as `vime_owner` (DATABASE_URL_OWNER). Returns how many were applied.
 * If there is no journal yet (nothing generated), it logs that and returns 0. A session advisory
 * lock serializes concurrent runs, for example two deploys starting at the same time. Refuses to
 * run (see `pendingMigrations`) when the applied history no longer matches the journal.
 */
export async function migrateDatabase({
  migrationsFolder = MIGRATIONS_FOLDER,
  log = console.log,
}: MigrateOptions = {}): Promise<number> {
  if (!existsSync(join(migrationsFolder, 'meta', '_journal.json'))) {
    log(
      `No migrations found in ${migrationsFolder} (meta/_journal.json is missing). Generate them with pnpm db:generate. Nothing to apply.`,
    );
    return 0;
  }
  const client = new Client({
    connectionString: databaseUrl('DATABASE_URL_OWNER'),
    application_name: 'vime-migrate',
  });
  await client.connect();
  try {
    await client.query(`select pg_advisory_lock(hashtext('vime:migrate'))`);
    pendingMigrations(await readApplied(client), readJournal(migrationsFolder));
    const before = await countApplied(client);
    await migrate(drizzle({ client }), { migrationsFolder });
    const applied = (await countApplied(client)) - before;
    log(
      applied === 0
        ? 'Database is up to date.'
        : `Applied ${applied} migration(s); ${before + applied} in total.`,
    );
    return applied;
  } finally {
    // Ending the session also releases the advisory lock.
    await client.end();
  }
}
