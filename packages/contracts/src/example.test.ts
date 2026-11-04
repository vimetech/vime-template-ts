import { describe, expect, it } from 'vitest';
import { ID_1, NOW, roundTrip } from './fixtures';
import { CreateNoteSchema, NoteSchema, UpdateNoteSchema } from './example';

describe('notes', () => {
  it('applies defaults on create and trims the title', () => {
    expect(CreateNoteSchema.parse({ title: '  Hello  ' })).toEqual({ title: 'Hello', body: '' });
    expect(CreateNoteSchema.safeParse({ title: '   ' }).success).toBe(false);
    expect(CreateNoteSchema.safeParse({}).success).toBe(false);
  });

  it('treats update as a patch', () => {
    expect(UpdateNoteSchema.parse({})).toEqual({});
    expect(UpdateNoteSchema.parse({ body: 'x' })).toEqual({ body: 'x' });
  });

  it('round-trips a note', () => {
    roundTrip(NoteSchema, {
      id: ID_1,
      title: 'Hello',
      body: '',
      createdBy: ID_1,
      createdAt: NOW,
      updatedAt: null,
    });
  });
});
