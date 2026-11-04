import { Client, escapeIdentifier, escapeLiteral } from 'pg';
import { databaseUrl, type DatabaseUrlKey } from './env';
import { DB_ROLES } from './roles';

/**
 * Infrastructure bootstrap (`pnpm db:bootstrap`). Connects as the superuser in DATABASE_URL_ADMIN,
 * creates or updates the three roles and the database, and sets schema privileges. Idempotent:
 * every step either checks first or is a GRANT/REVOKE that can be repeated.
 *
 * It never grants privileges on tables that already exist. Default privileges cover new tables,
 * and migrations can revoke privileges table by table (for example UPDATE/DELETE on activity_events
 * for vime_app). Re-running the bootstrap must not undo those revocations.
 */

export interface ConnectionTarget {
  user: string;
  password: string;
  database: string;
}

/**
 * Reads the user, password and database from a connection URL (percent-decoded). Throws if the
 * user is not `expectedUser`, or if the password or database name is missing. Error messages
 * never include the password.
 */
export function parseConnectionTarget(
  url: string,
  key: DatabaseUrlKey,
  expectedUser: string,
): ConnectionTarget {
  const parsed = new URL(url);
  const user = decodeURIComponent(parsed.username);
  const password = decodeURIComponent(parsed.password);
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (user !== expectedUser) {
    throw new Error(`${key} must connect as role ${expectedUser} (it uses "${user}").`);
  }
  if (password === '') {
    throw new Error(`${key} must include a password for role ${expectedUser}.`);
  }
  if (database === '') {
    throw new Error(`${key} must include a database name.`);
  }
  return { user, password, database };
}

interface RoleSpec {
  name: string;
  password: string;
  attributes: string;
}

const BASE_ATTRIBUTES = 'LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION';

function schemaStatements(): string[] {
  const owner = escapeIdentifier(DB_ROLES.owner);
  const runtime = `${escapeIdentifier(DB_ROLES.app)}, ${escapeIdentifier(DB_ROLES.system)}`;
  const defaults = `ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA public`;
  return [
    'REVOKE CREATE ON SCHEMA public FROM PUBLIC',
    `GRANT USAGE, CREATE ON SCHEMA public TO ${owner}`,
    `GRANT USAGE ON SCHEMA public TO ${runtime}`,
    `${defaults} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${runtime}`,
    `${defaults} GRANT USAGE, SELECT ON SEQUENCES TO ${runtime}`,
    `${defaults} GRANT EXECUTE ON FUNCTIONS TO ${runtime}`,
  ];
}

async function withClient<T>(url: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({
    connectionString: url,
    application_name: 'vime-bootstrap',
    connectionTimeoutMillis: 10_000,
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${encodeURIComponent(database)}`;
  return parsed.toString();
}

export interface BootstrapOptions {
  /** Receives one line per action taken. Defaults to console.log. */
  log?: (line: string) => void;
}

/** Creates or updates the roles, the database and the schema privileges. Safe to re-run. */
export async function bootstrapDatabase({
  log = console.log,
}: BootstrapOptions = {}): Promise<void> {
  const adminUrl = databaseUrl('DATABASE_URL_ADMIN');
  const owner = parseConnectionTarget(
    databaseUrl('DATABASE_URL_OWNER'),
    'DATABASE_URL_OWNER',
    DB_ROLES.owner,
  );
  const app = parseConnectionTarget(databaseUrl('DATABASE_URL'), 'DATABASE_URL', DB_ROLES.app);
  const system = parseConnectionTarget(
    databaseUrl('DATABASE_URL_SYSTEM'),
    'DATABASE_URL_SYSTEM',
    DB_ROLES.system,
  );
  const database = owner.database;
  for (const [key, target] of [
    ['DATABASE_URL', app],
    ['DATABASE_URL_SYSTEM', system],
  ] as const) {
    if (target.database !== database) {
      throw new Error(
        `${key} points to database "${target.database}" but DATABASE_URL_OWNER points to "${database}".`,
      );
    }
  }

  const roles: RoleSpec[] = [
    { name: owner.user, password: owner.password, attributes: `${BASE_ATTRIBUTES} NOBYPASSRLS` },
    { name: app.user, password: app.password, attributes: `${BASE_ATTRIBUTES} NOBYPASSRLS` },
    { name: system.user, password: system.password, attributes: `${BASE_ATTRIBUTES} BYPASSRLS` },
  ];

  await withClient(adminUrl, async (client) => {
    for (const role of roles) {
      const found = await client.query('select 1 from pg_roles where rolname = $1', [role.name]);
      const exists = (found.rowCount ?? 0) > 0;
      // DDL cannot take bind parameters: the password is passed as an escaped literal.
      await client.query(
        `${exists ? 'ALTER' : 'CREATE'} ROLE ${escapeIdentifier(role.name)} WITH ${role.attributes} PASSWORD ${escapeLiteral(role.password)}`,
      );
      log(`${exists ? 'updated' : 'created'} role ${role.name} (${role.attributes}, password set)`);
    }

    const found = await client.query<{ owner: string }>(
      'select pg_get_userbyid(datdba) as owner from pg_database where datname = $1',
      [database],
    );
    const current = found.rows[0];
    if (!current) {
      await client.query(
        `CREATE DATABASE ${escapeIdentifier(database)} OWNER ${escapeIdentifier(DB_ROLES.owner)}`,
      );
      log(`created database ${database} (owner ${DB_ROLES.owner})`);
    } else if (current.owner !== DB_ROLES.owner) {
      await client.query(
        `ALTER DATABASE ${escapeIdentifier(database)} OWNER TO ${escapeIdentifier(DB_ROLES.owner)}`,
      );
      log(`changed owner of database ${database} from ${current.owner} to ${DB_ROLES.owner}`);
    } else {
      log(`database ${database} already exists (owner ${DB_ROLES.owner})`);
    }
  });

  await withClient(withDatabase(adminUrl, database), async (client) => {
    await client.query('BEGIN');
    try {
      for (const statement of schemaStatements()) {
        await client.query(statement);
        log(`${database}: ${statement}`);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
}

/**
 * Makes sure the roles and the database exist, for test setup. Tries to connect with the owner,
 * app and system URLs. If any connection fails and DATABASE_URL_ADMIN is set, it runs
 * bootstrapDatabase. If DATABASE_URL_ADMIN is not set, it throws an error that says to run
 * `pnpm db:bootstrap`.
 */
export async function ensureDatabaseBootstrapped(): Promise<void> {
  const keys = ['DATABASE_URL_OWNER', 'DATABASE_URL', 'DATABASE_URL_SYSTEM'] as const;
  const failing: string[] = [];
  for (const key of keys) {
    try {
      await withClient(databaseUrl(key), async () => {});
    } catch {
      failing.push(key);
    }
  }
  if (failing.length === 0) {
    return;
  }
  if (!process.env.DATABASE_URL_ADMIN) {
    throw new Error(
      `Cannot connect with ${failing.join(', ')} and DATABASE_URL_ADMIN is not set. Run pnpm db:bootstrap.`,
    );
  }
  await bootstrapDatabase({ log: (line) => console.info(`[db:bootstrap] ${line}`) });
}
