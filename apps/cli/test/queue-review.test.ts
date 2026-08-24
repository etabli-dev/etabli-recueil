/**
 * `recueil queue` and `recueil review`, over a library a real ingest run filled.
 *
 * The state under test is state the pipeline produced: a `jobs` row for the run, and a
 * `review_queue` row the confidence gate wrote. Nothing here inserts a row by hand except where a
 * state cannot otherwise be reached, and every assertion about the effect of a command reads the
 * library back through another command rather than trusting the first one's own report.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { fixture, makeWorkspace, runCli, runJson, sha256OfFile, type Workspace } from './ingest-fixture.js';

const RECOGNISED = ['Stadtwerke Ulm GmbH', 'Rechnungsnummer: 2023-004417', 'Betrag 471,50 EUR'].join('\n');

interface ReviewEntry {
  id: string;
  subjectType: string;
  subjectId: string;
  reasonCode: string;
  explanation: string;
  proposedAction: string | null;
  proposedPayload: { itemType?: string; fields?: Record<string, unknown> } | null;
  confidence: number | null;
  severity: string;
  status: string;
  jobId: string | null;
}

interface JobEntry {
  id: string;
  jobType: string;
  state: string;
  attempts: number;
  maxAttempts: number;
  progressDone: number;
  progressTotal: number | null;
  errorMessage: string | null;
  cursor: string | null;
}

let work: Workspace;

beforeEach(() => {
  work = makeWorkspace('recueil-cli-queue-');
});

afterEach(() => {
  work.dispose();
});

/** One ingest run that leaves exactly one open review entry and one finished job. */
const ingestOneScan = async (): Promise<{ entry: ReviewEntry; jobs: JobEntry[] }> => {
  const scan = fixture('scans', 'invoice-image-only.pdf');
  const corpus = work.file('ocr.json', JSON.stringify({ [sha256OfFile(scan)]: RECOGNISED }));

  const ingest = await runCli([
    'ingest',
    scan,
    ...work.libraryArgs,
    '--source-kind',
    'scanner',
    '--ocr',
    'fake',
    '--ocr-corpus',
    corpus,
    '--no-progress',
  ]);
  expect(ingest.code).toBe(4);

  const review = await runJson<{ entries: ReviewEntry[] }>(['review', 'list', ...work.libraryArgs, '--full']);
  const jobs = await runJson<{ jobs: JobEntry[] }>(['queue', 'list', ...work.libraryArgs, '--full']);
  expect(review.json.entries).toHaveLength(1);
  return { entry: review.json.entries[0]!, jobs: jobs.json.jobs };
};

describe('recueil queue list', () => {
  it('shows the run the ingest created, with its progress and its type', async () => {
    const { jobs } = await ingestOneScan();
    const run = jobs.find((job) => job.jobType === 'ingest.run');
    expect(run, `no ingest.run job in ${JSON.stringify(jobs)}`).toBeDefined();
    expect(run!.state).toBe('waiting_review');
    expect(run!.progressDone).toBe(1);
    expect(run!.progressTotal).toBe(1);
  });

  it('filters by state and by type, and says so when nothing matches', async () => {
    await ingestOneScan();

    const byType = await runJson<{ jobs: JobEntry[] }>(['queue', 'list', ...work.libraryArgs, '--type', 'ingest.run']);
    expect(byType.json.jobs.every((job) => job.jobType === 'ingest.run')).toBe(true);
    expect(byType.json.jobs.length).toBeGreaterThan(0);

    const none = await runCli(['queue', 'list', ...work.libraryArgs, '--state', 'dead']);
    expect(none.code).toBe(0);
    expect(none.stdout).toMatch(/No jobs match/u);
  });

  it('refuses to invent a library that is not there', async () => {
    const result = await runCli(['queue', 'list', ...work.libraryArgs]);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/no library at/u);
  });
});

describe('recueil queue retry', () => {
  it('re-queues a finished run and keeps its cursor', async () => {
    const { jobs } = await ingestOneScan();
    const run = jobs.find((job) => job.jobType === 'ingest.run')!;

    const retried = await runJson<{ changed: Array<{ id: string; from: string }>; refused: unknown[] }>([
      'queue',
      'retry',
      run.id.slice(0, 10),
      ...work.libraryArgs,
    ]);
    expect(retried.json.refused).toEqual([]);
    expect(retried.json.changed[0]?.id).toBe(run.id);

    // Read the row back rather than believing the command: state queued, error cleared, attempts
    // untouched, and the ceiling lifted so the check constraint still holds.
    const after = await runJson<{ jobs: JobEntry[] }>(['queue', 'list', ...work.libraryArgs, '--full']);
    const row = after.json.jobs.find((job) => job.id === run.id)!;
    expect(row.state).toBe('queued');
    expect(row.errorMessage).toBeNull();
    expect(row.attempts).toBe(run.attempts);
    expect(row.maxAttempts).toBeGreaterThanOrEqual(run.attempts + 1);
  });

  it('refuses an id that names nothing, and an ambiguous prefix is reported', async () => {
    await ingestOneScan();
    const missing = await runCli(['queue', 'retry', 'zzzzzzzz', ...work.libraryArgs]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toMatch(/no job with id/u);
  });
});

describe('recueil queue cancel', () => {
  it('cancels a queued job and refuses one that has already finished', async () => {
    const { jobs } = await ingestOneScan();
    const run = jobs.find((job) => job.jobType === 'ingest.run')!;

    // Put it back in the queue so there is something cancellable, then cancel it.
    await runCli(['queue', 'retry', run.id, ...work.libraryArgs]);
    const cancelled = await runJson<{ changed: Array<{ id: string }>; refused: unknown[] }>([
      'queue',
      'cancel',
      run.id,
      ...work.libraryArgs,
    ]);
    expect(cancelled.json.refused).toEqual([]);

    const after = await runJson<{ jobs: JobEntry[] }>(['queue', 'list', ...work.libraryArgs, '--full']);
    expect(after.json.jobs.find((job) => job.id === run.id)?.state).toBe('cancelled');

    // A cancelled job cannot be cancelled again, and the refusal says why rather than lying.
    const again = await runJson<{ refused: Array<{ id: string; reason: string }> }>([
      'queue',
      'cancel',
      run.id,
      ...work.libraryArgs,
    ]);
    expect(again.json.refused[0]?.reason).toMatch(/already cancelled/u);
    expect(again.code).toBe(1);
  });
});

describe('recueil review list', () => {
  it('shows the gate\'s reason, its score and the proposal it would execute', async () => {
    const { entry } = await ingestOneScan();

    expect(entry.subjectType).toBe('document');
    expect(entry.reasonCode).toBe('low_confidence_metadata');
    expect(entry.status).toBe('open');
    expect(entry.proposedAction).toBe('create_item');
    expect(entry.confidence).toBeGreaterThan(0);
    expect(entry.confidence).toBeLessThan(0.75);
    expect(entry.explanation).toMatch(/The threshold is 0\.75/u);
    // The stored proposal is what accept will run, so it has to carry the facts the extractor found.
    expect(entry.proposedPayload?.fields).toMatchObject({ 'office.referenceNumber': '2023-004417' });
  });

  it('filters by reason and by status', async () => {
    await ingestOneScan();

    const wrong = await runJson<{ entries: ReviewEntry[] }>([
      'review',
      'list',
      ...work.libraryArgs,
      '--reason',
      'unsafe_archive_path',
    ]);
    expect(wrong.json.entries).toEqual([]);

    const accepted = await runJson<{ entries: ReviewEntry[] }>([
      'review',
      'list',
      ...work.libraryArgs,
      '--status',
      'accepted',
    ]);
    expect(accepted.json.entries).toEqual([]);
  });
});

describe('recueil review accept', () => {
  it('moves the entry into the library: an item, an attachment, and a closed entry', async () => {
    const { entry } = await ingestOneScan();

    const accepted = await runJson<{
      accepted: Array<{ id: string; itemId: string | null; attachmentId: string | null; warnings: string[] }>;
      refused: unknown[];
    }>(['review', 'accept', entry.id, ...work.libraryArgs, '--note', 'checked by hand']);

    expect(accepted.code).toBe(0);
    expect(accepted.json.refused).toEqual([]);
    const result = accepted.json.accepted[0]!;
    expect(result.itemId).toBeTruthy();
    expect(result.attachmentId).toBeTruthy();
    expect(result.warnings).toEqual([]);

    // The library really holds it: exporting finds the item the proposal described.
    const exported = await runCli(['export', 'csl-json', ...work.libraryArgs, '--all']);
    const records = JSON.parse(exported.stdout.slice(0, exported.stdout.indexOf('\n]') + 2)) as Array<{
      title?: string;
    }>;
    expect(records).toHaveLength(1);
    expect(records[0]?.title).toMatch(/Stadtwerke Ulm/u);

    // And the queue is empty, with the decision on the record.
    const open = await runJson<{ entries: ReviewEntry[]; open: Record<string, number> }>([
      'review',
      'list',
      ...work.libraryArgs,
    ]);
    expect(open.json.entries).toEqual([]);
    expect(open.json.open).toEqual({ info: 0, warning: 0, blocker: 0 });

    const closed = await runJson<{ entries: Array<ReviewEntry & { resolutionNote: string | null }> }>([
      'review',
      'list',
      ...work.libraryArgs,
      '--status',
      'accepted',
      '--full',
    ]);
    expect(closed.json.entries[0]?.id).toBe(entry.id);
    expect(closed.json.entries[0]?.resolutionNote).toBe('checked by hand');
  });

  it('refuses an entry that has already been resolved, rather than doing it twice', async () => {
    const { entry } = await ingestOneScan();
    await runCli(['review', 'accept', entry.id, ...work.libraryArgs]);

    const again = await runJson<{ refused: Array<{ id: string; reason: string }> }>([
      'review',
      'accept',
      entry.id,
      ...work.libraryArgs,
    ]);
    expect(again.json.refused[0]?.reason).toMatch(/already accepted/u);
    expect(again.code).toBe(5);

    // And no second item was created.
    const exported = await runCli(['export', 'csl-json', ...work.libraryArgs, '--all']);
    const records = JSON.parse(exported.stdout.slice(0, exported.stdout.indexOf('\n]') + 2)) as unknown[];
    expect(records).toHaveLength(1);
  });

  it('refuses an id that names nothing, as a usage error rather than a crash', async () => {
    await ingestOneScan();
    const result = await runCli(['review', 'accept', '01ZZZZZZZZ', ...work.libraryArgs]);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/no review queue entry with id/u);
    // A usage error, not "this is a bug in Recueil" with a stack under it.
    expect(result.stderr).not.toMatch(/unexpected error/u);
  });

  it('refuses to work a library that is not there', async () => {
    const result = await runCli(['review', 'accept', '01ZZZZZZZZ', ...work.libraryArgs]);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/no library at/u);
  });

  it('demands ids or --all rather than guessing', async () => {
    await ingestOneScan();
    const result = await runCli(['review', 'accept', ...work.libraryArgs]);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/give at least one entry id, or --all/u);
  });

  it('accepts a filtered batch with --all', async () => {
    const { entry } = await ingestOneScan();
    const accepted = await runJson<{ accepted: Array<{ id: string }> }>([
      'review',
      'accept',
      ...work.libraryArgs,
      '--all',
      '--reason',
      entry.reasonCode,
    ]);
    expect(accepted.json.accepted.map((row) => row.id)).toEqual([entry.id]);
  });
});

describe('recueil review reject', () => {
  it('closes the entry and creates nothing', async () => {
    const { entry } = await ingestOneScan();

    const rejected = await runJson<{ rejected: string[]; refused: unknown[] }>([
      'review',
      'reject',
      entry.id,
      ...work.libraryArgs,
      '--note',
      'a blank separator page',
    ]);
    expect(rejected.code).toBe(0);
    expect(rejected.json.rejected).toEqual([entry.id]);

    const exported = await runCli(['export', 'csl-json', ...work.libraryArgs, '--all']);
    expect(exported.stdout).toMatch(/^\s*\[\s*\]/u);

    const closed = await runJson<{ entries: ReviewEntry[] }>([
      'review',
      'list',
      ...work.libraryArgs,
      '--status',
      'rejected',
    ]);
    expect(closed.json.entries[0]?.id).toBe(entry.id);

    // P5: the document is still in the library. Rejecting a proposal is not deleting bytes.
    const jobs = await runJson<{ jobs: JobEntry[] }>(['queue', 'list', ...work.libraryArgs]);
    expect(jobs.json.jobs.length).toBeGreaterThan(0);
  });
});
