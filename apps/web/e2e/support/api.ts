import { randomUUID } from 'node:crypto';
import type { APIRequestContext, APIResponse } from '@playwright/test';
import type { z } from 'zod';

/*
 * Thin client of the VIME API for test setup.
 * Paths go through the web app's `/api` proxy, like the browser's. Every response body is parsed
 * with the @vime/contracts schema of the endpoint, so a contract drift fails the test loudly.
 */

type Query = Record<string, string | number | boolean | undefined>;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    request: string,
  ) {
    super(`${request} → ${status}: ${body}`);
    this.name = 'ApiError';
  }
}

export class VimeApi {
  constructor(private readonly context: APIRequestContext) {}

  async get<S extends z.ZodType>(path: string, schema: S, query?: Query): Promise<z.output<S>> {
    const response = await this.context.get(apiPath(path), { params: definedOnly(query) });
    return parse(response, schema, `GET ${path}`);
  }

  /** A mutation with a fresh Idempotency-Key, as the apps send them. */
  async mutate<S extends z.ZodType>(
    method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    schema: S,
    body?: unknown,
  ): Promise<z.output<S>> {
    const response = await this.context.fetch(apiPath(path), {
      method,
      headers: { 'idempotency-key': randomUUID() },
      ...(body === undefined ? {} : { data: body }),
    });
    return parse(response, schema, `${method} ${path}`);
  }

  /** The raw response of a POST (for endpoints outside /v1, e.g. Better Auth). */
  post(path: string, body: unknown): Promise<APIResponse> {
    return this.context.post(apiPath(path), {
      headers: { 'idempotency-key': randomUUID() },
      data: body,
    });
  }
}

/** `/v1/me` → `/api/v1/me` (the web's proxy prefix). */
export function apiPath(path: string): string {
  return `/api${path.startsWith('/') ? path : `/${path}`}`;
}

/** `/v1/orgs/<orgId><path>`. */
export function orgPath(orgId: string, path: string): string {
  return `/v1/orgs/${orgId}${path}`;
}

function definedOnly(query: Query | undefined): Record<string, string | number | boolean> {
  return Object.fromEntries(
    Object.entries(query ?? {}).filter(
      (entry): entry is [string, string | number | boolean] => entry[1] !== undefined,
    ),
  );
}

async function parse<S extends z.ZodType>(
  response: APIResponse,
  schema: S,
  request: string,
): Promise<z.output<S>> {
  const text = await response.text();
  if (!response.ok()) throw new ApiError(response.status(), text, request);
  const result = schema.safeParse(text === '' ? undefined : JSON.parse(text));
  if (!result.success) {
    throw new Error(`${request}: response does not match the contract: ${result.error.message}`);
  }
  return result.data;
}
