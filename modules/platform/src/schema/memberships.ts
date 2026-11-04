import { MEMBERSHIP_STATUSES } from '@vime/contracts';
import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import {
  enumCheck,
  organizationForeignKey,
  tenantColumns,
  tenantTable,
  timestamptz,
} from './_tenant';
import { user } from './auth';

/**
 * A user's membership in an organization. Authorization data (role keys → permissions) is resolved
 * per request from here; it is never stored in the session.
 *
 * Not built with `tenantTable()` because its RLS policy is special (custom migration
 * `0002_platform_policies`): USING `organization_id = app.current_org_id() OR user_id =
 * app.current_user_id()` (withUser lists "my memberships" across organizations), WITH CHECK
 * `organization_id = app.current_org_id()`. Because of the USING clause, a withTenant transaction
 * with a user also sees that user's memberships in other organizations: always filter by
 * organization_id.
 */
export const memberships = pgTable(
  'memberships',
  {
    ...tenantColumns(),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    /** System role keys (@vime/contracts ROLE_KEYS). Unknown keys grant nothing. */
    roleKeys: text('role_keys')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    status: text('status', { enum: MEMBERSHIP_STATUSES }).notNull().default('active'),
  },
  (t) => [
    organizationForeignKey(t.organizationId),
    unique('memberships_organization_id_id_unique').on(t.organizationId, t.id),
    unique('memberships_organization_id_user_id_unique').on(t.organizationId, t.userId),
    // withUser: "my memberships" across organizations.
    index('memberships_user_id_idx').on(t.userId),
    enumCheck('memberships_status_check', t.status, MEMBERSHIP_STATUSES),
  ],
).enableRLS();

/**
 * Invitation codes. Only an HMAC-SHA256 of the normalized code under a server-side key is stored
 * (`code_hash`, globally unique): without the key, a database dump does not reveal the codes. The
 * redeemer has no organization yet, so the lookup by hash runs in withSystem; the redemption itself
 * (membership, uses + 1) runs in withTenant of the invitation's organization.
 */
export const invitations = tenantTable(
  'invitations',
  {
    codeHash: text('code_hash').notNull().unique('invitations_code_hash_unique'),
    /** Lowercase email the invitation is bound to (only that user may redeem it), or null. */
    email: text('email'),
    roleKeys: text('role_keys').array().notNull(),
    expiresAt: timestamptz('expires_at').notNull(),
    maxUses: integer('max_uses').notNull().default(1),
    uses: integer('uses').notNull().default(0),
    revokedAt: timestamptz('revoked_at'),
    /** User id of the creator (no foreign key: historical reference, like activity actors). */
    createdBy: uuid('created_by').notNull(),
  },
  (t) => [
    index('invitations_organization_id_expires_at_idx').on(t.organizationId, t.expiresAt),
    check('invitations_uses_check', sql.raw('"max_uses" >= 1 and "uses" between 0 and "max_uses"')),
  ],
);
