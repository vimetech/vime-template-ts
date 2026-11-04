/**
 * @vime/worker: the jobs composition root. `main.ts` is the process entry point; these exports let
 * tests and scripts run handlers directly.
 */
export { isFinalAttempt, SINGLE_ATTEMPT, type JobAttempt, type WorkerDeps } from './deps';
export { loadWorkerEnv, WorkerEnvSchema, type WorkerEnv } from './env';
export {
  handleNoteCreated,
  NoteCreatedJobDataSchema,
  type NoteCreatedJobResult,
} from './handlers/example';
export { InvalidJobPayloadError, parsePayload } from './handlers/payload';
export { forEachOrganization, handlePurge, IDEMPOTENCY_KEY_RETENTION_DAYS } from './handlers/purge';
export {
  CRON_SCHEDULES,
  JOB_HANDLERS,
  registerSchedules,
  registerWorkers,
  runJob,
  type CronSchedule,
  type JobHandler,
} from './jobs';
export { createLogger, silentLogger, type Logger } from './logger';
