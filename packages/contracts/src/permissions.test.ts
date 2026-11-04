import { describe, expect, it } from 'vitest';
import {
  hasPermission,
  isRoleKey,
  PermissionSchema,
  PERMISSIONS,
  permissionsForRoles,
  ROLE_KEYS,
  RoleKeySchema,
  SYSTEM_ROLES,
  type Permission,
  type RoleKey,
} from './permissions';

/*
 * Expected matrix, written out independently of the implementation on purpose: any change to a
 * role's permissions must be a deliberate change here too.
 */
const EXPECTED: Record<RoleKey, readonly Permission[]> = {
  owner: PERMISSIONS,
  admin: PERMISSIONS,
  manager: ['member.manage', 'note.read', 'note.write', 'flag.manage', 'audit.read'],
  member: ['note.read'],
};

describe('PERMISSIONS', () => {
  it('has unique keys that the schema accepts', () => {
    expect(new Set(PERMISSIONS).size).toBe(PERMISSIONS.length);
    for (const p of PERMISSIONS) expect(PermissionSchema.parse(p)).toBe(p);
    expect(PermissionSchema.safeParse('note.delete').success).toBe(false);
  });
});

describe('SYSTEM_ROLES', () => {
  it('defines exactly the system role keys', () => {
    expect(Object.keys(SYSTEM_ROLES).sort()).toEqual([...ROLE_KEYS].sort());
  });

  it.each(ROLE_KEYS)('%s only grants known permissions, without duplicates', (role) => {
    const permissions = SYSTEM_ROLES[role].permissions;
    for (const p of permissions) expect(PERMISSIONS).toContain(p);
    expect(new Set(permissions).size).toBe(permissions.length);
  });

  it.each(ROLE_KEYS)('%s matches the documented matrix', (role) => {
    expect([...SYSTEM_ROLES[role].permissions].sort()).toEqual([...EXPECTED[role]].sort());
  });

  it('gives owner every permission', () => {
    const owner = permissionsForRoles(['owner']);
    expect(owner.size).toBe(PERMISSIONS.length);
    for (const p of PERMISSIONS) expect(hasPermission(owner, p)).toBe(true);
  });

  it('keeps the member to reading', () => {
    const member = permissionsForRoles(['member']);
    expect(hasPermission(member, 'note.read')).toBe(true);
    expect(hasPermission(member, 'note.write')).toBe(false);
    expect(hasPermission(member, 'member.manage')).toBe(false);
  });

  it('lets the manager do everything except managing the organization', () => {
    const manager = permissionsForRoles(['manager']);
    expect(hasPermission(manager, 'org.manage')).toBe(false);
    expect(hasPermission(manager, 'member.manage')).toBe(true);
    expect(hasPermission(manager, 'note.write')).toBe(true);
  });

  it('does not give org.manage to any non-owner/admin role', () => {
    for (const role of ROLE_KEYS.filter((r) => r !== 'owner' && r !== 'admin')) {
      expect(SYSTEM_ROLES[role].permissions).not.toContain('org.manage');
    }
  });
});

describe('permissionsForRoles', () => {
  it('returns the union of the roles', () => {
    const set = permissionsForRoles(['member', 'manager']);
    expect(set).toEqual(new Set([...EXPECTED.member, ...EXPECTED.manager]));
  });

  it('grants nothing for no roles or unknown roles (fails closed)', () => {
    expect(permissionsForRoles([]).size).toBe(0);
    expect(permissionsForRoles(['superuser', 'OWNER', '']).size).toBe(0);
    expect(permissionsForRoles(['retired_role', 'member'])).toEqual(new Set(EXPECTED.member));
  });
});

describe('RoleKeySchema / isRoleKey', () => {
  it('accepts system roles and rejects anything else', () => {
    for (const role of ROLE_KEYS) {
      expect(RoleKeySchema.parse(role)).toBe(role);
      expect(isRoleKey(role)).toBe(true);
    }
    expect(RoleKeySchema.safeParse('superuser').success).toBe(false);
    expect(isRoleKey('superuser')).toBe(false);
  });
});
