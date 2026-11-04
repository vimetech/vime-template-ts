// `pnpm db:migrate`: applies pending migrations from packages/db/migrations as vime_owner, then
// installs or upgrades the pg-boss schema, its queues and its grants (also as vime_owner).
import { loadRootEnvFile } from '../env';
import { installJobSchema } from '../jobs/install';
import { migrateDatabase } from '../migrate';

loadRootEnvFile(import.meta.dirname);

try {
  await migrateDatabase();
  await installJobSchema();
} catch (error) {
  console.error('Migration failed:', error);
  process.exitCode = 1;
}
