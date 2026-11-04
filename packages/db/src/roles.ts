/**
 * Postgres roles created by `pnpm db:bootstrap` (ADR 0004). Migrations and RLS reference them by
 * these names, so the connection URLs must use exactly these user names.
 */
export const DB_ROLES = {
  /** Owns the schema and every table. Used only to run migrations. */
  owner: 'vime_owner',
  /** Runtime role: not a table owner and without BYPASSRLS, so RLS always applies. */
  app: 'vime_app',
  /** BYPASSRLS. Used only inside withSystem. */
  system: 'vime_system',
} as const;

export type DbRoleName = (typeof DB_ROLES)[keyof typeof DB_ROLES];
