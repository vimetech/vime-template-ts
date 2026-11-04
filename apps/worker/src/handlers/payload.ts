import { ValidationError } from '@vime/kernel';
import type { z } from 'zod';

/**
 * A job payload that does not match its schema. Retrying cannot fix it: the wrapper logs it and
 * completes the job (pg-boss keeps the payload for inspection).
 */
export class InvalidJobPayloadError extends ValidationError {
  override name = 'InvalidJobPayloadError';
}

export function parsePayload<S extends z.ZodType>(
  schema: S,
  data: unknown,
  job: string,
): z.output<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new InvalidJobPayloadError(
      result.error.issues.map((issue) => ({
        path: issue.path.map(String).join('.'),
        message: issue.message,
      })),
      `Invalid ${job} payload`,
    );
  }
  return result.data;
}
