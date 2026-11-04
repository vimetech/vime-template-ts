import { withTenant } from '@vime/db';
import { JOB_QUEUE_NAMES } from '@vime/db/jobs';
import { getNote } from '@vime/example';
import { NotFoundError } from '@vime/kernel';
import { z } from 'zod';
import type { WorkerDeps } from '../deps';
import { parsePayload } from './payload';

/*
 * The example module's job: the shape of a per-organization handler. The payload carries `orgId`
 * and the handler opens withTenant(orgId), so every statement passes RLS. A real module does its
 * slow or external work here (never inside the request that dispatched the job).
 */

export const NoteCreatedJobDataSchema = z.object({
  orgId: z.uuid(),
  noteId: z.uuid(),
});

export type NoteCreatedJobResult = { status: 'done'; title: string } | { status: 'gone' };

/** `example.note.created {orgId, noteId}`: reads the note and logs its title. */
export async function handleNoteCreated(
  deps: WorkerDeps,
  data: unknown,
): Promise<NoteCreatedJobResult> {
  const { orgId, noteId } = parsePayload(
    NoteCreatedJobDataSchema,
    data,
    JOB_QUEUE_NAMES.exampleNoteCreated,
  );
  try {
    const note = await withTenant({ orgId }, (tx) => getNote(tx, orgId, noteId));
    deps.logger.info({ noteId, title: note.title }, 'note created');
    return { status: 'done', title: note.title };
  } catch (error) {
    // Deleted before the job ran: nothing to do, and retrying would not bring it back.
    if (error instanceof NotFoundError) return { status: 'gone' };
    throw error;
  }
}
