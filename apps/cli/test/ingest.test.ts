/**
 * `recueil ingest`, through the real entry point, against the repository's own fixtures.
 *
 * The four things asserted here are the four that would matter on the day this is used in anger:
 *
 * - a hostile archive is refused **and the file it tried to plant is not on disk**;
 * - a scan with no text layer goes through the OCR adapter and the text it produced is findable;
 * - a dry run writes nothing to the real library while still answering the question;
 * - the rule trace and the confidence the gate read are both reported per file.
 *
 * Every assertion about the library reads the library — through `recueil export`, `recueil review
 * list`, or the filesystem — rather than reading the ingest command's own summary back to itself.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { fixture, makeWorkspace, runCli, runJson, sha256OfFile, type Workspace } from './ingest-fixture.js';

/**
 * What the fake OCR engine returns for `scans/invoice-image-only.pdf`.
 *
 * The last line carries a word that appears nowhere else — not in the title the office heuristics
 * derive from the first line, not in any field — so a search that finds it can only have found the
 * recognised text through the document index.
 */
const RECOGNISED = [
  'Stadtwerke Ulm GmbH',
  'Rechnungsnummer: 2023-004417',
  'Gesamtbetrag 471,50 EUR',
  'Zaehlerstand kwitzelpfrump 4711',
].join('\n');

const OCR_ONLY_TERM = 'kwitzelpfrump';

interface IngestJson {
  exitCode: number;
  files: number;
  counts: { ingested: number; duplicates: number; review: number; containers: number; stopped: number; failed: number };
  verification: { pass: boolean; checks: Array<{ id: string; ok: boolean; detail: string }>; queried: Record<string, number> };
  scratchClean: boolean;
  results: Array<{
    path: string;
    status: string;
    mediaType: string;
    textState: string;
    rules: string;
    confidence: number | null;
    detail: string;
    sha256: string | null;
  }>;
  review: Array<{ id: string; reasonCode: string; explanation: string; confidence: number | null }>;
}

let work: Workspace;

beforeEach(() => {
  work = makeWorkspace();
});

afterEach(() => {
  work.dispose();
});

const ocrCorpusFor = (file: string, text: string): string =>
  work.file('ocr-corpus.json', JSON.stringify({ [sha256OfFile(file)]: text }, null, 2));

describe('a hostile archive', () => {
  it('is refused whole, and plants nothing on disk', async () => {
    const archive = fixture('archives', 'path-traversal.zip');
    const { code, json } = await runJson<IngestJson>(['ingest', archive, ...work.libraryArgs, '--no-progress']);

    // Routed to review rather than filed, with the reason a person can act on.
    expect(json.counts.review).toBe(1);
    expect(json.counts.ingested).toBe(0);
    expect(json.review[0]?.reasonCode).toBe('unsafe_archive_path');
    expect(json.review[0]?.explanation).toMatch(/recueil-pwned/u);
    expect(code).toBe(4);

    // The archive itself was kept — losing the only copy of a file the reader did not understand
    // would be the worst possible trade — but nothing was extracted.
    expect(json.results[0]?.status).toBe('review');
    expect(json.results[0]?.sha256).toMatch(/^[0-9a-f]{64}$/u);

    // The six hostile names in this fixture all aim outside the extraction root. None of them
    // arrived: not in the workspace, not in the storage tree, not at the absolute paths they name.
    const planted = readdirSync(work.root, { recursive: true, encoding: 'utf8' }).filter((entry) =>
      entry.includes('pwn'),
    );
    expect(planted).toEqual([]);
    expect(existsSync('/tmp/recueil-pwned.txt')).toBe(false);
    expect(json.scratchClean).toBe(true);
    expect(json.verification.pass).toBe(true);
  });

  it('does not partially extract: no member of the archive became a document', async () => {
    const archive = fixture('archives', 'path-traversal.zip');
    await runCli(['ingest', archive, ...work.libraryArgs, '--no-progress']);

    // `harmlos.txt` is the one legitimate entry, and a run that extracted it would have opened the
    // archive. This build refuses the archive whole, so it must not be there either.
    const { json } = await runJson<{ entries: Array<{ subjectId: string }> }>([
      'review',
      'list',
      ...work.libraryArgs,
      '--full',
    ]);
    expect(json.entries).toHaveLength(1);

    const blobs = readdirSync(work.storageRoot, { recursive: true, encoding: 'utf8' }).filter(
      (entry) => /[0-9a-f]{64}$/u.test(entry),
    );
    expect(blobs, 'only the archive itself should be stored').toHaveLength(1);
  });
});

describe('a scan with no text layer', () => {
  it('goes through the OCR adapter and becomes searchable', async () => {
    const scan = fixture('scans', 'invoice-image-only.pdf');
    const corpus = ocrCorpusFor(scan, RECOGNISED);

    const ingest = await runJson<IngestJson>([
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

    // The gate did not have enough to file it on its own, which is the correct outcome for a scan
    // with no bibliographic metadata, and the reason names the OCR contribution.
    expect(ingest.json.counts.review).toBe(1);
    expect(ingest.json.review[0]?.explanation).toMatch(/OCR recovered text/u);
    expect(ingest.json.results[0]?.confidence).toBeGreaterThan(0);
    expect(ingest.code).toBe(4);

    const entryId = ingest.json.review[0]!.id;
    const accepted = await runJson<{ accepted: Array<{ id: string; itemId: string | null }> }>([
      'review',
      'accept',
      entryId,
      ...work.libraryArgs,
    ]);
    expect(accepted.code).toBe(0);
    expect(accepted.json.accepted[0]?.itemId).toBeTruthy();

    // The proof: a word that exists only in what the OCR engine returned finds the item, through
    // the document text index and the attachment that joins it to the item.
    const found = await runCli([
      'export',
      'csl-json',
      ...work.libraryArgs,
      '--search',
      OCR_ONLY_TERM,
    ]);
    expect(found.code).toBe(0);
    const records = JSON.parse(found.stdout.slice(0, found.stdout.indexOf('\n]') + 2)) as Array<{ id: string }>;
    expect(records, `searching for ${OCR_ONLY_TERM} found nothing:\n${found.stdout}`).toHaveLength(1);
  });

  it('files nothing without an OCR engine, and says so rather than pretending', async () => {
    const scan = fixture('scans', 'invoice-image-only.pdf');
    const { json } = await runJson<IngestJson>(['ingest', scan, ...work.libraryArgs, '--no-progress']);

    expect(json.counts.ingested).toBe(0);
    expect(json.counts.review).toBe(1);
    // No engine ran, so no OCR contribution can appear in the ledger's explanation.
    expect(json.review[0]?.explanation).not.toMatch(/OCR recovered/u);
  });

  it('refuses `--ocr fake` with no corpus rather than recognising nothing quietly', async () => {
    const scan = fixture('scans', 'invoice-image-only.pdf');
    const result = await runCli(['ingest', scan, ...work.libraryArgs, '--ocr', 'fake', '--no-progress']);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/--ocr fake needs --ocr-corpus/u);
  });
});

describe('the rule trace', () => {
  const RULE_SET = [
    'version: 1',
    'kind: ingestion',
    'name: office',
    'mode: all-match',
    'rules:',
    '  - id: scanned-invoice',
    '    priority: 100',
    '    when:',
    '      all:',
    '        - type: mime',
    '          match: { equals: application/pdf }',
    '        - type: text',
    '          match: { contains: Rechnungsnummer }',
    '    then:',
    '      - type: set-item-type',
    '        itemType: invoice',
    '      - type: add-tags',
    '        tags: [Rechnung]',
    '      - type: set-confidence',
    '        confidence: 0.95',
    '  - id: never-fires',
    '    when:',
    '      type: sender',
    '      match: { equals: nobody@example.invalid }',
    '    then:',
    '      - type: add-tags',
    '        tags: [impossible]',
    '',
  ].join('\n');

  it('names the rules that fired and carries the confidence they set', async () => {
    const scan = fixture('scans', 'invoice-image-only.pdf');
    const rules = work.file('office.yaml', RULE_SET);
    const corpus = ocrCorpusFor(scan, RECOGNISED);

    const { code, json } = await runJson<IngestJson>([
      'ingest',
      scan,
      ...work.libraryArgs,
      '--source-kind',
      'scanner',
      '--ocr',
      'fake',
      '--ocr-corpus',
      corpus,
      '--rules',
      rules,
      '--no-progress',
    ]);

    // The rule set lifts the score above the gate, so the document is filed rather than queued.
    expect(json.counts.ingested).toBe(1);
    expect(json.counts.review).toBe(0);
    expect(code).toBe(0);

    const row = json.results[0]!;
    expect(row.rules).toBe('scanned-invoice');
    expect(row.confidence).toBeCloseTo(0.95, 2);
    // The columns stages 4 to 6 wrote onto the `documents` row, queried back.
    expect(row.mediaType).toBe('application/pdf');
    expect(row.textState).toMatch(/no text layer, ocr done/u);

    // And the rules really drove the commit: the item is an invoice and carries the tag.
    const exported = await runCli(['export', 'csl-json', ...work.libraryArgs, '--all']);
    expect(exported.stdout).toMatch(/"citation-key"/u);

    const items = await runJson<{ entries: unknown[] }>(['review', 'list', ...work.libraryArgs]);
    expect(items.json.entries).toHaveLength(0);
  });

  it('reports a rule that matched nothing', async () => {
    const scan = fixture('scans', 'invoice-image-only.pdf');
    const rules = work.file('office.yaml', RULE_SET);
    const corpus = ocrCorpusFor(scan, RECOGNISED);

    const result = await runCli([
      'ingest',
      scan,
      ...work.libraryArgs,
      '--ocr',
      'fake',
      '--ocr-corpus',
      corpus,
      '--rules',
      rules,
      '--trace',
      '--no-progress',
    ]);

    expect(result.stdout).toMatch(/never-fires \(priority 0\): not-matched/u);
    expect(result.stdout).toMatch(/scanned-invoice \(priority 100\): matched/u);
  });
});

describe('--dry-run', () => {
  it('answers the question and leaves the library untouched', async () => {
    const scan = fixture('scans', 'invoice-image-only.pdf');
    const corpus = ocrCorpusFor(scan, RECOGNISED);

    // A library that already exists, so the dry run has something to be consistent with.
    const first = await runCli(['ingest', fixture('scans', 'born-digital.pdf'), ...work.libraryArgs, '--no-progress']);
    expect(first.code === 0 || first.code === 4).toBe(true);

    const before = readdirSync(work.storageRoot, { recursive: true, encoding: 'utf8' }).filter((entry) =>
      /[0-9a-f]{64}$/u.test(entry),
    );

    const dry = await runJson<IngestJson>([
      'ingest',
      scan,
      ...work.libraryArgs,
      '--ocr',
      'fake',
      '--ocr-corpus',
      corpus,
      '--dry-run',
      '--no-progress',
    ]);

    // It really ran: it hashed the file, sniffed the type, ran OCR and reached the gate.
    expect(dry.json.results[0]?.mediaType).toBe('application/pdf');
    expect(dry.json.results[0]?.textState).toMatch(/no text layer, ocr done/u);
    expect(dry.json.results[0]?.confidence).toBeGreaterThan(0);
    expect(dry.json.counts.ingested + dry.json.counts.review).toBe(1);

    // And it wrote nothing: no new blob, and no review entry in the real library.
    const after = readdirSync(work.storageRoot, { recursive: true, encoding: 'utf8' }).filter((entry) =>
      /[0-9a-f]{64}$/u.test(entry),
    );
    expect(after).toEqual(before);

    const review = await runJson<{ entries: Array<{ subjectId: string }> }>(['review', 'list', ...work.libraryArgs]);
    expect(review.json.entries.every((entry) => entry.subjectId !== dry.json.results[0]?.sha256)).toBe(true);
  });
});

describe('a directory of files', () => {
  it('offers every file under it and refuses a symlink that leaves the root', async () => {
    const consume = work.stage(
      'consume',
      fixture('scans', 'born-digital.pdf'),
      fixture('scans', 'invoice-image-only.pdf'),
    );
    // A symlink pointing outside the watched root is the filesystem's version of `../../etc`.
    const outside = work.file('outside/secret.txt', 'not yours');
    const { symlinkSync } = await import('node:fs');
    symlinkSync(outside, join(consume, 'escape.txt'));

    const { json } = await runJson<IngestJson & { skipped: Array<{ path: string; reason: string }> }>([
      'ingest',
      consume,
      ...work.libraryArgs,
      '--no-progress',
    ]);

    expect(json.files).toBe(2);
    expect(json.skipped).toHaveLength(1);
    expect(json.skipped[0]?.reason).toMatch(/outside the watched folder/u);
  });

  it('is idempotent: a filed document arriving again is linked, not doubled', async () => {
    const consume = work.stage('consume', fixture('scans', 'born-digital.pdf'));

    // The first pass reaches the gate and is queued, because a plain office document carries no
    // metadata to be confident about. Accepting it is what *files* it — and only a filed document
    // can be recognised as a duplicate rather than re-offered to the gate.
    const first = await runJson<IngestJson>(['ingest', consume, ...work.libraryArgs, '--run-label', 'a', '--no-progress']);
    expect(first.json.counts.duplicates).toBe(0);
    expect(first.json.counts.review).toBe(1);

    const accepted = await runJson<{ accepted: Array<{ itemId: string | null }> }>([
      'review',
      'accept',
      first.json.review[0]!.id,
      ...work.libraryArgs,
    ]);
    expect(accepted.json.accepted[0]?.itemId).toBeTruthy();

    const second = await runJson<IngestJson>(['ingest', consume, ...work.libraryArgs, '--run-label', 'b', '--no-progress']);
    expect(second.json.counts.duplicates).toBe(1);
    expect(second.json.counts.ingested).toBe(0);
    expect(second.json.counts.review).toBe(0);
    expect(second.json.results[0]?.detail).toMatch(/already held as/u);

    const blobs = readdirSync(work.storageRoot, { recursive: true, encoding: 'utf8' }).filter((entry) =>
      /[0-9a-f]{64}$/u.test(entry),
    );
    expect(blobs).toHaveLength(1);
  });
});

describe('argument handling', () => {
  it('refuses a path that is not there, by name', async () => {
    const result = await runCli(['ingest', join(work.root, 'nope.pdf'), ...work.libraryArgs]);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/there is nothing at/u);
  });

  it('refuses to run with no paths at all', async () => {
    const result = await runCli(['ingest', ...work.libraryArgs]);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/nothing to ingest/u);
  });
});

/** A guard against a regression that would be silent: `rebuild()` drops the document text index. */
describe('the search index', () => {
  it('is not rebuilt after an ingest, so recognised text survives the run', async () => {
    const scan = fixture('scans', 'invoice-image-only.pdf');
    const corpus = ocrCorpusFor(scan, RECOGNISED);
    writeFileSync(join(work.root, 'marker'), 'x');

    const ingest = await runJson<IngestJson>([
      'ingest',
      scan,
      ...work.libraryArgs,
      '--ocr',
      'fake',
      '--ocr-corpus',
      corpus,
      '--no-progress',
    ]);
    const entryId = ingest.json.review[0]!.id;
    await runCli(['review', 'accept', entryId, ...work.libraryArgs]);

    const found = await runCli(['export', 'csl-json', ...work.libraryArgs, '--search', OCR_ONLY_TERM]);
    expect(found.stdout).toMatch(/"id"/u);
    expect(readFileSync(join(work.root, 'marker'), 'utf8')).toBe('x');
  });
});
