import type { ActivitySource } from '@vime/contracts';

/**
 * Who is doing a write, and where the request came from. Every mutating service takes one: it
 * names the organization (the same one as the surrounding withTenant transaction) and carries the
 * ADR 012 audit fields that `recordActivity` stores with each activity event.
 */
export interface ActorContext {
  /** Organization of the work. Must be the organization of the withTenant transaction. */
  orgId: string;
  source: ActivitySource;
  userId?: string | null;
  requestId?: string | null;
  idempotencyKey?: string | null;
  /** Raw device clock of the action (offline replays). */
  clientOccurredAt?: Date | null;
  /** Skew-corrected instant of the action (see `skewCorrectedOccurredAt`); defaults to now. */
  occurredAt?: Date | null;
}

/** Context for work done by the system itself (jobs, derivations, platform administration). */
export function systemActor(orgId: string, source: ActivitySource = 'system'): ActorContext {
  return { orgId, source };
}
