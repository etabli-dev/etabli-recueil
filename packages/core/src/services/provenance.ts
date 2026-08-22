/**
 * Field-level provenance and the manual lock (§3.6, P4).
 *
 * CONCEPT.md §5.4 promises that "manual edits are locked per field and never overwritten". P4-1
 * turns that from a code path into a property of the data: **every** write to a bibliographic or
 * office field leaves a `field_provenance` row saying where the value came from, when, and with
 * what confidence, and a write a human made is locked by the act of making it.
 *
 * The four rules, restated as the code enforces them:
 *
 * - **P4-1.** Every write records provenance. A hand-typed value gets `source = 'manual'` and
 *   `locked = 1`; a resolver's gets its own source and stays unlocked unless asked otherwise.
 * - **P4-2.** A resolver may write a field only when there is no row for it, or the row is
 *   unlocked. The lock is not overridable by configuration — `mayWrite` has no escape hatch, and a
 *   caller who wants one has to present a manual source, which is to say: a human.
 * - **P4-3.** Unlocking is an explicit action and is audited. Clearing a field does not clear its
 *   provenance: `previous_value` is retained, which is what makes "what used to be here, and who
 *   said so" answerable after the value is gone.
 * - **P4-4.** A write that is refused is *reported*, never silently dropped. `applyStamps` returns
 *   the skipped fields with the source that holds each lock, and `LibraryService` passes that up to
 *   its caller. A bulk enrichment run that overwrites nothing and says nothing is a bug.
 *
 * The table is generic over the entity (`item_bibliographic`, `item_office`, `creator`,
 * `item_creator`) rather than three parallel designs, so a resolver asks one question whatever it
 * is resolving.
 *
 * Field paths are the **camelCase** property names of the wire contract, not the snake_case column
 * names: `containerTitle`, not `container_title`. That is what `FieldPathSchema` accepts (an
 * underscore is not in its character class), and it is what a client sees, so it is what the
 * provenance map is keyed by.
 */
import { and, asc, eq } from 'drizzle-orm';

import type { RecueilDatabase } from '../db/client.js';
import { PROVENANCE_ENTITY_TYPES, fieldProvenance } from '../db/schema.js';
import type { FieldProvenanceRow } from '../db/schema.js';
import { ValidationError } from '../errors.js';
import { newId } from '../ids.js';
import { nowTimestamp } from '../time.js';
import type { Actor } from './actor.js';
import type { AuditService, Executor } from './audit.js';

export type ProvenanceEntityType = (typeof PROVENANCE_ENTITY_TYPES)[number];

/** The source slug of a hand-made edit. The one value that overrides a manual lock. */
export const MANUAL_SOURCE = 'manual';

/** Is this write a human's? Manual and only manual may pass a lock (P4-2). */
export const isManualSource = (source: string): boolean =>
  source === MANUAL_SOURCE || source.startsWith('manual:');

/**
 * Where a value came from, as a caller declares it.
 *
 * `lock` defaults to "true when the source is manual", which is P4-1's second sentence written as
 * a default rather than as something every caller has to remember.
 */
export interface ProvenanceStamp {
  /** `manual`, `crossref`, `openalex`, `import:zotero`, `plugin:<name>` … (open vocabulary). */
  source: string;
  sourceRecordId?: string | null;
  sourceVersion?: string | null;
  confidence?: number | null;
  /** When the value was obtained upstream. Defaults to the moment it is applied. */
  fetchedAt?: string;
  /** Override the default: manual writes lock, automated writes do not. */
  lock?: boolean;
}

/** The default stamp for a write whose caller said nothing: a human, typing, locking as they go. */
export const manualStamp = (): ProvenanceStamp => ({ source: MANUAL_SOURCE, lock: true });

/** A field an automated write was not allowed to touch, and who holds the lock (P4-4). */
export interface SkippedField {
  fieldPath: string;
  /** The source of the value that is protecting the field. */
  lockedBy: string;
  lockedAt: string | null;
}

export interface ApplyStampsInput {
  entityType: ProvenanceEntityType;
  entityId: string;
  /** `fieldPath -> the value that was written`, for `previous_value` bookkeeping. */
  values: Record<string, unknown>;
  /** The values as they were before the write, for the same. */
  previous: Record<string, unknown>;
  stamp: ProvenanceStamp;
  appliedAt: string;
  actor: Actor;
}

export class ProvenanceService {
  constructor(
    private readonly db: RecueilDatabase,
    private readonly audit: AuditService,
  ) {}

  /* ---------------------------------------------------------------------------------------- */
  /* Read                                                                                        */
  /* ---------------------------------------------------------------------------------------- */

  /** Every current provenance row for an entity, in field-path order. */
  forEntity(entityType: ProvenanceEntityType, entityId: string): FieldProvenanceRow[] {
    return this.db
      .select()
      .from(fieldProvenance)
      .where(
        and(eq(fieldProvenance.entityType, entityType), eq(fieldProvenance.entityId, entityId)),
      )
      .orderBy(asc(fieldProvenance.fieldPath))
      .all();
  }

  /** The same rows as the map a facet carries on the wire (`FieldProvenanceMap`). */
  map(entityType: ProvenanceEntityType, entityId: string): Record<string, FieldProvenanceRow> {
    const out: Record<string, FieldProvenanceRow> = {};
    for (const row of this.forEntity(entityType, entityId)) out[row.fieldPath] = row;
    return out;
  }

  /** One row, or undefined when the field has never been written. */
  get(
    entityType: ProvenanceEntityType,
    entityId: string,
    fieldPath: string,
    executor: Executor = this.db,
  ): FieldProvenanceRow | undefined {
    return executor
      .select()
      .from(fieldProvenance)
      .where(
        and(
          eq(fieldProvenance.entityType, entityType),
          eq(fieldProvenance.entityId, entityId),
          eq(fieldProvenance.fieldPath, fieldPath),
        ),
      )
      .get();
  }

  /** The fields locked against resolver writes — the projection the item pane asks for. */
  lockedFields(entityType: ProvenanceEntityType, entityId: string): string[] {
    return this.forEntity(entityType, entityId)
      .filter((row) => row.locked)
      .map((row) => row.fieldPath);
  }

  /**
   * May a write from this source touch this field? (P4-2.)
   *
   * There is no third answer and no configuration flag. Either the field is unwritten, or its row
   * is unlocked, or the incoming write is a human's.
   */
  mayWrite(
    entityType: ProvenanceEntityType,
    entityId: string,
    fieldPath: string,
    source: string,
    executor: Executor = this.db,
  ): boolean {
    if (isManualSource(source)) return true;
    const current = this.get(entityType, entityId, fieldPath, executor);
    return current === undefined || !current.locked;
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Write                                                                                       */
  /* ---------------------------------------------------------------------------------------- */

  /**
   * Split a proposed set of field writes into the ones the locks allow and the ones they do not.
   *
   * Called *before* the facet columns are written, so that a refused field is never applied and
   * then rolled back — the caller writes only `allowed` and reports `skipped`.
   */
  partition(
    entityType: ProvenanceEntityType,
    entityId: string,
    fieldPaths: readonly string[],
    source: string,
    executor: Executor = this.db,
  ): { allowed: string[]; skipped: SkippedField[] } {
    const allowed: string[] = [];
    const skipped: SkippedField[] = [];

    for (const fieldPath of fieldPaths) {
      if (isManualSource(source)) {
        allowed.push(fieldPath);
        continue;
      }
      const current = this.get(entityType, entityId, fieldPath, executor);
      if (current === undefined || !current.locked) {
        allowed.push(fieldPath);
        continue;
      }
      skipped.push({
        fieldPath,
        lockedBy: current.source,
        lockedAt: current.lockedAt,
      });
    }

    return { allowed, skipped };
  }

  /**
   * Record provenance for a set of fields that have just been written (P4-1).
   *
   * Upsert semantics on `(entity_type, entity_id, field_path)`: one current row per field, and the
   * value it replaced goes into `previous_value` so that a per-field history is one indexed query
   * rather than an audit replay. Must be called inside the same transaction as the facet write —
   * that is what makes "every write records provenance" true rather than usually true.
   */
  applyStamps(executor: Executor, input: ApplyStampsInput): FieldProvenanceRow[] {
    const { entityType, entityId, stamp, appliedAt, actor } = input;
    const locked = stamp.lock ?? isManualSource(stamp.source);
    const fetchedAt = stamp.fetchedAt ?? appliedAt;
    const written: FieldProvenanceRow[] = [];

    for (const fieldPath of Object.keys(input.values)) {
      const current = this.get(entityType, entityId, fieldPath, executor);
      const previousValue = asProvenanceText(
        Object.prototype.hasOwnProperty.call(input.previous, fieldPath)
          ? input.previous[fieldPath]
          : (current?.previousValue ?? null),
      );

      const row: FieldProvenanceRow = {
        id: current?.id ?? newId(),
        entityType,
        entityId,
        fieldPath,
        source: stamp.source,
        sourceRecordId: stamp.sourceRecordId ?? null,
        sourceVersion: stamp.sourceVersion ?? null,
        confidence: stamp.confidence ?? null,
        fetchedAt,
        appliedAt,
        // A field already locked stays locked: an unlock is an explicit action (P4-3), never a
        // side effect of a later resolver write that the lock happened to let through.
        locked: locked || (current?.locked ?? false),
        lockedAt: null,
        lockedByUserId: null,
        previousValue,
      };
      if (row.locked) {
        row.lockedAt = current?.locked === true ? (current.lockedAt ?? appliedAt) : appliedAt;
        row.lockedByUserId =
          current?.locked === true ? current.lockedByUserId : (actor.userId ?? null);
      }

      if (current === undefined) {
        executor.insert(fieldProvenance).values(row).run();
      } else {
        executor
          .update(fieldProvenance)
          .set({
            source: row.source,
            sourceRecordId: row.sourceRecordId,
            sourceVersion: row.sourceVersion,
            confidence: row.confidence,
            fetchedAt: row.fetchedAt,
            appliedAt: row.appliedAt,
            locked: row.locked,
            lockedAt: row.lockedAt,
            lockedByUserId: row.lockedByUserId,
            previousValue: row.previousValue,
          })
          .where(eq(fieldProvenance.id, row.id))
          .run();
      }

      written.push(row);
    }

    return written;
  }

  /**
   * Lock a field by hand, without changing its value (P4-1).
   *
   * Useful when a resolver got a field right and the user wants to stop a later run second-guessing
   * it. Locking a field that was never written is refused: there is nothing to protect, and an
   * empty lock would silently block the first correct value from arriving.
   */
  lock(
    entityType: ProvenanceEntityType,
    entityId: string,
    fieldPath: string,
    actor: Actor,
  ): FieldProvenanceRow {
    return this.db.transaction((tx) => {
      const current = this.get(entityType, entityId, fieldPath, tx);
      if (current === undefined) {
        throw new ValidationError(
          `No provenance row for '${fieldPath}' on ${entityType} '${entityId}', so there is ` +
            'nothing to lock. Write the field first; a manual write locks it (P4-1).',
          { entityType, entityId, fieldPath },
        );
      }
      if (current.locked) return current;

      const now = nowTimestamp();
      tx.update(fieldProvenance)
        .set({ locked: true, lockedAt: now, lockedByUserId: actor.userId ?? null })
        .where(eq(fieldProvenance.id, current.id))
        .run();

      this.audit.record(
        {
          actor,
          action: 'field.locked',
          entityType: 'field_provenance',
          entityId: current.id,
          before: { locked: false },
          after: { locked: true, entityType, subjectId: entityId, fieldPath },
          reason: 'manual lock (P4-2)',
        },
        tx,
      );

      return { ...current, locked: true, lockedAt: now, lockedByUserId: actor.userId ?? null };
    });
  }

  /** Unlock a field. An explicit user action, recorded in the audit log (P4-3). */
  unlock(
    entityType: ProvenanceEntityType,
    entityId: string,
    fieldPath: string,
    actor: Actor,
  ): FieldProvenanceRow {
    return this.db.transaction((tx) => {
      const current = this.get(entityType, entityId, fieldPath, tx);
      if (current === undefined) {
        throw new ValidationError(
          `No provenance row for '${fieldPath}' on ${entityType} '${entityId}'.`,
          { entityType, entityId, fieldPath },
        );
      }
      if (!current.locked) return current;

      tx.update(fieldProvenance)
        .set({ locked: false, lockedAt: null, lockedByUserId: null })
        .where(eq(fieldProvenance.id, current.id))
        .run();

      this.audit.record(
        {
          actor,
          action: 'field.unlocked',
          entityType: 'field_provenance',
          entityId: current.id,
          before: { locked: true, lockedAt: current.lockedAt },
          after: { locked: false, entityType, subjectId: entityId, fieldPath },
          reason: 'explicit unlock (P4-3)',
        },
        tx,
      );

      return { ...current, locked: false, lockedAt: null, lockedByUserId: null };
    });
  }
}

/**
 * A value as `previous_value` stores it: text, always, because the column is one column for
 * thirteen data types. `null` stays `null` — "there was nothing here" is a fact worth keeping
 * distinct from "there was an empty string here".
 */
export const asProvenanceText = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
};
