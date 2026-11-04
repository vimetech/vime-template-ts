// Vitest global setup: the worker tests need the bootstrapped roles, every migration applied and
// the pg-boss schema with its queues installed (`pnpm db:migrate`, which CI runs before the tests).
import { closeDb } from '@vime/db';
import {
  assertJobSchemaInstalled,
  assertMigrationsApplied,
  ensureDatabaseBootstrapped,
} from '@vime/db/testing';

export default async function setup(): Promise<void> {
  await ensureDatabaseBootstrapped();
  try {
    await assertMigrationsApplied();
    await assertJobSchemaInstalled();
  } finally {
    await closeDb();
  }
}
