import { pingDb } from '@vime/db';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { problemResponses, sendProblem } from '../http/problem';

const HealthSchema = z.object({ status: z.literal('ok') });

/** Liveness (process up) and readiness (database reachable). Public, no rate limit. */
export const healthRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/health',
    {
      schema: {
        tags: ['health'],
        summary: 'Liveness',
        security: [],
        response: { 200: HealthSchema },
      },
      config: { rateLimit: false },
    },
    async () => ({ status: 'ok' as const }),
  );

  app.get(
    '/health/ready',
    {
      schema: {
        tags: ['health'],
        summary: 'Readiness: the database answers',
        security: [],
        response: { 200: HealthSchema, ...problemResponses },
      },
      config: { rateLimit: false },
    },
    async (request, reply) => {
      try {
        await pingDb();
      } catch (error) {
        request.log.error({ err: error }, 'readiness check failed');
        return sendProblem(request, reply, {
          code: 'internal',
          status: 503,
          detail: 'The database is not reachable',
        });
      }
      return { status: 'ok' as const };
    },
  );
};
