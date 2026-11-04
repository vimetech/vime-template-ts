import { describe, expect, it } from 'vitest';
import type { Tx } from '@vime/db';
import { jobQueue } from '@vime/db/jobs';
import { JOB_NAMES, RecordingJobDispatcher, noteCreatedJob } from './jobs';

// The recording dispatcher never touches the transaction.
const tx = {} as Tx;
const orgId = '01900000-0000-7000-8000-000000000001';
const noteId = '01900000-0000-7000-8000-000000000002';

describe('job requests', () => {
  it('note created: one singleton per note', () => {
    expect(noteCreatedJob(orgId, noteId)).toEqual({
      name: 'example.note.created',
      data: { orgId, noteId },
      singletonKey: `note:${noteId}`,
    });
    expect(Object.values(JOB_NAMES).sort()).toEqual(['example.note.created']);
  });

  it('every job name is a queue of the pg-boss catalog', () => {
    for (const name of Object.values(JOB_NAMES)) {
      expect(jobQueue(name), name).toBeDefined();
    }
    // Singleton keys only coalesce on stately queues.
    expect(jobQueue(JOB_NAMES.exampleNoteCreated)?.policy).toBe('stately');
  });
});

describe('RecordingJobDispatcher', () => {
  it('records copies of the dispatched jobs, in order', async () => {
    const dispatcher = new RecordingJobDispatcher();
    const job = noteCreatedJob(orgId, noteId);
    await dispatcher.dispatch(tx, job);
    await dispatcher.dispatch(tx, noteCreatedJob(orgId, 'other'));
    job.data.noteId = 'mutated later';
    expect(dispatcher.jobs.map((j) => j.data.noteId)).toEqual([noteId, 'other']);
    expect(dispatcher.named(JOB_NAMES.exampleNoteCreated)).toHaveLength(2);
    dispatcher.clear();
    expect(dispatcher.jobs).toEqual([]);
  });

  it('rejects a job without orgId', () => {
    const dispatcher = new RecordingJobDispatcher();
    expect(() => dispatcher.dispatch(tx, { name: 'x', data: { orgId: '' } })).toThrow(TypeError);
  });
});
