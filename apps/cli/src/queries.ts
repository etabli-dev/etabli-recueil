/**
 * The four reads that `packages/core` does not expose as a service method.
 *
 * Same rule as `apps/server/src/queries.ts`: **no business logic here, and nothing writes.** Each
 * function below is a lookup the service layer has no method for yet — "is this DOI taken", "which
 * item did this entry key produce last time", "was an import of this file interrupted" — and each
 * exists because the alternative is worse, not because the CLI is entitled to reach past the
 * services. When `packages/core` grows the method, or when the Phase 1 `job` command arrives with a
 * job service behind it, these should be deleted rather than extended.
 *
 * They are gathered in one file so that "what does the CLI touch directly" is a question with a
 * short answer.
 */
import { schema } from '@recueil/core';
import type { Recueil } from '@recueil/core';
import { and, eq, isNull } from 'drizzle-orm';

/** A live item already holding this DOI, if there is one (invariant B1). */
export const itemWithDoi = (recueil: Recueil, doi: string): string | undefined =>
  recueil.db
    .select({ itemId: schema.itemBibliographic.itemId })
    .from(schema.itemBibliographic)
    .where(and(eq(schema.itemBibliographic.doi, doi), isNull(schema.itemBibliographic.itemTrashedAt)))
    .get()?.itemId;

/** A live item already holding this citation key, if there is one (ADR-0016). */
export const itemWithCitationKey = (recueil: Recueil, key: string): string | undefined =>
  recueil.db
    .select({ itemId: schema.itemBibliographic.itemId })
    .from(schema.itemBibliographic)
    .where(
      and(eq(schema.itemBibliographic.citationKey, key), isNull(schema.itemBibliographic.itemTrashedAt)),
    )
    .get()?.itemId;

/**
 * The live item a previous import of this source produced.
 *
 * `(source_system, source_id)` is the key that makes a re-import an update rather than a duplicate
 * (P9). There is no index-backed service lookup for it yet.
 */
export const itemFromSource = (
  recueil: Recueil,
  sourceSystem: string,
  sourceId: string,
): string | undefined =>
  recueil.db
    .select({ id: schema.items.id })
    .from(schema.items)
    .where(
      and(
        eq(schema.items.sourceSystem, sourceSystem),
        eq(schema.items.sourceId, sourceId),
        isNull(schema.items.trashedAt),
      ),
    )
    .get()?.id;

export interface InterruptedImport {
  readonly jobId: string;
  readonly stage: string;
  readonly index: number;
  readonly attempts: number;
}

/**
 * An import of this Zotero library that stopped part way.
 *
 * Matched on the database path recorded in the job's parameters rather than by recomputing the
 * idempotency key, because recomputing it means opening `zotero.sqlite` before deciding whether we
 * are going to be allowed to. The point is only to notice the interrupted run and put the decision
 * in the operator's hands.
 */
export const findInterruptedZoteroImport = (
  recueil: Recueil,
  databasePath: string,
): InterruptedImport | null => {
  const rows = recueil.db
    .select()
    .from(schema.jobs)
    .where(eq(schema.jobs.jobType, 'import.zotero'))
    .all();

  for (const row of rows) {
    if (row.state === 'succeeded' || row.cursor === null) continue;

    let recorded: unknown;
    try {
      recorded = (JSON.parse(row.params ?? '{}') as { databasePath?: unknown }).databasePath;
    } catch {
      continue;
    }
    if (typeof recorded !== 'string' || recorded !== databasePath) continue;

    let cursor: { stage?: unknown; index?: unknown } = {};
    try {
      cursor = JSON.parse(row.cursor) as { stage?: unknown; index?: unknown };
    } catch {
      cursor = {};
    }

    return {
      jobId: row.id,
      stage: typeof cursor.stage === 'string' ? cursor.stage : 'unknown',
      index: typeof cursor.index === 'number' ? cursor.index : 0,
      attempts: row.attempts,
    };
  }
  return null;
};
