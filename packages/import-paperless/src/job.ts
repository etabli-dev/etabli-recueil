/**
 * The import as a `jobs` row (P9, `spec/data-model.md` §6.3, invariants IK1–IK4).
 *
 * The shape is the Zotero importer's, because the invariants are the same ones and two importers
 * that resume differently would be two things to get wrong. What differs is what the key is built
 * from and what the cursor carries, and both differences come from the source being a *server*
 * rather than a file.
 *
 * **The key is the server's identity, not its contents.** `import.paperless:<server_hash>:<label>`,
 * where the hash is over the API root — scheme, host, port, path. Hashing the library instead would
 * mean an import interrupted on Monday could not be resumed on Tuesday if anyone had filed a single
 * document in between, which is exactly when resuming matters.
 *
 * **The cursor carries a document id, not only an index.** Zotero reads a file, so restarting a
 * stage from its beginning is cheap; Paperless is fetched over HTTP one original at a time, and
 * re-downloading four thousand PDFs to get back to where a run stopped is not a resume, it is a
 * re-run. Paperless document ids are monotonic and the walk is `ordering=id`, so "the last document
 * this run finished" is a resume point that survives documents being added or deleted in between:
 * a new document sorts after everything the first attempt saw, and a deleted one simply is not
 * there. Re-processing the checkpoint document itself is harmless (IK4), because every write the
 * importer makes is keyed — an item by `(source_system, source_id)`, a document by the SHA-256 of
 * its bytes, a tag by its name, a custom-field value by its slot.
 */
import { createHash } from 'node:crypto';

import { newId, nowTimestamp, schema } from '@recueil/core';
import type { Recueil } from '@recueil/core';
import { and, eq } from 'drizzle-orm';

/** `jobs.job_type` for this importer. Open vocabulary (§6.3). */
export const JOB_TYPE = 'import.paperless';

/** The stages of an import, in the order they run. The cursor names one of these. */
export const IMPORT_STAGES = [
  /** Correspondents, document types, tags and storage paths: everything documents refer to. */
  'vocabularies',
  /** The Recueil custom-field definitions, which document values need before they can be written. */
  'custom_fields',
  /** One pass per document: item, office facet, tags, notes, original, values. */
  'documents',
  /** `documentlink` values, which need every item on both ends to exist. */
  'links',
  /** The values the services will not take as arguments — `items.date_modified`. */
  'finalise',
] as const;

export type ImportStage = (typeof IMPORT_STAGES)[number];

export interface ImportCursor {
  stage: ImportStage;
  /** How many records of that stage had been written when the cursor was last flushed. */
  index: number;
  /** The highest Paperless document id this run has finished. 0 before the first one. */
  lastDocumentId: number;
}

export interface ImportProgress extends ImportCursor {
  /** How many records this stage has in total, when that is known before it starts. */
  total: number;
}

/** The key IK1 prescribes for this job type. */
export const importIdempotencyKey = (serverHash: string, runLabel: string): string =>
  `${JOB_TYPE}:${serverHash}:${runLabel}`;

/** A Paperless server's identity, hashed: scheme, host, port and path of the API root. */
export const serverHash = (apiRoot: URL): string =>
  createHash('sha256')
    .update(`${apiRoot.origin}${apiRoot.pathname}`)
    .digest('hex')
    .slice(0, 32);

export interface ImportJobHandle {
  id: string;
  idempotencyKey: string;
  attempt: number;
  /** The cursor this run inherited, or null for a run that starts from the beginning. */
  resumedFrom: ImportCursor | null;
}

/**
 * Claim the job for this run: create it, or take over the one that already exists for this server
 * and run label.
 *
 * A finished run that is asked for again starts over with a null cursor and re-verifies the whole
 * library — which costs a re-download and produces the same library, and is the honest reading of
 * "re-running an import is safe". An unfinished one is resumed from where it stopped.
 */
export const claimImportJob = (
  recueil: Recueil,
  input: { idempotencyKey: string; params: Record<string, unknown> },
): ImportJobHandle => {
  const now = nowTimestamp();

  return recueil.db.transaction((tx) => {
    const existing = tx
      .select()
      .from(schema.jobs)
      .where(eq(schema.jobs.idempotencyKey, input.idempotencyKey))
      .get();

    if (existing === undefined) {
      const id = newId();
      tx.insert(schema.jobs)
        .values({
          id,
          jobType: JOB_TYPE,
          idempotencyKey: input.idempotencyKey,
          params: JSON.stringify(input.params),
          state: 'running',
          priority: 0,
          runAfter: now,
          startedAt: now,
          heartbeatAt: now,
          attempts: 1,
          maxAttempts: 100,
          progressDone: 0,
          rootJobId: null,
          createdByUserId: recueil.user.id,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      return { id, idempotencyKey: input.idempotencyKey, attempt: 1, resumedFrom: null };
    }

    const resumedFrom = existing.state === 'succeeded' ? null : parseCursor(existing.cursor);
    const attempt = existing.attempts + 1;
    tx.update(schema.jobs)
      .set({
        state: 'running',
        params: JSON.stringify(input.params),
        startedAt: existing.startedAt ?? now,
        finishedAt: null,
        heartbeatAt: now,
        attempts: attempt,
        // `ck_jobs_attempts` caps attempts at `max_attempts`, and an import that a person keeps
        // re-running is not a failing job in need of a dead-letter queue.
        maxAttempts: Math.max(existing.maxAttempts, attempt),
        cursor: resumedFrom === null ? null : existing.cursor,
        errorCode: null,
        errorMessage: null,
        errorDetail: null,
        updatedAt: now,
      })
      .where(eq(schema.jobs.id, existing.id))
      .run();

    return { id: existing.id, idempotencyKey: input.idempotencyKey, attempt, resumedFrom };
  });
};

/** Write the resume point. Called after every record, which is what makes IK4's guarantee true. */
export const checkpoint = (recueil: Recueil, jobId: string, cursor: ImportCursor, done: number): void => {
  const now = nowTimestamp();
  recueil.db
    .update(schema.jobs)
    .set({
      cursor: JSON.stringify(cursor),
      progressDone: done,
      heartbeatAt: now,
      updatedAt: now,
    })
    .where(eq(schema.jobs.id, jobId))
    .run();
};

export const setProgressTotal = (recueil: Recueil, jobId: string, total: number): void => {
  recueil.db
    .update(schema.jobs)
    .set({ progressTotal: total, updatedAt: nowTimestamp() })
    .where(eq(schema.jobs.id, jobId))
    .run();
};

export const finishJob = (
  recueil: Recueil,
  jobId: string,
  outcome:
    | { state: 'succeeded'; result: Record<string, unknown> }
    | { state: 'cancelled' }
    | { state: 'failed'; errorCode: string; errorMessage: string },
): void => {
  const now = nowTimestamp();
  const patch: Record<string, unknown> = { state: outcome.state, finishedAt: now, updatedAt: now };
  if (outcome.state === 'succeeded') patch['result'] = JSON.stringify(outcome.result);
  if (outcome.state === 'failed') {
    patch['errorCode'] = outcome.errorCode;
    patch['errorMessage'] = outcome.errorMessage;
  }
  recueil.db.update(schema.jobs).set(patch).where(eq(schema.jobs.id, jobId)).run();
};

/**
 * A line in the job log (§6.4).
 *
 * `subject_type`/`subject_id` are indexed precisely so that "what happened to this document during
 * the import" is one query, which is what makes the review entries of P3 answerable after the run
 * as well as inside the report.
 */
export const logJob = (
  recueil: Recueil,
  jobId: string,
  entry: {
    level: 'debug' | 'info' | 'warn' | 'error';
    message: string;
    data?: Record<string, unknown>;
    subjectType?: string;
    subjectId?: string;
  },
): void => {
  recueil.db
    .insert(schema.jobLogs)
    .values({
      id: newId(),
      jobId,
      loggedAt: nowTimestamp(),
      level: entry.level,
      message: entry.message,
      data: entry.data === undefined ? null : JSON.stringify(entry.data),
      subjectType: entry.subjectType ?? null,
      subjectId: entry.subjectId ?? null,
    })
    .run();
};

/**
 * Drop this job's log rows.
 *
 * Called only when a run starts from the beginning, never when it resumes. The log is where the
 * verification report's observations live (§6.4), so a fresh run has to clear the previous
 * attempt's — they describe a server state that is about to be re-observed — while a resumed run
 * must keep them, because they are the record of the documents it is about to skip. `job_logs` is
 * operational telemetry rather than library data, so P5 does not reach it.
 */
export const clearJobLog = (recueil: Recueil, jobId: string): void => {
  recueil.db.delete(schema.jobLogs).where(eq(schema.jobLogs.jobId, jobId)).run();
};

/** The job row for a key, for a caller that wants to inspect a previous run. */
export const findImportJob = (recueil: Recueil, idempotencyKey: string) =>
  recueil.db
    .select()
    .from(schema.jobs)
    .where(and(eq(schema.jobs.jobType, JOB_TYPE), eq(schema.jobs.idempotencyKey, idempotencyKey)))
    .get();

const STAGE_SET: ReadonlySet<string> = new Set<string>(IMPORT_STAGES);

const parseCursor = (raw: string | null): ImportCursor | null => {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { stage, index, lastDocumentId } = parsed as {
      stage?: unknown;
      index?: unknown;
      lastDocumentId?: unknown;
    };
    if (typeof stage !== 'string' || !STAGE_SET.has(stage)) return null;
    return {
      stage: stage as ImportStage,
      index: typeof index === 'number' && Number.isSafeInteger(index) && index >= 0 ? index : 0,
      lastDocumentId:
        typeof lastDocumentId === 'number' &&
        Number.isSafeInteger(lastDocumentId) &&
        lastDocumentId >= 0
          ? lastDocumentId
          : 0,
    };
  } catch {
    return null;
  }
};
