/**
 * The race between stage 2 and stage 10, the verification that could not see it, and the job state
 * that could not see the review queue.
 *
 * All three were found by the Phase 2 adversarial review (`spec/findings-phase-2.md`) and none of
 * them was visible to the suite that shipped, for one reason: with no awaited work between the
 * duplicate check and the commit the pipeline is effectively synchronous, so every existing test
 * pinned the *serial* behaviour of a concurrent design. The extractor below therefore awaits — as a
 * real OCR pass, a GROBID call, an identifier resolver or a plugin stage does — and that is the
 * whole of what it takes to turn one document into four items.
 *
 * The documents here are invoices rather than papers on purpose. A scholarly PDF carries a DOI, and
 * `item_bibliographic.doi` has a unique index that refuses the second write; that index masked the
 * defect for exactly the corpus the earlier tests used. Office documents — the point of the Phase 2
 * Office facet and of the Paperless migration — have no such column and were unprotected.
 */
import { schema } from '@recueil/core';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { commitProposal } from '../src/commit.js';
import {
  IngestPipeline,
  bufferCandidate,
  emptyProposal,
  reviewQueue as reviewQueueTable,
} from '../src/index.js';
import type {
  ExtractedMetadata,
  IngestCandidate,
  IngestOutcome,
  MetadataExtractor,
  MetadataRequest,
  RunCounts,
} from '../src/index.js';
import { invoiceLines, makeLibrary, makePdf, makeZip } from './helpers.js';
import type { TestLibrary } from './helpers.js';

let library: TestLibrary;

beforeEach(() => {
  library = makeLibrary();
});

afterEach(() => {
  library.dispose();
});

/* ------------------------------------------------------------------------------------------ */

/**
 * A real extractor that takes time.
 *
 * Not a stub: it returns the office fields the commit needs and a confidence that clears the gate.
 * The `await` is the point — it is the awaited work of stages 3 to 9 that the shipped pipeline had
 * between its duplicate check and its commit, and without it no amount of concurrency interleaves.
 */
class SlowOfficeExtractor implements MetadataExtractor {
  readonly id = 'slow-office';
  readonly calls: string[] = [];

  constructor(private readonly delayMs = 60) {}

  supports(): boolean {
    return true;
  }

  async extract(request: MetadataRequest): Promise<ExtractedMetadata> {
    this.calls.push(request.sha256);
    await new Promise((resolve) => {
      setTimeout(resolve, this.delayMs);
    });
    return {
      fields: {
        'office.correspondent': {
          value: 'Stadtwerke Ulm',
          provenance: { source: this.id, fetchedAt: new Date().toISOString(), confidence: 0.95 },
        },
      },
      creators: [],
      identifiers: [],
      references: [],
      confidence: 0.95,
      extractor: this.id,
    };
  }
}

/** An extractor that always throws, so a candidate exhausts its retries and raises a blocker. */
class DoomedExtractor implements MetadataExtractor {
  readonly id = 'doomed';
  supports(): boolean {
    return true;
  }
  async extract(): Promise<ExtractedMetadata> {
    throw new Error('this extractor never works');
  }
}

const invoiceBytes = (salt?: string): Buffer =>
  makePdf({
    lines: invoiceLines({ correspondent: 'Stadtwerke Ulm', reference: 'SW-2026-0042' }),
    ...(salt === undefined ? {} : { salt }),
  });

const documentCount = (): number =>
  library.db.select({ n: sql<number>`count(*)` }).from(schema.documents).get()?.n ?? 0;

const liveItemCount = (): number =>
  library.db
    .select({ n: sql<number>`count(*)` })
    .from(schema.items)
    .where(isNull(schema.items.trashedAt))
    .get()?.n ?? 0;

const liveAttachmentCount = (): number =>
  library.db
    .select({ n: sql<number>`count(*)` })
    .from(schema.attachments)
    .where(isNull(schema.attachments.trashedAt))
    .get()?.n ?? 0;

const jobRow = (runId: string) =>
  library.db.select().from(schema.jobs).where(eq(schema.jobs.id, runId)).get();

const openEntries = (runId: string) =>
  library.db
    .select()
    .from(reviewQueueTable)
    .where(and(eq(reviewQueueTable.jobId, runId), eq(reviewQueueTable.status, 'open')))
    .all();

/** The document ids an outcome tree names, which is what `run()` hands the verification. */
const collectIds = (outcomes: readonly IngestOutcome[]): string[] => {
  const ids = new Set<string>();
  const walk = (outcome: IngestOutcome): void => {
    if ('documentId' in outcome && typeof outcome.documentId === 'string' && outcome.documentId !== '') {
      ids.add(outcome.documentId);
    }
    if ('members' in outcome && outcome.members !== undefined) outcome.members.forEach(walk);
  };
  outcomes.forEach(walk);
  return [...ids];
};

const checkOf = (
  verification: { checks: Array<{ id: string; ok: boolean; detail: string }> },
  id: string,
) => verification.checks.find((check) => check.id === id);

/* ------------------------------------------------------------------------------------------ */
/* 1. The race                                                                                  */
/* ------------------------------------------------------------------------------------------ */

describe('the same bytes arriving from several workers at once', () => {
  it('files exactly one document, one item and one attachment', async () => {
    const bytes = invoiceBytes();
    const extractor = new SlowOfficeExtractor();
    const pipeline = new IngestPipeline({
      recueil: library,
      config: { scratchRoot: library.root, concurrency: 4 },
      extractors: [extractor],
    });

    // Four arrivals of identical bytes under four different names, which is what a watched folder
    // holding 'invoice.pdf' and 'Rechnung Stadtwerke.pdf' looks like to the pipeline.
    const candidates: IngestCandidate[] = [0, 1, 2, 3].map((index) =>
      bufferCandidate(bytes, {
        sourceId: 'watched',
        sourceKind: 'folder',
        externalId: `/in/copy-${String(index)}.pdf`,
        filename: `copy-${String(index)}.pdf`,
      }),
    );

    const report = await pipeline.run(candidates, { runLabel: 'race' });

    expect(documentCount()).toBe(1);
    expect(liveItemCount()).toBe(1);
    expect(liveAttachmentCount()).toBe(1);

    expect(report.counts.ingested).toBe(1);
    expect(report.counts.duplicates).toBe(3);

    // Every arrival is still recorded: a second arrival of known bytes is a new fact (P4), and the
    // fix must not have bought its safety by dropping it.
    expect(report.verification.queried.arrivalsRecorded).toBe(4);
    expect(report.verification.queried.documentsFiledByRun).toBe(1);
    expect(report.verification.queried.attachmentsCreated).toBe(1);
    expect(report.verification.pass).toBe(true);

    // The expensive stage was paid once, not four times: the three that waited were told they were
    // duplicates at stage 2 and stopped, which is what the gate is for.
    expect(extractor.calls).toHaveLength(1);
  });

  it('holds across two pipeline instances, which is the shape a second process has', async () => {
    // Two `IngestPipeline`s over one library have two separate in-flight sets, so nothing in
    // process memory serialises them — the same position a second `recueil ingest` process is in.
    // What stops the second commit is the check inside the commit's own transaction.
    const bytes = invoiceBytes('two-instances');
    const options = {
      recueil: library,
      config: { scratchRoot: library.root, concurrency: 1 },
      extractors: [new SlowOfficeExtractor(80)],
    };
    const first = new IngestPipeline(options);
    const second = new IngestPipeline(options);

    const [a, b] = await Promise.all([
      first.run([bufferCandidate(bytes, { sourceId: 'a', externalId: '/a/invoice.pdf' })], {
        runLabel: 'instance-a',
      }),
      second.run([bufferCandidate(bytes, { sourceId: 'b', externalId: '/b/invoice.pdf' })], {
        runLabel: 'instance-b',
      }),
    ]);

    expect(documentCount()).toBe(1);
    expect(liveItemCount()).toBe(1);
    expect(liveAttachmentCount()).toBe(1);

    const statuses = [a.outcomes[0]!.outcome.status, b.outcomes[0]!.outcome.status].sort();
    expect(statuses).toEqual(['duplicate', 'ingested']);
    expect(a.verification.pass).toBe(true);
    expect(b.verification.pass).toBe(true);
  });

  it('serialises members of one archive without deadlocking on the container', async () => {
    // The gate is re-entrant along one line of descent and nowhere else. A container holding two
    // identical members must file one of them and link the other, not wait on a lease it holds.
    const member = invoiceBytes('zipped');
    const zip = makeZip([
      { name: 'a/invoice.pdf', bytes: member },
      { name: 'b/invoice.pdf', bytes: member },
    ]);

    const pipeline = new IngestPipeline({
      recueil: library,
      config: { scratchRoot: library.root, concurrency: 2 },
      extractors: [new SlowOfficeExtractor(20)],
    });

    const report = await pipeline.run(
      [bufferCandidate(zip, { filename: 'batch.zip', externalId: '/in/batch.zip' })],
      { runLabel: 'zip-race' },
    );

    expect(report.counts.failed).toBe(0);
    expect(liveItemCount()).toBe(1);
    expect(liveAttachmentCount()).toBe(1);
  }, 20_000);
});

/* ------------------------------------------------------------------------------------------ */
/* 2. Falsifying the verification (ADR-0021 §4)                                                  */
/* ------------------------------------------------------------------------------------------ */

describe('verify(), handed a library that contradicts the run', () => {
  /** A run that filed one invoice, and the pieces of it a falsification test needs to mutate. */
  const fileOne = async (
    salt: string,
  ): Promise<{
    pipeline: IngestPipeline;
    report: Awaited<ReturnType<IngestPipeline['run']>>;
    bytes: Buffer;
    documentId: string;
    itemId: string;
    sha256: string;
  }> => {
    const bytes = invoiceBytes(salt);
    const pipeline = new IngestPipeline({
      recueil: library,
      config: { scratchRoot: library.root, concurrency: 1 },
      extractors: [new SlowOfficeExtractor(1)],
    });
    const report = await pipeline.run(
      [bufferCandidate(bytes, { sourceId: 'watched', externalId: '/in/one.pdf' })],
      { runLabel: `honest-${salt}` },
    );
    expect(report.verification.pass).toBe(true);
    const filed = report.outcomes[0]!.outcome as {
      status: string;
      documentId: string;
      itemId: string;
      sha256: string;
    };
    expect(filed.status).toBe('ingested');
    return {
      pipeline,
      report,
      bytes,
      documentId: filed.documentId,
      itemId: filed.itemId,
      sha256: filed.sha256,
    };
  };

  const reverify = (
    pipeline: IngestPipeline,
    report: Awaited<ReturnType<IngestPipeline['run']>>,
    overrides: { counts?: Partial<RunCounts>; documentIds?: string[]; outcomes?: IngestOutcome[] } = {},
  ) =>
    pipeline.verifyRun(
      report.runId,
      { ...report.counts, ...(overrides.counts ?? {}) },
      new Set(overrides.documentIds ?? collectIds(report.outcomes.map((entry) => entry.outcome))),
      overrides.outcomes ?? report.outcomes.map((entry) => entry.outcome),
    );

  it('FAILS when a document has been filed twice', async () => {
    const run = await fileOne('double-file');

    // Rebuild, exactly, the state the Phase 2 review observed: a second arrival of the same bytes
    // under a second name against the same job, and a second item over the one document. That is
    // what two racing workers left behind, and the shipped verification called it `pass: true`
    // with `documentsWithoutAttachment: -1`.
    await library.documents.ingestBuffer(run.bytes, {
      sourceKind: 'folder',
      sourceRef: '/in/two.pdf',
      jobId: run.report.runId,
      actor: library.actor,
    });

    const proposal = emptyProposal();
    proposal.itemType = 'document';
    proposal.confidence = 0.9;
    proposal.fields['office.correspondent'] = {
      value: 'Stadtwerke Ulm',
      provenance: { source: 'test', fetchedAt: new Date().toISOString(), confidence: 0.9 },
    };
    const injected = commitProposal({
      recueil: library,
      reviewQueue: run.pipeline.reviewQueue,
      actor: library.actor,
      documentId: run.documentId,
      sha256: run.sha256,
      proposal,
      attachmentRole: 'supplement',
      provenanceSource: 'test',
      runId: run.report.runId,
      sourceStage: 'test',
    });

    const verification = reverify(run.pipeline, run.report, {
      counts: { ingested: 2 },
      outcomes: [
        run.report.outcomes[0]!.outcome,
        {
          status: 'ingested',
          documentId: run.documentId,
          itemId: injected.itemId,
          sha256: run.sha256,
          confidence: 0.9,
        },
      ],
    });

    expect(verification.queried.attachmentsCreated).toBe(2);
    expect(verification.queried.documentsFiledByRun).toBe(1);
    // Counted, never derived: the number that used to reach -1 here is a `count(*)` and cannot.
    expect(verification.queried.documentsWithoutAttachment).toBe(0);
    expect(verification.queried.documentsWithoutAttachment).toBeGreaterThanOrEqual(0);
    // The shipped checks all passed over exactly this library. This one does not.
    expect(checkOf(verification, 'documents_filed_once')?.ok).toBe(false);
    expect(verification.pass).toBe(false);
  });

  it('FAILS when the run’s own item acquires a second attachment behind its back', async () => {
    const run = await fileOne('second-attachment');
    const other = await library.documents.ingestBuffer(invoiceBytes('some-other-file'), {
      sourceKind: 'upload',
      sourceRef: 'other',
      actor: library.actor,
    });
    library.documents.attachDocument(
      { itemId: run.itemId, documentId: other.document.id, role: 'supplement' },
      library.actor,
    );

    const verification = reverify(run.pipeline, run.report);
    expect(checkOf(verification, 'documents_filed_once')?.ok).toBe(false);
    expect(verification.pass).toBe(false);
  });

  it('FAILS when the item the run says it created has been trashed', async () => {
    const run = await fileOne('trashed-item');
    library.db
      .update(schema.items)
      .set({ trashedAt: new Date().toISOString() })
      .where(eq(schema.items.id, run.itemId))
      .run();

    const verification = reverify(run.pipeline, run.report);
    expect(checkOf(verification, 'items_created_exist')?.ok).toBe(false);
    expect(verification.pass).toBe(false);
  });

  it('FAILS when a document the run says it touched is not in the library', async () => {
    const run = await fileOne('missing-document');
    const verification = reverify(run.pipeline, run.report, {
      documentIds: [run.documentId, 'doc_never_existed'],
    });
    expect(checkOf(verification, 'documents_present')?.ok).toBe(false);
    expect(verification.pass).toBe(false);
  });

  it('FAILS when the arrivals the run recorded have gone', async () => {
    const run = await fileOne('missing-arrivals');
    library.db
      .delete(schema.documentProvenance)
      .where(eq(schema.documentProvenance.jobId, run.report.runId))
      .run();

    const verification = reverify(run.pipeline, run.report);
    expect(verification.queried.arrivalsRecorded).toBe(0);
    expect(checkOf(verification, 'arrivals_recorded')?.ok).toBe(false);
    expect(verification.pass).toBe(false);
  });

  it('FAILS when a document the run left unfiled is not accounted for', async () => {
    const run = await fileOne('unaccounted');
    library.db
      .update(schema.attachments)
      .set({ trashedAt: new Date().toISOString() })
      .where(eq(schema.attachments.documentId, run.documentId))
      .run();

    const verification = reverify(run.pipeline, run.report);
    expect(verification.queried.documentsWithoutAttachment).toBe(1);
    expect(checkOf(verification, 'every_document_accounted_for')?.ok).toBe(false);
    expect(verification.pass).toBe(false);
  });

  it('does NOT fail when two candidates refresh one review entry, which §6.1 requires', async () => {
    // `review_queue` keeps at most one open row per dedupe key, so two arrivals of the same bytes
    // that stop at the same gate for the same reason share an entry. That is P9 working, and a
    // check that called it a mismatch would be an alarm on correct behaviour.
    const pipeline = new IngestPipeline({
      recueil: library,
      config: { scratchRoot: library.root, concurrency: 2, ocrEnabled: false },
      extractors: [],
    });
    const bytes = makePdf({ salt: 'twice-doubtful' });
    const report = await pipeline.run(
      [
        bufferCandidate(bytes, { sourceId: 'watched', externalId: '/in/a.pdf' }),
        bufferCandidate(bytes, { sourceId: 'watched', externalId: '/in/b.pdf' }),
      ],
      { runLabel: 'two-doubtful' },
    );

    expect(report.counts.review).toBe(2);
    expect(openEntries(report.runId)).toHaveLength(1);
    expect(checkOf(report.verification, 'review_entries_raised')?.ok).toBe(true);
    expect(report.verification.pass).toBe(true);
  });

  it('FAILS when the review entry the run raised is no longer open', async () => {
    // A candidate with nothing to say about itself: no text layer, no OCR engine, no extractor
    // that helps. It goes to a person, and the run says so.
    const pipeline = new IngestPipeline({
      recueil: library,
      config: { scratchRoot: library.root, concurrency: 1, ocrEnabled: false },
      extractors: [],
    });
    const report = await pipeline.run(
      [bufferCandidate(makePdf({ salt: 'doubtful' }), { sourceId: 'watched', externalId: '/in/scan.pdf' })],
      { runLabel: 'doubtful' },
    );
    expect(report.counts.review).toBe(1);
    expect(report.verification.pass).toBe(true);

    library.db
      .update(reviewQueueTable)
      .set({ status: 'accepted', resolvedAt: new Date().toISOString() })
      .where(eq(reviewQueueTable.jobId, report.runId))
      .run();

    const verification = reverify(pipeline, report);
    expect(verification.queried.namedReviewEntriesOpen).toBe(0);
    expect(checkOf(verification, 'review_entries_raised')?.ok).toBe(false);
    expect(verification.pass).toBe(false);
  });
});

/* ------------------------------------------------------------------------------------------ */
/* 3. The job state, derived from the queue                                                      */
/* ------------------------------------------------------------------------------------------ */

describe('a run that left work for a person', () => {
  it('does not report itself clean when the commit raised a rule-conflict entry', async () => {
    const bytes = invoiceBytes('rule-conflict');
    const pipeline = new IngestPipeline({
      recueil: library,
      config: { scratchRoot: library.root, concurrency: 1 },
      extractors: [new SlowOfficeExtractor(1)],
      rules: [
        {
          id: 'file-into-nowhere',
          match: { sourceKind: ['folder'] },
          // The collection does not exist. `commitProposal` files the item, warns, and raises an
          // open `rule_conflict` entry against this job — none of which changes the candidate's
          // outcome, which is why counting outcomes could not see it.
          actions: { addCollectionIds: ['col_does_not_exist'] },
        },
      ],
    });

    const report = await pipeline.run(
      [bufferCandidate(bytes, { sourceKind: 'folder', sourceId: 'watched', externalId: '/in/x.pdf' })],
      { runLabel: 'conflict' },
    );

    expect(report.counts.ingested).toBe(1);
    expect(report.counts.review).toBe(0);

    const entries = openEntries(report.runId);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.reasonCode).toBe('rule_conflict');

    expect(report.verification.queried.openReviewEntries).toBe(1);
    expect(jobRow(report.runId)!.state).toBe('waiting_review');
  });

  it('names the open blocker when a candidate exhausted its retries', async () => {
    const bytes = invoiceBytes('doomed');
    const pipeline = new IngestPipeline({
      recueil: library,
      config: { scratchRoot: library.root, concurrency: 1 },
      extractors: [new DoomedExtractor()],
    });

    const report = await pipeline.run(
      [bufferCandidate(bytes, { sourceId: 'watched', externalId: '/in/doomed.pdf' })],
      { runLabel: 'blocker' },
    );

    expect(report.counts.failed).toBe(1);

    const entries = openEntries(report.runId);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.severity).toBe('blocker');

    // The queue is queried, so the run can say what it is waiting on rather than only that it fell
    // over. Before this, the blocker was invisible to every number the run reported.
    expect(report.verification.queried.blockerReviewEntries).toBe(1);
    expect(report.verification.queried.openReviewEntries).toBe(1);

    const job = jobRow(report.runId)!;
    expect(job.state).not.toBe('succeeded');
    expect(job.errorMessage).toContain('review_queue');
  });

  it('still reports a clean run as succeeded', async () => {
    const bytes = invoiceBytes('clean');
    const pipeline = new IngestPipeline({
      recueil: library,
      config: { scratchRoot: library.root, concurrency: 1 },
      extractors: [new SlowOfficeExtractor(1)],
    });
    const report = await pipeline.run(
      [bufferCandidate(bytes, { sourceId: 'watched', externalId: '/in/clean.pdf' })],
      { runLabel: 'clean' },
    );
    expect(openEntries(report.runId)).toHaveLength(0);
    expect(jobRow(report.runId)!.state).toBe('succeeded');
    expect(report.verification.pass).toBe(true);
  });
});
