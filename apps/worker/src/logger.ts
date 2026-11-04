import pino, { type DestinationStream, type Logger } from 'pino';
import type { WorkerEnv } from './env';

export type { Logger } from 'pino';

/**
 * Paths that may carry secrets or personal data when an object is logged. Credentials and
 * webhook tokens are never logged on purpose; this is the safety net. A project adds the paths of
 * its own sensitive fields here.
 */
export const REDACTED_PATHS = [
  'credentials',
  '*.credentials',
  'apiKey',
  '*.apiKey',
  'password',
  '*.password',
  'token',
  '*.token',
  'webhookToken',
  'authorization',
  '*.authorization',
  'email',
  '*.email',
  'phone',
  '*.phone',
  'raw',
  '*.raw',
  'payload',
  '*.payload',
];

/** Structured pino logger (JSON; pretty only in development), with secret paths redacted. */
export function createLogger(
  env: Pick<WorkerEnv, 'NODE_ENV' | 'LOG_LEVEL'>,
  stream?: DestinationStream,
): Logger {
  const options = {
    name: 'vime-worker',
    level: env.LOG_LEVEL,
    redact: { paths: REDACTED_PATHS, censor: '[Redacted]' },
    ...(env.NODE_ENV === 'development' && stream === undefined
      ? { transport: { target: 'pino-pretty', options: { translateTime: 'SYS:HH:MM:ss.l' } } }
      : {}),
  };
  return stream === undefined ? pino(options) : pino(options, stream);
}

/** A logger that writes nothing (tests). */
export function silentLogger(): Logger {
  return pino({ level: 'silent' });
}
