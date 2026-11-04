/**
 * @vime/db/jobs: pg-boss (ADR 006). The queue catalog, the schema installer that `pnpm db:migrate`
 * runs, and the runtime pieces of the composition roots: `startJobBoss` and `PgBossJobDispatcher`.
 * Only apps/api, apps/worker and this package's scripts import it; modules depend on the
 * `JobDispatcher` port of the main entry point (`@vime/db`) instead.
 */
export {
  HOLD_QUEUED_JOB_FUNCTION,
  JOB_SCHEMA,
  JOB_QUEUES,
  JOB_QUEUE_NAMES,
  jobQueue,
  queueOptions,
  type JobQueueDefinition,
  type JobQueueName,
  type JobQueuePolicy,
} from './queues';
export { queueDrift, type StoredQueueOptions } from './drift';
export {
  installJobSchema,
  jobSchemaFunctionStatements,
  jobSchemaGrantStatements,
  jobSchemaTargetVersion,
  splitMigrationPlan,
  type InstallJobSchemaOptions,
  type JobSchemaInstallResult,
} from './install';
export {
  PgBossJobDispatcher,
  checkJobQueues,
  createJobBoss,
  startJobBoss,
  type JobBossMode,
  type JobBossOptions,
  type QueueCheck,
} from './runtime';
export type { JobData, JobDispatcher, JobRequest } from './types';
