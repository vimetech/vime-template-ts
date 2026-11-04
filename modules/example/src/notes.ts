import {
  CreateNoteSchema,
  ListNotesQuerySchema,
  UpdateNoteSchema,
  type ListNotesQuery,
  type Note,
  type Page,
} from '@vime/contracts';
import type { Tx } from '@vime/db';
import { NotFoundError, ValidationError, isUuid, newId } from '@vime/kernel';
import { iso, isoOrNull, parseInput, recordActivity, type ActorContext } from '@vime/platform';
import { and, desc, eq, lt } from 'drizzle-orm';
import type { z } from 'zod';
import { notes } from './schema';

/*
 * Notes: the example domain service. Same contract as every module service (see @vime/platform):
 * it takes the `Tx` of the caller's withTenant transaction, validates its input with
 * @vime/contracts, writes an activity event in the same transaction for each state change and
 * throws @vime/kernel DomainErrors. RLS scopes every statement to `ctx.orgId`; the explicit
 * `organization_id` filters below are belt and braces, so a mistaken system-role call cannot cross.
 */

type NoteRow = typeof notes.$inferSelect;

function toNote(row: NoteRow): Note {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    createdBy: row.createdBy,
    createdAt: iso(row.createdAt),
    updatedAt: isoOrNull(row.updatedAt),
  };
}

/** Creates a note (`CreateNoteSchema`). Audited as `note.created`. */
export async function createNote(
  tx: Tx,
  ctx: ActorContext,
  input: z.input<typeof CreateNoteSchema>,
): Promise<Note> {
  const data = parseInput(CreateNoteSchema, input);
  const [row] = await tx
    .insert(notes)
    .values({
      id: newId(),
      organizationId: ctx.orgId,
      title: data.title,
      body: data.body,
      createdBy: ctx.userId ?? null,
    })
    .returning();
  if (!row) {
    throw new Error('Insert into notes returned no row');
  }
  await recordActivity(tx, ctx, {
    entityType: 'note',
    entityId: row.id,
    eventType: 'note.created',
    payload: { title: row.title },
  });
  return toNote(row);
}

/** One note of `orgId`; NotFoundError if absent (or of another organization). */
export async function getNote(tx: Tx, orgId: string, noteId: string): Promise<Note> {
  const [row] = await tx
    .select()
    .from(notes)
    .where(and(eq(notes.organizationId, orgId), eq(notes.id, noteId)));
  if (!row) {
    throw new NotFoundError('note', noteId);
  }
  return toNote(row);
}

/**
 * Notes of `orgId`, newest first. Ids are UUIDv7 (creation order), so the cursor is the id of the
 * last note of the previous page.
 */
export async function listNotes(
  tx: Tx,
  orgId: string,
  query: z.input<typeof ListNotesQuerySchema> = {},
): Promise<Page<Note>> {
  const { limit, cursor }: ListNotesQuery = parseInput(ListNotesQuerySchema, query);
  if (cursor !== undefined && !isUuid(cursor)) {
    throw new ValidationError([{ path: 'cursor', message: 'Invalid cursor' }]);
  }
  const rows = await tx
    .select()
    .from(notes)
    .where(
      and(eq(notes.organizationId, orgId), cursor === undefined ? undefined : lt(notes.id, cursor)),
    )
    .orderBy(desc(notes.id))
    .limit(limit + 1);
  const items = rows.slice(0, limit).map(toNote);
  const last = items.at(-1);
  return { items, nextCursor: rows.length > limit && last ? last.id : null };
}

/** PATCH of a note (`UpdateNoteSchema`). Audited as `note.updated` with the changed fields. */
export async function updateNote(
  tx: Tx,
  ctx: ActorContext,
  noteId: string,
  input: z.input<typeof UpdateNoteSchema>,
): Promise<Note> {
  const patch = parseInput(UpdateNoteSchema, input);
  const [current] = await tx
    .select()
    .from(notes)
    .where(and(eq(notes.organizationId, ctx.orgId), eq(notes.id, noteId)))
    .for('update');
  if (!current) {
    throw new NotFoundError('note', noteId);
  }
  const values: Partial<Pick<NoteRow, 'title' | 'body'>> = {};
  if (patch.title !== undefined) values.title = patch.title;
  if (patch.body !== undefined) values.body = patch.body;
  if (Object.keys(values).length === 0) {
    return toNote(current);
  }
  const [row] = await tx
    .update(notes)
    .set(values)
    .where(and(eq(notes.organizationId, ctx.orgId), eq(notes.id, noteId)))
    .returning();
  if (!row) {
    throw new NotFoundError('note', noteId);
  }
  await recordActivity(tx, ctx, {
    entityType: 'note',
    entityId: noteId,
    eventType: 'note.updated',
    payload: { changes: values },
  });
  return toNote(row);
}

/** Deletes a note. Audited as `note.deleted`. NotFoundError if absent. */
export async function deleteNote(tx: Tx, ctx: ActorContext, noteId: string): Promise<void> {
  const deleted = await tx
    .delete(notes)
    .where(and(eq(notes.organizationId, ctx.orgId), eq(notes.id, noteId)))
    .returning({ id: notes.id, title: notes.title });
  const row = deleted[0];
  if (!row) {
    throw new NotFoundError('note', noteId);
  }
  await recordActivity(tx, ctx, {
    entityType: 'note',
    entityId: noteId,
    eventType: 'note.deleted',
    payload: { title: row.title },
  });
}
