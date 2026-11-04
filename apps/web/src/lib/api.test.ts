import { NoteSchema, OrganizationSchema, type Note, type Organization } from '@vime/contracts';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ApiContractError, ApiProblem, createApiClient, filenameFromDisposition } from './api';

type FetchArgs = [input: string, init: RequestInit];

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  const problem = status >= 400;
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': problem ? 'application/problem+json; charset=utf-8' : 'application/json',
      ...headers,
    },
  });
}

function problemBody(code: string, status: number, extra: Record<string, unknown> = {}) {
  return { type: `https://errors.vime.ops/${code}`, title: 'x', status, code, ...extra };
}

/** A client over a scripted fetch: each call returns (or throws) the next scripted result. */
function clientWith(script: (Response | Error)[], options: { strict?: boolean } = {}) {
  const calls: FetchArgs[] = [];
  const fetchMock = vi.fn(async (input: string, init: RequestInit) => {
    calls.push([input, init]);
    const next = script.shift();
    if (!next) throw new Error('unexpected fetch');
    if (next instanceof Error) throw next;
    return next;
  });
  let keyCounter = 0;
  const onContractMismatch = vi.fn();
  const client = createApiClient({
    baseUrl: '/api',
    appVersion: 'web/1.2.3',
    fetch: fetchMock as unknown as typeof fetch,
    strict: options.strict ?? true,
    newIdempotencyKey: () => `00000000-0000-4000-8000-00000000000${++keyCounter}`,
    retry: { attempts: 3, baseDelayMs: 1 },
    sleep: async () => undefined,
    onContractMismatch,
  });
  const header = (index: number, name: string) => new Headers(calls[index]?.[1].headers).get(name);
  return { client, calls, header, onContractMismatch };
}

const sampleNote: Note = {
  id: '01928f3e-7c3a-7b2e-9a6f-3c1d2e4f5a6b',
  title: 'Nota',
  body: '',
  createdBy: null,
  createdAt: '2026-10-09T10:00:00.000Z',
  updatedAt: null,
};

describe('api client: requests', () => {
  it('sends credentials, Accept JSON and X-App-Version; builds the query string', async () => {
    const { client, calls, header } = clientWith([json(200, sampleNote)]);
    await client.get('/v1/orgs/o1/notes/n1', NoteSchema, {
      query: { date: '2026-10-10', empty: '', none: undefined, flag: false },
    });
    expect(calls[0]?.[0]).toBe('/api/v1/orgs/o1/notes/n1?date=2026-10-10&flag=false');
    expect(calls[0]?.[1].credentials).toBe('include');
    expect(header(0, 'accept')).toBe('application/json');
    expect(header(0, 'x-app-version')).toBe('web/1.2.3');
    expect(header(0, 'idempotency-key')).toBeNull();
  });
});

describe('api client: idempotency', () => {
  it('reuses the same Idempotency-Key when retrying a mutation after a network error', async () => {
    const { client, calls, header } = clientWith([
      new TypeError('Failed to fetch'),
      json(200, sampleNote),
    ]);
    const result = await client.mutate('POST', '/v1/orgs/o1/notes', {
      body: { title: 'Nota' },
      schema: NoteSchema,
    });
    expect(result.id).toBe(sampleNote.id);
    expect(calls).toHaveLength(2);
    expect(header(0, 'idempotency-key')).toBe('00000000-0000-4000-8000-000000000001');
    expect(header(1, 'idempotency-key')).toBe(header(0, 'idempotency-key'));
    expect(header(0, 'content-type')).toBe('application/json');
    expect(calls[1]?.[1].body).toBe(calls[0]?.[1].body);
  });

  it('reuses the key on 503 and on idempotency_in_progress', async () => {
    const { client, calls, header } = clientWith([
      json(503, problemBody('internal', 503)),
      json(409, problemBody('idempotency_in_progress', 409)),
      json(200, { published: 3 }),
    ]);
    const result = await client.mutate('POST', '/v1/orgs/o1/assignments/publish', {
      body: { date: '2026-10-10' },
      schema: z.object({ published: z.number() }),
    });
    expect(result.published).toBe(3);
    expect(calls).toHaveLength(3);
    expect(new Set([0, 1, 2].map((i) => header(i, 'idempotency-key'))).size).toBe(1);
  });

  it('uses a new key for each separate mutation call', async () => {
    const { client, header } = clientWith([json(200, sampleNote), json(200, sampleNote)]);
    await client.mutate('POST', '/x', { body: {}, schema: NoteSchema });
    await client.mutate('POST', '/x', { body: {}, schema: NoteSchema });
    expect(header(0, 'idempotency-key')).not.toBe(header(1, 'idempotency-key'));
  });

  it('gives up after the configured attempts, throwing the last problem', async () => {
    const { client, calls } = clientWith([
      new TypeError('offline'),
      new TypeError('offline'),
      new TypeError('offline'),
    ]);
    await expect(client.mutate('DELETE', '/x', { schema: null })).rejects.toMatchObject({
      code: 'network',
      status: 0,
    });
    expect(calls).toHaveLength(3);
  });

  it('does not retry business errors and does not send a body or content type without one', async () => {
    const { client, calls, header } = clientWith([
      json(422, problemBody('precondition_failed', 422)),
    ]);
    await expect(client.mutate('DELETE', '/x', { schema: null })).rejects.toBeInstanceOf(
      ApiProblem,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[1].body).toBeUndefined();
    expect(header(0, 'content-type')).toBeNull();
  });
});

describe('api client: raw bodies', () => {
  it('sends a CSV as-is with its content type (not wrapped in JSON)', async () => {
    const { client, calls, header } = clientWith([json(200, { created: 1 })]);
    const csv = 'code,name\nHST-001,Depa "Larco"';
    await client.mutate('POST', '/v1/orgs/o1/properties/import', {
      body: csv,
      contentType: 'text/csv; charset=utf-8',
      schema: null,
    });
    expect(calls[0]?.[1].body).toBe(csv);
    expect(header(0, 'content-type')).toBe('text/csv; charset=utf-8');
  });

  it('refuses a non-string body with a content type', async () => {
    const { client, calls } = clientWith([]);
    await expect(
      client.mutate('POST', '/x', { body: { csv: 'a' }, contentType: 'text/csv', schema: null }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(calls).toHaveLength(0);
  });
});

describe('api client: problems', () => {
  it('parses problem+json with field errors and missing requirements', async () => {
    const { client } = clientWith([
      json(422, {
        ...problemBody('precondition_failed', 422),
        detail: 'Faltan 2 ítems',
        requestId: 'req-1',
        missing: [
          { key: 'bathroom.towels', reason: 'answer_required' },
          {
            key: 'living.overview',
            reason: 'photos_required',
            details: { required: 1, confirmed: 0 },
          },
        ],
      }),
    ]);
    const error = await client
      .mutate('POST', '/v1/orgs/o1/notes/n1/close', { body: {}, schema: NoteSchema })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiProblem);
    const problem = error as ApiProblem;
    expect(problem.status).toBe(422);
    expect(problem.code).toBe('precondition_failed');
    expect(problem.detail).toBe('Faltan 2 ítems');
    expect(problem.requestId).toBe('req-1');
    expect(problem.missing.map((m) => m.key)).toEqual(['bathroom.towels', 'living.overview']);
  });

  it('parses validation errors', async () => {
    const { client } = clientWith([
      json(400, {
        ...problemBody('validation_failed', 400),
        errors: [{ path: 'code', message: 'Too small' }],
      }),
    ]);
    const error = (await client
      .mutate('POST', '/x', { body: {}, schema: NoteSchema })
      .catch((caught: unknown) => caught)) as ApiProblem;
    expect(error.code).toBe('validation_failed');
    expect(error.errors).toEqual([{ path: 'code', message: 'Too small' }]);
  });

  it('turns a non-problem error response into an unknown problem with its status', async () => {
    const { client } = clientWith([
      new Response('<html>Bad gateway</html>', {
        status: 502,
        headers: { 'content-type': 'text/html' },
      }),
    ]);
    const error = (await client
      .get('/x', NoteSchema)
      .catch((caught: unknown) => caught)) as ApiProblem;
    expect(error).toBeInstanceOf(ApiProblem);
    expect(error.status).toBe(502);
    expect(error.code).toBe('unknown');
  });

  it('fails loudly (strict) when a response does not match its contract', async () => {
    const { client } = clientWith([json(200, { ...sampleNote, createdAt: 'yesterday' })]);
    await expect(client.get('/x', NoteSchema)).rejects.toBeInstanceOf(ApiContractError);
  });

  it('logs and passes the body through when not strict', async () => {
    const { client, onContractMismatch } = clientWith([json(200, { id: 'x' })], { strict: false });
    await expect(client.get('/x', NoteSchema)).resolves.toEqual({ id: 'x' });
    expect(onContractMismatch).toHaveBeenCalledOnce();
  });
});

describe('api client: ETag', () => {
  const organization: Organization = {
    id: '01928f3e-7c3a-7b2e-9a6f-0000000000aa',
    name: 'Acme',
    slug: 'acme',
    timezone: 'America/Lima',
    locale: 'es-PE',
    settings: { coordinationPhoneE164: null, disabledFunctions: [] },
    createdAt: '2026-10-01T12:00:00.000Z',
    updatedAt: null,
  };

  it('sends If-None-Match and reports 304 as not modified', async () => {
    const { client, calls, header } = clientWith([new Response(null, { status: 304 })]);
    const result = await client.getConditional('/o', OrganizationSchema, { etag: 'W/"abc"' });
    expect(result).toEqual({ notModified: true });
    expect(header(0, 'if-none-match')).toBe('W/"abc"');
    expect(calls[0]?.[1].cache).toBe('no-store');
  });

  it('returns the body and its ETag on 200', async () => {
    const { client, header } = clientWith([json(200, organization, { etag: 'W/"v1"' })]);
    const result = await client.getConditional('/o', OrganizationSchema);
    expect(header(0, 'if-none-match')).toBeNull();
    expect(result).toEqual({ notModified: false, data: organization, etag: 'W/"v1"' });
  });
});

describe('filenameFromDisposition', () => {
  it('reads plain and RFC 5987 file names', () => {
    expect(filenameFromDisposition('attachment; filename="plan-del-dia-2026-10-10.csv"')).toBe(
      'plan-del-dia-2026-10-10.csv',
    );
    expect(filenameFromDisposition("attachment; filename*=UTF-8''plan%20d%C3%ADa.csv")).toBe(
      'plan día.csv',
    );
    expect(filenameFromDisposition(null)).toBeNull();
  });
});
