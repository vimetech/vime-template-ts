import { withSystem, withTenant } from '@vime/db';
import { JOB_QUEUE_NAMES } from '@vime/db/jobs';
import { listOrganizationIds, purgeIdempotencyKeys } from '@vime/platform';
import type { WorkerDeps } from '../deps';

/*
 * Cron handlers (no organization in the payload). They list the organizations with the system
 * role (sanctioned use of withSystem: job fan-out), then act per organization inside withTenant,
 * so every write passes RLS.
 *
 * A failure in one organization does not stop the others, and it does NOT fail the job: a pg-boss
 * retry would redo EVERY organization. Failed organizations are retried once inline, then logged
 * as errors; the job fails (and pg-boss retries it) only when every organization failed, i.e.
 * nothing was committed. The next run covers them.
 */

export const IDEMPOTENCY_KEY_RETENTION_DAYS = 30;
const DAY_MS = 86_400_000;

class FanoutError extends Error {
  override name = 'FanoutError';
}

/** Runs `fn` for every organization, as described above. */
export async function forEachOrganization(
  deps: WorkerDeps,
  job: string,
  orgIds: readonly string[],
  fn: (orgId: string) => Promise<void>,
): Promise<void> {
  const failed: string[] = [];
  for (const orgId of orgIds) {
    try {
      await fn(orgId);
    } catch (error) {
      failed.push(orgId);
      deps.logger.warn({ err: error, orgId, job }, 'fan-out failed for an organization; retrying');
    }
  }
  const stillFailed: string[] = [];
  for (const orgId of failed) {
    try {
      await fn(orgId);
    } catch (error) {
      stillFailed.push(orgId);
      deps.logger.error({ err: error, orgId, job }, 'fan-out failed for an organization');
    }
  }
  if (stillFailed.length > 0 && stillFailed.length === orgIds.length) {
    // Nothing was committed: a pg-boss retry duplicates nothing.
    throw new FanoutError(`${job} failed for every organization (${stillFailed.length})`);
  }
}

/** `platform.purge`: per organization, idempotency keys older than 30 days. */
export async function handlePurge(deps: WorkerDeps): Promise<{ idempotencyKeys: number }> {
  const keysBefore = new Date(deps.now().getTime() - IDEMPOTENCY_KEY_RETENTION_DAYS * DAY_MS);
  const orgIds = await withSystem((tx) => listOrganizationIds(tx));
  const totals = { idempotencyKeys: 0 };
  await forEachOrganization(deps, JOB_QUEUE_NAMES.platformPurge, orgIds, (orgId) =>
    withTenant({ orgId }, async (tx) => {
      totals.idempotencyKeys += await purgeIdempotencyKeys(tx, keysBefore);
    }),
  );
  return totals;
}
