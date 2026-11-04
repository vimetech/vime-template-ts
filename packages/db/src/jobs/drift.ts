import type { JobQueueDefinition } from './queues';

/** The queue options pg-boss stores (`getQueue()`), as far as the catalog sets them. */
export interface StoredQueueOptions {
  policy?: string;
  retryLimit?: number;
  retryDelay?: number;
  retryBackoff?: boolean;
  retryDelayMax?: number | null;
  expireInSeconds?: number;
  retentionSeconds?: number;
  deleteAfterSeconds?: number;
}

const COMPARED = [
  'retryLimit',
  'retryDelay',
  'retryBackoff',
  'retryDelayMax',
  'expireInSeconds',
  'retentionSeconds',
  'deleteAfterSeconds',
] as const;

/**
 * Names of the options of a stored queue that differ from its catalog definition (`policy` is
 * reported too, although only a new queue can change it).
 */
export function queueDrift(stored: StoredQueueOptions, definition: JobQueueDefinition): string[] {
  const drift: string[] = [];
  if ((stored.policy ?? 'standard') !== definition.policy) {
    drift.push('policy');
  }
  for (const key of COMPARED) {
    if ((stored[key] ?? null) !== (definition[key] ?? null)) {
      drift.push(key);
    }
  }
  return drift;
}
