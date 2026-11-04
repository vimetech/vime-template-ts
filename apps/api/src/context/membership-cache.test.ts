import type { ResolvedMembership } from '@vime/platform';
import { describe, expect, it, vi } from 'vitest';
import { MembershipCache } from './membership-cache';

const USER = '01a10000-0000-7000-8000-00000000000a';
const ORG = '01a10000-0000-7000-8000-00000000000b';

function membership(roleKeys: ResolvedMembership['roleKeys']): ResolvedMembership {
  return {
    membershipId: '01a10000-0000-7000-8000-00000000000c',
    organizationId: ORG,
    userId: USER,
    roleKeys,
    permissions: new Set(),
    organizationSuspended: false,
  };
}

describe('MembershipCache', () => {
  it('serves a cached value until the TTL expires', async () => {
    let now = 0;
    const cache = new MembershipCache({ ttlMs: 30_000, now: () => now });
    const load = vi.fn(async () => membership(['owner']));
    await cache.get(USER, ORG, load);
    now = 29_999;
    await cache.get(USER, ORG, load);
    expect(load).toHaveBeenCalledTimes(1);
    now = 30_000;
    await cache.get(USER, ORG, load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('caches "not a member" too, and drops entries on invalidate', async () => {
    const cache = new MembershipCache();
    const load = vi.fn(async () => null);
    expect(await cache.get(USER, ORG, load)).toBeNull();
    expect(await cache.get(USER.toUpperCase(), ORG, load)).toBeNull();
    expect(load).toHaveBeenCalledTimes(1);
    cache.invalidate(USER, ORG);
    await cache.get(USER, ORG, load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('does not store a load that started before an invalidation', async () => {
    const cache = new MembershipCache();
    let release: (value: ResolvedMembership) => void = () => {};
    const stale = cache.get(USER, ORG, () => new Promise((resolve) => (release = resolve)));
    cache.invalidate(USER, ORG);
    release(membership(['member']));
    expect((await stale)?.roleKeys).toEqual(['member']);
    const fresh = vi.fn(async () => membership(['manager']));
    expect((await cache.get(USER, ORG, fresh))?.roleKeys).toEqual(['manager']);
    expect(fresh).toHaveBeenCalledTimes(1);
  });

  it('evicts the oldest entry when full', async () => {
    const cache = new MembershipCache({ maxEntries: 2 });
    for (const org of ['o1', 'o2', 'o3']) {
      await cache.get(USER, org, async () => null);
    }
    expect(cache.size).toBe(2);
    const load = vi.fn(async () => null);
    await cache.get(USER, 'o1', load);
    expect(load).toHaveBeenCalledTimes(1);
  });
});
