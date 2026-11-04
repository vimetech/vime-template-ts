import { permissionsForRoles, type MeMembership, type Permission } from '@vime/contracts';
import { describe, expect, it } from 'vitest';
import { pickMembership, webMemberships } from './active-org';

function membership(id: string, name: string, permissions: Iterable<Permission>): MeMembership {
  return {
    organization: { id, name, slug: id, timezone: 'America/Lima', locale: 'es-PE' },
    roleKeys: ['member'],
    permissions: [...permissions],
  };
}

describe('the organization to open on the website', () => {
  // A membership whose roles grant nothing this website shows (e.g. a retired role key).
  const alfa = membership('alfa', 'Alfa', []);
  const beta = membership('beta', 'Beta', permissionsForRoles(['manager']));
  const gamma = membership('gamma', 'Gamma', permissionsForRoles(['owner']));

  it('skips memberships without any page here, even the first one by name', () => {
    expect(pickMembership(webMemberships([alfa, beta]), null)?.organization.id).toBe('beta');
  });

  it('ignores a remembered organization without a page and keeps a remembered one with pages', () => {
    expect(pickMembership(webMemberships([alfa, beta, gamma]), 'alfa')?.organization.id).toBe(
      'beta',
    );
    expect(pickMembership(webMemberships([alfa, beta, gamma]), 'gamma')?.organization.id).toBe(
      'gamma',
    );
  });

  it('has nothing to open when no membership has a page', () => {
    expect(pickMembership(webMemberships([alfa]), 'alfa')).toBeNull();
  });
});
