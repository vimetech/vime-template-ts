import { isRoleKey, type RoleKey } from '@vime/contracts';

/*
 * Mapping helpers from database rows to @vime/contracts response shapes (ISO timestamps). Internal
 * to the module.
 */

export function iso(value: Date): string {
  return value.toISOString();
}

export function isoOrNull(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

/** Stored role keys the code knows; unknown keys grant nothing and are not returned. */
export function knownRoleKeys(values: readonly string[]): RoleKey[] {
  return values.filter(isRoleKey);
}

/** Domain of the synthetic emails given to users that sign in with an invitation code only. */
export const SYNTHETIC_EMAIL_DOMAIN = 'staff.invalid';

/** `u_<userId>@staff.invalid`: Better Auth requires an email; `.invalid` never receives mail. */
export function syntheticStaffEmail(userId: string): string {
  return `u_${userId}@${SYNTHETIC_EMAIL_DOMAIN}`;
}

export function isSyntheticEmail(email: string): boolean {
  return email.toLowerCase().endsWith(`@${SYNTHETIC_EMAIL_DOMAIN}`);
}
