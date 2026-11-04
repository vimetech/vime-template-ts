import * as Sentry from '@sentry/node';
import type { ErrorEvent } from '@sentry/node';

/*
 * Error reporting (architecture §16): jobs that fail for good (no retry left), pg-boss errors and
 * crashes go to Sentry when SENTRY_DSN is set; without it nothing is sent and nothing changes. Only
 * the error, its stack and a few tags leave the process: never job payloads (they carry tenant data),
 * requests or users. apps/api has the same module (src/http/error-reporting.ts): composition roots
 * do not import each other.
 */

export type ErrorTags = Record<string, string | number | undefined>;

export interface ErrorReporter {
  /** True when reports go somewhere (a DSN is set). */
  enabled: boolean;
  capture(error: unknown, tags?: ErrorTags): void;
  /**
   * Waits (at most `timeoutMs`) for queued reports, before the process exits. True when they all
   * left in time and the last one was accepted (a 2xx from Sentry, not a network or HTTP error).
   */
  flush(timeoutMs: number): Promise<boolean>;
}

export const NO_REPORTER: ErrorReporter = {
  enabled: false,
  capture: () => undefined,
  flush: () => Promise.resolve(true),
};

let current: ErrorReporter = NO_REPORTER;

/** The process-wide reporter (the no-op one until `setErrorReporter`). */
export function errorReporter(): ErrorReporter {
  return current;
}

export function setErrorReporter(reporter: ErrorReporter): void {
  current = reporter;
}

export interface SentryConfig {
  dsn: string | undefined;
  environment: string;
  /** The deployed version: SENTRY_RELEASE, else the commit or the deployment Railway reports. */
  release: string | undefined;
}

export function sentryConfig(env: {
  NODE_ENV: string;
  SENTRY_DSN?: string | undefined;
  SENTRY_ENVIRONMENT?: string | undefined;
  SENTRY_RELEASE?: string | undefined;
  RAILWAY_GIT_COMMIT_SHA?: string | undefined;
  RAILWAY_DEPLOYMENT_ID?: string | undefined;
}): SentryConfig {
  return {
    dsn: env.SENTRY_DSN,
    environment: env.SENTRY_ENVIRONMENT ?? env.NODE_ENV,
    release: env.SENTRY_RELEASE ?? env.RAILWAY_GIT_COMMIT_SHA ?? env.RAILWAY_DEPLOYMENT_ID,
  };
}

/** What Sentry keeps of an event: the exception and our tags, nothing about the request or user. */
export function scrubEvent(event: ErrorEvent): ErrorEvent {
  delete event.request;
  delete event.user;
  delete event.breadcrumbs;
  return event;
}

/**
 * Starts the Sentry SDK for `service` (`api` or `worker`) and returns its reporter, or the no-op
 * one without a DSN. No tracing and no automatic instrumentation: only uncaught exceptions,
 * unhandled rejections and what the code captures.
 */
export function startSentry(config: SentryConfig, service: string): ErrorReporter {
  if (!config.dsn) return NO_REPORTER;
  // The SDK's flush only says the queue drained, also when a send failed: remember the outcome.
  let lastSendFailed = false;
  Sentry.init({
    transport: (options) => {
      const transport = Sentry.makeNodeTransport(options);
      return {
        ...transport,
        send: async (envelope) => {
          try {
            const response = await transport.send(envelope);
            const status = response.statusCode;
            lastSendFailed = status === undefined || status < 200 || status >= 300;
            return response;
          } catch (error) {
            lastSendFailed = true;
            throw error;
          }
        },
      };
    },
    dsn: config.dsn,
    environment: config.environment,
    ...(config.release ? { release: config.release } : {}),
    serverName: service,
    sendDefaultPii: false,
    skipOpenTelemetrySetup: true,
    defaultIntegrations: false,
    integrations: [
      Sentry.onUncaughtExceptionIntegration(),
      Sentry.onUnhandledRejectionIntegration(),
      Sentry.linkedErrorsIntegration(),
    ],
    initialScope: { tags: { service } },
    beforeSend: scrubEvent,
  });
  return {
    enabled: true,
    capture: (error, tags = {}) => {
      Sentry.withScope((scope) => {
        for (const [key, value] of Object.entries(tags)) {
          if (value !== undefined) scope.setTag(key, String(value));
        }
        Sentry.captureException(error);
      });
    },
    flush: async (timeoutMs) => (await Sentry.flush(timeoutMs)) && !lastSendFailed,
  };
}
