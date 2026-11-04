import { z } from 'zod';

/**
 * Permission keys (source of truth). Authorization always checks permissions, never role names.
 * A domain module adds its permissions here (e.g. `note.read` / `note.write`) and grants them in
 * the matrix below.
 */
export const PERMISSIONS = [
  'org.manage',
  'member.manage',
  'note.read',
  'note.write',
  'flag.manage',
  'audit.read',
] as const;
export const PermissionSchema = z.enum(PERMISSIONS);
export type Permission = z.infer<typeof PermissionSchema>;

/** System roles, defined in code. `memberships.role_keys` stores these keys. */
export const ROLE_KEYS = ['owner', 'admin', 'manager', 'member'] as const;
export const RoleKeySchema = z.enum(ROLE_KEYS);
export type RoleKey = z.infer<typeof RoleKeySchema>;

export interface SystemRole {
  readonly permissions: readonly Permission[];
}

/*
 * Role → permission matrix (least privilege; a membership's permissions are the union of its roles).
 *
 * | Permission    | owner | admin | manager | member |
 * | ------------- | :---: | :---: | :-----: | :----: |
 * | org.manage    |   x   |   x   |         |        |
 * | member.manage |   x   |   x   |    x    |        |
 * | note.read     |   x   |   x   |    x    |   x    |
 * | note.write    |   x   |   x   |    x    |        |
 * | flag.manage   |   x   |   x   |    x    |        |
 * | audit.read    |   x   |   x   |    x    |        |
 *
 * Notes:
 * - There is no billing yet, so admin equals owner; owner-only safeguards (e.g. never removing the
 *   last owner) are service rules, not permissions.
 * - The manager runs the day to day (members, the domain, the exception queue, the audit trail)
 *   but cannot change the organization's settings.
 * - The member reads the domain and nothing else.
 */
export const SYSTEM_ROLES: Readonly<Record<RoleKey, SystemRole>> = {
  owner: { permissions: [...PERMISSIONS] },
  admin: { permissions: [...PERMISSIONS] },
  manager: { permissions: PERMISSIONS.filter((p) => p !== 'org.manage') },
  member: { permissions: ['note.read'] },
};

export function isRoleKey(value: string): value is RoleKey {
  return (ROLE_KEYS as readonly string[]).includes(value);
}

/**
 * Effective permissions of a membership: the union of its roles' permissions.
 * Unknown role keys (e.g. a retired role still stored in `role_keys`) grant nothing.
 */
export function permissionsForRoles(roleKeys: Iterable<string>): Set<Permission> {
  const result = new Set<Permission>();
  for (const key of roleKeys) {
    if (!isRoleKey(key)) continue;
    for (const permission of SYSTEM_ROLES[key].permissions) result.add(permission);
  }
  return result;
}

export function hasPermission(
  permissions: ReadonlySet<Permission>,
  permission: Permission,
): boolean {
  return permissions.has(permission);
}
