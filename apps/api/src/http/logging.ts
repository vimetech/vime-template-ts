import { newId } from '@vime/kernel';
import type { FastifyServerOptions, RawRequestDefaultExpression } from 'fastify';
import type { DestinationStream, LoggerOptions } from 'pino';
import type { ApiEnv } from '../env';

/** Header carrying the request id in both directions. */
export const REQUEST_ID_HEADER = 'x-request-id';

/** Incoming ids are accepted only when short and plain, so they are safe to log and echo. */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/** The client's (or proxy's) `X-Request-Id` when safe, otherwise a new UUIDv7. */
export function generateRequestId(request: RawRequestDefaultExpression): string {
  const incoming = request.headers[REQUEST_ID_HEADER];
  return typeof incoming === 'string' && SAFE_REQUEST_ID.test(incoming) ? incoming : newId();
}

/**
 * Headers that carry credentials. Redacted wherever they would be logged (request serializer
 * below, and any object logged with them).
 */
export const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["set-cookie"]',
  'req.headers["set-auth-token"]',
  'res.headers["set-cookie"]',
  'res.headers["set-auth-token"]',
  'headers.authorization',
  'headers.cookie',
];

interface SerializableRequest {
  method?: string;
  url?: string;
  hostname?: string;
  ip?: string;
  headers?: Record<string, unknown>;
}

/** Prefix of the public webhook receivers, whose last path segment is a secret token. */
export const WEBHOOK_PATH_PREFIX = '/v1/webhooks/';

/**
 * A URL as it may be logged: query strings of /auth URLs are dropped (they can carry one-time
 * tokens) and the secret token of webhook URLs is replaced.
 */
export function loggableUrl(url: string): string {
  if (url.startsWith('/auth/')) {
    return url.split('?')[0] ?? url;
  }
  if (url.startsWith(WEBHOOK_PATH_PREFIX)) {
    const path = url.split('?')[0] ?? url;
    const provider = path.slice(WEBHOOK_PATH_PREFIX.length).split('/')[0] ?? '';
    return `${WEBHOOK_PATH_PREFIX}${provider}/[Redacted]`;
  }
  return url;
}

/**
 * Logged view of a request: method, URL (see `loggableUrl`), client IP and headers (credentials
 * redacted by pino).
 */
function serializeRequest(request: SerializableRequest) {
  const url = request.url ?? '';
  return {
    method: request.method,
    url: loggableUrl(url),
    hostname: request.hostname,
    remoteAddress: request.ip,
    headers: request.headers,
  };
}

export type LoggerSetting =
  boolean | { level?: LoggerOptions['level']; stream?: DestinationStream };

/** Fastify logger options (pino) with redaction; pretty output only in development. */
export function loggerOptions(
  env: ApiEnv,
  setting: LoggerSetting | undefined,
): FastifyServerOptions['logger'] {
  if (setting === false) {
    return false;
  }
  const custom = typeof setting === 'object' ? setting : {};
  const pretty = env.NODE_ENV === 'development' && custom.stream === undefined;
  return {
    level: custom.level ?? env.LOG_LEVEL,
    redact: { paths: REDACTED_PATHS, censor: '[Redacted]' },
    serializers: { req: serializeRequest },
    ...(custom.stream === undefined ? {} : { stream: custom.stream }),
    ...(pretty
      ? { transport: { target: 'pino-pretty', options: { translateTime: 'SYS:HH:MM:ss.l' } } }
      : {}),
  };
}
