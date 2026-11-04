// `pnpm db:bootstrap`: creates or updates the roles, the database and the schema privileges.
import { bootstrapDatabase } from '../bootstrap';
import { loadRootEnvFile } from '../env';

loadRootEnvFile(import.meta.dirname);

try {
  await bootstrapDatabase();
  console.log('Bootstrap complete.');
} catch (error) {
  console.error('Bootstrap failed:', error);
  process.exitCode = 1;
}
