import { FEATURES, FeatureKeySchema, JsonObjectSchema, type FeatureKey } from '@vime/contracts';
import type { Tx } from '@vime/db';
import { and, eq, gt, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { recordActivity } from './audit';
import type { ActorContext } from './context';
import { parseInput } from './errors';
import { organizationEntitlements } from './schema';

function usableAt(now: Date) {
  return and(
    eq(organizationEntitlements.enabled, true),
    or(isNull(organizationEntitlements.validUntil), gt(organizationEntitlements.validUntil, now)),
  );
}

/**
 * The only way to ask whether an organization may use a feature: `enabled` and not past
 * `valid_until`. Used by the API's requireFeature guard, services and jobs.
 */
export async function organizationCanUseFeature(
  tx: Tx,
  orgId: string,
  feature: FeatureKey,
  now: Date = new Date(),
): Promise<boolean> {
  const rows = await tx
    .select({ featureKey: organizationEntitlements.featureKey })
    .from(organizationEntitlements)
    .where(
      and(
        eq(organizationEntitlements.organizationId, orgId),
        eq(organizationEntitlements.featureKey, feature),
        usableAt(now),
      ),
    );
  return rows.length > 0;
}

/** Features the organization can use now, in FEATURES order (for hiding UI). */
export async function listEnabledFeatures(
  tx: Tx,
  orgId: string,
  now: Date = new Date(),
): Promise<FeatureKey[]> {
  const rows = await tx
    .select({ featureKey: organizationEntitlements.featureKey })
    .from(organizationEntitlements)
    .where(and(eq(organizationEntitlements.organizationId, orgId), usableAt(now)));
  const enabled = new Set(rows.map((row) => row.featureKey));
  return FEATURES.filter((feature) => enabled.has(feature));
}

export const SetEntitlementSchema = z.object({
  featureKey: FeatureKeySchema,
  enabled: z.boolean(),
  limits: JsonObjectSchema.default({}),
  validUntil: z.date().nullable().default(null),
});
export type SetEntitlementInput = z.input<typeof SetEntitlementSchema>;
export type Entitlement = typeof organizationEntitlements.$inferSelect;

/**
 * Creates or replaces an entitlement of `ctx.orgId`. vime_app cannot write entitlements: run it
 * through withSystem (platform administration, seeds). Audited as `entitlement.set`.
 */
export async function setEntitlement(
  tx: Tx,
  ctx: ActorContext,
  input: SetEntitlementInput,
): Promise<Entitlement> {
  const data = parseInput(SetEntitlementSchema, input);
  const [row] = await tx
    .insert(organizationEntitlements)
    .values({
      organizationId: ctx.orgId,
      featureKey: data.featureKey,
      enabled: data.enabled,
      limits: data.limits,
      validUntil: data.validUntil,
    })
    .onConflictDoUpdate({
      target: [organizationEntitlements.organizationId, organizationEntitlements.featureKey],
      set: {
        enabled: data.enabled,
        limits: data.limits,
        validUntil: data.validUntil,
        updatedAt: sql`now()`,
      },
    })
    .returning();
  if (!row) {
    throw new Error('Upsert into organization_entitlements returned no row');
  }
  await recordActivity(tx, ctx, {
    entityType: 'organization',
    entityId: ctx.orgId,
    eventType: 'entitlement.set',
    payload: {
      featureKey: data.featureKey,
      enabled: data.enabled,
      limits: data.limits,
      validUntil: data.validUntil?.toISOString() ?? null,
    },
  });
  return row;
}
