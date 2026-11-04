import { boolean, jsonb, primaryKey, text } from 'drizzle-orm/pg-core';
import { tenantTableWithoutId, timestamptz } from './_tenant';

/**
 * Features enabled per organization (@vime/contracts FEATURES). vime_app can only SELECT (custom
 * migration `0001_platform_policies`); platform administration writes through withSystem.
 */
export const organizationEntitlements = tenantTableWithoutId(
  'organization_entitlements',
  {
    featureKey: text('feature_key').notNull(),
    enabled: boolean('enabled').notNull().default(false),
    /** Feature limits (e.g. `{ "maxProperties": 150 }`), enforced by the service that creates the resource. */
    limits: jsonb('limits').$type<Record<string, unknown>>().notNull().default({}),
    /** Exclusive end of the entitlement; NULL = no end. */
    validUntil: timestamptz('valid_until'),
  },
  (t) => [
    primaryKey({
      name: 'organization_entitlements_pk',
      columns: [t.organizationId, t.featureKey],
    }),
  ],
);
