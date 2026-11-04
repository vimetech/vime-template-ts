import { LOCALES } from '@vime/contracts';
import { newId } from '@vime/kernel';
import { sql } from 'drizzle-orm';
import { jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { enumCheck, timestamptz } from './_columns';

/**
 * The tenant root. It has no `organization_id`, so it is not a tenant table for the RLS catalog
 * audit, but it still has row level security.
 *
 * RLS (custom migration `0001_platform_policies`): a row is visible when it is the current
 * organization (`id = app.current_org_id()`) or the current user has an active membership in it
 * (`withUser` "my organizations"). Writes require `id = app.current_org_id()`. vime_app cannot
 * DELETE organizations; organizations are created through `withSystem`.
 *
 * vime_app may UPDATE only the columns an organization edits itself (custom migration
 * `0001_platform_policies`): a new column is out of its reach until that grant lists it, and
 * `suspended_at` must never be listed (ADR 0015).
 */
export const organizations = pgTable(
  'organizations',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => newId()),
    name: text('name').notNull(),
    slug: text('slug').notNull().unique('organizations_slug_unique'),
    timezone: text('timezone').notNull().default('America/Lima'),
    locale: text('locale', { enum: LOCALES }).notNull().default('es-PE'),
    /** Validated with `OrganizationSettingsSchema` (@vime/contracts) before every write. */
    settings: jsonb('settings').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at')
      .default(sql`null`)
      .$onUpdate(() => sql`now()`),
    /** Set by the platform console (withSystem): nobody can use the organization while set. */
    suspendedAt: timestamptz('suspended_at'),
  },
  (t) => [enumCheck('organizations_locale_check', t.locale, LOCALES)],
).enableRLS();
