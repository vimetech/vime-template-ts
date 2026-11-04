import { isUuid } from '@vime/kernel';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { databaseUrl, type DatabaseUrlKey } from './env';

/**
 * One connection pool per Postgres role (ADR 0004). Pools are created on first use, so importing
 * this package never reads the environment or opens a connection. drizzle-kit, unit tests and
 * scripts can import it freely.
 *
 * The raw pools and Drizzle instances are internal to @vime/db. Other packages only get a
 * transaction handle, through withTenant, withUser or withSystem.
 */
export type PoolKind = 'app' | 'system' | 'owner' | 'auth';

const URL_KEYS: Record<PoolKind, DatabaseUrlKey> = {
  app: 'DATABASE_URL',
  system: 'DATABASE_URL_SYSTEM',
  owner: 'DATABASE_URL_OWNER',
  // Better Auth only (see createAuthDatabase): same role as `system`, own pool and
  // application_name, so auth traffic is visible on its own in pg_stat_activity.
  auth: 'DATABASE_URL_SYSTEM',
};

function createDb(pool: Pool) {
  // Query builder only. No relational schema is registered, so this package never imports module
  // schemas, and modules write explicit queries.
  return drizzle({ client: pool });
}

type Db = ReturnType<typeof createDb>;

/**
 * A Drizzle transaction (query builder; `tx.query.*` relational queries are not available). This
 * is the only database handle that modules ever receive.
 */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

interface Connection {
  pool: Pool;
  db: Db;
}

const connections = new Map<PoolKind, Connection>();

/** @internal Lazily creates the pool for `kind`. Never re-exported from the package entry points. */
export function connection(kind: PoolKind): Connection {
  const existing = connections.get(kind);
  if (existing) {
    return existing;
  }
  const pool = new Pool({
    connectionString: databaseUrl(URL_KEYS[kind]),
    application_name: `vime-${kind}`,
    // Fail instead of waiting forever when Postgres is unreachable or the pool is exhausted.
    connectionTimeoutMillis: 10_000,
  });
  pool.on('error', (error) => {
    // An idle client lost its connection (for example, Postgres restarted). pg discards that
    // client. Without this listener the 'error' event would crash the process.
    console.error(`[@vime/db] idle ${kind} connection error: ${error.message}`);
  });
  const created = { pool, db: createDb(pool) };
  connections.set(kind, created);
  return created;
}

/** The database context of a tenant transaction. Richer request or job contexts can be passed as is. */
export interface TenantDbContext {
  orgId: string;
  /** The acting user, if any (a job or webhook has none). */
  userId?: string | null;
}

function requireUuid(value: unknown, name: string): string {
  if (!isUuid(value)) {
    throw new TypeError(`${name} must be a UUID`);
  }
  return value.toLowerCase();
}

function runAsApp<T>(orgId: string, userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return connection('app').db.transaction(async (tx) => {
    // is_local = true: the settings end with the transaction, so a pooled connection never carries
    // one tenant's context into the next transaction. On a reused connection the settings read as ''
    // afterwards, and app.current_org_id() maps '' to NULL (zero rows).
    await tx.execute(
      sql`select set_config('app.org_id', ${orgId}, true), set_config('app.user_id', ${userId}, true)`,
    );
    return fn(tx);
  });
}

/**
 * Runs `fn` in a transaction as `vime_app` (RLS enforced) with `app.org_id` set to `ctx.orgId`, and
 * `app.user_id` set to `ctx.userId`, or to '' when there is no actor. Commits when `fn` resolves and
 * rolls back when it throws. Throws a TypeError, without touching the database, if an id is not a UUID.
 *
 * Never make external calls (HTTP, S3, push) inside `fn`.
 */
export async function withTenant<T>(ctx: TenantDbContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const orgId = requireUuid(ctx.orgId, 'orgId');
  const userId = ctx.userId == null ? '' : requireUuid(ctx.userId, 'userId');
  return runAsApp(orgId, userId, fn);
}

/**
 * Runs `fn` in a transaction as `vime_app` with only `app.user_id` set (`app.org_id` is ''). Used
 * for cross-organization queries about the user themself, such as "my memberships". Throws a
 * TypeError if `userId` is not a UUID.
 */
export async function withUser<T>(userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return runAsApp('', requireUuid(userId, 'userId'), fn);
}

/**
 * Runs `fn` in a transaction as `vime_system`, which has BYPASSRLS. Only for work with no tenant
 * yet: resolving a webhook's organization, reconciliation fan-out, Better Auth tables, redeeming
 * invitations, and admin tasks close to migrations. Look up the organization, then do the real
 * work in withTenant. Justify every use in code review.
 */
export async function withSystem<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return connection('system').db.transaction(fn);
}

/** The database handle that Better Auth's Drizzle adapter receives (query builder, no schema). */
export type AuthDatabase = Db;

/**
 * AUTH ONLY. Returns a Drizzle database on a dedicated pool of the `vime_system` role
 * (DATABASE_URL_SYSTEM, application_name `vime-auth`), for Better Auth's Drizzle adapter in
 * apps/api: `drizzleAdapter(createAuthDatabase(), { provider: 'pg', schema: authSchema })`.
 *
 * Better Auth needs a database object of its own, not a transaction callback, and its tables
 * (user, session, account, verification) have no RLS and no grants for vime_app (ADR 0004/0005).
 * This handle bypasses RLS: never pass it to module services or use it for tenant data. Tenant work
 * goes through withTenant; everything else that needs the system role goes through withSystem.
 *
 * The pool is created on first use and shared by later calls. closeDb() ends it; call this again
 * afterwards to get a handle on a new pool.
 */
export function createAuthDatabase(): AuthDatabase {
  return connection('auth').db;
}

/**
 * Health check: runs `select 1` on the app pool. Resolves when Postgres answers, and rejects
 * otherwise (also when DATABASE_URL is missing).
 */
export async function pingDb(): Promise<void> {
  await connection('app').pool.query('select 1');
}

/**
 * Closes every pool created so far (for graceful shutdown and test teardown). Waits for checked-out
 * clients to be released. Pools are created again if the package is used after this.
 */
export async function closeDb(): Promise<void> {
  const pools = [...connections.values()].map((c) => c.pool);
  connections.clear();
  await Promise.all(pools.map((pool) => pool.end()));
}
