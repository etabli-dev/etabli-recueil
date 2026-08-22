/**
 * Idempotency keys for bulk writes (P9, `spec/data-model.md` §6.3 IK1–IK3).
 *
 * IK2 says it exactly: "Bulk API endpoints accept an `Idempotency-Key` header; the server stores it
 * as `api:<token_id>:<header value>`. A repeat with the same key returns the original job —
 * including its `result` — rather than enqueuing a second one. This is what makes a retried mobile
 * upload or a flaky CLI run safe."
 *
 * The store is the `jobs` table, and that is not a stretch of it: a bulk call *is* a job, it just
 * happens to run inline rather than being claimed by a worker. It gets a row with the key on it,
 * `state = 'succeeded'` and the response document in `result`, and `ux_jobs_idempotency_key` — a
 * global unique index — is what makes the replay check a single lookup rather than a race.
 *
 * IK3, re-runs: `force = true` appends a run counter to the key, so nothing is ever silently
 * duplicated and nothing silently skipped.
 *
 * The key is scoped by token because that is what §6.3 says, and the reason is worth keeping in
 * mind: a client's key only has to be unique to itself, so a CLI and a mobile app may both send
 * `1` without colliding. A request with no token — the single-user default — is scoped to `local`.
 */
import { newId, nowTimestamp, schema } from '@recueil/core';
import type { Actor, AuditService, RecueilDatabase } from '@recueil/core';
import { and, eq, like } from 'drizzle-orm';

export interface ReplayOrRecordInput<TResult> {
  readonly db: RecueilDatabase;
  readonly audit: AuditService;
  readonly actor: Actor;
  /** The job type recorded on the row, e.g. `api.items.bulk`. */
  readonly jobType: string;
  readonly tokenId: string | null;
  /** The client's key. Without one there is nothing to replay and the work simply runs. */
  readonly key: string | undefined;
  /** IK3: run again under a counted key rather than replaying. */
  readonly force: boolean;
  /** The work. Receives the batch id it should report. */
  readonly run: (batchId: string) => TResult;
}

export interface ReplayOrRecordResult<TResult> {
  readonly result: TResult;
  /** True when this is the stored result of an earlier identical call. */
  readonly replayed: boolean;
}

/** `api:<token_id>:<value>` (IK2). */
export const storedKey = (tokenId: string | null, key: string): string =>
  `api:${tokenId ?? 'local'}:${key}`;

export const replayOrRecord = <TResult>(input: ReplayOrRecordInput<TResult>): ReplayOrRecordResult<TResult> => {
  const { db, audit, actor, jobType, tokenId, key, force, run } = input;

  if (key === undefined) {
    return { result: run(newId()), replayed: false };
  }

  const base = storedKey(tokenId, key);
  const effectiveKey = force ? `${base}#${nextRunCounter(db, base)}` : base;

  if (!force) {
    const existing = db
      .select()
      .from(schema.jobs)
      .where(eq(schema.jobs.idempotencyKey, effectiveKey))
      .get();

    if (existing !== undefined) {
      // A row with no result is a call that crashed between claiming the key and finishing. There
      // is nothing to replay, and running again under the same key would break IK2's promise that
      // one key is one outcome; the caller is told to re-run explicitly with `force`.
      if (existing.result === null) {
        return {
          result: run(existing.batchId ?? existing.id),
          replayed: false,
        };
      }
      return { result: JSON.parse(existing.result) as TResult, replayed: true };
    }
  }

  const batchId = newId();
  const now = nowTimestamp();
  const jobId = newId();

  const result = run(batchId);

  db.transaction((tx) => {
    tx.insert(schema.jobs)
      .values({
        id: jobId,
        jobType,
        idempotencyKey: effectiveKey,
        params: JSON.stringify({ batchId }),
        state: 'succeeded',
        priority: 0,
        runAfter: now,
        startedAt: now,
        finishedAt: now,
        attempts: 1,
        maxAttempts: 1,
        progressDone: 1,
        progressTotal: 1,
        result: JSON.stringify(result),
        batchId,
        createdByUserId: actor.userId ?? null,
        createdByTokenId: tokenId,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    audit.record(
      {
        actor,
        action: 'job.finished',
        entityType: 'job',
        entityId: jobId,
        after: { jobType, idempotencyKey: effectiveKey, batchId },
      },
      tx,
    );
  });

  return { result, replayed: false };
};

/** The next `#n` suffix for a forced re-run (IK3). */
const nextRunCounter = (db: RecueilDatabase, base: string): number => {
  const rows = db
    .select({ key: schema.jobs.idempotencyKey })
    .from(schema.jobs)
    .where(and(like(schema.jobs.idempotencyKey, `${base}%`)))
    .all();

  let highest = 0;
  for (const row of rows) {
    if (row.key === null) continue;
    if (row.key === base) {
      highest = Math.max(highest, 1);
      continue;
    }
    const match = /#(\d+)$/u.exec(row.key);
    if (match !== null) highest = Math.max(highest, Number.parseInt(match[1] as string, 10));
  }
  return highest + 1;
};
