import type { ErrorEvent } from '@sentry/node';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { NO_REPORTER, scrubEvent, sentryConfig, startSentry } from './error-reporting';

describe('error reporting', () => {
  it('sends nothing without a DSN', () => {
    expect(startSentry(sentryConfig({ NODE_ENV: 'production' }), 'api')).toBe(NO_REPORTER);
  });

  it('names the environment and the deployed version', () => {
    expect(
      sentryConfig({
        NODE_ENV: 'production',
        SENTRY_DSN: 'https://key@o1.ingest.sentry.io/1',
        RAILWAY_GIT_COMMIT_SHA: 'abc123',
        RAILWAY_DEPLOYMENT_ID: 'dep-1',
      }),
    ).toEqual({
      dsn: 'https://key@o1.ingest.sentry.io/1',
      environment: 'production',
      release: 'abc123',
    });
    expect(
      sentryConfig({
        NODE_ENV: 'production',
        SENTRY_ENVIRONMENT: 'pilot',
        SENTRY_RELEASE: 'v1',
        RAILWAY_GIT_COMMIT_SHA: 'abc123',
      }),
    ).toMatchObject({ environment: 'pilot', release: 'v1' });
    expect(sentryConfig({ NODE_ENV: 'production', RAILWAY_DEPLOYMENT_ID: 'dep-1' }).release).toBe(
      'dep-1',
    );
  });

  it('keeps the exception and tags, never the request, the user or breadcrumbs', () => {
    const event = {
      type: undefined,
      exception: { values: [{ type: 'Error', value: 'boom' }] },
      tags: { route: '/v1/orgs/:orgId/tasks' },
      request: {
        url: 'https://ops.example.com/api/v1/orgs/x/properties/y/access',
        data: '{"doorCode":"4821#"}',
        headers: { authorization: 'Bearer secret', cookie: 'session=secret' },
      },
      user: { id: 'user_1', email: 'owner@example.com' },
      breadcrumbs: [{ message: 'select door_code from ...' }],
    } as ErrorEvent;
    const scrubbed = scrubEvent(event);
    expect(scrubbed).toEqual({
      type: undefined,
      exception: { values: [{ type: 'Error', value: 'boom' }] },
      tags: { route: '/v1/orgs/:orgId/tasks' },
    });
    expect(JSON.stringify(scrubbed)).not.toMatch(/4821|secret|owner@example/);
  });

  it('says whether the report was accepted, not just that the queue drained', async () => {
    let status = 200;
    let received = 0;
    const server = createServer((request, response) => {
      request.resume();
      request.on('end', () => {
        received += 1;
        response.writeHead(status);
        response.end('{}');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const send = async (dsn: string) => {
        const reporter = startSentry({ dsn, environment: 'test', release: undefined }, 'api');
        expect(reporter.enabled).toBe(true);
        reporter.capture(new Error('check'), { diagnostic: 'test' });
        return reporter.flush(5_000);
      };
      const dsn = `http://key@127.0.0.1:${port}/1`;
      expect(await send(dsn)).toBe(true);
      status = 403;
      expect(await send(dsn)).toBe(false);
      expect(received).toBe(2);
      server.close();
      // Nobody listening (blocked network, wrong host): not delivered.
      expect(await send(dsn)).toBe(false);
    } finally {
      server.close();
    }
  });
});
