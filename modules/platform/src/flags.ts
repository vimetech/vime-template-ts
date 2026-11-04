import {
  FlagKindSchema,
  FlagSeveritySchema,
  JsonObjectSchema,
  type FlagStatus,
} from '@vime/contracts';
import type { Tx } from '@vime/db';
import { ConflictError, NotFoundError, newId } from '@vime/kernel';
import { and, desc, eq, getTableColumns, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { recordActivity } from './audit';
import type { ActorContext } from './context';
import { parseInput } from './errors';
import { opsFlags } from './schema';

export type OpsFlag = typeof opsFlags.$inferSelect;

export const UpsertFlagSchema = z.object({
  kind: FlagKindSchema,
  /** Identifies the situation within the kind (e.g. `<reservationA>:<reservationB>`). */
  dedupeKey: z.string().min(1).max(500),
  severity: FlagSeveritySchema,
  /** The module row the situation is about, when it is about one. */
  entityType: z.string().min(1).max(64).nullish(),
  entityId: z.uuid().nullish(),
  details: JsonObjectSchema.default({}),
});
export type UpsertFlagInput = z.input<typeof UpsertFlagSchema>;

export interface UpsertFlagResult {
  flag: OpsFlag;
  /** `created`: new open flag; `updated`: the open flag's data changed; `unchanged`: same data. */
  outcome: 'created' | 'updated' | 'unchanged';
}

/** Matches the partial unique index `ops_flags_open_dedupe_unique`. */
const OPEN_FLAG_TARGET_WHERE = sql.raw(`status = 'open'`);

/**
 * Raises a flag in the exception queue, idempotently: while an OPEN flag with the same
 * (kind, dedupeKey) exists, it is updated in place (or left alone when nothing changed) instead of
 * creating a duplicate. Atomic through the partial unique index (INSERT ... ON CONFLICT). Audited as
 * `ops_flag.raised` / `ops_flag.updated` (no event when unchanged).
 */
export async function upsertOpenFlag(
  tx: Tx,
  ctx: ActorContext,
  input: UpsertFlagInput,
): Promise<UpsertFlagResult> {
  const data = parseInput(UpsertFlagSchema, input);
  const values = {
    severity: data.severity,
    entityType: data.entityType ?? null,
    entityId: data.entityId ?? null,
    details: data.details,
  };
  const [row] = await tx
    .insert(opsFlags)
    .values({
      id: newId(),
      organizationId: ctx.orgId,
      kind: data.kind,
      dedupeKey: data.dedupeKey,
      ...values,
    })
    .onConflictDoUpdate({
      target: [opsFlags.organizationId, opsFlags.kind, opsFlags.dedupeKey],
      targetWhere: OPEN_FLAG_TARGET_WHERE,
      set: {
        severity: sql`excluded.severity`,
        entityType: sql`excluded.entity_type`,
        entityId: sql`excluded.entity_id`,
        details: sql`excluded.details`,
        updatedAt: sql`now()`,
      },
      // Skip the write (and the event) when nothing changed.
      setWhere: sql`(${opsFlags.severity}, ${opsFlags.entityType}, ${opsFlags.entityId}, ${opsFlags.details})
        is distinct from
        (excluded.severity, excluded.entity_type, excluded.entity_id, excluded.details)`,
    })
    .returning({ ...getTableColumns(opsFlags), inserted: sql<boolean>`(xmax = 0)` });

  if (!row) {
    // The open flag exists and already holds this data (ON CONFLICT locked it, so it is still open).
    const [existing] = await tx
      .select()
      .from(opsFlags)
      .where(
        and(
          eq(opsFlags.kind, data.kind),
          eq(opsFlags.dedupeKey, data.dedupeKey),
          eq(opsFlags.status, 'open'),
        ),
      );
    if (!existing) {
      throw new Error(`Open flag ${data.kind}/${data.dedupeKey} vanished during upsert`);
    }
    return { flag: existing, outcome: 'unchanged' };
  }

  const { inserted, ...flag } = row;
  await recordActivity(tx, ctx, {
    entityType: 'ops_flag',
    entityId: flag.id,
    eventType: inserted ? 'ops_flag.raised' : 'ops_flag.updated',
    payload: { kind: flag.kind, dedupeKey: flag.dedupeKey, ...values },
  });
  return { flag, outcome: inserted ? 'created' : 'updated' };
}

export const ResolveFlagSchema = z.object({
  status: z.enum(['resolved', 'dismissed']),
  note: z.string().trim().max(2000).optional(),
});
export type ResolveFlagInput = z.input<typeof ResolveFlagSchema>;

/**
 * Closes an open flag as `resolved` or `dismissed` (by `ctx.userId`). ConflictError if it is not
 * open. Once closed, the same situation can raise a new flag.
 */
export async function resolveFlag(
  tx: Tx,
  ctx: ActorContext,
  flagId: string,
  input: ResolveFlagInput,
): Promise<OpsFlag> {
  const data = parseInput(ResolveFlagSchema, input);
  const [current] = await tx.select().from(opsFlags).where(eq(opsFlags.id, flagId)).for('update');
  if (!current) {
    throw new NotFoundError('ops_flag', flagId);
  }
  if (current.status !== 'open') {
    throw new ConflictError(`The flag is already ${current.status}`, {
      details: { status: current.status },
    });
  }
  const [row] = await tx
    .update(opsFlags)
    .set({ status: data.status, resolvedBy: ctx.userId ?? null, resolvedAt: sql`now()` })
    .where(eq(opsFlags.id, flagId))
    .returning();
  if (!row) {
    throw new NotFoundError('ops_flag', flagId);
  }
  await recordActivity(tx, ctx, {
    entityType: 'ops_flag',
    entityId: flagId,
    eventType: data.status === 'resolved' ? 'ops_flag.resolved' : 'ops_flag.dismissed',
    payload: { kind: row.kind, dedupeKey: row.dedupeKey, note: data.note ?? null },
  });
  return row;
}

export interface FlagFilter {
  status?: FlagStatus;
  entityType?: string;
  entityId?: string;
}

/** Flags of the current organization, newest first (the exception queue: `{ status: 'open' }`). */
export async function listFlags(tx: Tx, filter: FlagFilter = {}): Promise<OpsFlag[]> {
  const conditions: SQL[] = [];
  if (filter.status !== undefined) conditions.push(eq(opsFlags.status, filter.status));
  if (filter.entityType !== undefined) conditions.push(eq(opsFlags.entityType, filter.entityType));
  if (filter.entityId !== undefined) conditions.push(eq(opsFlags.entityId, filter.entityId));
  return tx
    .select()
    .from(opsFlags)
    .where(and(...conditions))
    .orderBy(desc(opsFlags.id));
}
