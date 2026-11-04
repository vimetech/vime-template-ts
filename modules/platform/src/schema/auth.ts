import { newId } from '@vime/kernel';
import { boolean, index, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { timestamptz } from './_tenant';

/*
 * Better Auth 1.7 core tables (user, session, account, verification) for its Drizzle adapter.
 *
 * - The adapter addresses tables by the keys of the schema object it receives and columns by their
 *   property names, so the property names below are Better Auth's field names (`emailVerified`,
 *   `userId`...) while the SQL columns are snake_case. Pass `authSchema` as the adapter schema:
 *   `drizzleAdapter(db, { provider: 'pg', schema: authSchema })`.
 * - Ids are `uuid` columns. @vime/db requires UUID user ids (withTenant/withUser), and memberships,
 *   devices and staff_members reference `user.id`. Configure Better Auth with
 *   `advanced: { database: { generateId: () => newId() } }` (a function, so ids are UUIDv7 from
 *   @vime/kernel). `$defaultFn(newId)` also fills the id if the adapter ever omits it.
 *   Do not use `generateId: 'uuid'`: with Postgres the adapter then leaves the id to a database
 *   default, and these tables have none (ids are always generated in the app).
 * - Columns Better Auth never writes must be nullable or have a default (its schema check rejects
 *   anything else), so do not add required columns here.
 * - Not tenant tables: no organization_id and no RLS. vime_app has no privileges on them (custom
 *   migration `0002_platform_policies`); only withSystem (vime_system) reads or writes them.
 */

function idColumn() {
  return uuid('id')
    .primaryKey()
    .$defaultFn(() => newId());
}

export const user = pgTable('user', {
  id: idColumn(),
  name: text('name').notNull(),
  email: text('email').notNull().unique('user_email_unique'),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
  updatedAt: timestamptz('updated_at').notNull().defaultNow(),
});

export const session = pgTable(
  'session',
  {
    id: idColumn(),
    expiresAt: timestamptz('expires_at').notNull(),
    token: text('token').notNull().unique('session_token_unique'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
  },
  (t) => [index('session_user_id_idx').on(t.userId)],
);

export const account = pgTable(
  'account',
  {
    id: idColumn(),
    /** Provider-side account id; for the credential provider it is the user id as text. */
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamptz('access_token_expires_at'),
    refreshTokenExpiresAt: timestamptz('refresh_token_expires_at'),
    scope: text('scope'),
    /** Password hash (credential provider). */
    password: text('password'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [index('account_user_id_idx').on(t.userId)],
);

export const verification = pgTable(
  'verification',
  {
    id: idColumn(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamptz('expires_at').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [index('verification_identifier_idx').on(t.identifier)],
);

/** The schema object for Better Auth's Drizzle adapter (keys are Better Auth model names). */
export const authSchema = { user, session, account, verification };
