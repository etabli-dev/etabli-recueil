/**
 * The audit log (§6.5, P5).
 *
 * Every mutation goes through `record`, in the same transaction as the write it describes. That is
 * the whole design: if the write commits, the audit row commits, and if either fails both roll
 * back. There is no "log it afterwards" path, because a log that can be skipped is a log nobody can
 * reason from.
 *
 * `before`/`after` carry the changed fields only, not the whole row (AL4). A full snapshot is
 * reconstructed by replaying, or read from `trash.restore_payload` for a trashed entity.
 */
import { desc, eq } from 'drizzle-orm';

import type { RecueilDatabase } from '../db/client.js';
import { auditLog } from '../db/schema.js';
import type { AuditLogRow } from '../db/schema.js';
import { newId } from '../ids.js';
import { nowTimestamp } from '../time.js';
import type { Actor } from './actor.js';
import { actorColumns } from './actor.js';

/** A JSON-serialisable delta. */
export type AuditDelta = Record<string, unknown> | null;

export interface AuditEntry {
  actor: Actor;
  /** Dotted verb: `item.created`, `document.ingested`, `item.trashed`, `item.conflict`. */
  action: string;
  entityType: string;
  entityId: string;
  before?: AuditDelta;
  after?: AuditDelta;
  reason?: string | null;
  occurredAt?: string;
}

/** Anything that can execute a Drizzle insert: the database, or a transaction on it. */
export type Executor = Pick<RecueilDatabase, 'insert' | 'select' | 'update' | 'delete'>;

export class AuditService {
  constructor(private readonly db: RecueilDatabase) {}

  /**
   * Write one audit row. Pass the transaction as `executor` — the default is the bare connection,
   * which is correct only for a write that is itself a single statement.
   */
  record(entry: AuditEntry, executor: Executor = this.db): string {
    const id = newId();
    executor
      .insert(auditLog)
      .values({
        id,
        occurredAt: entry.occurredAt ?? nowTimestamp(),
        ...actorColumns(entry.actor),
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId,
        before: serialise(entry.before),
        after: serialise(entry.after),
        reason: entry.reason ?? null,
        requestId: entry.actor.requestId ?? null,
        apiRoute: entry.actor.apiRoute ?? null,
        ipAddress: entry.actor.ipAddress ?? null,
        userAgent: entry.actor.userAgent ?? null,
      })
      .run();
    return id;
  }

  /** The history of one entity, newest first. Reading is what the log is for. */
  forEntity(entityType: string, entityId: string, limit = 100): AuditLogRow[] {
    return this.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.entityType, entityType))
      .orderBy(desc(auditLog.id))
      .limit(limit)
      .all()
      .filter((row) => row.entityId === entityId);
  }
}

const serialise = (value: AuditDelta | undefined): string | null =>
  value === undefined || value === null ? null : JSON.stringify(value);

/**
 * The changed fields of an update, as the pair AL4 wants: only keys whose value actually moved.
 * An update that changes nothing produces `null` on both sides and is not worth a row.
 */
export const diffFields = <TRow extends Record<string, unknown>>(
  before: TRow,
  after: Partial<TRow>,
): { before: AuditDelta; after: AuditDelta } => {
  const changedBefore: Record<string, unknown> = {};
  const changedAfter: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(after)) {
    if (Object.is(before[key], value)) continue;
    changedBefore[key] = before[key] ?? null;
    changedAfter[key] = value ?? null;
  }

  if (Object.keys(changedAfter).length === 0) return { before: null, after: null };
  return { before: changedBefore, after: changedAfter };
};
