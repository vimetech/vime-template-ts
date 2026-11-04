import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import {
  ConflictError,
  DomainError,
  ForbiddenError,
  NotFoundError,
  PreconditionFailedError,
  ValidationError,
} from './errors';

describe('domain errors', () => {
  it('carry a stable code, a name and the Error prototype chain', () => {
    const cases: Array<[DomainError, string, string]> = [
      [new NotFoundError('task', 'abc'), 'not_found', 'NotFoundError'],
      [new ForbiddenError(), 'forbidden', 'ForbiddenError'],
      [new ConflictError('Row version mismatch'), 'conflict', 'ConflictError'],
      [new ValidationError([]), 'validation_failed', 'ValidationError'],
      [
        new PreconditionFailedError('Cannot start'),
        'precondition_failed',
        'PreconditionFailedError',
      ],
      [new DomainError('custom_code', 'Custom'), 'custom_code', 'DomainError'],
    ];
    for (const [error, code, name] of cases) {
      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(DomainError);
      expect(error.code).toBe(code);
      expect(error.name).toBe(name);
    }
    expect(new NotFoundError('task')).not.toBeInstanceOf(ConflictError);
  });

  it('describes the missing entity without revealing more', () => {
    const error = new NotFoundError('property', '0190f2a4-7c1e-7b3a-9d2e-4f5a6b7c8d9e');
    expect(error.message).toBe('property 0190f2a4-7c1e-7b3a-9d2e-4f5a6b7c8d9e not found');
    expect(error.entity).toBe('property');
    expect(error.id).toBe('0190f2a4-7c1e-7b3a-9d2e-4f5a6b7c8d9e');
    expect(error.details).toEqual({
      entity: 'property',
      id: '0190f2a4-7c1e-7b3a-9d2e-4f5a6b7c8d9e',
    });
    const withoutId = new NotFoundError('organization');
    expect(withoutId.message).toBe('organization not found');
    expect(withoutId.id).toBeUndefined();
    expect(withoutId.details).toEqual({ entity: 'organization' });
  });

  it('keeps details and cause', () => {
    const cause = new Error('duplicate key value violates unique constraint');
    const error = new ConflictError('Property code already exists', {
      details: { field: 'code' },
      cause,
    });
    expect(error.details).toEqual({ field: 'code' });
    expect(error.cause).toBe(cause);
    expect(new ForbiddenError('Missing permission task.assign').message).toBe(
      'Missing permission task.assign',
    );
    expect(new ForbiddenError().details).toBeUndefined();
  });

  it('lists unmet requirements of a failed precondition', () => {
    const error = new PreconditionFailedError('Checklist incomplete', [
      { key: 'kitchen_clean', reason: 'answer_required' },
      { key: 'bathroom_photo', reason: 'photos_required', details: { required: 2, confirmed: 1 } },
    ]);
    expect(error.missing).toHaveLength(2);
    expect(error.missing[1]?.details).toEqual({ required: 2, confirmed: 1 });
    expect(new PreconditionFailedError('Service date is in the future').missing).toEqual([]);
  });

  it('builds a ValidationError from a Zod error with dot-separated paths', () => {
    const schema = z.object({
      name: z.string().min(1),
      items: z.array(z.object({ zoneId: z.uuid() })),
    });
    const parsed = schema.safeParse({ name: '', items: [{ zoneId: 'nope' }] });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const error = ValidationError.fromZod(parsed.error);
    expect(error.code).toBe('validation_failed');
    expect(error.message).toBe('Validation failed');
    expect(error.cause).toBe(parsed.error);
    expect(error.issues.map((issue) => issue.path)).toEqual(['name', 'items.0.zoneId']);
    expect(error.issues.every((issue) => issue.message.length > 0)).toBe(true);

    const root = z.string().safeParse(42);
    if (root.success) return;
    expect(ValidationError.fromZod(root.error, 'Bad body').issues[0]?.path).toBe('');
    expect(ValidationError.fromZod(root.error, 'Bad body').message).toBe('Bad body');
  });
});
