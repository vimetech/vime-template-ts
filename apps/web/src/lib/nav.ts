import type { FeatureKey, Permission } from '@vime/contracts';

/*
 * Permission- and feature-aware navigation: an entry is shown when the active membership holds ANY
 * of its permissions (the same permissions the API checks for the page's main read) and the
 * organization has its feature (entitlement) on. Hiding is cosmetic; the API enforces
 * authorization and entitlements on every request. A new feature adds its entry here (and its
 * path in routes/nav-paths.ts, its route in router.tsx and its label under `nav` in the i18n
 * catalogs).
 */

export const NAV_KEYS = ['notes', 'settings'] as const;
export type NavKey = (typeof NAV_KEYS)[number];

export interface NavItem {
  key: NavKey;
  /** Path segment under `/o/$orgId/`. */
  segment: string;
  anyOf: readonly Permission[];
  /** Feature the page's API routes require (`requireFeature`); none for platform pages. */
  feature?: FeatureKey;
}

export const NAV_ITEMS: readonly NavItem[] = [
  // The first visible entry is the landing page: the work comes first, the setup pages last.
  { key: 'notes', segment: 'notas', anyOf: ['note.read'], feature: 'example' },
  { key: 'settings', segment: 'configuracion', anyOf: ['org.manage', 'member.manage'] },
];

export function hasAny(
  permissions: ReadonlySet<Permission>,
  required: readonly Permission[],
): boolean {
  return required.some((permission) => permissions.has(permission));
}

/**
 * The features of a membership as a set, or null when unknown (a `/v1/me` cached by an older
 * build without `features`): unknown features hide nothing, the API still answers 403.
 */
export function featureSet(
  features: readonly FeatureKey[] | undefined,
): ReadonlySet<FeatureKey> | null {
  return features === undefined ? null : new Set(features);
}

/** The organization has `feature` on (always true when the features are unknown). */
export function hasFeature(
  features: ReadonlySet<FeatureKey> | null,
  feature: FeatureKey | undefined,
): boolean {
  return feature === undefined || features === null || features.has(feature);
}

/** The membership may open this navigation entry (permission and feature). */
export function canOpen(
  item: NavItem,
  permissions: ReadonlySet<Permission>,
  features: ReadonlySet<FeatureKey> | null = null,
): boolean {
  return hasAny(permissions, item.anyOf) && hasFeature(features, item.feature);
}

/** Navigation entries the membership may see, in menu order. */
export function visibleNavItems(
  permissions: ReadonlySet<Permission>,
  features: ReadonlySet<FeatureKey> | null = null,
): NavItem[] {
  return NAV_ITEMS.filter((item) => canOpen(item, permissions, features));
}

export function navItem(key: NavKey): NavItem {
  const item = NAV_ITEMS.find((candidate) => candidate.key === key);
  if (!item) throw new Error(`Unknown nav item ${key}`);
  return item;
}

/** Where to land in an organization: the first page the membership can see (null: none). */
export function landingSegment(
  permissions: ReadonlySet<Permission>,
  features: ReadonlySet<FeatureKey> | null = null,
): string | null {
  return visibleNavItems(permissions, features)[0]?.segment ?? null;
}

/** Slots of the phone's bottom bar. */
export const BOTTOM_NAV_SLOTS = 5;

/**
 * The phone's bottom bar: every entry when they fit in `slots`, else the first `slots - 1` (menu
 * order, so the work comes first) and the rest behind a "Más" button.
 */
export function splitBottomNav<T>(
  items: readonly T[],
  slots: number = BOTTOM_NAV_SLOTS,
): { primary: T[]; more: T[] } {
  if (items.length <= slots) return { primary: [...items], more: [] };
  return { primary: items.slice(0, slots - 1), more: items.slice(slots - 1) };
}
