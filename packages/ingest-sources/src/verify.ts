/**
 * The check that stands between an ingest and a deletion.
 *
 * A consume policy of `delete` destroys the only other copy of a file. The Phase 1 review found
 * verification code that counted the importer's own log entries and could therefore never fail, and
 * called it worse than no check because it reads as evidence. The rule that came out of it is the
 * one this module implements: **a check queries both sides.**
 *
 * The two sides here are the library and the store, and neither is allowed to vouch for the other:
 *
 *   1. `documents` is queried for a row at this digest. A pipeline outcome saying "ingested" is the
 *      pipeline's own account of itself, so the row is fetched rather than assumed.
 *   2. The blob is re-read out of the content store and hashed. The path a content-addressed store
 *      keeps a blob at is a *claim* about its contents, and a truncated write, a full disk or a
 *      botched restore all leave a file whose name asserts a digest its bytes do not have. So the
 *      digest is recomputed from the bytes and compared, and the byte count is compared with the
 *      `documents.byte_size` the library recorded.
 *
 * Both have to agree before anything is deleted. When they disagree the failure is reported with
 * the numbers in it, the original is left exactly where it is, and the run says so.
 *
 * ## What an outcome has to account for, and the two ways that went wrong
 *
 * ADR-0021's re-attack found that querying both sides is necessary and not sufficient: a check that
 * compares the right numbers of the wrong things still passes. Two shapes of that were live here.
 *
 * **A container that names bytes the deployment deliberately did not store.** `outcomeDigests` used
 * to demand a `documents` row for the *container's own* digest as well as its members'. A zip is
 * not itself a library record — `storeArchiveContainers.zip` defaults to false — so no such row
 * exists, every zip refused verification for ever, the `delete` policy never fired, the watched
 * folder never drained and `SourceRunner.runOnce` returned `ok: false` permanently, while the
 * members had in fact been filed correctly. Two shipped defaults contradicting each other. The
 * container's digest is now *optional evidence*: if the library has a row at it, it is verified in
 * full like any other; if it has none and the outcome says the container was not filed
 * (`documentId` is empty, which is what `pipeline.ts` writes when `containerStored` is false), the
 * absence is reported as an exclusion rather than treated as a failure. ADR-0021 §2 permits a
 * filter only where the exclusion is stated, so it is stated: `summary` names it and the caller
 * records it beside the deletion.
 *
 * **A container whose member never reached the library at all.** The walk collected whatever
 * carried a `sha256` and said nothing about the nodes that carried none, so a container with a
 * `failed` member — bytes that three attempts could not file — verified clean on the strength of
 * its *other* members, and the archive that was their only copy was licensed for deletion. That is
 * the cardinality-instead-of-correspondence shape exactly: the right number of blobs, not the
 * right ones. Every node in the tree is now accounted for by name, and one that names no stored
 * bytes is a refusal.
 *
 * **And a floor.** A comparison of nothing with nothing must not pass. At least one digest has to
 * have been found in the library *and* re-read out of the store before anything on the far side may
 * be touched, so an outcome whose every digest was excused verifies as not ok.
 */
import { createHash } from 'node:crypto';

import { schema } from '@recueil/core';
import type { Recueil } from '@recueil/core';
import type { IngestOutcome, Sha256 } from '@recueil/ingest';
import { eq } from 'drizzle-orm';

export interface DigestVerification {
  sha256: Sha256;
  ok: boolean;
  /** The `documents.id` found at this digest, or null when there is no row. */
  documentId: string | null;
  /** What the library says the blob is. */
  recordedBytes: number | null;
  /** What the store actually held, counted while hashing. Null when the blob could not be read. */
  storedBytes: number | null;
  /** The digest recomputed from the stored bytes. Null when the blob could not be read. */
  recomputed: Sha256 | null;
  /** One line per check, both the passes and the failures, so the report is readable as evidence. */
  checks: Array<{ id: string; ok: boolean; detail: string }>;
}

export interface StoreVerification {
  ok: boolean;
  digests: DigestVerification[];
  /**
   * Digests the outcome named that the library legitimately does not hold: an archive container the
   * deployment chose not to file. Reported rather than silently dropped (ADR-0021 §2).
   */
  notStored: Sha256[];
  /**
   * Nodes of the outcome that name no stored bytes at all — a member the pipeline could not file.
   * Non-empty is always a refusal: the far side is holding bytes the library does not have.
   */
  unaccounted: Array<{ status: string; detail: string }>;
  /** A sentence for the acknowledgement record and the log. */
  summary: string;
}

/** One digest an outcome named, and what the check is entitled to demand of it. */
export interface OutcomeDigestRef {
  sha256: Sha256;
  /** `container` for an archive's own bytes; `document` for anything the pipeline filed. */
  role: 'document' | 'container';
  /**
   * False only for an archive container the outcome says was not filed as a document, which is the
   * shipped default for zips. A row at this digest is still verified in full if one exists; its
   * absence is an exclusion to report rather than a failure.
   */
  required: boolean;
}

/**
 * Every node of an outcome tree, split into the digests it named and the ones it could not.
 *
 * Both halves matter. The digests are what gets verified; the gaps are what makes verifying them
 * insufficient, because a container is only as filed as its least filed member.
 */
export const walkOutcome = (
  outcome: IngestOutcome,
): { digests: OutcomeDigestRef[]; unaccounted: Array<{ status: string; detail: string }> } => {
  const digests: OutcomeDigestRef[] = [];
  const unaccounted: Array<{ status: string; detail: string }> = [];
  const seen = new Set<Sha256>();

  const walk = (node: IngestOutcome): void => {
    const sha256 = 'sha256' in node && typeof node.sha256 === 'string' ? node.sha256 : null;
    if (sha256 === null) {
      unaccounted.push({
        status: node.status,
        detail:
          node.status === 'failed'
            ? `a member failed with ${node.code}: ${node.message}`
            : `a '${node.status}' node names no stored bytes`,
      });
    } else if (!seen.has(sha256)) {
      seen.add(sha256);
      // `pipeline.ts` writes an empty `documentId` on a container outcome exactly when it did not
      // file the container as a document, which is what `storeArchiveContainers` decides.
      const unfiledContainer =
        node.status === 'container' && ('documentId' in node ? node.documentId : '') === '';
      digests.push({
        sha256,
        role: node.status === 'container' ? 'container' : 'document',
        required: !unfiledContainer,
      });
    }
    if ('members' in node && node.members !== undefined) for (const member of node.members) walk(member);
  };

  walk(outcome);
  return { digests, unaccounted };
};

/** Every digest an outcome touched, including an archive's members, without duplicates. */
export const outcomeDigests = (outcome: IngestOutcome): Sha256[] =>
  walkOutcome(outcome).digests.map((digest) => digest.sha256);

/**
 * A `documents.id` a review-queue entry about this outcome can hang off, or null.
 *
 * A refusal has to name a library record an operator can act from. The container of an archive is
 * frequently not one — `storeArchiveContainers.zip` is false by default, and `pipeline.ts` writes
 * an empty `documentId` in that case — so the first member that *did* become a document is used
 * instead. Raising an entry against an empty id would put a row in the queue pointing at nothing,
 * which is worse than not raising one.
 */
export const subjectDocumentId = (outcome: IngestOutcome): string | null => {
  const found = ((node: IngestOutcome): string | null => {
    const id = 'documentId' in node ? node.documentId : undefined;
    if (typeof id === 'string' && id !== '') return id;
    if ('members' in node && node.members !== undefined) {
      for (const member of node.members) {
        const inner = subjectDocumentId(member);
        if (inner !== null) return inner;
      }
    }
    return null;
  })(outcome);
  return found;
};

/** Re-read one blob and compare it with the `documents` row at the same digest. */
export const verifyStoredDocument = async (
  recueil: Recueil,
  sha256: Sha256,
): Promise<DigestVerification> => {
  const checks: DigestVerification['checks'] = [];

  const row = recueil.db
    .select({
      id: schema.documents.id,
      byteSize: schema.documents.byteSize,
      storageOk: schema.documents.storageOk,
      trashedAt: schema.documents.trashedAt,
    })
    .from(schema.documents)
    .where(eq(schema.documents.sha256, sha256))
    .get();

  if (row === undefined) {
    checks.push({
      id: 'document_row',
      ok: false,
      detail: `no documents row at ${sha256}: the library does not know these bytes`,
    });
    return {
      sha256,
      ok: false,
      documentId: null,
      recordedBytes: null,
      storedBytes: null,
      recomputed: null,
      checks,
    };
  }
  checks.push({ id: 'document_row', ok: true, detail: `documents.id = ${row.id}` });

  let storedBytes = 0;
  let recomputed: Sha256 | null = null;
  try {
    const hash = createHash('sha256');
    const stream = await recueil.storage.get(sha256);
    for await (const chunk of stream) {
      const buffer = chunk as Buffer;
      storedBytes += buffer.byteLength;
      hash.update(buffer);
    }
    recomputed = hash.digest('hex');
  } catch (error) {
    checks.push({
      id: 'blob_readable',
      ok: false,
      detail: `the store could not produce the blob: ${error instanceof Error ? error.message : String(error)}`,
    });
    return {
      sha256,
      ok: false,
      documentId: row.id,
      recordedBytes: row.byteSize,
      storedBytes: null,
      recomputed: null,
      checks,
    };
  }
  checks.push({ id: 'blob_readable', ok: true, detail: `${String(storedBytes)} bytes read back` });

  const digestOk = recomputed === sha256;
  checks.push({
    id: 'digest_matches',
    ok: digestOk,
    detail: digestOk
      ? 'the bytes in the store hash to the digest they are filed under'
      : `the blob filed under ${sha256} hashes to ${recomputed}`,
  });

  const sizeOk = storedBytes === row.byteSize;
  checks.push({
    id: 'size_matches',
    ok: sizeOk,
    detail: sizeOk
      ? `${String(storedBytes)} bytes, as documents.byte_size records`
      : `the store holds ${String(storedBytes)} bytes; documents.byte_size says ${String(row.byteSize)}`,
  });

  const flagOk = row.storageOk;
  checks.push({
    id: 'storage_ok_flag',
    ok: flagOk,
    detail: flagOk ? 'documents.storage_ok is set' : 'documents.storage_ok is false: a check has already failed on this blob',
  });

  return {
    sha256,
    ok: digestOk && sizeOk && flagOk,
    documentId: row.id,
    recordedBytes: row.byteSize,
    storedBytes,
    recomputed,
    checks,
  };
};

/**
 * Verify every digest an outcome produced.
 *
 * An outcome with no digest at all — `failed`, and `stopped` before stage 1 got that far — verifies
 * as *not ok* with that as the reason. It is the honest answer: there is nothing in the store to
 * point at, so nothing on the far side may be destroyed. The same answer is given when the outcome
 * names digests but not one of them turned out to be in the library: that is the floor, and it is
 * there because a comparison of nothing with nothing passing is how a report certifies a migration
 * that carried no bytes.
 */
export const verifyOutcome = async (
  recueil: Recueil,
  outcome: IngestOutcome,
): Promise<StoreVerification> => {
  const { digests, unaccounted } = walkOutcome(outcome);

  if (unaccounted.length > 0) {
    return {
      ok: false,
      digests: [],
      notStored: [],
      unaccounted,
      summary:
        `the ${outcome.status} outcome does not account for ` +
        `${String(unaccounted.length)} of the document(s) it produced, so the original is the only ` +
        `copy of them: ${unaccounted.map((gap) => gap.detail).join('; ')}`,
    };
  }

  if (digests.length === 0) {
    return {
      ok: false,
      digests: [],
      notStored: [],
      unaccounted,
      summary: `the ${outcome.status} outcome names no stored bytes, so nothing can be verified`,
    };
  }

  const results: DigestVerification[] = [];
  const notStored: Sha256[] = [];
  for (const digest of digests) {
    const result = await verifyStoredDocument(recueil, digest.sha256);
    // The one excusable absence, and only this one: an archive container the deployment chose not
    // to file. Anything else missing from `documents` is a failure, and a container that *does*
    // have a row is verified in full like everything else.
    if (!digest.required && result.documentId === null) {
      notStored.push(digest.sha256);
      continue;
    }
    results.push(result);
  }

  const failed = results.filter((result) => !result.ok);
  const passed = results.filter((result) => result.ok);
  const exclusion =
    notStored.length === 0
      ? ''
      : ` (the container's own bytes, ${notStored.join(', ')}, are not filed as a document: this ` +
        'deployment does not store archive containers, so its members are the record of it)';

  // The floor. Every digest excused and none verified is a run that stored nothing, and 0 = 0 must
  // not read as evidence (ADR-0021).
  if (passed.length === 0) {
    return {
      ok: false,
      digests: results,
      notStored,
      unaccounted,
      summary:
        failed.length > 0
          ? failureSummary(failed)
          : `the ${outcome.status} outcome named ${String(digests.length)} digest(s) and the ` +
            'library holds none of them, so there is nothing the store can be shown to have kept' +
            exclusion,
    };
  }

  return {
    ok: failed.length === 0,
    digests: results,
    notStored,
    unaccounted,
    summary:
      failed.length === 0
        ? `${String(passed.length)} blob(s) re-read from the store, hashed, and matched to their documents row${exclusion}`
        : failureSummary(failed),
  };
};

const failureSummary = (failed: readonly DigestVerification[]): string =>
  failed
    .map(
      (result) =>
        `${result.sha256}: ` +
        result.checks
          .filter((check) => !check.ok)
          .map((check) => check.detail)
          .join('; '),
    )
    .join(' | ');
