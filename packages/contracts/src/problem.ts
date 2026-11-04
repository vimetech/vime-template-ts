import { z } from 'zod';

/**
 * Stable machine-readable problem codes. Clients branch on `code`, never on `title` or `detail`.
 * New codes may be added over time; old mobile builds must tolerate unknown codes, which is why
 * `ProblemDetailsSchema.code` is a plain string and not this enum.
 */
export const PROBLEM_CODES = [
  'validation_failed',
  'unauthenticated',
  'forbidden',
  'not_found',
  'conflict',
  'feature_not_enabled',
  'organization_suspended',
  'idempotency_conflict',
  'idempotency_in_progress',
  'precondition_failed',
  'rate_limited',
  'app_version_unsupported',
  'internal',
] as const;
export const ProblemCodeSchema = z.enum(PROBLEM_CODES);
export type ProblemCode = z.infer<typeof ProblemCodeSchema>;

/**
 * Default HTTP status for each problem code.
 * - `forbidden` / `feature_not_enabled`: missing permission / entitlement off (both 403).
 * - `organization_suspended`: the platform suspended the organization; nobody can use it (403).
 * - `not_found`: does not exist OR is not visible to the actor (other org, outside `.assigned` scope).
 * - `conflict`: concurrent modification or uniqueness violation.
 * - `idempotency_conflict`: same `Idempotency-Key` with a different request body.
 * - `idempotency_in_progress`: same `Idempotency-Key` while the first request is still running.
 * - `precondition_failed`: business guard not met (state machine transition, completion requirements).
 * - `app_version_unsupported`: `X-App-Version` below the minimum supported version.
 */
export const PROBLEM_STATUS = {
  validation_failed: 400,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  feature_not_enabled: 403,
  organization_suspended: 403,
  idempotency_conflict: 409,
  idempotency_in_progress: 409,
  precondition_failed: 422,
  rate_limited: 429,
  app_version_unsupported: 426,
  internal: 500,
} as const satisfies Record<ProblemCode, number>;

export const ProblemFieldErrorSchema = z.object({
  /** Dot-separated path to the invalid field (e.g. `items.0.zoneId`); empty for the root. */
  path: z.string(),
  message: z.string(),
});
export type ProblemFieldError = z.infer<typeof ProblemFieldErrorSchema>;

/**
 * One unmet requirement of a business guard (same shape as the kernel's `MissingRequirement`):
 * the entries of the `missing` extension of a `precondition_failed` problem (e.g. a task that
 * cannot be completed yet) and of the checklist view. `reason` is a plain string so that old
 * mobile builds tolerate new reasons; the known ones are `COMPLETION_MISSING_REASONS`.
 */
export const MissingRequirementSchema = z.object({
  /** Stable identifier of the requirement, e.g. a checklist `itemKey`. */
  key: z.string(),
  /** Stable machine-readable reason, e.g. `answer_required` or `photos_required`. */
  reason: z.string(),
  /** Extra machine-readable context, e.g. `{ required: 2, confirmed: 1 }`. */
  details: z.unknown().optional(),
});
export type MissingRequirement = z.infer<typeof MissingRequirementSchema>;

/**
 * RFC 9457 problem details (`application/problem+json`). Extension members beyond the listed ones
 * are allowed (e.g. `missing` items for a failed completion, `minVersion` for an outdated app).
 */
export const ProblemDetailsSchema = z.looseObject({
  type: z.string(),
  title: z.string(),
  status: z.number().int().min(100).max(599),
  detail: z.string().optional(),
  instance: z.string().optional(),
  code: z.string(),
  errors: z.array(ProblemFieldErrorSchema).optional(),
});
export type ProblemDetails = z.infer<typeof ProblemDetailsSchema>;
