/**
 * @vime/db/admin: the database steps of a release, as functions for deploy scripts (apps/api's
 * `release.ts`, Railway's pre-deploy command). The same code as `pnpm db:bootstrap` and
 * `pnpm db:migrate`; never imported by runtime code (api routes, worker jobs).
 *
 * - `bootstrapDatabase`: roles, database and schema privileges (superuser, DATABASE_URL_ADMIN).
 * - `migrateDatabase`: Drizzle migrations as vime_owner (DATABASE_URL_OWNER). A bundle must pass
 *   `migrationsFolder`: `MIGRATIONS_FOLDER` resolves next to this file's sources.
 * - `installJobSchema`: pg-boss schema, queues and grants (DATABASE_URL_OWNER).
 */
export { bootstrapDatabase, type BootstrapOptions } from './bootstrap';
export { MIGRATIONS_FOLDER, migrateDatabase, type MigrateOptions } from './migrate';
export {
  installJobSchema,
  type InstallJobSchemaOptions,
  type JobSchemaInstallResult,
} from './jobs/install';
