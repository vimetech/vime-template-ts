import { closeDb, withSystem, withTenant, withUser, type Tx } from '@vime/db';
import { rlsCatalogAudit } from '@vime/db/testing';
import { NotFoundError, newId } from '@vime/kernel';
import { pgError } from '@vime/platform';
import { createTestOrg, createTestUser, webActor, type TestUser } from '@vime/platform/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNote, deleteNote, getNote, listNotes, updateNote } from './notes';
import { notes } from './schema';

afterAll(async () => {
  await closeDb();
});

/** Runs `fn` and returns the SQLSTATE it fails with. */
async function sqlState(fn: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await fn();
  } catch (error) {
    return pgError(error)?.code ?? `non-db error: ${String(error)}`;
  }
  throw new Error('Expected the statement to fail');
}

interface Tenant {
  orgId: string;
  owner: TestUser;
  noteId: string;
}

async function seedTenant(): Promise<Tenant> {
  const owner = await createTestUser('Owner');
  const org = await createTestOrg({ ownerUserId: owner.id });
  return withTenant({ orgId: org.id, userId: owner.id }, async (tx) => {
    const note = await createNote(tx, webActor(org.id, owner.id), { title: 'Seed', body: 'x' });
    return { orgId: org.id, owner, noteId: note.id };
  });
}

let a: Tenant;
let b: Tenant;

beforeAll(async () => {
  [a, b] = await Promise.all([seedTenant(), seedTenant()]);
});

function inA<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withTenant({ orgId: a.orgId, userId: a.owner.id }, fn);
}

describe('RLS catalog audit', () => {
  it('reports no violations with the example tables', async () => {
    expect(await rlsCatalogAudit()).toEqual([]);
  });
});

describe('notes: two-tenant isolation (org A acting on org B)', () => {
  it('does not show B notes, by id or in the list', async () => {
    await inA(async (tx) => {
      expect(await tx.select().from(notes).where(eq(notes.id, b.noteId))).toEqual([]);
      await expect(getNote(tx, a.orgId, b.noteId)).rejects.toBeInstanceOf(NotFoundError);
      const page = await listNotes(tx, a.orgId);
      expect(page.items.map((n) => n.id)).toEqual([a.noteId]);
    });
  });

  it('updates and deletes 0 rows of B', async () => {
    await inA(async (tx) => {
      const updated = await tx
        .update(notes)
        .set({ title: 'hijacked' })
        .where(eq(notes.id, b.noteId))
        .returning();
      expect(updated).toEqual([]);
      await expect(
        updateNote(tx, webActor(a.orgId, a.owner.id), b.noteId, { title: 'hijacked' }),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(deleteNote(tx, webActor(a.orgId, a.owner.id), b.noteId)).rejects.toBeInstanceOf(
        NotFoundError,
      );
    });
    const [untouched] = await withSystem((tx) =>
      tx.select().from(notes).where(eq(notes.id, b.noteId)),
    );
    expect(untouched?.title).toBe('Seed');
  });

  it('rejects inserting a note with organization_id = B (WITH CHECK)', async () => {
    const state = await sqlState(() =>
      inA((tx) =>
        tx.insert(notes).values({ id: newId(), organizationId: b.orgId, title: 'Intruder' }),
      ),
    );
    expect(state).toBe('42501');
  });

  it('rejects moving an A note to B (WITH CHECK on update)', async () => {
    const state = await sqlState(() =>
      inA((tx) => tx.update(notes).set({ organizationId: b.orgId }).where(eq(notes.id, a.noteId))),
    );
    expect(state).toBe('42501');
  });

  it('fails closed without an organization context', async () => {
    const stranger = await createTestUser('Stranger');
    await withUser(stranger.id, async (tx) => {
      expect(await tx.select().from(notes)).toEqual([]);
    });
    await withTenant({ orgId: newId() }, async (tx) => {
      expect(await tx.select().from(notes)).toEqual([]);
    });
  });
});

describe('notes: service', () => {
  it('creates, lists newest first with a cursor, updates and deletes, with activity events', async () => {
    const owner = await createTestUser('Owner');
    const org = await createTestOrg({ ownerUserId: owner.id });
    const ctx = webActor(org.id, owner.id);
    const run = <T>(fn: (tx: Tx) => Promise<T>) =>
      withTenant({ orgId: org.id, userId: owner.id }, fn);

    const created = await run(async (tx) => {
      const first = await createNote(tx, ctx, { title: ' First ' });
      const second = await createNote(tx, ctx, { title: 'Second', body: 'b' });
      const third = await createNote(tx, ctx, { title: 'Third' });
      return [first, second, third];
    });
    expect(created[0]).toMatchObject({ title: 'First', body: '', createdBy: owner.id });

    const page1 = await run((tx) => listNotes(tx, org.id, { limit: 2 }));
    expect(page1.items.map((n) => n.title)).toEqual(['Third', 'Second']);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await run((tx) =>
      listNotes(tx, org.id, { limit: 2, cursor: page1.nextCursor ?? '' }),
    );
    expect(page2.items.map((n) => n.title)).toEqual(['First']);
    expect(page2.nextCursor).toBeNull();

    const updated = await run((tx) => updateNote(tx, ctx, created[1]!.id, { body: 'changed' }));
    expect(updated).toMatchObject({ title: 'Second', body: 'changed' });
    expect(updated.updatedAt).not.toBeNull();
    // An empty patch changes nothing (no event).
    expect(await run((tx) => updateNote(tx, ctx, created[1]!.id, {}))).toEqual(updated);

    await run((tx) => deleteNote(tx, ctx, created[2]!.id));
    await expect(run((tx) => getNote(tx, org.id, created[2]!.id))).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect((await run((tx) => listNotes(tx, org.id))).items).toHaveLength(2);
  });
});
