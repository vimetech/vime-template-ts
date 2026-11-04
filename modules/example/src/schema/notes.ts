import { index, text, uuid } from 'drizzle-orm/pg-core';
import { tenantTable } from '@vime/platform/schema';

/**
 * A note of an organization: the example tenant table. `tenantTable()` gives it `id`,
 * `organization_id` (FK to organizations, ON DELETE CASCADE), the timestamps,
 * `UNIQUE (organization_id, id)` and the `tenant_isolation` RLS policy (ADR 0004).
 *
 * `created_by` is a user id without a foreign key (historical reference, like activity actors).
 */
export const notes = tenantTable(
  'notes',
  {
    title: text('title').notNull(),
    body: text('body').notNull().default(''),
    createdBy: uuid('created_by'),
  },
  (t) => [index('notes_organization_id_created_at_idx').on(t.organizationId, t.createdAt)],
);
