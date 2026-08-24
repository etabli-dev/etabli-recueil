/**
 * The pipeline, end to end.
 *
 * These are the six behaviours CONCEPT §5.3 is judged on: an archive expands into its members, a
 * re-ingest produces one document and two arrivals, a page with no text layer reaches OCR and the
 * recognised text becomes findable, a doubtful record reaches a person instead of the library, an
 * interrupted run resumes to the same end state, and scratch is empty when it is over.
 */
import { readdirSync } from 'node:fs';

import { schema } from '@recueil/core';
import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  EventBus,
  FakeMetadataExtractor,
  FakeOcrEngine,
  IngestPipeline,
  bufferCandidate,
  candidateKey,
  reviewQueue,
} from '../src/index.js';
import type { IngestCandidate } from '../src/index.js';
import { invoiceLines, makeLibrary, makePdf, makeZip, scholarlyLines } from './helpers.js';
import type { TestLibrary } from './helpers.js';

let library: TestLibrary;

beforeEach(() => {
  library = makeLibrary();
});

afterEach(() => {
  library.dispose();
});

const documentCount = (): number =>
  library.db.select({ n: sql<number>`count(*)` }).from(schema.documents).get()?.n ?? 0;

const itemCount = (): number =>
  library.db.select({ n: sql<number>`count(*)` }).from(schema.items).get()?.n ?? 0;

const provenanceCount = (documentId: string): number =>
  library.db
    .select({ n: sql<number>`count(*)` })
    .from(schema.documentProvenance)
    .where(eq(schema.documentProvenance.documentId, documentId))
    .get()?.n ?? 0;

const jobRows = () =>
  library.db.select().from(schema.jobs).where(eq(schema.jobs.jobType, 'ingest.run')).all();

const jobLogRows = (jobId: string) =>
  library.db.select().from(schema.jobLogs).where(eq(schema.jobLogs.jobId, jobId)).all();

const auditRows = (action: string) =>
  library.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, action)).all();

/* ------------------------------------------------------------------------------------------ */

describe('a zip of two PDFs', () => {
  it('produces two documents, two items and one audit trail', async () => {
    const first = makePdf({ lines: scholarlyLines({ title: 'On Ingestion', doi: '10.1234/one' }) });
    const second = makePdf({ lines: scholarlyLines({ title: 'On Provenance', doi: '10.1234/two' }) });
    const archive = makeZip([
      { name: 'papers/one.pdf', bytes: first },
      { name: 'papers/two.pdf', bytes: second },
    ]);

    const events = new EventBus();
    const pipeline = new IngestPipeline({
      recueil: library,
      config: { scratchRoot: library.root },
      events,
      extractors: [
        new FakeMetadataExtractor({
          fallback: { itemType: 'article', title: 'A paper', confidence: 0.9 },
        }),
      ],
    });

    const report = await pipeline.run(
      [bufferCandidate(archive, { filename: 'papers.zip', sourceId: 'test', externalId: 'papers.zip' })],
      { runLabel: 'zip-run' },
    );

    // Two PDFs came out; the zip itself is a lorry and is not kept by default.
    expect(documentCount()).toBe(2);
    expect(itemCount()).toBe(2);
    expect(report.counts.ingested).toBe(2);
    expect(report.counts.containers).toBe(1);

    // One audit trail: one job row, whose log names both documents.
    const jobs = jobRows();
    expect(jobs).toHaveLength(1);
    const logs = jobLogRows(jobs[0]!.id);
    const documentIds = library.db.select({ id: schema.documents.id }).from(schema.documents).all();
    for (const { id } of documentIds) {
      expect(logs.some((line) => line.subjectId === id)).toBe(true);
    }

    // And the append-only log has one ingestion per document (P5).
    expect(auditRows('document.ingested')).toHaveLength(2);
    expect(auditRows('item.created')).toHaveLength(2);

    // The report's verification queries the library rather than narrating the run.
    expect(report.verification.queried.documentsCreated).toBe(2);
    expect(report.verification.queried.itemsWithAttachment).toBe(2);
    expect(report.verification.pass).toBe(true);

    // Scratch was used and is gone.
    expect(report.scratchClean).toBe(true);

    const created = events.of('item.created');
    expect(created).toHaveLength(2);
  });

  it('files each member under the archive it came from', async () => {
    const archive = makeZip([
      { name: 'a.pdf', bytes: makePdf({ lines: scholarlyLines({ title: 'A', doi: '10.1/a' }) }) },
    ]);
    const pipeline = new IngestPipeline({
      recueil: library,
      config: { scratchRoot: library.root },
      extractors: [new FakeMetadataExtractor({ fallback: { title: 'A', confidence: 0.9 } })],
    });

    await pipeline.run([bufferCandidate(archive, { filename: 'papers.zip' })], { runLabel: 'r' });

    const document = library.db.select().from(schema.documents).get();
    const detail = JSON.parse(document!.sourceDetail) as { archive?: { entry?: string } };
    expect(detail.archive?.entry).toBe('a.pdf');
  });
});

/* ------------------------------------------------------------------------------------------ */

describe('ingesting the same file twice', () => {
  it('produces one document, one item and two provenance records', async () => {
    const bytes = makePdf({ lines: scholarlyLines({ title: 'Twice', doi: '10.1234/twice' }) });
    const pipeline = new IngestPipeline({
      recueil: library,
      config: { scratchRoot: library.root },
      extractors: [new FakeMetadataExtractor({ fallback: { title: 'Twice', confidence: 0.9 } })],
    });

    const candidate = (): IngestCandidate =>
      bufferCandidate(bytes, { filename: 'twice.pdf', sourceId: 'watched', externalId: '/in/twice.pdf' });

    const first = await pipeline.run([candidate()], { runLabel: 'first' });
    const second = await pipeline.run([candidate()], { runLabel: 'second' });

    expect(documentCount()).toBe(1);
    expect(itemCount()).toBe(1);

    const documentId = library.db.select().from(schema.documents).get()!.id;
    expect(provenanceCount(documentId)).toBe(2);

    expect(first.outcomes[0]!.outcome.status).toBe('ingested');
    expect(second.outcomes[0]!.outcome.status).toBe('duplicate');

    // Exactly one arrival is the origin; the second is a fact about the library, not a new document.
    const firstFlags = library.db
      .select({ isFirst: schema.documentProvenance.isFirst })
      .from(schema.documentProvenance)
      .where(eq(schema.documentProvenance.documentId, documentId))
      .all();
    expect(firstFlags.filter((row) => row.isFirst)).toHaveLength(1);
  });

  it('is idempotent within one run label as well', async () => {
    const bytes = makePdf({ lines: scholarlyLines({ title: 'Same', doi: '10.1234/same' }) });
    const pipeline = new IngestPipeline({
      recueil: library,
      config: { scratchRoot: library.root },
      extractors: [new FakeMetadataExtractor({ fallback: { title: 'Same', confidence: 0.9 } })],
    });

    const candidate = bufferCandidate(bytes, { sourceId: 's', externalId: 'same.pdf' });
    await pipeline.run([candidate], { runLabel: 'once' });
    await pipeline.run([candidate], { runLabel: 'once' });

    expect(documentCount()).toBe(1);
    expect(itemCount()).toBe(1);
    expect(jobRows()).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------------------------------ */

describe('a page with no text layer', () => {
  it('routes to OCR, and the recognised text lands in the search index', async () => {
    const scan = makePdf({ salt: 'scan-1' });
    const ocr = new FakeOcrEngine({
      defaultText:
        'Stadtwerke Ulm\nRechnung\nRechnungsdatum: 14.03.2026\nRechnungsnummer: SW-2026-0042\n' +
        'Kundennummer: KD-99213\nGesamtbetrag 1.234,56 EUR',
    });

    const pipeline = new IngestPipeline({ recueil: library, config: { scratchRoot: library.root }, ocr });

    const report = await pipeline.run(
      [bufferCandidate(scan, { filename: 'scan.pdf', sourceKind: 'scanner', sourceId: 'ads-4700w' })],
      { runLabel: 'scan-run' },
    );

    expect(ocr.calls).toHaveLength(1);

    const document = library.db.select().from(schema.documents).get()!;
    expect(document.hasTextLayer).toBe(false);
    expect(document.ocrStatus).toBe('done');
    expect(document.textCharCount).toBeGreaterThan(0);
    expect(document.simhash).toMatch(/^[0-9a-f]{16}$/u);

    // The words the fake produced are findable, which is the whole point of stage 5.
    const hits = library.search.search('Rechnungsnummer');
    expect(hits.hits.some((hit) => hit.entityId === document.id)).toBe(true);

    // And the document is reachable whichever side of the gate it fell on.
    expect(['ingested', 'review']).toContain(report.outcomes[0]!.outcome.status);
  });

  it('records ocr_status = skipped when no engine is configured, and files nothing silently', async () => {
    const scan = makePdf({ salt: 'scan-2' });
    const pipeline = new IngestPipeline({ recueil: library, config: { scratchRoot: library.root } });

    const report = await pipeline.run([bufferCandidate(scan, { filename: 'scan.pdf' })], {
      runLabel: 'no-ocr',
    });

    const document = library.db.select().from(schema.documents).get()!;
    expect(document.ocrStatus).toBe('skipped');
    expect(report.outcomes[0]!.outcome.status).toBe('review');
    expect(itemCount()).toBe(0);
  });

  it('raises ocr_failed and keeps going when the engine throws', async () => {
    const scan = makePdf({ salt: 'scan-3' });
    const ocr = new FakeOcrEngine({ failWith: new Error('tesseract died') });
    const pipeline = new IngestPipeline({ recueil: library, config: { scratchRoot: library.root }, ocr });

    await pipeline.run([bufferCandidate(scan, { filename: 'scan.pdf' })], { runLabel: 'ocr-fail' });

    const entries = library.db
      .select()
      .from(reviewQueue)
      .where(eq(reviewQueue.reasonCode, 'ocr_failed'))
      .all();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.explanation).toContain('tesseract died');
    expect(library.db.select().from(schema.documents).get()!.ocrStatus).toBe('failed');
  });
});

/* ------------------------------------------------------------------------------------------ */

describe('the confidence gate', () => {
  it('writes a review entry instead of an item when the score is below the threshold', async () => {
    const bytes = makePdf({ lines: scholarlyLines({ title: 'Doubtful', doi: '10.1234/doubt' }) });
    const pipeline = new IngestPipeline({
      recueil: library,
      config: { scratchRoot: library.root, confidenceThreshold: 0.75 },
      extractors: [new FakeMetadataExtractor({ fallback: { title: 'Doubtful', confidence: 0.05 } })],
    });

    const report = await pipeline.run([bufferCandidate(bytes, { filename: 'doubtful.pdf' })], {
      runLabel: 'gate',
    });

    expect(itemCount()).toBe(0);
    expect(documentCount()).toBe(1);

    const outcome = report.outcomes[0]!.outcome;
    expect(outcome.status).toBe('review');

    const entries = library.db.select().from(reviewQueue).all();
    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    expect(entry.status).toBe('open');
    expect(entry.subjectType).toBe('document');
    expect(entry.proposedAction).toBe('create_item');
    expect(entry.sourceStage).toBe('ingest.9');
    expect(entry.confidence).toBeLessThan(0.75);

    // The explanation says what the pipeline was unsure about, not merely that it was unsure.
    expect(entry.explanation).toContain('the score is');
    expect(entry.explanation).toContain('threshold');

    // And the proposal is carried, so accepting the entry has something to execute (RQ1).
    const payload = JSON.parse(entry.proposedPayload!) as { fields: Record<string, unknown> };
    expect(payload.fields['bibliographic.title']).toBe('Doubtful');
  });

  it('creates the item when the score clears the threshold', async () => {
    const bytes = makePdf({ lines: scholarlyLines({ title: 'Confident', doi: '10.1234/sure' }) });
    const pipeline = new IngestPipeline({
      recueil: library,
      config: { scratchRoot: library.root },
      extractors: [
        new FakeMetadataExtractor({
          fallback: {
            itemType: 'article',
            title: 'Confident',
            containerTitle: 'Journal of Reproducible Findings',
            issuedYear: 2026,
            doi: '10.1234/sure',
            confidence: 0.95,
          },
        }),
      ],
    });

    const report = await pipeline.run([bufferCandidate(bytes, { filename: 'sure.pdf' })], {
      runLabel: 'gate-pass',
    });

    expect(report.outcomes[0]!.outcome.status).toBe('ingested');
    expect(itemCount()).toBe(1);
    expect(library.db.select().from(reviewQueue).all()).toHaveLength(0);

    const item = library.db.select().from(schema.items).get()!;
    expect(item.itemType).toBe('article');
    const facet = library.db.select().from(schema.itemBibliographic).get()!;
    expect(facet.title).toBe('Confident');
    expect(facet.doi).toBe('10.1234/sure');
  });

  it('does not open a second entry for the same problem on a re-run (P9)', async () => {
    const bytes = makePdf({ lines: scholarlyLines({ title: 'Doubtful', doi: '10.1234/doubt2' }) });
    const make = (): IngestPipeline =>
      new IngestPipeline({
        recueil: library,
        config: { scratchRoot: library.root },
        extractors: [new FakeMetadataExtractor({ fallback: { title: 'D', confidence: 0.05 } })],
      });

    await make().run([bufferCandidate(bytes, { externalId: 'd.pdf' })], { runLabel: 'a' });
    await make().run([bufferCandidate(bytes, { externalId: 'd.pdf' })], { runLabel: 'b' });

    const open = library.db.select().from(reviewQueue).where(eq(reviewQueue.status, 'open')).all();
    expect(open).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------------------------------ */

describe('an interrupted run', () => {
  it('resumes to the same end state without repeating the expensive stages', async () => {
    const good = makePdf({ salt: 'resume-good' });
    const doomed = makePdf({ salt: 'resume-doomed' });

    const ocrText = 'Deutsche Rentenversicherung\nRenteninformation\nDatum: 02.02.2026\nAktenzeichen: RV-771';
    const ocr = new FakeOcrEngine({ defaultText: ocrText });

    // The digest of the doomed file, so the flaky extractor knows which one to die on. Putting the
    // bytes in the store now is harmless: the store is content-addressed and the pipeline's own
    // `put` of the same bytes is a verified no-op.
    const doomedSha = (await library.storage.put(doomed)).sha256;

    // An extractor that dies the first time it is asked about the second document, and behaves
    // afterwards. That is what an interrupted run looks like from the pipeline's point of view.
    let deaths = 0;
    const flaky = new FakeMetadataExtractor({
      fallback: { itemType: 'document', title: 'Renteninformation', confidence: 0.95 },
      supports: ['scan', 'office_document', 'scholarly_pdf', 'text'],
    });
    const originalExtract = flaky.extract.bind(flaky);
    flaky.extract = async (request) => {
      if (deaths === 0 && request.sha256 === doomedSha) {
        deaths += 1;
        throw new Error('the process died mid-run');
      }
      return originalExtract(request);
    };

    const pipeline = new IngestPipeline({
      recueil: library,
      // One at a time, so the order the two candidates are handled in is deterministic.
      config: { scratchRoot: library.root, concurrency: 1, maxAttemptsPerCandidate: 1 },
      ocr,
      extractors: [flaky],
    });

    const candidates = [
      bufferCandidate(good, { filename: 'good.pdf', sourceId: 'src', externalId: 'good.pdf' }),
      bufferCandidate(doomed, { filename: 'doomed.pdf', sourceId: 'src', externalId: 'doomed.pdf' }),
    ];

    const interrupted = await pipeline.run(candidates, { runLabel: 'resumable' });
    expect(interrupted.counts.failed).toBe(1);
    expect(interrupted.counts.ingested).toBe(1);

    const ocrCallsAfterFirstRun = ocr.calls.length;
    expect(ocrCallsAfterFirstRun).toBe(2);

    const resumed = await pipeline.run(candidates, { runLabel: 'resumable' });

    expect(resumed.resumed).toBe(true);
    expect(resumed.counts.failed).toBe(0);
    expect(resumed.counts.ingested + resumed.counts.duplicates).toBe(2);

    // Both documents are filed, and there is still exactly one of each.
    expect(documentCount()).toBe(2);
    expect(itemCount()).toBe(2);

    // The whole point of the checkpoint: OCR ran twice in total, not four times. The good
    // candidate was skipped from its terminal checkpoint and the doomed one resumed after stage 5.
    expect(ocr.calls).toHaveLength(2);

    // One job row across both attempts, with the second recorded as a second attempt.
    const jobs = jobRows();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.attempts).toBe(2);
    expect(jobs[0]!.state).toBe('succeeded');
  });

  it('leaves no stage checkpoints behind once a candidate has committed', async () => {
    const bytes = makePdf({ lines: scholarlyLines({ title: 'Clean', doi: '10.1234/clean' }) });
    const pipeline = new IngestPipeline({
      recueil: library,
      config: { scratchRoot: library.root },
      extractors: [new FakeMetadataExtractor({ fallback: { title: 'Clean', confidence: 0.95 } })],
    });

    await pipeline.run([bufferCandidate(bytes, { externalId: 'clean.pdf' })], { runLabel: 'compact' });

    const stages = library.connection
      .prepare(`select stage from ingest_checkpoints`)
      .all() as Array<{ stage: string }>;
    expect(stages.map((row) => row.stage)).toEqual(['commit']);
  });
});

/* ------------------------------------------------------------------------------------------ */

describe('scratch', () => {
  it('is empty after a run, and after a run that failed', async () => {
    const archive = makeZip([
      { name: 'ok.pdf', bytes: makePdf({ lines: invoiceLines({ correspondent: 'Acme', reference: 'A-1' }) }) },
    ]);

    const pipeline = new IngestPipeline({ recueil: library, config: { scratchRoot: library.root } });
    const report = await pipeline.run([bufferCandidate(archive, { filename: 'a.zip' })], {
      runLabel: 'scratch-ok',
    });
    expect(report.scratchClean).toBe(true);

    // Nothing named after the run is left in the configured scratch root either.
    const leftovers = readdirSync(library.root).filter((name) => name.startsWith('recueil-ingest-'));
    expect(leftovers).toEqual([]);
  });

  it('cleans up when extraction throws', async () => {
    // A zip whose central directory is intact but whose member data is truncated: the reader gets
    // through the limits and then fails on the CRC, which is the awkward case for a `finally`.
    const good = makeZip([{ name: 'a.pdf', bytes: makePdf({ salt: 'x' }) }]);
    const broken = Buffer.from(good);
    broken[40] = (broken[40]! ^ 0xff) & 0xff;

    const pipeline = new IngestPipeline({ recueil: library, config: { scratchRoot: library.root } });
    const report = await pipeline.run([bufferCandidate(broken, { filename: 'broken.zip' })], {
      runLabel: 'scratch-fail',
    });

    expect(report.scratchClean).toBe(true);
    expect(readdirSync(library.root).filter((name) => name.startsWith('recueil-ingest-'))).toEqual([]);

    // The unreadable archive is kept whatever the container policy says, with a review entry on it.
    expect(documentCount()).toBe(1);
    const entries = library.db.select().from(reviewQueue).all();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.reasonCode).toBe('archive_unreadable');
  });
});

/* ------------------------------------------------------------------------------------------ */

describe('the run report', () => {
  it('verifies against the database rather than against its own tally', async () => {
    const bytes = makePdf({ lines: scholarlyLines({ title: 'Checked', doi: '10.1234/checked' }) });
    const pipeline = new IngestPipeline({
      recueil: library,
      config: { scratchRoot: library.root },
      extractors: [new FakeMetadataExtractor({ fallback: { title: 'Checked', confidence: 0.95 } })],
    });

    const report = await pipeline.run([bufferCandidate(bytes, { externalId: 'checked.pdf' })], {
      runLabel: 'verify',
    });
    expect(report.verification.pass).toBe(true);

    // Break the library behind the report's back and re-derive it: a check that cannot fail is not
    // a check, so this proves the numbers come from the tables.
    const documentId = library.db.select().from(schema.documents).get()!.id;
    library.db
      .update(schema.attachments)
      .set({ trashedAt: new Date().toISOString() })
      .where(eq(schema.attachments.documentId, documentId))
      .run();

    const rerun = await pipeline.run([bufferCandidate(bytes, { externalId: 'checked.pdf' })], {
      runLabel: 'verify-2',
    });
    expect(rerun.verification.queried.itemsWithAttachment).toBe(0);
  });
});

/* ------------------------------------------------------------------------------------------ */

describe('a crash between the commit and its checkpoint', () => {
  it('does not file the document a second time when the run resumes', async () => {
    const bytes = makePdf({ lines: scholarlyLines({ title: 'Torn', doi: '10.1234/torn' }) });
    const pipeline = new IngestPipeline({
      recueil: library,
      config: { scratchRoot: library.root },
      extractors: [new FakeMetadataExtractor({ fallback: { title: 'Torn', confidence: 0.95 } })],
    });

    const candidate = bufferCandidate(bytes, { sourceId: 'src', externalId: 'torn.pdf' });
    await pipeline.run([candidate], { runLabel: 'torn' });
    expect(itemCount()).toBe(1);

    const documentId = library.db.select().from(schema.documents).get()!.id;
    const job = jobRows()[0]!;

    // Reconstruct the state a crash between stage 10's commit and its checkpoint leaves behind:
    // the item exists, the terminal checkpoint does not, and the stage-2 checkpoint still says the
    // document was not filed — because it was not, when that checkpoint was written.
    library.connection.prepare(`update jobs set state = 'running' where id = ?`).run(job.id);
    library.connection.prepare(`delete from ingest_checkpoints where run_id = ?`).run(job.id);
    const key = candidateKey(candidate.ref);
    const sha = library.db.select().from(schema.documents).get()!.sha256;
    library.connection
      .prepare(
        `insert into ingest_checkpoints (run_id, candidate_key, stage, sha256, payload, created_at)
         values (?, ?, 'duplicate_check', ?, ?, ?)`,
      )
      .run(
        job.id,
        key,
        sha,
        JSON.stringify({
          documentId,
          sha256: sha,
          byteSize: bytes.length,
          mediaType: 'application/pdf',
          created: true,
          alreadyFiled: false,
        }),
        new Date().toISOString(),
      );

    const resumed = await pipeline.run([candidate], { runLabel: 'torn' });

    expect(resumed.resumed).toBe(true);
    expect(itemCount()).toBe(1);
    expect(documentCount()).toBe(1);
    expect(resumed.outcomes[0]!.outcome.status).toBe('duplicate');
  });
});

/* ------------------------------------------------------------------------------------------ */

describe('an archive whose member fails', () => {
  it('retries only that member when the run resumes', async () => {
    const one = makePdf({ lines: scholarlyLines({ title: 'Member one', doi: '10.9/one' }) });
    const two = makePdf({ lines: scholarlyLines({ title: 'Member two', doi: '10.9/two' }) });
    const archive = makeZip([
      { name: 'one.pdf', bytes: one },
      { name: 'two.pdf', bytes: two },
    ]);

    const oneSha = (await library.storage.put(one)).sha256;
    const twoSha = (await library.storage.put(two)).sha256;

    let died = false;
    const extractor = new FakeMetadataExtractor({
      fallback: { itemType: 'article', title: 'Member', confidence: 0.95 },
    });
    const original = extractor.extract.bind(extractor);
    extractor.extract = async (request) => {
      if (!died && request.sha256 === twoSha) {
        died = true;
        throw new Error('the process died on the second member');
      }
      return original(request);
    };

    const pipeline = new IngestPipeline({
      recueil: library,
      config: { scratchRoot: library.root, concurrency: 1, maxAttemptsPerCandidate: 1 },
      extractors: [extractor],
    });

    const candidate = bufferCandidate(archive, { sourceId: 'src', externalId: 'members.zip' });

    const first = await pipeline.run([candidate], { runLabel: 'members' });
    expect(first.counts.ingested).toBe(1);
    expect(first.counts.failed).toBe(1);
    expect(itemCount()).toBe(1);

    const callsAfterFirstRun = extractor.calls.length;

    const resumed = await pipeline.run([candidate], { runLabel: 'members' });
    expect(resumed.counts.failed).toBe(0);
    expect(itemCount()).toBe(2);
    expect(documentCount()).toBe(2);

    // The member that succeeded is not extracted again; only the one that failed is. The throwing
    // attempt never reaches the recorder, so `twoSha` is counted once — on the resume.
    expect(extractor.calls.length).toBe(callsAfterFirstRun + 1);
    expect(extractor.callsFor(oneSha)).toBe(1);
    expect(extractor.callsFor(twoSha)).toBe(1);
  });
});
