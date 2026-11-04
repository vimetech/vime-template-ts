// Vitest global setup for @vime/db: creates the roles and database when they are missing
// (requires DATABASE_URL_ADMIN). In CI, `pnpm db:bootstrap` has already run, so this only checks.
import { ensureDatabaseBootstrapped } from '../bootstrap';

export default async function setup(): Promise<void> {
  await ensureDatabaseBootstrapped();
}
