/*
 * @vime/platform/testing: integration test fixtures, for this module and the modules above it.
 * Every test creates its own organizations (unique slugs) and users (unique emails) through
 * withSystem, and never truncates tables: the database is shared. Never import from runtime code.
 */
import { PERMISSIONS, type Organization, type Permission } from '@vime/contracts';
import { withSystem } from '@vime/db';
import { newId } from '@vime/kernel';
import type { ActorContext } from '../context';
import { createOrganization } from '../organizations';
import { user } from '../schema';

export const ALL_PERMISSIONS: ReadonlySet<Permission> = new Set(PERMISSIONS);

/** Invitation code HMAC key for tests (the API derives the real one from its secret). */
export const TEST_INVITATION_CODE_KEY = 'test-only-invitation-code-key-0123456789abcdef';

export function uniqueSuffix(): string {
  return newId().slice(-12);
}

export interface TestUser {
  id: string;
  name: string;
  email: string;
}

/** A Better Auth user row (as the auth flow would create it). */
export async function createTestUser(name = 'Test User', email?: string): Promise<TestUser> {
  const id = newId();
  const row = { id, name, email: email ?? `user-${uniqueSuffix()}@test.vime.invalid` };
  await withSystem((tx) => tx.insert(user).values(row));
  return row;
}

/** A new organization with a unique slug, optionally with an owner. */
export async function createTestOrg(
  options: { ownerUserId?: string; timezone?: string; name?: string } = {},
): Promise<Organization> {
  return withSystem((tx) =>
    createOrganization(
      tx,
      {
        name: options.name ?? 'Test Org',
        slug: `test-${uniqueSuffix()}`,
        ...(options.timezone ? { timezone: options.timezone } : {}),
      },
      options.ownerUserId ? { ownerUserId: options.ownerUserId } : {},
    ),
  );
}

export function webActor(orgId: string, userId?: string): ActorContext {
  return { orgId, source: 'web', ...(userId ? { userId } : {}) };
}
