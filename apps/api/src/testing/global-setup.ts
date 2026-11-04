// Vitest global setup: the integration tests need the bootstrapped roles and every migration in
// packages/db/migrations applied (`pnpm db:migrate`, which CI runs before the tests), with an
// applied history that still matches the journal.
import { closeDb } from '@vime/db';
import { assertMigrationsApplied, ensureDatabaseBootstrapped } from '@vime/db/testing';

export default async function setup(): Promise<void> {
  await ensureDatabaseBootstrapped();
  try {
    await assertMigrationsApplied();
  } finally {
    await closeDb();
  }
}
