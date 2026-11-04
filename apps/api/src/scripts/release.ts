/*
 * Release (`node apps/api/dist/release.js`): what runs once per deploy, before the new API starts
 * (Railway's pre-deploy command; docs/deploy.md). Every step is idempotent, logs what it did and
 * fails the deploy (non-zero exit) when it cannot do its job:
 *
 * 0. Validate the API environment (loadEnv): a deploy that would not boot does not migrate.
 * 1. Bootstrap: roles, database and schema privileges, with the superuser of DATABASE_URL_ADMIN.
 *    Skipped (logged) when DATABASE_URL_ADMIN is not set.
 * 2. Migrations: Drizzle migrations and the pg-boss schema, as vime_owner (DATABASE_URL_OWNER,
 *    a direct connection: advisory locks serialize concurrent releases).
 * 3. Provisioning of the first organization, with BOOTSTRAP_OWNER_EMAIL, BOOTSTRAP_OWNER_PASSWORD
 *    (12+ characters) and BOOTSTRAP_ORG_NAME (optional: BOOTSTRAP_OWNER_NAME, BOOTSTRAP_ORG_SLUG,
 *    BOOTSTRAP_ORG_TIMEZONE): the owner's email + password user (an existing user is never
 *    touched: its password is not reset), the organization (es-PE) with that user as owner and the
 *    `example` entitlement. Each piece is created only when missing, so a re-run, or a later change
 *    made in the app, is left alone. Never creates demo data. Passwords are never logged.
 * 4. Platform administrator account, with PLATFORM_ADMIN_EMAIL and PLATFORM_ADMIN_PASSWORD (12+
 *    characters; optional: PLATFORM_ADMIN_NAME): an email + password user with no organization,
 *    for the platform console (ADR 0015). An existing user is never touched. The step logs the
 *    user's id: the console opens only once that id is in PLATFORM_ADMIN_USER_IDS.
 *
 * A project adds its own steps here (e.g. object storage CORS, default records of its domain).
 * Database URLs are read from process.env by @vime/db; the rest from `options.env`.
 */
import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SlugSchema, TimeZoneSchema, type FeatureKey } from '@vime/contracts';
import { closeDb, withSystem } from '@vime/db';
import {
  MIGRATIONS_FOLDER,
  bootstrapDatabase,
  installJobSchema,
  migrateDatabase,
} from '@vime/db/admin';
import { createOrganization, setEntitlement, systemActor } from '@vime/platform';
import { memberships, organizationEntitlements, organizations } from '@vime/platform/schema';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { createAuth } from '../auth/auth';
import { CREDENTIAL_PROVIDER_ID, createCredentialUser, type AuthUserStore } from '../auth/users';
import { loadEnv } from '../env';

type Log = (line: string) => void;

/** The feature the first organization starts with. */
const BOOTSTRAP_FEATURE: FeatureKey = 'example';

const optionalString = z
  .string()
  .trim()
  .transform((value) => (value === '' ? undefined : value))
  .optional();

/** Variables of the release itself (on top of the API's). */
const ReleaseEnvSchema = z.object({
  /** Migrations folder; default: packages/db/migrations next to the sources or the bundle. */
  MIGRATIONS_DIR: optionalString,
  BOOTSTRAP_OWNER_EMAIL: optionalString,
  BOOTSTRAP_OWNER_PASSWORD: z.string().optional(),
  BOOTSTRAP_OWNER_NAME: optionalString,
  BOOTSTRAP_ORG_NAME: optionalString,
  BOOTSTRAP_ORG_SLUG: optionalString,
  BOOTSTRAP_ORG_TIMEZONE: optionalString,
  PLATFORM_ADMIN_EMAIL: optionalString,
  PLATFORM_ADMIN_PASSWORD: z.string().optional(),
  PLATFORM_ADMIN_NAME: optionalString,
});
type ReleaseEnv = z.output<typeof ReleaseEnvSchema>;

/** The first organization and its owner (BOOTSTRAP_*), validated. */
export const ProvisionInputSchema = z.object({
  ownerEmail: z.string().trim().toLowerCase().pipe(z.email()),
  ownerPassword: z
    .string()
    .min(12, 'must be at least 12 characters')
    .max(128, 'must be at most 128 characters'),
  ownerName: z.string().trim().min(1).max(200),
  orgName: z.string().trim().min(1).max(200),
  orgSlug: SlugSchema,
  orgTimezone: TimeZoneSchema,
});
export type ProvisionInput = z.output<typeof ProvisionInputSchema>;

/** The platform administrator's account (PLATFORM_ADMIN_*), validated. */
export const PlatformAdminInputSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email()),
  password: z
    .string()
    .min(12, 'must be at least 12 characters')
    .max(128, 'must be at most 128 characters'),
  name: z.string().trim().min(1).max(200),
});
export type PlatformAdminInput = z.output<typeof PlatformAdminInputSchema>;

/**
 * Step 4's input: null when neither PLATFORM_ADMIN_EMAIL nor PLATFORM_ADMIN_PASSWORD is set;
 * throws (naming the variables, never their values) when only one is, or when one is invalid.
 */
export function platformAdminInputFromEnv(env: ReleaseEnv): PlatformAdminInput | null {
  const email = env.PLATFORM_ADMIN_EMAIL ?? '';
  const password = env.PLATFORM_ADMIN_PASSWORD ?? '';
  if (email === '' && password === '') {
    return null;
  }
  if (email === '' || password === '') {
    throw new Error(
      'The platform administrator needs PLATFORM_ADMIN_EMAIL and PLATFORM_ADMIN_PASSWORD; ' +
        `missing: ${email === '' ? 'PLATFORM_ADMIN_EMAIL' : 'PLATFORM_ADMIN_PASSWORD'}.`,
    );
  }
  const parsed = PlatformAdminInputSchema.safeParse({
    email,
    password,
    name: env.PLATFORM_ADMIN_NAME ?? email.split('@')[0],
  });
  if (!parsed.success) {
    throw new Error(
      `Invalid platform administrator variables:\n${formatIssues(parsed.error, {
        email: 'PLATFORM_ADMIN_EMAIL',
        password: 'PLATFORM_ADMIN_PASSWORD',
        name: 'PLATFORM_ADMIN_NAME',
      })}`,
    );
  }
  return parsed.data;
}

/** The three required variables of the provisioning step: all of them, or none. */
const REQUIRED_PROVISION_VARIABLES = [
  'BOOTSTRAP_OWNER_EMAIL',
  'BOOTSTRAP_OWNER_PASSWORD',
  'BOOTSTRAP_ORG_NAME',
] as const;

/** URL slug of an organization name: `Acme` → `acme`, `Pérez & Hijos` → `perez-hijos`. */
export function slugify(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '');
}

/** An email as it may be logged: `jane.doe@example.com` → `j***@example.com`. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  return at <= 0 ? '***' : `${email[0]}***${email.slice(at)}`;
}

function formatIssues(error: z.ZodError, names: Record<string, string>): string {
  return error.issues
    .map((issue) => {
      const key = String(issue.path[0] ?? '');
      return `  - ${names[key] ?? key}: ${issue.message}`;
    })
    .join('\n');
}

/**
 * The provisioning input from the environment: null when none of the required BOOTSTRAP_*
 * variables is set; throws (naming the variables, never their values) when only some are, or
 * when one is invalid.
 */
export function provisionInputFromEnv(env: ReleaseEnv): ProvisionInput | null {
  const required = REQUIRED_PROVISION_VARIABLES;
  const present = required.filter((key) => (env[key] ?? '') !== '');
  if (present.length === 0) {
    return null;
  }
  if (present.length < required.length) {
    const missing = required.filter((key) => !present.includes(key));
    throw new Error(`Provisioning needs ${required.join(', ')}; missing: ${missing.join(', ')}.`);
  }
  const email = env.BOOTSTRAP_OWNER_EMAIL ?? '';
  const orgName = env.BOOTSTRAP_ORG_NAME ?? '';
  const parsed = ProvisionInputSchema.safeParse({
    ownerEmail: email,
    ownerPassword: env.BOOTSTRAP_OWNER_PASSWORD,
    ownerName: env.BOOTSTRAP_OWNER_NAME ?? email.split('@')[0],
    orgName,
    orgSlug: env.BOOTSTRAP_ORG_SLUG ?? slugify(orgName),
    orgTimezone: env.BOOTSTRAP_ORG_TIMEZONE ?? 'America/Lima',
  });
  if (!parsed.success) {
    throw new Error(
      `Invalid provisioning variables:\n${formatIssues(parsed.error, {
        ownerEmail: 'BOOTSTRAP_OWNER_EMAIL',
        ownerPassword: 'BOOTSTRAP_OWNER_PASSWORD',
        ownerName: 'BOOTSTRAP_OWNER_NAME',
        orgName: 'BOOTSTRAP_ORG_NAME',
        orgSlug: 'BOOTSTRAP_ORG_SLUG (or a BOOTSTRAP_ORG_NAME with letters or digits)',
        orgTimezone: 'BOOTSTRAP_ORG_TIMEZONE',
      })}`,
    );
  }
  return parsed.data;
}

/**
 * The migrations folder: MIGRATIONS_DIR, else packages/db/migrations next to the sources (tsx,
 * tests) or next to the bundle (`apps/api/dist/release.js` → `packages/db/migrations`, the
 * Docker image's layout). Throws when none has a journal: a release must never skip migrations
 * because a folder was not copied.
 */
export function resolveMigrationsFolder(explicit: string | undefined): string {
  const candidates = explicit
    ? [explicit]
    : [
        MIGRATIONS_FOLDER,
        fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url)),
      ];
  const found = candidates.find((dir) => existsSync(join(dir, 'meta', '_journal.json')));
  if (!found) {
    throw new Error(
      `No migrations journal (meta/_journal.json) in ${candidates.join(' or ')}. ` +
        'Copy packages/db/migrations into the image or set MIGRATIONS_DIR.',
    );
  }
  return found;
}

export interface ProvisionResult {
  userId: string;
  orgId: string;
  user: 'created' | 'exists';
  organization: 'created' | 'exists';
  entitlement: 'enabled' | 'exists';
}

/**
 * Step 3: the first organization and its owner, each piece only when missing (see the header).
 * `store` is Better Auth's context, the same path the seed and the invitations use.
 */
export async function provision(
  input: ProvisionInput,
  store: AuthUserStore,
  log: Log,
): Promise<ProvisionResult> {
  const who = maskEmail(input.ownerEmail);
  const existing = await store.internalAdapter.findUserByEmail(input.ownerEmail, {
    includeAccounts: true,
  });
  let userId: string;
  let user: ProvisionResult['user'];
  if (existing) {
    userId = existing.user.id;
    user = 'exists';
    const hasPassword = existing.accounts.some((a) => a.providerId === CREDENTIAL_PROVIDER_ID);
    log(
      `owner ${who}: exists, password left unchanged` +
        (hasPassword ? '' : ' (WARNING: this user has no password sign-in)'),
    );
  } else {
    const created = await createCredentialUser(store, {
      email: input.ownerEmail,
      name: input.ownerName,
      password: input.ownerPassword,
      method: 'release',
    });
    userId = created.id;
    user = 'created';
    log(`owner ${who}: created`);
  }

  // Serialized with any concurrent release (advisory lock), then looked up by slug.
  const org = await withSystem(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('vime:release:provision'))`);
    const [row] = await tx
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.slug, input.orgSlug));
    if (row) {
      const [member] = await tx
        .select({ status: memberships.status })
        .from(memberships)
        .where(and(eq(memberships.organizationId, row.id), eq(memberships.userId, userId)));
      return { id: row.id, created: false, memberStatus: member?.status ?? null };
    }
    const created = await createOrganization(
      tx,
      { name: input.orgName, slug: input.orgSlug, timezone: input.orgTimezone, locale: 'es-PE' },
      { ownerUserId: userId },
    );
    return { id: created.id, created: true, memberStatus: 'active' };
  });
  const id = org.id;
  const organization: ProvisionResult['organization'] = org.created ? 'created' : 'exists';
  if (org.created) {
    log(`organization ${input.orgSlug}: created (${input.orgTimezone}, es-PE, owner ${who})`);
  } else {
    log(
      `organization ${input.orgSlug}: exists` +
        (org.memberStatus
          ? ` (membership of ${who}: ${org.memberStatus})`
          : ` (WARNING: ${who} is not a member; not added, grant access from the app)`),
    );
  }

  // Only when the organization has no entitlement row at all: one disabled on purpose stays
  // disabled.
  const entitlement = await withSystem(async (tx): Promise<ProvisionResult['entitlement']> => {
    const [row] = await tx
      .select({ enabled: organizationEntitlements.enabled })
      .from(organizationEntitlements)
      .where(
        and(
          eq(organizationEntitlements.organizationId, id),
          eq(organizationEntitlements.featureKey, BOOTSTRAP_FEATURE),
        ),
      );
    if (row) {
      log(`entitlement ${BOOTSTRAP_FEATURE}: exists (${row.enabled ? 'enabled' : 'disabled'})`);
      return 'exists';
    }
    await setEntitlement(tx, systemActor(id), { featureKey: BOOTSTRAP_FEATURE, enabled: true });
    log(`entitlement ${BOOTSTRAP_FEATURE}: enabled`);
    return 'enabled';
  });

  return { userId, orgId: id, user, organization, entitlement };
}

export interface PlatformAdminResult {
  userId: string;
  user: 'created' | 'exists';
  /** The id is in PLATFORM_ADMIN_USER_IDS: the console already opens for this user. */
  listed: boolean;
}

/**
 * Step 4: the platform administrator's email + password user, created only when missing (with no
 * organization). Its id goes to the log: PLATFORM_ADMIN_USER_IDS, not this step, opens the console.
 */
export async function provisionPlatformAdmin(
  input: PlatformAdminInput,
  store: AuthUserStore,
  adminIds: readonly string[],
  log: Log,
): Promise<PlatformAdminResult> {
  const who = maskEmail(input.email);
  const existing = await store.internalAdapter.findUserByEmail(input.email);
  let userId: string;
  let user: PlatformAdminResult['user'];
  if (existing) {
    userId = existing.user.id;
    user = 'exists';
    log(`platform administrator ${who}: exists (id ${userId}), password left unchanged`);
  } else {
    const created = await createCredentialUser(store, {
      email: input.email,
      name: input.name,
      password: input.password,
      method: 'release',
    });
    userId = created.id;
    user = 'created';
    log(`platform administrator ${who}: created (id ${userId})`);
  }
  const listed = adminIds.includes(userId.toLowerCase());
  log(
    listed
      ? 'platform administrator: in PLATFORM_ADMIN_USER_IDS, the console is open'
      : `platform administrator: add ${userId} to PLATFORM_ADMIN_USER_IDS to open the console`,
  );
  return { userId, user, listed };
}

export interface ReleaseOptions {
  /** API and release variables (default process.env). Database URLs always come from process.env. */
  env?: NodeJS.ProcessEnv;
  log?: Log;
}

export interface ReleaseResult {
  bootstrapped: boolean;
  migrationsApplied: number;
  provisioning: ProvisionResult | null;
  /** Step 4; null when its variables are not set. */
  platformAdmin: PlatformAdminResult | null;
}

/** Runs the release steps in order (see the header). Throws on the first failing step. */
export async function runRelease(options: ReleaseOptions = {}): Promise<ReleaseResult> {
  const source = options.env ?? process.env;
  const log = options.log ?? ((line: string) => console.log(`[release] ${line}`));

  const env = loadEnv(source);
  const parsed = ReleaseEnvSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(`Invalid release environment:\n${formatIssues(parsed.error, {})}`);
  }
  const releaseEnv = parsed.data;
  // Validated before touching the database, so a typo fails the deploy before any change.
  const provisionInput = provisionInputFromEnv(releaseEnv);
  const platformAdminInput = platformAdminInputFromEnv(releaseEnv);
  const migrationsFolder = resolveMigrationsFolder(releaseEnv.MIGRATIONS_DIR);

  let bootstrapped = false;
  if (process.env['DATABASE_URL_ADMIN']) {
    log('1/4 bootstrap: roles, database and privileges (DATABASE_URL_ADMIN)');
    await bootstrapDatabase({ log: (line) => log(`  ${line}`) });
    bootstrapped = true;
  } else {
    log('1/4 bootstrap: skipped (DATABASE_URL_ADMIN is not set)');
  }

  log(`2/4 migrations: ${migrationsFolder} (DATABASE_URL_OWNER)`);
  const migrationsApplied = await migrateDatabase({
    migrationsFolder,
    log: (line) => log(`  ${line}`),
  });
  await installJobSchema({ log: (line) => log(`  ${line}`) });

  let provisioning: ProvisionResult | null = null;
  if (provisionInput) {
    log(`3/4 provisioning: organization ${provisionInput.orgSlug}`);
    const store = await createAuth({ env }).$context;
    provisioning = await provision(provisionInput, store, (line) => log(`  ${line}`));
  } else {
    log('3/4 provisioning: skipped (BOOTSTRAP_OWNER_EMAIL, _PASSWORD and ORG_NAME are not set)');
  }

  let platformAdmin: PlatformAdminResult | null = null;
  if (platformAdminInput) {
    log('4/4 platform administrator');
    const store = await createAuth({ env }).$context;
    platformAdmin = await provisionPlatformAdmin(
      platformAdminInput,
      store,
      env.PLATFORM_ADMIN_USER_IDS,
      (line) => log(`  ${line}`),
    );
  } else {
    log('4/4 platform administrator: skipped (PLATFORM_ADMIN_EMAIL and _PASSWORD are not set)');
  }
  return { bootstrapped, migrationsApplied, provisioning, platformAdmin };
}

/** True when this module is the process's entry point (`node dist/release.js`, `tsx release.ts`). */
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  const started = Date.now();
  let code = 0;
  try {
    await runRelease();
    console.log(`[release] done in ${((Date.now() - started) / 1000).toFixed(1)} s`);
  } catch (error) {
    console.error('[release] FAILED:', error);
    code = 1;
  } finally {
    await closeDb().catch(() => undefined);
  }
  // Explicit exit: an idle keep-alive socket must not hold a pre-deploy step open.
  process.exit(code);
}
