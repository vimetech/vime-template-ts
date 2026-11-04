import {
  MissingRequirementSchema,
  ProblemDetailsSchema,
  type MissingRequirement,
  type ProblemFieldError,
} from '@vime/contracts';
import { z } from 'zod';

/*
 * Typed client of the VIME API (REST /v1, problem+json errors). Every response is parsed with the
 * @vime/contracts Zod schema of its route; a mismatch is a contract bug and fails loudly in
 * development. Mutations carry an Idempotency-Key that is generated once per mutation call and
 * reused by the automatic retries of that same call, so a retry after a lost response never
 * applies the change twice.
 */

/** Pseudo problem codes for failures that never produced a problem+json response. */
export const NETWORK_PROBLEM = 'network';
export const UNKNOWN_PROBLEM = 'unknown';

/** An error response of the API (RFC 9457), or a network failure (`code: 'network'`). */
export class ApiProblem extends Error {
  override name = 'ApiProblem';
  /** HTTP status; 0 for network failures. */
  readonly status: number;
  /** Stable machine code (`PROBLEM_CODES`, or `network` / `unknown`). Branch on this. */
  readonly code: string;
  readonly title: string;
  readonly detail: string | undefined;
  /** Field errors of a `validation_failed` problem (`path` is dot-separated). */
  readonly errors: ProblemFieldError[];
  /** Unmet requirements of a `precondition_failed` problem (e.g. checklist items). */
  readonly missing: MissingRequirement[];
  readonly requestId: string | undefined;
  /** The raw problem body, for extension members (`details`, `minVersion`...). */
  readonly body: Record<string, unknown> | null;

  constructor(init: {
    status: number;
    code: string;
    title: string;
    detail?: string | undefined;
    errors?: ProblemFieldError[];
    missing?: MissingRequirement[];
    requestId?: string | undefined;
    body?: Record<string, unknown> | null;
    cause?: unknown;
  }) {
    super(init.detail ?? init.title, init.cause === undefined ? undefined : { cause: init.cause });
    this.status = init.status;
    this.code = init.code;
    this.title = init.title;
    this.detail = init.detail;
    this.errors = init.errors ?? [];
    this.missing = init.missing ?? [];
    this.requestId = init.requestId;
    this.body = init.body ?? null;
  }
}

/** A response that does not match its contracts schema (API and client out of sync). */
export class ApiContractError extends Error {
  override name = 'ApiContractError';
  constructor(
    readonly path: string,
    readonly issues: z.core.$ZodIssue[],
  ) {
    super(
      `Response of ${path} does not match its contract: ${issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ')}`,
    );
  }
}

export function isApiProblem(error: unknown): error is ApiProblem {
  return error instanceof ApiProblem;
}

/** Builds an `ApiProblem` from an error response (problem+json or anything else). */
export function problemFromBody(status: number, body: unknown, statusText = ''): ApiProblem {
  const parsed = ProblemDetailsSchema.safeParse(body);
  if (parsed.success) {
    const problem = parsed.data;
    const missing = z.array(MissingRequirementSchema).safeParse(problem['missing']);
    const requestId = problem['requestId'];
    return new ApiProblem({
      status: problem.status,
      code: problem.code,
      title: problem.title,
      detail: problem.detail,
      errors: problem.errors ?? [],
      missing: missing.success ? missing.data : [],
      requestId: typeof requestId === 'string' ? requestId : undefined,
      body: problem,
    });
  }
  return new ApiProblem({
    status,
    code: UNKNOWN_PROBLEM,
    title: statusText || `HTTP ${status}`,
    body: body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : null,
  });
}

export type QueryValue = string | number | boolean | null | undefined;
export type QueryParams = Record<string, QueryValue>;

export type MutationMethod = 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface RetryPolicy {
  /** Total attempts of one mutation call, the first included. */
  attempts: number;
  /** Delay before the 2nd attempt; doubled for each later one. */
  baseDelayMs: number;
}

export interface ApiClientConfig {
  /** Base URL of the API: `/api` behind the dev proxy, or an absolute URL. */
  baseUrl: string;
  /** Sent as `X-App-Version`. */
  appVersion: string;
  fetch?: typeof fetch;
  /** Throw `ApiContractError` when a response does not match its schema (default: true). */
  strict?: boolean;
  /** Idempotency-Key generator (default: `crypto.randomUUID`). */
  newIdempotencyKey?: () => string;
  retry?: RetryPolicy;
  sleep?: (ms: number) => Promise<void>;
  /** Called for contract mismatches when not strict (logging). */
  onContractMismatch?: (error: ApiContractError) => void;
}

export interface GetOptions {
  query?: QueryParams;
  signal?: AbortSignal;
}

export interface MutateOptions<S extends z.ZodType | null> {
  /** JSON body; with `contentType`, a string sent as-is. */
  body?: unknown;
  /**
   * Send `body` (a string) as-is with this Content-Type instead of JSON, e.g. a CSV import as
   * `text/csv` (the API accepts larger CSV bodies than JSON ones).
   */
  contentType?: string;
  /** Response schema; `null` for responses without a body (204). */
  schema: S;
  query?: QueryParams;
  signal?: AbortSignal;
  /** Use this key instead of a new one (e.g. a caller-level retry of the same intent). */
  idempotencyKey?: string;
}

export type ConditionalResult<T> =
  { notModified: true } | { notModified: false; data: T; etag: string | null };

export interface Download {
  blob: Blob;
  filename: string | null;
}

/** Statuses after which the same request may be retried safely (same Idempotency-Key). */
const RETRYABLE_STATUSES = new Set([502, 503, 504]);

const DEFAULT_RETRY: RetryPolicy = { attempts: 3, baseDelayMs: 400 };

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

/** `Content-Disposition: attachment; filename="x.csv"` → `x.csv`. */
export function filenameFromDisposition(header: string | null): string | null {
  if (!header) return null;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (star?.[1]) return decodeURIComponent(star[1]);
  const plain = /filename="?([^";]+)"?/i.exec(header);
  return plain?.[1] ?? null;
}

export type ApiClient = ReturnType<typeof createApiClient>;

export function createApiClient(config: ApiClientConfig) {
  const doFetch = config.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const strict = config.strict ?? true;
  const newKey = config.newIdempotencyKey ?? (() => crypto.randomUUID());
  const retry = config.retry ?? DEFAULT_RETRY;
  const sleep = config.sleep ?? defaultSleep;
  const base = config.baseUrl.replace(/\/+$/, '');

  function url(path: string, query?: QueryParams): string {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined || value === null || value === '') continue;
      search.set(key, String(value));
    }
    const qs = search.toString();
    return `${base}${path}${qs ? `?${qs}` : ''}`;
  }

  function headers(extra?: Record<string, string>): Headers {
    const result = new Headers({ Accept: 'application/json', 'X-App-Version': config.appVersion });
    for (const [name, value] of Object.entries(extra ?? {})) result.set(name, value);
    return result;
  }

  async function send(input: string, init: RequestInit): Promise<Response> {
    try {
      return await doFetch(input, { credentials: 'include', ...init });
    } catch (error) {
      if (isAbort(error)) throw error;
      throw new ApiProblem({
        status: 0,
        code: NETWORK_PROBLEM,
        title: 'Network error',
        detail: error instanceof Error ? error.message : undefined,
        cause: error,
      });
    }
  }

  async function readBody(response: Response): Promise<unknown> {
    if (response.status === 204 || response.status === 304) return null;
    const text = await response.text();
    if (text === '') return null;
    const type = response.headers.get('content-type') ?? '';
    if (type.includes('json')) {
      try {
        return JSON.parse(text) as unknown;
      } catch {
        return text;
      }
    }
    return text;
  }

  async function failure(response: Response): Promise<ApiProblem> {
    return problemFromBody(response.status, await readBody(response), response.statusText);
  }

  function validate<S extends z.ZodType>(path: string, schema: S, body: unknown): z.output<S> {
    const parsed = schema.safeParse(body);
    if (parsed.success) return parsed.data;
    const error = new ApiContractError(path, parsed.error.issues);
    if (strict) throw error;
    config.onContractMismatch?.(error);
    return body as z.output<S>;
  }

  async function get<S extends z.ZodType>(
    path: string,
    schema: S,
    options: GetOptions = {},
  ): Promise<z.output<S>> {
    const response = await send(url(path, options.query), {
      method: 'GET',
      headers: headers(),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (!response.ok) throw await failure(response);
    return validate(path, schema, await readBody(response));
  }

  /**
   * GET with `If-None-Match`: a 304 means "nothing changed, keep what you have". The browser cache
   * is bypassed (`no-store`) so the 304 reaches us instead of being turned into a cached 200.
   */
  async function getConditional<S extends z.ZodType>(
    path: string,
    schema: S,
    options: GetOptions & { etag?: string | null } = {},
  ): Promise<ConditionalResult<z.output<S>>> {
    const response = await send(url(path, options.query), {
      method: 'GET',
      cache: 'no-store',
      headers: headers(options.etag ? { 'If-None-Match': options.etag } : undefined),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (response.status === 304) return { notModified: true };
    if (!response.ok) throw await failure(response);
    return {
      notModified: false,
      data: validate(path, schema, await readBody(response)),
      etag: response.headers.get('etag'),
    };
  }

  /**
   * A mutation. One Idempotency-Key per call: network failures, 502/503/504 and
   * `idempotency_in_progress` are retried with the SAME key (the server replays the stored
   * response if the first attempt went through); any other error is thrown at once.
   */
  async function mutate<S extends z.ZodType | null>(
    method: MutationMethod,
    path: string,
    options: MutateOptions<S>,
  ): Promise<S extends z.ZodType ? z.output<S> : null> {
    const key = options.idempotencyKey ?? newKey();
    const hasBody = options.body !== undefined;
    const raw = options.contentType !== undefined;
    if (raw && hasBody && typeof options.body !== 'string') {
      throw new TypeError('A body with a contentType must be a string');
    }
    const payload = raw ? (options.body as string) : JSON.stringify(options.body);
    let attempt = 0;
    for (;;) {
      attempt += 1;
      let retryable: ApiProblem;
      try {
        const response = await send(url(path, options.query), {
          method,
          headers: headers({
            'Idempotency-Key': key,
            ...(hasBody ? { 'Content-Type': options.contentType ?? 'application/json' } : {}),
          }),
          ...(hasBody ? { body: payload } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
        });
        if (response.ok) {
          const body = await readBody(response);
          return (options.schema === null ? null : validate(path, options.schema, body)) as never;
        }
        const problem = await failure(response);
        const inProgress = problem.code === 'idempotency_in_progress';
        if (!RETRYABLE_STATUSES.has(response.status) && !inProgress) throw problem;
        retryable = problem;
      } catch (error) {
        if (!(error instanceof ApiProblem) || error.code !== NETWORK_PROBLEM) throw error;
        retryable = error;
      }
      if (attempt >= retry.attempts || options.signal?.aborted) throw retryable;
      await sleep(retry.baseDelayMs * 2 ** (attempt - 1));
    }
  }

  /** A file download (CSV export) with the session cookie. */
  async function download(path: string, options: GetOptions = {}): Promise<Download> {
    const response = await send(url(path, options.query), {
      method: 'GET',
      headers: headers({ Accept: 'text/csv, application/problem+json' }),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (!response.ok) throw await failure(response);
    return {
      blob: await response.blob(),
      filename: filenameFromDisposition(response.headers.get('content-disposition')),
    };
  }

  return { url, get, getConditional, mutate, download };
}
