/**
 * The `trash` table, as the services see it (§1.5, §6.6, P5).
 *
 * Invariant T1 is the reason this is a shared module rather than a private method on each service:
 * `trashed_at IS NOT NULL` on an entity if and only if there is an open row here for it, and the
 * two are written in one transaction. Six services now soft-delete something, and six copies of
 * "insert a trash row" is six chances for one of them to forget the `group_id`, the reason or the
 * restore payload.
 *
 * A restore does not delete the trash row. It stamps `restored_at`, so that "this was in the trash
 * from Tuesday to Thursday" survives, and so that `ux_trash_open` — partial on `restored_at IS NULL
 * AND purged_at IS NULL` — lets the same entity be trashed again later.
 */
import { and, eq, isNull } from 'drizzle-orm';

import { TRASH_ENTITY_TYPES, TRASH_REASONS, trash } from '../db/schema.js';
import type { TrashRow } from '../db/schema.js';
import { newId } from '../ids.js';
import type { Executor } from './audit.js';

export type TrashEntityType = (typeof TRASH_ENTITY_TYPES)[number];
export type TrashReason = (typeof TRASH_REASONS)[number];

/**
 * Anything that can run the statements here: the database, or a transaction on it. The same
 * `Executor` the audit log takes, because a trash row and its audit row are always written
 * together, by the same caller, into the same transaction.
 */
export type { Executor } from './audit.js';

export interface TrashOptions {
  reason?: TrashReason;
  reasonDetail?: string | null;
  /** Set when `reason` is `merge`: the winner (§6.6). */
  mergeTargetItemId?: string | null;
  /** Field-by-field account of what the winner took, so a merge reverses field by field. */
  mergeRecord?: Record<string, unknown> | null;
}

export interface OpenTrashRecordInput extends TrashOptions {
  entityType: TrashEntityType;
  entityId: string;
  /** Groups the rows written by one cascading trash, so a restore puts back what went together. */
  groupId: string;
  trashedAt: string;
  trashedByUserId: string | null;
  /** Everything needed to undo: detached memberships, tag assignments, previous parents. */
  restorePayload?: Record<string, unknown>;
}

/** One open `trash` row — the other half of invariant T1. */
export const openTrashRecord = (tx: Executor, input: OpenTrashRecordInput): string => {
  const id = newId();
  tx.insert(trash)
    .values({
      id,
      entityType: input.entityType,
      entityId: input.entityId,
      groupId: input.groupId,
      trashedAt: input.trashedAt,
      trashedByUserId: input.trashedByUserId,
      reason: input.reason ?? 'user',
      reasonDetail: input.reasonDetail ?? null,
      restorePayload: JSON.stringify(input.restorePayload ?? {}),
      mergeTargetItemId: input.mergeTargetItemId ?? null,
      mergeRecord: input.mergeRecord === undefined || input.mergeRecord === null
        ? null
        : JSON.stringify(input.mergeRecord),
    })
    .run();
  return id;
};

/** The open record for an entity, if it has one. */
export const findOpenTrashRecord = (
  tx: Executor,
  entityType: TrashEntityType,
  entityId: string,
): TrashRow | undefined =>
  tx
    .select()
    .from(trash)
    .where(
      and(
        eq(trash.entityType, entityType),
        eq(trash.entityId, entityId),
        isNull(trash.restoredAt),
        isNull(trash.purgedAt),
      ),
    )
    .get();

/** Every open record written by one cascading trash. */
export const findTrashGroup = (tx: Executor, groupId: string): TrashRow[] =>
  tx
    .select()
    .from(trash)
    .where(and(eq(trash.groupId, groupId), isNull(trash.restoredAt), isNull(trash.purgedAt)))
    .all();

/** Close a record: the entity is back, and the row becomes history rather than disappearing. */
export const closeTrashRecord = (
  tx: Executor,
  trashId: string,
  restoredAt: string,
  restoredByUserId: string | null,
): void => {
  tx.update(trash).set({ restoredAt, restoredByUserId }).where(eq(trash.id, trashId)).run();
};

/** The restore payload, parsed. A malformed payload is treated as an empty one, never as a crash. */
export const readRestorePayload = (row: TrashRow): Record<string, unknown> => {
  try {
    const parsed: unknown = JSON.parse(row.restorePayload);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* fall through */
  }
  return {};
};
