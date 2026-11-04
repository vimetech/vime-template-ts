/**
 * @vime/platform/schema: Drizzle tables of the platform module, plus the tenant table helpers that
 * every module uses for its own tables.
 */
export {
  tenantTable,
  tenantTableWithoutId,
  tenantColumns,
  tenantColumnsWithoutId,
  tenantForeignKey,
  organizationForeignKey,
  enumCheck,
  timestamptz,
} from './_tenant';
export type { TenantColumns, TenantColumnsWithoutId, TenantParent } from './_tenant';
export { user, session, account, verification, authSchema } from './auth';
export { organizations } from './organizations';
export { memberships, invitations } from './memberships';
export { organizationEntitlements } from './entitlements';
export { activityEvents } from './activity';
export { idempotencyKeys } from './idempotency';
export { opsFlags } from './flags';
export { notifications } from './notifications';
