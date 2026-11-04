import {
  LocaleSchema,
  OPTIONAL_FUNCTIONS,
  OrganizationSettingsSchema,
  SlugSchema,
  TimeZoneSchema,
  UpdateOrganizationSchema,
  type Locale,
  type Organization,
} from '@vime/contracts';
import type { Tx } from '@vime/db';
import { ConflictError, NotFoundError, ValidationError, isUuid, newId } from '@vime/kernel';
import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { recordActivity } from './audit';
import type { ActorContext } from './context';
import { iso, isoOrNull } from './dto';
import { isUniqueViolation, parseInput } from './errors';
import { memberships, organizations } from './schema';

type OrganizationRow = typeof organizations.$inferSelect;

function toOrganization(row: OrganizationRow): Organization {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    timezone: row.timezone,
    locale: row.locale,
    // Stored settings may predate newer keys: parsing fills their defaults.
    settings: OrganizationSettingsSchema.parse(row.settings),
    createdAt: iso(row.createdAt),
    updatedAt: isoOrNull(row.updatedAt),
  };
}

export const CreateOrganizationSchema = z.object({
  name: z.string().trim().min(1).max(200),
  slug: SlugSchema,
  timezone: TimeZoneSchema.default('America/Lima'),
  locale: LocaleSchema.default('es-PE'),
  settings: OrganizationSettingsSchema.default(OrganizationSettingsSchema.parse({})),
});
export type CreateOrganizationInput = z.input<typeof CreateOrganizationSchema>;

export interface CreateOrganizationOptions {
  /** Pre-generated organization id (UUID). Defaults to a new UUIDv7. */
  id?: string;
  /** Adds an active membership with the `owner` role for this user. */
  ownerUserId?: string;
  /** Audit fields of whoever creates it (orgId is ignored: it is the new organization). */
  actor?: Omit<ActorContext, 'orgId'>;
}

/**
 * Creates an organization (and optionally its first owner membership). Run it through withSystem:
 * the organization does not exist yet, so there is no tenant context. Throws ConflictError if the
 * slug is taken.
 */
export async function createOrganization(
  tx: Tx,
  input: CreateOrganizationInput,
  options: CreateOrganizationOptions = {},
): Promise<Organization> {
  const data = parseInput(CreateOrganizationSchema, input);
  const id = options.id ?? newId();
  if (!isUuid(id)) {
    throw new TypeError('organization id must be a UUID');
  }
  const ctx: ActorContext = { source: 'system', ...options.actor, orgId: id };
  let row: OrganizationRow | undefined;
  try {
    [row] = await tx
      .insert(organizations)
      .values({
        id,
        name: data.name,
        slug: data.slug,
        timezone: data.timezone,
        locale: data.locale,
        settings: data.settings,
      })
      .returning();
  } catch (error) {
    if (isUniqueViolation(error, 'organizations_slug_unique')) {
      throw new ConflictError(`The slug ${data.slug} is already taken`, { cause: error });
    }
    throw error;
  }
  if (!row) {
    throw new Error('Insert into organizations returned no row');
  }
  await recordActivity(tx, ctx, {
    entityType: 'organization',
    entityId: id,
    eventType: 'organization.created',
    payload: { name: data.name, slug: data.slug, timezone: data.timezone, locale: data.locale },
  });
  if (options.ownerUserId !== undefined) {
    const membershipId = newId();
    await tx.insert(memberships).values({
      id: membershipId,
      organizationId: id,
      userId: options.ownerUserId,
      roleKeys: ['owner'],
    });
    await recordActivity(tx, ctx, {
      entityType: 'membership',
      entityId: membershipId,
      eventType: 'membership.created',
      payload: { userId: options.ownerUserId, roleKeys: ['owner'] },
    });
  }
  return toOrganization(row);
}

/**
 * The organization `orgId`. Visible inside its own withTenant transaction, or in withUser for an
 * active member. Throws NotFoundError otherwise.
 */
export async function getOrganization(tx: Tx, orgId: string): Promise<Organization> {
  const [row] = await tx.select().from(organizations).where(eq(organizations.id, orgId));
  if (!row) {
    throw new NotFoundError('organization', orgId);
  }
  return toOrganization(row);
}

/**
 * The turned-off functions to store from a change: every value must be an `OPTIONAL_FUNCTIONS` one
 * or already stored (a client sends back, as it found them, the values it does not know, such as a
 * function removed since); only the known ones are kept.
 */
function knownDisabledFunctions(sent: readonly string[], stored: readonly string[]): string[] {
  const known: readonly string[] = OPTIONAL_FUNCTIONS;
  const invalid = sent.findIndex((value) => !known.includes(value) && !stored.includes(value));
  if (invalid !== -1) {
    throw new ValidationError([
      { path: `settings.disabledFunctions.${invalid}`, message: 'Unknown function' },
    ]);
  }
  return sent.filter((value) => known.includes(value));
}

/**
 * PATCH of the current organization (`UpdateOrganizationSchema`). `settings` keys are merged into the
 * stored settings, and the result is validated with `OrganizationSettingsSchema`.
 */
export async function updateOrganization(
  tx: Tx,
  ctx: ActorContext,
  input: z.input<typeof UpdateOrganizationSchema>,
): Promise<Organization> {
  const patch = parseInput(UpdateOrganizationSchema, input);
  const [current] = await tx
    .select()
    .from(organizations)
    .where(eq(organizations.id, ctx.orgId))
    .for('update');
  if (!current) {
    throw new NotFoundError('organization', ctx.orgId);
  }
  const values: {
    name?: string;
    timezone?: string;
    locale?: Locale;
    settings?: Record<string, unknown>;
  } = {};
  if (patch.name !== undefined) values.name = patch.name;
  if (patch.timezone !== undefined) values.timezone = patch.timezone;
  if (patch.locale !== undefined) values.locale = patch.locale;
  if (patch.settings !== undefined) {
    const currentSettings = OrganizationSettingsSchema.parse(current.settings);
    const disabledFunctions =
      patch.settings.disabledFunctions === undefined
        ? {}
        : {
            disabledFunctions: knownDisabledFunctions(
              patch.settings.disabledFunctions,
              currentSettings.disabledFunctions,
            ),
          };
    values.settings = parseInput(OrganizationSettingsSchema, {
      ...currentSettings,
      ...patch.settings,
      ...disabledFunctions,
    });
  }
  if (Object.keys(values).length === 0) {
    return toOrganization(current);
  }
  const [row] = await tx
    .update(organizations)
    .set(values)
    .where(eq(organizations.id, ctx.orgId))
    .returning();
  if (!row) {
    throw new NotFoundError('organization', ctx.orgId);
  }
  await recordActivity(tx, ctx, {
    entityType: 'organization',
    entityId: ctx.orgId,
    eventType: 'organization.updated',
    payload: { changes: patch },
  });
  return toOrganization(row);
}

/**
 * Ids of every organization, in id order (fan-out of cron jobs: the worker opens withTenant for
 * each). Run in withSystem.
 */
export async function listOrganizationIds(systemTx: Tx): Promise<string[]> {
  const rows = await systemTx
    .select({ id: organizations.id })
    .from(organizations)
    .orderBy(asc(organizations.id));
  return rows.map((row) => row.id);
}
