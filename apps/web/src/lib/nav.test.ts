import { permissionsForRoles, type RoleKey } from '@vime/contracts';
import { describe, expect, it } from 'vitest';
import { webMemberships } from './active-org';
import {
  canOpen,
  featureSet,
  hasFeature,
  landingSegment,
  navItem,
  splitBottomNav,
  visibleNavItems,
} from './nav';

const keysFor = (...roles: RoleKey[]) =>
  visibleNavItems(permissionsForRoles(roles)).map((item) => item.key);

describe('permission-aware navigation', () => {
  it('shows every section to owners and admins', () => {
    const all = ['notes', 'settings'];
    expect(keysFor('owner')).toEqual(all);
    expect(keysFor('admin')).toEqual(all);
  });

  it('keeps Settings for managers (member.manage opens members and invitations)', () => {
    expect(keysFor('manager')).toEqual(['notes', 'settings']);
  });

  it('hides Settings from members', () => {
    expect(keysFor('member')).toEqual(['notes']);
  });

  it('shows nothing to a membership with no permission at all', () => {
    expect(visibleNavItems(new Set())).toEqual([]);
    expect(landingSegment(new Set())).toBeNull();
  });

  it('lands on the notes when allowed, else on the first visible section', () => {
    expect(landingSegment(permissionsForRoles(['owner']))).toBe('notas');
    expect(landingSegment(new Set(['org.manage'] as const))).toBe('configuracion');
  });

  it('unions the permissions of several roles', () => {
    expect(keysFor('member', 'manager')).toEqual(keysFor('manager'));
  });
});

describe('feature-aware navigation', () => {
  const owner = permissionsForRoles(['owner']);

  it('hides the example section when the organization does not have the feature', () => {
    const keys = visibleNavItems(owner, featureSet([])).map((item) => item.key);
    expect(keys).toEqual(['settings']);
    expect(landingSegment(owner, featureSet([]))).toBe('configuracion');
  });

  it('shows everything when the example feature is on', () => {
    expect(visibleNavItems(owner, featureSet(['example']))).toHaveLength(2);
  });

  it('hides nothing when /v1/me did not say (older cached response)', () => {
    expect(featureSet(undefined)).toBeNull();
    expect(visibleNavItems(owner, featureSet(undefined))).toHaveLength(2);
    expect(hasFeature(null, 'example')).toBe(true);
    expect(hasFeature(new Set(), undefined)).toBe(true);
  });

  it('needs the permission and the feature to open a section', () => {
    const notes = navItem('notes');
    expect(canOpen(notes, owner, featureSet(['example']))).toBe(true);
    expect(canOpen(notes, owner, featureSet(['advanced_insights']))).toBe(false);
    expect(canOpen(notes, new Set(), featureSet(['example']))).toBe(false);
  });

  it('picks no organization for the web when none of its pages is visible', () => {
    const none = webMemberships([
      {
        organization: { id: 'o1', name: 'A', slug: 'a', timezone: 'America/Lima', locale: 'es-PE' },
        roleKeys: ['member'],
        permissions: [],
        features: ['example'],
      },
      {
        organization: { id: 'o2', name: 'B', slug: 'b', timezone: 'America/Lima', locale: 'es-PE' },
        roleKeys: ['member'],
        permissions: ['note.read'],
        features: [],
      },
    ]);
    expect(none).toEqual([]);
  });
});

describe('phone bottom bar', () => {
  it('shows the first pages and the rest behind "Más"', () => {
    const { primary, more } = splitBottomNav(['a', 'b', 'c', 'd', 'e', 'f', 'g']);
    expect(primary).toEqual(['a', 'b', 'c', 'd']);
    expect(more).toEqual(['e', 'f', 'g']);
  });

  it('needs no "Más" when every page fits', () => {
    expect(splitBottomNav(['a', 'b', 'c', 'd', 'e'])).toEqual({
      primary: ['a', 'b', 'c', 'd', 'e'],
      more: [],
    });
    expect(splitBottomNav(keysFor('owner'))).toEqual({ primary: ['notes', 'settings'], more: [] });
  });
});
