import {
  PROBLEM_STATUS,
  ProblemDetailsSchema,
  type ProblemCode,
  type ProblemDetails,
  type ProblemFieldError,
} from '@vime/contracts';
import { DomainError, PreconditionFailedError, ValidationError } from '@vime/kernel';
import { pgError } from '@vime/platform';
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod';
import { errorReporter } from './error-reporting';

/*
 * RFC 9457 problem details (`application/problem+json`) for every error response of the API.
 * Clients branch on `code` (stable, from @vime/contracts PROBLEM_CODES), never on `title`/`detail`.
 */

export const PROBLEM_CONTENT_TYPE = 'application/problem+json; charset=utf-8';

/** Base of the problem `type` URIs: one stable URI per problem code. */
export const PROBLEM_TYPE_BASE = 'https://errors.vime.ops/';

const TITLES: Record<ProblemCode, string> = {
  validation_failed: 'The request is not valid',
  unauthenticated: 'Authentication required',
  forbidden: 'Not allowed',
  not_found: 'Not found',
  conflict: 'Conflict with the current state',
  feature_not_enabled: 'Feature not enabled for this organization',
  organization_suspended: 'Organization suspended',
  idempotency_conflict: 'Idempotency-Key reused with a different request',
  idempotency_in_progress: 'A request with this Idempotency-Key is in progress',
  precondition_failed: 'Requirements not met',
  rate_limited: 'Too many requests',
  app_version_unsupported: 'App version no longer supported',
  internal: 'Internal error',
};

function isProblemCode(code: string): code is ProblemCode {
  return Object.hasOwn(PROBLEM_STATUS, code);
}

export function problemType(code: string): string {
  return `${PROBLEM_TYPE_BASE}${code.replaceAll('_', '-')}`;
}

export interface ProblemInit {
  code: string;
  status?: number;
  detail?: string;
  errors?: ProblemFieldError[];
  /** Extension members (RFC 9457 §3.2). */
  extensions?: Record<string, unknown>;
}

/** Builds a problem body; `status` defaults to the code's default status. */
export function problem(request: FastifyRequest, init: ProblemInit): ProblemDetails {
  const known = isProblemCode(init.code);
  const status = init.status ?? (known ? PROBLEM_STATUS[init.code as ProblemCode] : 500);
  return {
    type: problemType(init.code),
    title: known ? TITLES[init.code as ProblemCode] : 'Request failed',
    status,
    ...(init.detail === undefined ? {} : { detail: init.detail }),
    instance: request.url.split('?')[0] ?? request.url,
    code: init.code,
    ...(init.errors === undefined ? {} : { errors: init.errors }),
    ...init.extensions,
    requestId: request.id,
  };
}

export function sendProblem(
  request: FastifyRequest,
  reply: FastifyReply,
  init: ProblemInit,
): FastifyReply {
  const body = problem(request, init);
  return reply.code(body.status).type(PROBLEM_CONTENT_TYPE).send(body);
}

// ---------------------------------------------------------------------------
// HTTP-level errors (the kernel's DomainErrors cover the domain cases)
// ---------------------------------------------------------------------------

/** No valid session (or a revoked device). 401 `unauthenticated`. */
export class UnauthenticatedError extends DomainError {
  override name = 'UnauthenticatedError';
  declare readonly code: 'unauthenticated';

  constructor(message = 'Sign in to continue') {
    super('unauthenticated', message);
  }
}

/** The organization does not have the feature entitlement. 403 `feature_not_enabled`. */
export class FeatureNotEnabledError extends DomainError {
  override name = 'FeatureNotEnabledError';
  declare readonly code: 'feature_not_enabled';

  constructor(feature: string) {
    super('feature_not_enabled', `The ${feature} feature is not enabled for this organization`, {
      details: { feature },
    });
  }
}

/**
 * The platform suspended the organization (ADR 0015). 403 `organization_suspended`, only to its
 * members and support: anyone else gets the usual 404.
 */
export class OrganizationSuspendedError extends DomainError {
  override name = 'OrganizationSuspendedError';
  declare readonly code: 'organization_suspended';

  constructor() {
    super('organization_suspended', 'This organization is suspended. Contact VIME.');
  }
}

/** Thrown by @fastify/rate-limit's errorResponseBuilder. 429 `rate_limited`. */
export class RateLimitedError extends DomainError {
  override name = 'RateLimitedError';
  declare readonly code: 'rate_limited';

  constructor(retryAfterSeconds: number) {
    super('rate_limited', `Too many requests. Retry in ${retryAfterSeconds} seconds.`, {
      details: { retryAfterSeconds },
    });
  }
}

// ---------------------------------------------------------------------------
// Error → problem mapping
// ---------------------------------------------------------------------------

/** Unknown DomainError codes (module-specific business rules) default to 422. */
const UNKNOWN_DOMAIN_CODE_STATUS = 422;

function domainProblem(error: DomainError): ProblemInit {
  const status = isProblemCode(error.code)
    ? PROBLEM_STATUS[error.code]
    : UNKNOWN_DOMAIN_CODE_STATUS;
  const init: ProblemInit = { code: error.code, status, detail: error.message };
  if (error instanceof ValidationError) {
    init.errors = error.issues.map((issue) => ({ path: issue.path, message: issue.message }));
  } else if (error instanceof PreconditionFailedError) {
    init.extensions = { missing: error.missing };
  } else if (error.details !== undefined) {
    init.extensions = { details: error.details };
  }
  return init;
}

/** Request-validation errors from the Zod validator compiler (body, params, query, headers). */
function schemaValidationProblem(
  error: FastifyError & { validationContext?: string },
): ProblemInit {
  const context = error.validationContext;
  const errors = (error.validation ?? []).map((issue) => {
    const field = issue.instancePath.replace(/^\//, '').replaceAll('/', '.');
    // Body fields keep their plain path (same as service-level ValidationErrors); other parts are
    // prefixed: `query.limit`, `params.orgId`, `headers.idempotency-key`.
    const prefix =
      context && context !== 'body' ? (context === 'querystring' ? 'query' : context) : '';
    const path = [prefix, field].filter(Boolean).join('.');
    return { path, message: issue.message ?? 'Invalid value' };
  });
  return { code: 'validation_failed', status: 400, detail: 'The request is not valid', errors };
}

/** Problem code for a bare HTTP status (framework and Better Auth errors). */
export function codeForStatus(status: number): ProblemCode {
  switch (status) {
    case 401:
      return 'unauthenticated';
    case 403:
      return 'forbidden';
    case 404:
      return 'not_found';
    case 409:
      return 'conflict';
    case 429:
      return 'rate_limited';
    default:
      return status >= 500 ? 'internal' : 'validation_failed';
  }
}

/**
 * Maps any thrown error to a problem. Domain and validation errors keep their message; framework
 * 4xx errors (malformed JSON, unsupported media type, body too large) keep Fastify's message;
 * everything else is a 500 whose detail never reveals internals (the error is logged instead).
 */
export function problemForError(error: unknown): ProblemInit & { internal: boolean } {
  if (error instanceof DomainError) {
    return { ...domainProblem(error), internal: false };
  }
  if (hasZodFastifySchemaValidationErrors(error)) {
    return { ...schemaValidationProblem(error), internal: false };
  }
  const sqlState = pgError(error)?.code;
  if (sqlState === '40P01' || sqlState === '40001') {
    // Deadlock or serialization failure: the transaction was rolled back and can be retried.
    // Services order their locks to avoid these; this is the safety net.
    return {
      code: 'conflict',
      status: 409,
      detail: 'The request conflicted with a concurrent change. Retry it.',
      internal: false,
    };
  }
  const fastifyError = error as Partial<FastifyError>;
  const status = fastifyError.statusCode;
  if (typeof status === 'number' && status >= 400 && status < 500) {
    const init: ProblemInit = { code: codeForStatus(status), status };
    if (typeof fastifyError.message === 'string') init.detail = fastifyError.message;
    return { ...init, internal: false };
  }
  return {
    code: 'internal',
    status: 500,
    detail: 'An unexpected error occurred. Quote the requestId when reporting it.',
    internal: true,
  };
}

/**
 * Fastify error handler: every error becomes problem+json. Returns nothing: Fastify would send a
 * returned value again.
 */
export function errorHandler(
  error: FastifyError,
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  const { internal, ...init } = problemForError(error);
  if (internal || (init.status ?? 400) >= 500) {
    request.log.error({ err: error }, internal ? 'unhandled error' : 'request failed');
    const params = request.params as Record<string, unknown> | undefined;
    errorReporter().capture(error, {
      method: request.method,
      route: request.routeOptions.url,
      request_id: request.id,
      org_id: typeof params?.['orgId'] === 'string' ? params['orgId'] : undefined,
    });
  } else {
    request.log.info({ code: init.code, status: init.status }, 'request rejected');
  }
  if (error instanceof RateLimitedError) {
    const details = error.details as { retryAfterSeconds: number };
    reply.header('retry-after', String(details.retryAfterSeconds));
  }
  if (init.code === 'unauthenticated') {
    reply.header('www-authenticate', 'Bearer');
  }
  sendProblem(request, reply, init);
}

/** Not-found handler: unknown routes get the same 404 problem as missing entities. */
export function notFoundHandler(request: FastifyRequest, reply: FastifyReply): FastifyReply {
  return sendProblem(request, reply, {
    code: 'not_found',
    detail: `No route for ${request.method} ${request.url.split('?')[0] ?? ''}`,
  });
}

/** OpenAPI description of problem responses (`4xx`/`5xx` on every route). */
export const problemResponses = {
  '4xx': {
    description: 'Problem details (RFC 9457). Branch on `code`.',
    content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
  },
  '5xx': {
    description: 'Problem details (RFC 9457) with code `internal`.',
    content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
  },
} as const;
