import { closeDb, withTenant, type Tx } from '@vime/db';
import { ConflictError, NotFoundError, ValidationError, newId } from '@vime/kernel';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listFlags, resolveFlag, upsertOpenFlag } from './flags';
import { createNotification } from './notifications';
import { activityEvents, notifications, opsFlags } from './schema';
import { createTestOrg, createTestUser, webActor, type TestUser } from './testing/fixtures';

afterAll(async () => {
  await closeDb();
});

let orgId: string;
let manager: TestUser;

beforeAll(async () => {
  manager = await createTestUser('Manager');
  orgId = (await createTestOrg({ ownerUserId: manager.id })).id;
});

function inOrg<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withTenant({ orgId, userId: manager.id }, fn);
}

const system = () => ({ orgId, source: 'system' as const });

describe('ops flags', () => {
  it('raises one open flag per (kind, dedupeKey), however many times it is detected', async () => {
    const dedupeKey = `overlap:${newId()}`;
    const input = {
      kind: 'example_needs_review' as const,
      dedupeKey,
      severity: 'warning' as const,
      details: { reservations: ['r1', 'r2'] },
    };
    const first = await inOrg((tx) => upsertOpenFlag(tx, system(), input));
    const second = await inOrg((tx) => upsertOpenFlag(tx, system(), input));
    expect(first.outcome).toBe('created');
    expect(second.outcome).toBe('unchanged');
    expect(second.flag.id).toBe(first.flag.id);

    const changed = await inOrg((tx) =>
      upsertOpenFlag(tx, system(), { ...input, severity: 'critical' }),
    );
    expect(changed.outcome).toBe('updated');
    expect(changed.flag).toMatchObject({ id: first.flag.id, severity: 'critical' });

    const rows = await inOrg((tx) =>
      tx.select().from(opsFlags).where(eq(opsFlags.dedupeKey, dedupeKey)),
    );
    expect(rows).toHaveLength(1);
    const events = await inOrg((tx) =>
      tx
        .select({ eventType: activityEvents.eventType })
        .from(activityEvents)
        .where(eq(activityEvents.entityId, first.flag.id)),
    );
    expect(events.map((e) => e.eventType).sort()).toEqual(['ops_flag.raised', 'ops_flag.updated']);
  });

  it('concurrent detections still produce a single open flag', async () => {
    const dedupeKey = `concurrent:${newId()}`;
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        inOrg((tx) =>
          upsertOpenFlag(tx, system(), {
            kind: 'example_needs_review',
            dedupeKey,
            severity: 'info',
          }),
        ),
      ),
    );
    expect(results.filter((r) => r.outcome === 'created')).toHaveLength(1);
    expect(new Set(results.map((r) => r.flag.id)).size).toBe(1);
  });

  it('resolving closes the flag; the same situation can then raise a new one', async () => {
    const dedupeKey = `late-cancel:${newId()}`;
    const input = {
      kind: 'example_needs_review' as const,
      dedupeKey,
      severity: 'critical' as const,
    };
    const { flag } = await inOrg((tx) => upsertOpenFlag(tx, system(), input));
    const resolved = await inOrg((tx) =>
      resolveFlag(tx, webActor(orgId, manager.id), flag.id, { status: 'resolved', note: 'ok' }),
    );
    expect(resolved).toMatchObject({ status: 'resolved', resolvedBy: manager.id });
    expect(resolved.resolvedAt).toBeInstanceOf(Date);

    await expect(
      inOrg((tx) => resolveFlag(tx, webActor(orgId, manager.id), flag.id, { status: 'dismissed' })),
    ).rejects.toBeInstanceOf(ConflictError);
    await expect(
      inOrg((tx) => resolveFlag(tx, webActor(orgId, manager.id), newId(), { status: 'resolved' })),
    ).rejects.toBeInstanceOf(NotFoundError);

    const reopened = await inOrg((tx) => upsertOpenFlag(tx, system(), input));
    expect(reopened.outcome).toBe('created');
    expect(reopened.flag.id).not.toBe(flag.id);
    const open = await inOrg((tx) => listFlags(tx, { status: 'open' }));
    expect(open.filter((f) => f.dedupeKey === dedupeKey).map((f) => f.id)).toEqual([
      reopened.flag.id,
    ]);
  });

  it('validates the kind and severity', async () => {
    await expect(
      inOrg((tx) =>
        upsertOpenFlag(tx, system(), {
          kind: 'made_up' as 'example_needs_review',
          dedupeKey: 'x',
          severity: 'info',
        }),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('notifications', () => {
  it('deduplicates by dedupe key within the organization', async () => {
    const dedupeKey = `digest:${newId()}`;
    const input = {
      recipientUserId: manager.id,
      channel: 'in_app' as const,
      templateKey: 'digest.today',
      params: { notes: 3 },
      dedupeKey,
    };
    const first = await inOrg((tx) => createNotification(tx, system(), input));
    const second = await inOrg((tx) => createNotification(tx, system(), input));
    expect(first.created).toBe(true);
    expect(first.notification.status).toBe('pending');
    expect(second.created).toBe(false);
    expect(second.notification.id).toBe(first.notification.id);
    const rows = await inOrg((tx) =>
      tx
        .select()
        .from(notifications)
        .where(
          and(eq(notifications.organizationId, orgId), eq(notifications.dedupeKey, dedupeKey)),
        ),
    );
    expect(rows).toHaveLength(1);

    // Without a dedupe key every call creates one.
    const { dedupeKey: _omit, ...withoutKey } = input;
    const a = await inOrg((tx) => createNotification(tx, system(), withoutKey));
    const b = await inOrg((tx) => createNotification(tx, system(), withoutKey));
    expect(a.notification.id).not.toBe(b.notification.id);
  });

  it('requires a recipient', async () => {
    await expect(
      inOrg((tx) =>
        createNotification(tx, system(), {
          channel: 'in_app',
          templateKey: 'x',
        } as unknown as Parameters<typeof createNotification>[2]),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
