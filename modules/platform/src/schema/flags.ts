import { FLAG_SEVERITIES, FLAG_STATUSES } from '@vime/contracts';
import { sql } from 'drizzle-orm';
import { index, jsonb, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { enumCheck, tenantTable, timestamptz } from './_tenant';

/**
 * The exception queue: situations a human must review. At most one OPEN flag per
 * `(organization_id, kind, dedupe_key)`, so repeated detection (e.g. re-derivations) is idempotent.
 *
 * `kind` is open-ended (modules add kinds; @vime/contracts FLAG_KINDS), so it has no CHECK.
 * `entity_type` / `entity_id` name the module row the situation is about, without a foreign key
 * (platform cannot import upper modules' schemas); a module that wants one adds it in its own
 * migration.
 */
export const opsFlags = tenantTable(
  'ops_flags',
  {
    kind: text('kind').notNull(),
    severity: text('severity', { enum: FLAG_SEVERITIES }).notNull(),
    entityType: text('entity_type'),
    entityId: uuid('entity_id'),
    details: jsonb('details').$type<Record<string, unknown>>().notNull().default({}),
    status: text('status', { enum: FLAG_STATUSES }).notNull().default('open'),
    dedupeKey: text('dedupe_key').notNull(),
    /** User id of who resolved or dismissed it (no foreign key: historical reference). */
    resolvedBy: uuid('resolved_by'),
    resolvedAt: timestamptz('resolved_at'),
  },
  (t) => [
    uniqueIndex('ops_flags_open_dedupe_unique')
      .on(t.organizationId, t.kind, t.dedupeKey)
      .where(sql`${t.status} = 'open'`),
    index('ops_flags_organization_id_status_created_at_idx').on(
      t.organizationId,
      t.status,
      t.createdAt,
    ),
    index('ops_flags_organization_id_entity_idx').on(t.organizationId, t.entityType, t.entityId),
    enumCheck('ops_flags_severity_check', t.severity, FLAG_SEVERITIES),
    enumCheck('ops_flags_status_check', t.status, FLAG_STATUSES),
  ],
);
