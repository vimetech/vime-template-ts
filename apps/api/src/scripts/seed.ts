/*
 * Development seed (`pnpm db:seed`). Idempotent: run it as often as you like; it only creates what
 * is missing (users by email, organizations by slug, notes by title) and resets the seed users'
 * passwords to SEED_OWNER_PASSWORD.
 *
 * - "Acme" (slug acme, America/Lima, es-PE): the `example` feature enabled; an owner and a
 *   manager; a handful of example notes.
 * - "Acme Norte" (slug acme-norte): a second organization with the same owner, so the organization
 *   switcher has two entries.
 *
 * A project extends this with its own domain data (see modules/example for the shape of a module).
 * Refuses to run with NODE_ENV=production.
 */
import type { RoleKey } from '@vime/contracts';
import { closeDb, withSystem, withTenant } from '@vime/db';
import { createNote, listNotes } from '@vime/example';
import {
  addMembership,
  createOrganization,
  organizationCanUseFeature,
  setEntitlement,
  systemActor,
  type ActorContext,
} from '@vime/platform';
import { memberships, organizations } from '@vime/platform/schema';
import { and, eq } from 'drizzle-orm';
import { createAuth } from '../auth/auth';
import { ensureCredentialUser } from '../auth/users';
import { loadEnv } from '../env';

const DEFAULT_PASSWORD = 'vime-dev-password';
const TIMEZONE = 'America/Lima';

interface OrgSeed {
  name: string;
  slug: string;
  notes: readonly { title: string; body: string }[];
}

function log(message: string): void {
  console.log(`[seed] ${message}`);
}

async function ensureOrganization(seed: OrgSeed, ownerUserId: string): Promise<string> {
  const existing = await withSystem(async (tx) => {
    const [row] = await tx
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.slug, seed.slug));
    return row?.id ?? null;
  });
  if (existing) {
    log(`organization ${seed.slug} exists`);
    return existing;
  }
  const org = await withSystem((tx) =>
    createOrganization(
      tx,
      { name: seed.name, slug: seed.slug, timezone: TIMEZONE, locale: 'es-PE' },
      { ownerUserId },
    ),
  );
  log(`organization ${seed.slug} created`);
  return org.id;
}

/** Adds the membership when the user has none here, whatever its status (a suspended one stays). */
async function ensureMembership(orgId: string, userId: string, roleKeys: RoleKey[]) {
  const actor = systemActor(orgId);
  await withTenant({ orgId }, async (tx) => {
    const [existing] = await tx
      .select({ status: memberships.status })
      .from(memberships)
      .where(and(eq(memberships.organizationId, orgId), eq(memberships.userId, userId)));
    if (existing) {
      if (existing.status !== 'active') {
        log(`membership ${roleKeys.join(',')} exists but is ${existing.status}; left as is`);
      }
      return;
    }
    await addMembership(tx, actor, { userId, roleKeys });
    log(`membership ${roleKeys.join(',')} added`);
  });
}

/** Turns the `example` feature on when the organization cannot use it yet. */
async function ensureExampleFeature(orgId: string): Promise<void> {
  await withSystem(async (tx) => {
    if (await organizationCanUseFeature(tx, orgId, 'example')) {
      log('feature example enabled');
      return;
    }
    await setEntitlement(tx, systemActor(orgId), { featureKey: 'example', enabled: true });
    log('feature example turned on');
  });
}

/** The seed notes, matched by title; the rest are left alone. */
async function ensureNotes(orgId: string, ownerUserId: string, seed: OrgSeed): Promise<void> {
  const actor: ActorContext = { ...systemActor(orgId), userId: ownerUserId };
  await withTenant({ orgId, userId: ownerUserId }, async (tx) => {
    const existing = new Set(
      (await listNotes(tx, orgId, { limit: 200 })).items.map((n) => n.title),
    );
    let created = 0;
    for (const note of seed.notes) {
      if (existing.has(note.title)) continue;
      await createNote(tx, actor, note);
      created += 1;
    }
    log(`${seed.slug}: ${seed.notes.length} notes (${created} created)`);
  });
}

async function main(): Promise<void> {
  const env = loadEnv();
  if (env.NODE_ENV === 'production') {
    throw new Error('Refusing to seed with NODE_ENV=production.');
  }
  const password = process.env['SEED_OWNER_PASSWORD'] || DEFAULT_PASSWORD;
  const auth = createAuth({ env });
  const store = await auth.$context;

  const owner = await ensureCredentialUser(store, {
    email: 'owner@acme.test',
    name: 'Valeria Ríos',
    password,
  });
  const manager = await ensureCredentialUser(store, {
    email: 'manager@acme.test',
    name: 'Diego Paredes',
    password,
  });
  log(
    `users ready (owner ${owner.created ? 'created' : 'exists'}, manager ${manager.created ? 'created' : 'exists'})`,
  );

  const seeds: OrgSeed[] = [
    {
      name: 'Acme',
      slug: 'acme',
      notes: [
        { title: 'Bienvenida', body: 'Esta es la primera nota de la organización.' },
        { title: 'Pendientes de la semana', body: 'Revisar los accesos del equipo.' },
        { title: 'Ideas', body: '' },
      ],
    },
    {
      name: 'Acme Norte',
      slug: 'acme-norte',
      notes: [{ title: 'Bienvenida', body: 'Segunda organización del mismo dueño.' }],
    },
  ];

  const orgIds: Record<string, string> = {};
  for (const seed of seeds) {
    const orgId = await ensureOrganization(seed, owner.user.id);
    orgIds[seed.slug] = orgId;
    await ensureMembership(orgId, owner.user.id, ['owner']);
    await ensureExampleFeature(orgId);
    await ensureNotes(orgId, owner.user.id, seed);
  }
  await ensureMembership(orgIds['acme'] as string, manager.user.id, ['manager']);

  console.log(`
Seed complete. Sign in at ${env.WEB_ORIGIN} (API ${env.API_PUBLIC_URL}):

  Owner (Acme + Acme Norte)  owner@acme.test   / ${password}
  Manager (Acme)             manager@acme.test / ${password}

  Acme       ${orgIds['acme']}
  Acme Norte ${orgIds['acme-norte']}

More members: POST /v1/orgs/<orgId>/invitations { "roleKeys": ["member"], "email": "..." },
then «¿Te invitaron por correo?» on the sign-in page (or POST /auth/invite/redeem).
`);
}

main()
  .then(() => closeDb())
  .catch(async (error: unknown) => {
    console.error(error);
    await closeDb();
    process.exitCode = 1;
  });
