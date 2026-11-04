import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, escapeIdentifier } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import {
  MIGRATIONS_FOLDER,
  migrateDatabase,
  pendingMigrations,
  readJournal,
  type JournalMigration,
} from './migrate';

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

interface FakeMigration {
  tag: string;
  sql: string;
}

/** Writes a migrations folder in drizzle-kit's layout (meta/_journal.json + <tag>.sql). */
function writeMigrations(dir: string, migrations: FakeMigration[]): void {
  mkdirSync(join(dir, 'meta'), { recursive: true });
  const entries = migrations.map((m, idx) => ({
    idx,
    version: '7',
    when: 1_700_000_000_000 + idx * 1000,
    tag: m.tag,
    breakpoints: true,
  }));
  writeFileSync(
    join(dir, 'meta', '_journal.json'),
    JSON.stringify({ version: '7', dialect: 'postgresql', entries }),
  );
  for (const m of migrations) {
    writeFileSync(join(dir, `${m.tag}.sql`), m.sql);
  }
}

describe('pendingMigrations', () => {
  const journal: JournalMigration[] = [
    { tag: '0000_a', hash: 'h0', when: 1000 },
    { tag: '0001_b', hash: 'h1', when: 2000 },
    { tag: '0002_c', hash: 'h2', when: 3000 },
  ];

  it('returns the journal entries after the applied prefix', () => {
    expect(pendingMigrations([], journal)).toEqual(['0000_a', '0001_b', '0002_c']);
    expect(pendingMigrations([{ hash: 'h0', createdAt: 1000 }], journal)).toEqual([
      '0001_b',
      '0002_c',
    ]);
    const all = journal.map((m) => ({ hash: m.hash, createdAt: m.when }));
    expect(pendingMigrations(all, journal)).toEqual([]);
  });

  it('refuses a history whose applied migrations were edited or regenerated', () => {
    // Same count, but 0001 was regenerated (new hash and `when`): a count check would pass.
    const applied = [
      { hash: 'h0', createdAt: 1000 },
      { hash: 'old-h1', createdAt: 1500 },
      { hash: 'h2', createdAt: 3000 },
    ];
    expect(() => pendingMigrations(applied, journal)).toThrow(
      /rewritten since this database was migrated \(0001_b\).*db:bootstrap && pnpm db:migrate/,
    );
    expect(() =>
      pendingMigrations(
        [...journal.map((m) => ({ hash: m.hash, createdAt: m.when })), applied[0]!],
        journal,
      ),
    ).toThrow(/not in the journal/);
  });

  it('hashes the repository journal the way drizzle records it', () => {
    const entries = readJournal();
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(entry.tag).toMatch(/^\d{4}_/);
    }
  });
});

describe('migrateDatabase', () => {
  it('points at packages/db/migrations by default', () => {
    expect(MIGRATIONS_FOLDER).toMatch(/packages[\\/]db[\\/]migrations$/);
  });

  it('explains and returns 0 when nothing has been generated, without connecting', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vime-db-migrate-'));
    tempDirs.push(dir);
    const lines: string[] = [];
    const saved = process.env.DATABASE_URL_OWNER;
    delete process.env.DATABASE_URL_OWNER;
    try {
      expect(await migrateDatabase({ migrationsFolder: dir, log: (l) => lines.push(l) })).toBe(0);
    } finally {
      process.env.DATABASE_URL_OWNER = saved;
    }
    expect(lines.join('\n')).toMatch(/No migrations found .*pnpm db:generate/);
  });

  // Runs against a throwaway database so that the shared database's migration journal is never
  // touched. Creating a database needs the admin URL (turbo passes DATABASE_URL_ADMIN through to
  // tests); this case is skipped only where it is not set at all.
  it.skipIf(!process.env.DATABASE_URL_ADMIN)(
    'applies pending migrations once, and rolls back a failing one',
    async () => {
      const adminUrl = process.env.DATABASE_URL_ADMIN ?? '';
      const ownerUrl = process.env.DATABASE_URL_OWNER ?? '';
      const database = `vime_migrate_test_${randomBytes(6).toString('hex')}`;
      const dir = mkdtempSync(join(tmpdir(), 'vime-db-migrate-'));
      tempDirs.push(dir);

      const admin = new Client({ connectionString: adminUrl });
      await admin.connect();
      await admin.query(`create database ${escapeIdentifier(database)} owner vime_owner`);
      const target = new URL(ownerUrl);
      target.pathname = `/${database}`;
      process.env.DATABASE_URL_OWNER = target.toString();
      try {
        const first: FakeMigration = {
          tag: '0000_probe',
          sql: 'create table probe (id integer primary key);\n--> statement-breakpoint\ninsert into probe values (1);',
        };
        writeMigrations(dir, [first]);
        const log = () => {};
        expect(await migrateDatabase({ migrationsFolder: dir, log })).toBe(1);
        expect(await migrateDatabase({ migrationsFolder: dir, log })).toBe(0);

        writeMigrations(dir, [
          first,
          {
            tag: '0001_broken',
            sql: 'insert into probe values (2);\n--> statement-breakpoint\nselect * from missing_table;',
          },
        ]);
        await expect(migrateDatabase({ migrationsFolder: dir, log })).rejects.toThrow();

        const check = new Client({ connectionString: target.toString() });
        await check.connect();
        try {
          const probe = await check.query('select id from probe order by id');
          expect(probe.rows).toEqual([{ id: 1 }]);
          const journal = await check.query(
            'select count(*)::int as n from drizzle.__drizzle_migrations',
          );
          expect(journal.rows).toEqual([{ n: 1 }]);
        } finally {
          await check.end();
        }

        // An applied migration edited afterwards: refused with an actionable error, not re-run.
        writeMigrations(dir, [{ ...first, sql: `${first.sql}\n-- edited` }]);
        await expect(migrateDatabase({ migrationsFolder: dir, log })).rejects.toThrow(
          /rewritten since this database was migrated \(0000_probe\)/,
        );
      } finally {
        process.env.DATABASE_URL_OWNER = ownerUrl;
        await admin.query(`drop database if exists ${escapeIdentifier(database)} with (force)`);
        await admin.end();
      }
    },
  );
});
