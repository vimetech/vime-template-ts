import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, withSystem } from '@vime/db';
import { dropTestDatabase } from '@vime/db/testing';
import { setEntitlement, systemActor } from '@vime/platform';
import { activityEvents, organizationEntitlements } from '@vime/platform/schema';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, cookieHeader, testEnv } from '../testing/helpers';
import {
  maskEmail,
  platformAdminInputFromEnv,
  provisionInputFromEnv,
  resolveMigrationsFolder,
  runRelease,
  slugify,
} from './release';

/** API variables the release validates, when the environment lacks them (CI runs via turbo). */
const API_DEFAULTS = {
  API_PUBLIC_URL: 'http://localhost:4000',
  WEB_ORIGIN: 'http://localhost:5173',
  BETTER_AUTH_SECRET: 'test-only-secret-0123456789abcdef0123456789',
  CREDENTIALS_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
};

describe('release helpers', () => {
  it('slugifies organization names and masks emails for the logs', () => {
    expect(slugify('Acme')).toBe('acme');
    expect(slugify('  Pérez & Hijos S.A.C. ')).toBe('perez-hijos-s-a-c');
    expect(slugify('Ñandú — Lima 2')).toBe('nandu-lima-2');
    expect(slugify('¡¡!!')).toBe('');
    expect(maskEmail('j.mena.t@gmail.com')).toBe('j***@gmail.com');
    expect(maskEmail('nope')).toBe('***');
  });

  it('reads the provisioning variables: all or none, validated, never echoing the password', () => {
    expect(provisionInputFromEnv({})).toBeNull();
    expect(
      provisionInputFromEnv({
        BOOTSTRAP_OWNER_EMAIL: ' Owner@Example.COM ',
        BOOTSTRAP_OWNER_PASSWORD: 'a-long-password-1',
        BOOTSTRAP_ORG_NAME: 'Acmé Lima',
      }),
    ).toEqual({
      ownerEmail: 'owner@example.com',
      ownerPassword: 'a-long-password-1',
      ownerName: 'Owner',
      orgName: 'Acmé Lima',
      orgSlug: 'acme-lima',
      orgTimezone: 'America/Lima',
    });
    expect(() => provisionInputFromEnv({ BOOTSTRAP_OWNER_EMAIL: 'owner@example.com' })).toThrow(
      /missing: BOOTSTRAP_OWNER_PASSWORD, BOOTSTRAP_ORG_NAME/,
    );
    // The three are first emptied in one write, then deleted one by one; every intermediate state
    // skips provisioning instead of failing the release.
    const emptied = {
      BOOTSTRAP_OWNER_EMAIL: '',
      BOOTSTRAP_OWNER_PASSWORD: '',
      BOOTSTRAP_ORG_NAME: '',
    };
    expect(provisionInputFromEnv(emptied)).toBeNull();
    expect(
      provisionInputFromEnv({ BOOTSTRAP_OWNER_PASSWORD: '', BOOTSTRAP_ORG_NAME: '' }),
    ).toBeNull();
    expect(provisionInputFromEnv({ BOOTSTRAP_ORG_NAME: '' })).toBeNull();

    const secret = 'short-pw';
    let message = '';
    try {
      provisionInputFromEnv({
        BOOTSTRAP_OWNER_EMAIL: 'not-an-email',
        BOOTSTRAP_OWNER_PASSWORD: secret,
        BOOTSTRAP_ORG_NAME: '!!!',
        BOOTSTRAP_ORG_TIMEZONE: 'Mars/Olympus',
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('BOOTSTRAP_OWNER_EMAIL');
    expect(message).toContain('BOOTSTRAP_OWNER_PASSWORD: must be at least 12 characters');
    expect(message).toContain('BOOTSTRAP_ORG_SLUG');
    expect(message).toContain('BOOTSTRAP_ORG_TIMEZONE');
    expect(message).not.toContain(secret);
  });

  it('reads the platform administrator variables: both or none, never echoing the password', () => {
    expect(platformAdminInputFromEnv({})).toBeNull();
    expect(
      platformAdminInputFromEnv({ PLATFORM_ADMIN_EMAIL: '', PLATFORM_ADMIN_PASSWORD: '' }),
    ).toBeNull();
    expect(
      platformAdminInputFromEnv({
        PLATFORM_ADMIN_EMAIL: ' Admin@Example.com ',
        PLATFORM_ADMIN_PASSWORD: 'a-long-password-1',
      }),
    ).toEqual({ email: 'admin@example.com', password: 'a-long-password-1', name: 'Admin' });
    expect(() => platformAdminInputFromEnv({ PLATFORM_ADMIN_EMAIL: 'a@example.com' })).toThrow(
      /missing: PLATFORM_ADMIN_PASSWORD/,
    );
    let message = '';
    try {
      platformAdminInputFromEnv({
        PLATFORM_ADMIN_EMAIL: 'a@example.com',
        PLATFORM_ADMIN_PASSWORD: 'short',
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('PLATFORM_ADMIN_PASSWORD: must be at least 12 characters');
    expect(message).not.toContain('short');
  });

  it('refuses an environment the API would refuse, before touching the database', async () => {
    const lines: string[] = [];
    const production = {
      ...API_DEFAULTS,
      ...process.env,
      NODE_ENV: 'production',
      BETTER_AUTH_SECRET: randomBytes(32).toString('base64'),
      CREDENTIALS_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    };
    await expect(
      runRelease({
        env: { ...production, BETTER_AUTH_SECRET: 'short' },
        log: (l) => lines.push(l),
      }),
    ).rejects.toThrow(/BETTER_AUTH_SECRET/);
    await expect(
      runRelease({
        env: { ...production, BOOTSTRAP_ORG_NAME: 'Acme' },
        log: (l) => lines.push(l),
      }),
    ).rejects.toThrow(/missing: BOOTSTRAP_OWNER_EMAIL, BOOTSTRAP_OWNER_PASSWORD/);
    expect(lines).toEqual([]);
  });

  it('refuses to run without a migrations journal', () => {
    const empty = mkdtempSync(join(tmpdir(), 'vime-migrations-'));
    try {
      expect(() => resolveMigrationsFolder(empty)).toThrow(/No migrations journal/);
      expect(resolveMigrationsFolder(undefined)).toMatch(/packages[\\/]db[\\/]migrations$/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

const adminUrl = process.env['DATABASE_URL_ADMIN'];

/**
 * The whole release against a database that does not exist yet (same roles as the test database,
 * a throwaway `vime_test_release_*` database), run twice. Needs DATABASE_URL_ADMIN, like CI.
 */
describe.skipIf(!adminUrl)('release on a fresh database', () => {
  const database = `vime_test_release_${randomBytes(4).toString('hex')}`;
  const keys = ['DATABASE_URL', 'DATABASE_URL_SYSTEM', 'DATABASE_URL_OWNER'] as const;
  const saved: Partial<Record<(typeof keys)[number], string>> = {};
  let app: FastifyInstance | undefined;

  beforeAll(async () => {
    // Pools of this file must point at the new database: none exists yet, close any anyway.
    await closeDb();
    for (const key of keys) {
      const value = process.env[key];
      if (!value) throw new Error(`${key} is not set`);
      saved[key] = value;
      const url = new URL(value);
      url.pathname = `/${database}`;
      process.env[key] = url.toString();
    }
  });

  afterAll(async () => {
    await app?.close();
    await closeDb();
    for (const key of keys) {
      process.env[key] = saved[key];
    }
    await dropTestDatabase(database);
  });

  const email = `Owner-${randomBytes(3).toString('hex')}@Release.Test.Invalid`;
  const firstPassword = 'first-password-0123';
  const releaseEnv = (password: string) => ({
    ...API_DEFAULTS,
    ...process.env,
    NODE_ENV: 'test',
    BOOTSTRAP_OWNER_EMAIL: email,
    BOOTSTRAP_OWNER_PASSWORD: password,
    BOOTSTRAP_OWNER_NAME: 'Dueña Piloto',
    BOOTSTRAP_ORG_NAME: 'Acmé Piloto',
  });

  it('bootstraps, migrates and provisions the first organization, idempotently', async () => {
    const lines: string[] = [];
    const first = await runRelease({
      env: releaseEnv(firstPassword),
      log: (line) => lines.push(line),
    });
    expect(first.bootstrapped).toBe(true);
    expect(first.migrationsApplied).toBeGreaterThan(0);
    expect(first.provisioning).toMatchObject({
      user: 'created',
      organization: 'created',
      entitlement: 'enabled',
    });
    const log = lines.join('\n');
    expect(log).toContain(`created database ${database}`);
    expect(log).toContain('pg-boss: installed schema');
    expect(log).toContain('organization acme-piloto: created');
    expect(log).not.toContain(firstPassword);
    expect(log).not.toContain(email.toLowerCase());

    // Again, with another password: nothing changes, the owner's password is not reset.
    const again: string[] = [];
    const second = await runRelease({
      env: releaseEnv('second-password-4567'),
      log: (line) => again.push(line),
    });
    expect(second).toEqual({
      bootstrapped: true,
      migrationsApplied: 0,
      provisioning: {
        userId: first.provisioning?.userId,
        orgId: first.provisioning?.orgId,
        user: 'exists',
        organization: 'exists',
        entitlement: 'exists',
      },
      platformAdmin: null,
    });
    expect(again.join('\n')).toContain('password left unchanged');

    const orgId = first.provisioning?.orgId as string;
    const counts = await withSystem(async (tx) => {
      const events = await tx
        .select({ eventType: activityEvents.eventType })
        .from(activityEvents)
        .where(eq(activityEvents.organizationId, orgId));
      return {
        created: events.filter((e) => e.eventType === 'organization.created').length,
        entitlements: events.filter((e) => e.eventType === 'entitlement.set').length,
      };
    });
    expect(counts).toEqual({ created: 1, entitlements: 1 });

    // The owner signs in with the first password and sees the organization with the feature.
    app = await buildTestApp();
    const wrong = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      payload: { email, password: 'second-password-4567' },
    });
    expect(wrong.statusCode).toBe(401);
    const signIn = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      payload: { email, password: firstPassword },
    });
    expect(signIn.statusCode).toBe(200);
    const cookie = cookieHeader(signIn);
    const me = await app.inject({ method: 'GET', url: '/api/v1/me', headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({
      user: { name: 'Dueña Piloto', email: email.toLowerCase() },
      memberships: [
        {
          organization: { id: orgId, slug: 'acme-piloto', timezone: 'America/Lima' },
          roleKeys: ['owner'],
          features: ['example'],
        },
      ],
    });
    const notes = await app.inject({
      method: 'GET',
      url: `/api/v1/orgs/${orgId}/notes`,
      headers: { cookie },
    });
    expect(notes.statusCode).toBe(200);
  });

  it('creates the platform administrator once, with no organization', async () => {
    const adminEmail = `admin-${randomBytes(3).toString('hex')}@release.test.invalid`;
    const password = 'platform-password-0123';
    const env = { ...releaseEnv(firstPassword), PLATFORM_ADMIN_EMAIL: adminEmail };
    const lines: string[] = [];
    const first = await runRelease({
      env: { ...env, PLATFORM_ADMIN_PASSWORD: password },
      log: (line) => lines.push(line),
    });
    expect(first.platformAdmin).toMatchObject({ user: 'created', listed: false });
    const userId = first.platformAdmin?.userId as string;
    const log = lines.join('\n');
    expect(log).toContain(`add ${userId} to PLATFORM_ADMIN_USER_IDS`);
    expect(log).not.toContain(password);
    expect(log).not.toContain(adminEmail);

    const second = await runRelease({
      env: {
        ...env,
        PLATFORM_ADMIN_PASSWORD: 'another-password-4567',
        PLATFORM_ADMIN_USER_IDS: userId,
      },
      log: () => {},
    });
    expect(second.platformAdmin).toEqual({ userId, user: 'exists', listed: true });

    const api = await buildTestApp({ env: testEnv({ PLATFORM_ADMIN_USER_IDS: userId }) });
    try {
      const signIn = await api.inject({
        method: 'POST',
        url: '/api/auth/sign-in/email',
        payload: { email: adminEmail, password },
      });
      expect(signIn.statusCode).toBe(200);
      const me = await api.inject({
        method: 'GET',
        url: '/api/v1/me',
        headers: { cookie: cookieHeader(signIn) },
      });
      expect(me.json()).toMatchObject({ memberships: [], platformAdmin: true });
    } finally {
      await api.close();
    }
  });

  it('leaves an entitlement disabled on purpose as it is', async () => {
    const orgId = (await runRelease({ env: releaseEnv(firstPassword), log: () => {} })).provisioning
      ?.orgId as string;
    await withSystem((tx) =>
      setEntitlement(tx, systemActor(orgId), { featureKey: 'example', enabled: false }),
    );
    const result = await runRelease({ env: releaseEnv(firstPassword), log: () => {} });
    expect(result.provisioning?.entitlement).toBe('exists');
    const [row] = await withSystem((tx) =>
      tx
        .select({ enabled: organizationEntitlements.enabled })
        .from(organizationEntitlements)
        .where(
          and(
            eq(organizationEntitlements.organizationId, orgId),
            eq(organizationEntitlements.featureKey, 'example'),
          ),
        ),
    );
    expect(row?.enabled).toBe(false);
  });
});
