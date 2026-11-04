/*
 * Integration-test helpers for @vime/api (never imported by runtime code). Tests build the app with
 * `buildTestApp()` and talk to it with `app.inject`, against the real database. Every test creates
 * its own users (unique emails) and organizations (unique slugs) and never truncates tables.
 */
import { randomBytes } from 'node:crypto';
import type { RoleKey } from '@vime/contracts';
import { withSystem, withTenant } from '@vime/db';
import { addMembership, setEntitlement, systemActor } from '@vime/platform';
import { createTestOrg, uniqueSuffix } from '@vime/platform/testing';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp, type BuildAppOptions } from '../app';
import { ensureCredentialUser } from '../auth/users';
import { loadEnv, type ApiEnv } from '../env';

/**
 * Values for the API-only variables when the environment does not provide them (CI passes only the
 * database URLs through turbo). Never used outside tests.
 */
const TEST_ENV_DEFAULTS = {
  API_PUBLIC_URL: 'http://localhost:4000',
  WEB_ORIGIN: 'http://localhost:5173',
  BETTER_AUTH_SECRET: 'test-only-secret-0123456789abcdef0123456789',
};

/**
 * Credentials that tests store are encrypted with a random key of this test process, never with
 * the environment's key, so nothing a test stores can be read by a process on the environment's.
 */
export const TEST_CREDENTIALS_KEY = randomBytes(32).toString('base64');

export function testEnv(overrides: Record<string, string> = {}): ApiEnv {
  return loadEnv({
    ...TEST_ENV_DEFAULTS,
    ...process.env,
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    CREDENTIALS_ENCRYPTION_KEY: TEST_CREDENTIALS_KEY,
    ...overrides,
  });
}

/** Rate limits high enough not to interfere with a test file's requests. */
export const RELAXED_RATE_LIMITS = { global: 100_000, auth: 100_000, signIn: 100_000 };

/** The app on the test environment. */
export async function buildTestApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  return buildApp({
    env: testEnv(),
    logger: false,
    rateLimits: RELAXED_RATE_LIMITS,
    ...options,
  });
}

export interface TestUser {
  id: string;
  name: string;
  email: string;
  password: string;
}

/** A user with an email + password account (unique email). */
export async function createUser(app: FastifyInstance, name = 'Test User'): Promise<TestUser> {
  const email = `user-${uniqueSuffix()}@api.test.invalid`;
  const password = `pw-${uniqueSuffix()}`;
  const { user } = await ensureCredentialUser(await app.betterAuth.$context, {
    email,
    name,
    password,
  });
  return { id: user.id, name, email, password };
}

export interface Credentials {
  /** `Cookie` request header with the session cookie (web). */
  cookie: string;
  /** Session token from `set-auth-token` (mobile bearer). */
  token: string;
}

/** `name=value` pairs of every Set-Cookie of a response, as a Cookie request header. */
export function cookieHeader(response: LightMyRequestResponse): string {
  const setCookie = response.headers['set-cookie'];
  const cookies = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  return cookies.map((cookie) => cookie.split(';')[0]).join('; ');
}

export async function signIn(app: FastifyInstance, user: TestUser): Promise<Credentials> {
  const response = await app.inject({
    method: 'POST',
    url: '/auth/sign-in/email',
    payload: { email: user.email, password: user.password },
  });
  if (response.statusCode !== 200) {
    throw new Error(`sign-in failed: ${response.statusCode} ${response.body}`);
  }
  const token = response.headers['set-auth-token'];
  if (typeof token !== 'string') {
    throw new Error('sign-in returned no set-auth-token header');
  }
  return { cookie: cookieHeader(response), token };
}

export function bearer(credentials: Credentials | string): Record<string, string> {
  const token = typeof credentials === 'string' ? credentials : credentials.token;
  return { authorization: `Bearer ${token}` };
}

/** A new organization (unique slug) with `ownerUserId` as owner and `example` enabled. */
export async function createOrg(
  ownerUserId: string,
  options: { name?: string; timezone?: string; example?: boolean } = {},
): Promise<string> {
  const org = await createTestOrg({
    ownerUserId,
    name: options.name ?? 'API Test Org',
    ...(options.timezone ? { timezone: options.timezone } : {}),
  });
  if (options.example ?? true) {
    await withSystem((tx) =>
      setEntitlement(tx, systemActor(org.id), { featureKey: 'example', enabled: true }),
    );
  }
  return org.id;
}

export async function addMember(
  orgId: string,
  userId: string,
  roleKeys: RoleKey[],
): Promise<string> {
  const membership = await withTenant({ orgId }, (tx) =>
    addMembership(tx, systemActor(orgId), { userId, roleKeys }),
  );
  return membership.membershipId;
}

export interface TestCodeMember {
  userId: string;
  /** Bearer token of the member's session (mobile). */
  token: string;
}

/**
 * A code-only member (`roleKeys`), the way the product creates one: an invitation (POST
 * /invitations) and its redemption (POST /auth/invite/redeem) with no email.
 */
export async function createCodeMember(
  app: FastifyInstance,
  owner: Credentials,
  orgId: string,
  name: string,
  roleKeys: RoleKey[] = ['member'],
): Promise<TestCodeMember> {
  const invitation = await app.inject({
    method: 'POST',
    url: `/v1/orgs/${orgId}/invitations`,
    headers: bearer(owner),
    payload: { roleKeys },
  });
  if (invitation.statusCode !== 201) {
    throw new Error(`invitation failed: ${invitation.statusCode} ${invitation.body}`);
  }
  const redeemed = await app.inject({
    method: 'POST',
    url: '/auth/invite/redeem',
    payload: { code: invitation.json<{ code: string }>().code, name },
  });
  if (redeemed.statusCode !== 200) {
    throw new Error(`redeem failed: ${redeemed.statusCode} ${redeemed.body}`);
  }
  const body = redeemed.json<{ token: string; user: { id: string } }>();
  return { userId: body.user.id, token: body.token };
}
