import type { ZodError } from 'zod';

/**
 * Domain errors are HTTP-agnostic: modules throw them and the API maps `code` to an RFC 9457
 * problem (status, type, extension members). `code` is a stable machine-readable string that
 * clients may branch on; `message` is for logs and the problem `detail`, never for branching.
 */

export interface DomainErrorOptions {
  /** Extra machine-readable context (ids, current state, limits). Must be JSON-serializable. */
  details?: unknown;
  /** Underlying error, kept for logs (standard `Error.cause`). */
  cause?: unknown;
}

export class DomainError extends Error {
  override name = 'DomainError';
  readonly code: string;
  readonly details?: unknown;

  constructor(code: string, message: string, options: DomainErrorOptions = {}) {
    super(message, 'cause' in options ? { cause: options.cause } : undefined);
    this.code = code;
    if (options.details !== undefined) {
      this.details = options.details;
    }
  }
}

/**
 * The entity does not exist OR is not visible to the actor (another organization, outside the
 * actor's assigned scope). Never reveal which of the two it is.
 */
export class NotFoundError extends DomainError {
  override name = 'NotFoundError';
  declare readonly code: 'not_found';
  readonly entity: string;
  readonly id?: string;

  /** `entity` is a stable lowercase name such as `task` or `property`. */
  constructor(entity: string, id?: string, options: DomainErrorOptions = {}) {
    super('not_found', id === undefined ? `${entity} not found` : `${entity} ${id} not found`, {
      details: { entity, ...(id === undefined ? {} : { id }) },
      ...options,
    });
    this.entity = entity;
    if (id !== undefined) {
      this.id = id;
    }
  }
}

/** The actor is authenticated but lacks the permission (or feature entitlement) for the action. */
export class ForbiddenError extends DomainError {
  override name = 'ForbiddenError';
  declare readonly code: 'forbidden';

  constructor(message = 'Forbidden', options: DomainErrorOptions = {}) {
    super('forbidden', message, options);
  }
}

/** The request conflicts with the current state (concurrent modification, uniqueness violation). */
export class ConflictError extends DomainError {
  override name = 'ConflictError';
  declare readonly code: 'conflict';

  constructor(message: string, options: DomainErrorOptions = {}) {
    super('conflict', message, options);
  }
}

/** One invalid field. Same shape as the problem `errors[]` entries in @vime/contracts. */
export interface ValidationIssue {
  /** Dot-separated path to the invalid field (e.g. `items.0.zoneId`); empty string for the root. */
  path: string;
  message: string;
}

/** Input is malformed or violates a field-level rule. */
export class ValidationError extends DomainError {
  override name = 'ValidationError';
  declare readonly code: 'validation_failed';
  readonly issues: readonly ValidationIssue[];

  constructor(
    issues: readonly ValidationIssue[],
    message = 'Validation failed',
    options: DomainErrorOptions = {},
  ) {
    super('validation_failed', message, options);
    this.issues = issues;
  }

  /** Converts a Zod error (e.g. from parsing a jsonb settings column) into a ValidationError. */
  static fromZod(error: ZodError, message?: string): ValidationError {
    const issues = error.issues.map((issue) => ({
      path: issue.path.map((key) => (typeof key === 'symbol' ? key.toString() : key)).join('.'),
      message: issue.message,
    }));
    return new ValidationError(issues, message, { cause: error });
  }
}

/** One unmet requirement of a business guard, e.g. a required checklist item left unanswered. */
export interface MissingRequirement {
  /** Stable identifier of the requirement (e.g. a checklist `item_key`). */
  key: string;
  /** Stable machine-readable reason (e.g. `answer_required`, `photos_required`). */
  reason: string;
  /** Extra machine-readable context (e.g. `{ required: 2, confirmed: 1 }`). */
  details?: unknown;
}

/**
 * A business guard is not met: the request is well-formed but the entity is not in a state that
 * allows it (state machine transition, completion requirements such as missing checklist items).
 */
export class PreconditionFailedError extends DomainError {
  override name = 'PreconditionFailedError';
  declare readonly code: 'precondition_failed';
  readonly missing: readonly MissingRequirement[];

  constructor(
    message: string,
    missing: readonly MissingRequirement[] = [],
    options: DomainErrorOptions = {},
  ) {
    super('precondition_failed', message, options);
    this.missing = missing;
  }
}
