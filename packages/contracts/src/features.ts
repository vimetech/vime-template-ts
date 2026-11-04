import { z } from 'zod';

/**
 * Feature keys enabled per organization (`organization_entitlements.feature_key`). Commercial
 * plans do not exist in code; a route needs both the feature (`requireFeature`) and the permission.
 * A new domain module adds its feature key here.
 */
export const FEATURES = ['example', 'advanced_insights'] as const;
export const FeatureKeySchema = z.enum(FEATURES);
export type FeatureKey = z.infer<typeof FeatureKeySchema>;
