/**
 * The check that gates every destructive consume policy, on its own.
 *
 * The source tests exercise it end to end; this file pins the individual answers, including the
 * ones a passing end-to-end test would never reach: an outcome that names no bytes at all, a
 * digest with no `documents` row, a blob that no longer hashes to its own name, and a `documents`
 * row whose `storage_ok` has already been cleared by a check.
 */
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

import { bufferCandidate } from '@recueil/ingest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_CONSUME_ON,
  decideConsume,
  outcomeDigests,
  sourceState,
  subjectDocumentId,
  verifyOutcome,
  verifyStoredDocument,
} from '../src/index.js';
import type { IngestOutcome } from '../src/index.js';
import { makeLibrary, makePdf, makePipeline } from './helpers.js';
import type { TestLibrary } from './helpers.js';

let library: TestLibrary;

beforeEach(() => {
  library = makeLibrary();
});

afterEach(() => {
  library.dispose();
});

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

/** Put real bytes through the real pipeline, so the row and the blob are both genuine. */
const ingest = async (bytes: Buffer): Promise<IngestOutcome> =>
  makePipeline(library).ingestOne(
    bufferCandidate(bytes, { filename: 'thing.pdf', sourceKind: 'upload' }),
  );

describe('outcomeDigests', () => {
  it('collects the container and every member, without repeats', () => {
    const outcome: IngestOutcome = {
      status: 'container',
      documentId: 'doc_a',
      sha256: 'a'.repeat(64),
      members: [
        { status: 'ingested', documentId: 'doc_b', itemId: 'itm_b', sha256: 'b'.repeat(64), confidence: 1 },
        { status: 'duplicate', documentId: 'doc_b', sha256: 'b'.repeat(64) },
        {
          status: 'review',
          reviewQueueEntryId: 'rq_1',
          documentId: 'doc_c',
          sha256: 'c'.repeat(64),
          reasonCode: 'low_confidence_metadata',
        },
      ],
    };

    expect(outcomeDigests(outcome)).toEqual(['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)]);
  });

  it('finds nothing in an outcome that never reached the store', () => {
    expect(outcomeDigests({ status: 'failed', code: 'ingest_failed', message: 'no' })).toEqual([]);
  });
});

describe('verifyStoredDocument', () => {
  it('passes when the row and the bytes agree, and says which checks it ran', async () => {
    const bytes = makePdf({ lines: ['a real document'] });
    await ingest(bytes);

    const verification = await verifyStoredDocument(library, sha256(bytes));

    expect(verification.ok).toBe(true);
    expect(verification.documentId).not.toBeNull();
    expect(verification.storedBytes).toBe(bytes.byteLength);
    expect(verification.recomputed).toBe(sha256(bytes));
    expect(verification.checks.map((check) => check.id)).toEqual([
      'document_row',
      'blob_readable',
      'digest_matches',
      'size_matches',
      'storage_ok_flag',
    ]);
    expect(verification.checks.every((check) => check.ok)).toBe(true);
  });

  it('fails when the library has never seen the digest', async () => {
    const verification = await verifyStoredDocument(library, sha256(Buffer.from('never ingested')));

    expect(verification.ok).toBe(false);
    expect(verification.documentId).toBeNull();
    expect(verification.checks[0]?.detail).toContain('no documents row');
  });

  it('fails when the blob no longer hashes to the digest it is filed under', async () => {
    const bytes = makePdf({ lines: ['this will rot'] });
    await ingest(bytes);
    const digest = sha256(bytes);
    await writeFile(library.storage.path(digest), Buffer.from('rot'));

    const verification = await verifyStoredDocument(library, digest);

    expect(verification.ok).toBe(false);
    expect(verification.checks.find((check) => check.id === 'digest_matches')?.ok).toBe(false);
    expect(verification.checks.find((check) => check.id === 'size_matches')?.ok).toBe(false);
  });

  it('fails when the blob is missing from the store altogether', async () => {
    const bytes = makePdf({ lines: ['this will vanish'] });
    await ingest(bytes);
    const digest = sha256(bytes);
    await library.storage.delete(digest);

    const verification = await verifyStoredDocument(library, digest);

    expect(verification.ok).toBe(false);
    expect(verification.checks.find((check) => check.id === 'blob_readable')?.ok).toBe(false);
  });

  it('fails when a previous check has already cleared documents.storage_ok', async () => {
    const bytes = makePdf({ lines: ['flagged as unsound'] });
    await ingest(bytes);
    const digest = sha256(bytes);
    library.connection.prepare('update documents set storage_ok = 0 where sha256 = ?').run(digest);

    const verification = await verifyStoredDocument(library, digest);

    expect(verification.ok).toBe(false);
    expect(verification.checks.find((check) => check.id === 'storage_ok_flag')?.ok).toBe(false);
  });
});

describe('decideConsume', () => {
  it('never verifies, and never consumes, under the leave policy', async () => {
    const outcome = await ingest(makePdf({ lines: ['left alone'] }));

    const decision = await decideConsume({ recueil: library, outcome, policy: { mode: 'leave' } });

    expect(decision.consume).toBe(false);
    expect(decision.action).toBe('left');
    expect(decision.verification).toBeNull();
  });

  it('refuses a status that is not in the consume list, and says which are', async () => {
    const decision = await decideConsume({
      recueil: library,
      outcome: { status: 'failed', code: 'ingest_failed', message: 'the reader gave up' },
      policy: { mode: 'delete' },
    });

    expect(decision.consume).toBe(false);
    expect(decision.action).toBe('left');
    expect(decision.detail).toContain('ingested, duplicate, review, container');
    expect(DEFAULT_CONSUME_ON).not.toContain('failed');
  });

  it('refuses an outcome that names no stored bytes', async () => {
    const decision = await decideConsume({
      recueil: library,
      outcome: { status: 'review', reviewQueueEntryId: 'rq', documentId: 'doc', sha256: 'f'.repeat(64), reasonCode: 'x' },
      policy: { mode: 'delete' },
    });

    expect(decision.consume).toBe(false);
    expect(decision.action).toBe('refused');
    expect(decision.verification?.ok).toBe(false);
  });

  it('allows the consume once both sides agree', async () => {
    const outcome = await ingest(makePdf({ lines: ['ready to be filed away'] }));

    const decision = await decideConsume({ recueil: library, outcome, policy: { mode: 'delete' } });

    expect(decision.consume).toBe(true);
    expect(decision.verification?.ok).toBe(true);
    expect(decision.detail).toContain('matched to their documents row');
  });

  it('refuses a container whose member blob has rotted, even though the container is sound', async () => {
    const memberBytes = makePdf({ lines: ['the member'] });
    await ingest(memberBytes);
    const outcome: IngestOutcome = {
      status: 'container',
      documentId: 'doc_container',
      sha256: sha256(memberBytes),
      members: [
        {
          status: 'ingested',
          documentId: 'doc_member',
          itemId: 'itm_member',
          sha256: sha256(Buffer.from('a member that was never stored')),
          confidence: 1,
        },
      ],
    };

    const verification = await verifyOutcome(library, outcome);

    expect(verification.ok).toBe(false);
    expect(verification.digests).toHaveLength(2);
    expect(verification.digests.filter((digest) => digest.ok)).toHaveLength(1);
  });

  /**
   * `storeArchiveContainers.zip` is false by default, so a zip container has no `documents` row —
   * `pipeline.ts` writes an empty `documentId` on the outcome to say so. The check demanded one
   * anyway, so every zip refused verification for ever: with a `delete` policy the watched folder
   * never drained, `SourceRunner.runOnce` returned `ok: false` permanently, and the refusal blamed
   * the store ("the library does not know these bytes") for a file the deployment had deliberately
   * chosen not to store. Two shipped defaults contradicting each other.
   */
  it('verifies a container the deployment does not store, on its members, and says so', async () => {
    const memberBytes = makePdf({ lines: ['the only member'] });
    const member = await ingest(memberBytes);
    const outcome: IngestOutcome = {
      status: 'container',
      // Empty: the pipeline is telling the check it did not file the container as a document.
      documentId: '',
      sha256: sha256(Buffer.from('a zip nobody stored')),
      members: [member],
    };

    const verification = await verifyOutcome(library, outcome);

    expect(verification.ok).toBe(true);
    expect(verification.notStored).toEqual([sha256(Buffer.from('a zip nobody stored'))]);
    // ADR-0021 §2: the exclusion is stated in the evidence rather than applied quietly.
    expect(verification.summary).toContain('not filed as a document');
    expect(verification.digests.map((digest) => digest.sha256)).toEqual([sha256(memberBytes)]);
  });

  it('still verifies an unstored container in full when the library turns out to hold it', async () => {
    const bytes = makePdf({ lines: ['a container that was stored after all'] });
    const stored = await ingest(bytes);
    const outcome: IngestOutcome = {
      status: 'container',
      documentId: '',
      sha256: 'sha256' in stored ? stored.sha256! : '',
      members: [],
    };

    const verification = await verifyOutcome(library, outcome);

    expect(verification.notStored).toEqual([]);
    expect(verification.digests.map((digest) => digest.sha256)).toEqual([sha256(bytes)]);
    expect(verification.ok).toBe(true);
  });

  /**
   * The walk collected whatever carried a `sha256` and said nothing about the nodes that carried
   * none, so a container whose member ingest FAILED — bytes that three attempts could not file —
   * verified clean on the strength of its other members, and the archive that was their only copy
   * was licensed for deletion. The right number of blobs, not the right ones (ADR-0021).
   */
  it('refuses a container with a member the pipeline could not file at all', async () => {
    const memberBytes = makePdf({ lines: ['the member that made it'] });
    const member = await ingest(memberBytes);
    const outcome: IngestOutcome = {
      status: 'container',
      documentId: '',
      sha256: sha256(Buffer.from('the archive')),
      members: [
        member,
        { status: 'failed', code: 'archive_member_unreadable', message: 'the second member never arrived' },
      ],
    };

    const verification = await verifyOutcome(library, outcome);
    const decision = await decideConsume({ recueil: library, outcome, policy: { mode: 'delete' } });

    expect(verification.ok).toBe(false);
    expect(verification.unaccounted).toHaveLength(1);
    expect(verification.summary).toContain('does not account for');
    expect(decision.consume).toBe(false);
    expect(decision.action).toBe('refused');
  });

  /**
   * The floor. A comparison of nothing with nothing must not read as evidence: an outcome whose
   * every digest is excused has had nothing shown to be in the library, so nothing on the far side
   * may be touched.
   */
  it('refuses when every digest it named was excused and none was found', async () => {
    const outcome: IngestOutcome = {
      status: 'container',
      documentId: '',
      sha256: sha256(Buffer.from('a container of nothing')),
      members: [],
    };

    const verification = await verifyOutcome(library, outcome);

    expect(verification.ok).toBe(false);
    expect(verification.summary).toContain('the library holds none of them');
  });
});

describe('subjectDocumentId', () => {
  it('falls back to the first member when the container itself is not a library record', () => {
    expect(
      subjectDocumentId({
        status: 'container',
        documentId: '',
        sha256: 'a'.repeat(64),
        members: [
          { status: 'failed', code: 'x', message: 'y' },
          { status: 'ingested', documentId: 'doc_member', itemId: 'itm', sha256: 'b'.repeat(64), confidence: 1 },
        ],
      }),
    ).toBe('doc_member');
    // Nothing to hang a review-queue entry off is null, not an empty string pointing at nothing.
    expect(subjectDocumentId({ status: 'failed', code: 'x', message: 'y' })).toBeNull();
  });
});

describe('SourceStateStore', () => {
  it('treats a pending row as unhandled, and a completed one at the same revision as handled', () => {
    const state = sourceState(library);
    const ref = { sourceId: 'folder:test', externalId: 'a.pdf', revision: '1:2' };
    const outcome: IngestOutcome = {
      status: 'ingested',
      documentId: 'doc',
      itemId: 'itm',
      sha256: 'a'.repeat(64),
      confidence: 1,
    };

    state.recordOutcome({ sourceId: ref.sourceId, ref, outcome });
    expect(state.isHandled(ref.sourceId, ref.externalId, ref.revision)).toBe(false);
    expect(state.pending(ref.sourceId)).toHaveLength(1);

    state.recordAcknowledgement({
      sourceId: ref.sourceId,
      externalId: ref.externalId,
      action: 'moved',
      detail: 'moved after verification',
      verified: true,
    });

    expect(state.isHandled(ref.sourceId, ref.externalId, ref.revision)).toBe(true);
    // New content under the same name is a new arrival, not a repeat.
    expect(state.isHandled(ref.sourceId, ref.externalId, '9:9')).toBe(false);
    expect(state.pending(ref.sourceId)).toHaveLength(0);
  });

  it('never treats a refusal as handled, so the next run tries again', () => {
    const state = sourceState(library);
    const ref = { sourceId: 'folder:test', externalId: 'b.pdf', revision: '1:2' };
    state.recordOutcome({
      sourceId: ref.sourceId,
      ref,
      outcome: { status: 'ingested', documentId: 'd', itemId: 'i', sha256: 'b'.repeat(64), confidence: 1 },
    });
    state.recordAcknowledgement({
      sourceId: ref.sourceId,
      externalId: ref.externalId,
      action: 'refused',
      detail: 'the store could not be verified',
      verified: false,
    });

    expect(state.isHandled(ref.sourceId, ref.externalId, ref.revision)).toBe(false);
  });

  it('remembers the label of an unfinished run and forgets it when told', () => {
    const state = sourceState(library);
    expect(state.cursor('imap:test').open_run_label).toBeNull();

    state.setOpenRun('imap:test', 'imap:test@2026-08-22T09:00:00Z');
    expect(state.cursor('imap:test').open_run_label).toBe('imap:test@2026-08-22T09:00:00Z');

    state.setOpenRun('imap:test', null);
    expect(state.cursor('imap:test').open_run_label).toBeNull();
  });

  it('counts consecutive poll failures and resets on the first success', () => {
    const state = sourceState(library);
    expect(state.recordPollFailure('webdav:test', 'connection refused')).toBe(1);
    expect(state.recordPollFailure('webdav:test', 'connection refused')).toBe(2);
    state.recordPollSuccess('webdav:test');
    expect(state.cursor('webdav:test').consecutive_failures).toBe(0);
    expect(state.cursor('webdav:test').last_error).toBeNull();
  });
});
