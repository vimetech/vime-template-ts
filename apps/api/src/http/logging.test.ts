import { closeDb } from '@vime/db';
import { Writable } from 'node:stream';
import { afterAll, describe, expect, it } from 'vitest';
import { buildTestApp } from '../testing/helpers';
import { loggableUrl } from './logging';

afterAll(async () => {
  await closeDb();
});

describe('request logging', () => {
  it('logs request headers with credentials redacted, and the request id', async () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        lines.push(...chunk.toString('utf8').split('\n').filter(Boolean));
        callback();
      },
    });
    const app = await buildTestApp({ logger: { level: 'info', stream } });
    try {
      await app.inject({
        method: 'GET',
        url: '/v1/me',
        headers: {
          authorization: 'Bearer super-secret-token',
          cookie: 'vime.session_token=super-secret-cookie',
          'x-request-id': 'log-test-1',
        },
      });
      await app.inject({ method: 'GET', url: '/auth/verify-email?token=one-time-secret' });
    } finally {
      await app.close();
    }
    const output = lines.join('\n');
    expect(output).not.toContain('super-secret-token');
    expect(output).not.toContain('super-secret-cookie');
    expect(output).not.toContain('one-time-secret');
    interface LogEntry {
      requestId?: string;
      req?: { headers: Record<string, string> };
    }
    const incoming = lines
      .map((line) => JSON.parse(line) as LogEntry)
      .find((entry) => entry.requestId === 'log-test-1' && entry.req);
    expect(incoming?.req?.headers['authorization']).toBe('[Redacted]');
    expect(incoming?.req?.headers['cookie']).toBe('[Redacted]');
  });
});

describe('loggableUrl', () => {
  it('replaces the secret token of webhook URLs and drops /auth query strings', () => {
    expect(loggableUrl('/v1/webhooks/acme/abcDEF_-123?x=1')).toBe('/v1/webhooks/acme/[Redacted]');
    expect(loggableUrl('/v1/webhooks/acme')).toBe('/v1/webhooks/acme/[Redacted]');
    expect(loggableUrl('/auth/verify-email?token=secret')).toBe('/auth/verify-email');
    expect(loggableUrl('/v1/orgs/x/zones?limit=5')).toBe('/v1/orgs/x/zones?limit=5');
  });
});
