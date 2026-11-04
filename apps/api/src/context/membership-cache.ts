import type { ResolvedMembership } from '@vime/platform';

interface Entry {
  value: ResolvedMembership | null;
  expiresAt: number;
}

export interface MembershipCacheOptions {
  ttlMs?: number;
  maxEntries?: number;
  now?: () => number;
}

/**
 * Short in-process cache of (userId, orgId) → active membership (or null), so a burst of requests
 * resolves authorization once (architecture §5.2). Entries live `ttlMs` (30 s by default) and are
 * dropped right away by `invalidate` when the API changes a membership (roles, status, invitation
 * redeemed). Other API processes see such a change within the TTL at most.
 *
 * A load that started before an invalidation of its key is not stored, so a stale read can never
 * overwrite a fresh invalidation.
 */
export class MembershipCache {
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, Entry>();
  /** Bumped by every invalidation of a key (and by clear) to discard loads started earlier. */
  private readonly generations = new Map<string, number>();
  private epoch = 0;

  constructor(options: MembershipCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? 30_000;
    this.maxEntries = options.maxEntries ?? 10_000;
    this.now = options.now ?? Date.now;
  }

  private static key(userId: string, orgId: string): string {
    return `${userId.toLowerCase()}:${orgId.toLowerCase()}`;
  }

  private generation(key: string): string {
    return `${this.epoch}:${this.generations.get(key) ?? 0}`;
  }

  /** The cached membership, or the result of `load` (cached for the TTL). */
  async get(
    userId: string,
    orgId: string,
    load: () => Promise<ResolvedMembership | null>,
  ): Promise<ResolvedMembership | null> {
    const key = MembershipCache.key(userId, orgId);
    const cached = this.entries.get(key);
    if (cached && cached.expiresAt > this.now()) {
      return cached.value;
    }
    this.entries.delete(key);
    const generation = this.generation(key);
    const value = await load();
    if (this.generation(key) === generation) {
      if (this.entries.size >= this.maxEntries) {
        // Map iteration order is insertion order: drop the oldest entry.
        const oldest = this.entries.keys().next();
        if (!oldest.done) this.entries.delete(oldest.value);
      }
      this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
    }
    return value;
  }

  /** Forgets the membership of `userId` in `orgId` (call after changing it). */
  invalidate(userId: string, orgId: string): void {
    const key = MembershipCache.key(userId, orgId);
    this.entries.delete(key);
    this.generations.set(key, (this.generations.get(key) ?? 0) + 1);
    if (this.generations.size > this.maxEntries) {
      // Rare: many distinct invalidations. Start a new epoch so in-flight loads are discarded.
      this.generations.clear();
      this.epoch += 1;
    }
  }

  clear(): void {
    this.entries.clear();
    this.generations.clear();
    this.epoch += 1;
  }

  get size(): number {
    return this.entries.size;
  }
}
