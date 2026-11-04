import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance } from 'fastify';
import { RateLimitedError } from './problem';

/**
 * Request budgets per client IP and time window (in-memory store: per API process). Behind a
 * proxy, set TRUST_PROXY so the IP is the client's.
 */
export interface RateLimitSettings {
  timeWindowMs: number;
  /** Every route without its own limit. */
  global: number;
  /** /auth/* (get-session, sign-out...). */
  auth: number;
  /** Sign-in and invitation redeem: guessing passwords or codes must stay impractical. */
  signIn: number;
  /**
   * Public webhook receivers, per client IP. Providers send from a few shared IPs for all of
   * their accounts, so this is generous; unknown tokens are 404s that cost one indexed lookup.
   */
  webhook: number;
}

export const DEFAULT_RATE_LIMITS: RateLimitSettings = {
  timeWindowMs: 60_000,
  global: 600,
  auth: 120,
  signIn: 10,
  webhook: 600,
};

/** Registers @fastify/rate-limit. Must run before the routes it applies to are registered. */
export async function registerRateLimit(
  app: FastifyInstance,
  settings: RateLimitSettings,
): Promise<void> {
  await app.register(rateLimit, {
    global: true,
    max: settings.global,
    timeWindow: settings.timeWindowMs,
    errorResponseBuilder: (_request, context) =>
      new RateLimitedError(Math.max(1, Math.ceil(context.ttl / 1000))),
  });
}
