import type { ActivitySource } from '@vime/contracts';

/** Sent by the mobile app with its version (spec §6). Captured, not enforced yet. */
export const APP_VERSION_HEADER = 'x-app-version';
/** Mutations may carry a client UUID that makes retries safe (spec §6, architecture §9.3). */
export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';
/**
 * Sent by the mobile outbox when it replays commands queued offline: the device clock at sending
 * time. The server derives the device's clock offset from it (spec §6) and treats the request as
 * an offline replay.
 */
export const CLIENT_SENT_AT_HEADER = 'x-client-sent-at';
/** Set on a response that replays the stored response of an earlier identical request. */
export const IDEMPOTENT_REPLAY_HEADER = 'idempotent-replayed';

const APP_VERSION = /^[0-9A-Za-z.+_-]{1,32}$/;

/** The `X-App-Version` value when well-formed (e.g. `1.4.2`, `1.4.2+105`), otherwise null. */
export function parseAppVersion(value: unknown): string | null {
  return typeof value === 'string' && APP_VERSION.test(value.trim()) ? value.trim() : null;
}

/** Audit source of a request: the mobile app identifies itself with `X-App-Version`. */
export function activitySourceFor(appVersion: string | null): ActivitySource {
  return appVersion ? 'mobile' : 'web';
}
