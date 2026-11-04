import { z } from 'zod';
import { PageQuerySchema, UuidSchema } from './common';
import { optionalText, requiredText, timestamps } from './fields';

/*
 * DTOs of the example module (`modules/example`): a note per organization. This is the slot a new
 * project replaces with its first real domain. Same conventions as `platform.ts`: `XxxSchema` is
 * the response shape, `CreateXxxSchema` a POST body with defaults, `UpdateXxxSchema` a PATCH body.
 */

const noteFields = {
  title: requiredText(200),
  body: optionalText(10_000),
};

export const CreateNoteSchema = z.object({
  title: noteFields.title,
  body: noteFields.body.default(''),
});
export type CreateNote = z.infer<typeof CreateNoteSchema>;

export const UpdateNoteSchema = z.object(noteFields).partial();
export type UpdateNote = z.infer<typeof UpdateNoteSchema>;

export const NoteSchema = z.object({
  id: UuidSchema,
  title: z.string(),
  body: z.string(),
  /** User id of the creator (no foreign key: historical reference). */
  createdBy: z.string().nullable(),
  ...timestamps,
});
export type Note = z.infer<typeof NoteSchema>;

/** GET /notes: newest first, cursor-paginated. */
export const ListNotesQuerySchema = PageQuerySchema;
export type ListNotesQuery = z.infer<typeof ListNotesQuerySchema>;
