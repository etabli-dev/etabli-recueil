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
  /** A sentence for the acknowledgement record and the log. */
  summary: string;
}

/** Every digest an outcome touched, including an archive's members, without duplicates. */
export const outcomeDigests = (outcome: IngestOutcome): Sha256[] => {
  const digests: Sha256[] = [];
  const walk = (node: IngestOutcome): void => {
    if ('sha256' in node && typeof node.sha256 === 'string') digests.push(node.sha256);
    if ('members' in node && node.members !== undefined) for (const member of node.members) walk(member);
  };
  walk(outcome);
  return [...new Set(digests)];
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
 * point at, so nothing on the far side may be destroyed.
 */
export const verifyOutcome = async (
  recueil: Recueil,
  outcome: IngestOutcome,
): Promise<StoreVerification> => {
  const digests = outcomeDigests(outcome);
  if (digests.length === 0) {
    return {
      ok: false,
      digests: [],
      summary: `the ${outcome.status} outcome names no stored bytes, so nothing can be verified`,
    };
  }

  const results: DigestVerification[] = [];
  for (const digest of digests) results.push(await verifyStoredDocument(recueil, digest));

  const failed = results.filter((result) => !result.ok);
  return {
    ok: failed.length === 0,
    digests: results,
    summary:
      failed.length === 0
        ? `${String(results.length)} blob(s) re-read from the store, hashed, and matched to their documents row`
        : failed
            .map(
              (result) =>
                `${result.sha256}: ` +
                result.checks
                  .filter((check) => !check.ok)
                  .map((check) => check.detail)
                  .join('; '),
            )
            .join(' | '),
  };
};
