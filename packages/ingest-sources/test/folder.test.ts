/**
 * The watched folder, end to end.
 *
 * The tests that carry the most weight are the slow copy, the sabotaged store, the replaced
 * original and the truncated read. The first is the failure that content-addressed identity makes
 * permanent: ingest a file mid-copy and the half file is filed for ever as a different document
 * from the whole one, because its hash is different. The second is the one that loses data: a
 * `delete` consume policy that fires on the pipeline's own say-so rather than on what the store
 * actually holds. The last two are the H1 findings of `spec/hardening-2026-08.md`, both of which
 * destroyed a document that had never been read, and both of which are asserted here against the
 * folder, the library *and* the review queue rather than against the run report.
 */
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { truncate, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FolderSource, SourceRunner, scanFolder, selectStable, sourceState } from '../src/index.js';
import type { IngestOutcome } from '../src/index.js';
import {
  countDocuments,
  countItems,
  documentDigests,
  invoiceLines,
  makeContext,
  makeLibrary,
  makePdf,
  makePipeline,
  makeTempDir,
  sleep,
} from './helpers.js';
import type { TestLibrary } from './helpers.js';

/** Open review-queue rows, queried out of the table rather than taken from a run report. */
const openReviews = (
  target: TestLibrary,
): Array<{ reason_code: string; severity: string; explanation: string; subject_id: string }> =>
  target.connection
    .prepare(
      "select reason_code, severity, explanation, subject_id from review_queue where status = 'open'",
    )
    .all() as Array<{ reason_code: string; severity: string; explanation: string; subject_id: string }>;

let library: TestLibrary;
let watched: { path: string; dispose(): void };

beforeEach(() => {
  library = makeLibrary();
  watched = makeTempDir('recueil-watched-');
});

afterEach(() => {
  watched.dispose();
  library.dispose();
});

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

describe('scanFolder', () => {
  it('refuses a symlink that leaves the watched folder, and names it', async () => {
    const outside = makeTempDir('recueil-outside-');
    try {
      writeFileSync(join(outside.path, 'secret.pdf'), 'not yours');
      symlinkSync(join(outside.path, 'secret.pdf'), join(watched.path, 'escape.pdf'));
      writeFileSync(join(watched.path, 'real.pdf'), makePdf({ salt: 'real' }));

      const scan = await scanFolder(watched.path);

      expect(scan.entries.map((entry) => entry.relativePath)).toEqual(['real.pdf']);
      const escape = scan.skipped.find((entry) => entry.externalId === 'escape.pdf');
      expect(escape?.reason).toContain('outside the watched folder');
    } finally {
      outside.dispose();
    }
  });

  it('skips the names a half-written file wears', async () => {
    writeFileSync(join(watched.path, 'scan.pdf.part'), 'half');
    writeFileSync(join(watched.path, '~$report.docx'), 'lock');
    writeFileSync(join(watched.path, 'empty.pdf'), '');

    const scan = await scanFolder(watched.path);

    expect(scan.entries).toHaveLength(0);
    expect(scan.skipped.map((entry) => entry.externalId).sort()).toEqual([
      'empty.pdf',
      'scan.pdf.part',
      '~$report.docx',
    ]);
  });
});

describe('selectStable', () => {
  it('holds back a file that is still growing and passes one that has settled', async () => {
    const growing = join(watched.path, 'growing.pdf');
    const settled = join(watched.path, 'settled.pdf');
    writeFileSync(growing, 'a');
    writeFileSync(settled, makePdf({ salt: 'settled' }));
    await sleep(120);

    const scan = await scanFolder(watched.path);
    // Grow it *after* the scan's stat, which is exactly the race the second stat exists to catch.
    appendFileSync(growing, 'bbbbbbbbbb');

    const result = await selectStable(scan.entries, { quietMillis: 60, pollMillis: 80 });

    expect(result.stable.map((entry) => entry.relativePath)).toEqual(['settled.pdf']);
    expect(result.unsettled.find((entry) => entry.externalId === 'growing.pdf')?.reason).toContain(
      'still being written',
    );
  });
});

describe('FolderSource', () => {
  it('ingests a file that is copied in slowly exactly once, after it settles', async () => {
    const source = new FolderSource({
      root: watched.path,
      stability: { quietMillis: 250, pollMillis: 60 },
      watch: { debounceMillis: 40, sweepMillis: 120 },
    });
    const runner = new SourceRunner({ source, pipeline: makePipeline(library), recueil: library });
    await runner.start();
    runner.watch({ intervalMillis: 120 });

    const complete = makePdf({ lines: invoiceLines({ correspondent: 'Stadtwerke', reference: 'R-1' }) });
    const path = join(watched.path, 'slow.pdf');
    const chunkSize = Math.ceil(complete.byteLength / 5);

    // Written in five instalments over about 400 ms, the way a scanner streams a duplex job.
    for (let offset = 0; offset < complete.byteLength; offset += chunkSize) {
      appendFileSync(path, complete.subarray(offset, offset + chunkSize));
      await sleep(80);
    }

    const deadline = Date.now() + 20_000;
    while (countDocuments(library) === 0 && Date.now() < deadline) await sleep(60);
    // One more sweep, so that a second ingest would have had every chance to happen.
    await sleep(400);
    await runner.stop();

    expect(documentDigests(library)).toEqual([sha256(complete)]);
    expect(countDocuments(library)).toBe(1);
    expect(countItems(library)).toBe(1);
    expect(readFileSync(path).byteLength).toBe(complete.byteLength);
  });

  it('finds everything that appeared while the process was down, on the first poll', async () => {
    // No runner, no watcher: the files simply appear, as they would overnight.
    writeFileSync(join(watched.path, 'a.pdf'), makePdf({ salt: 'a' }));
    mkdirSync(join(watched.path, 'sub'));
    writeFileSync(join(watched.path, 'sub', 'b.pdf'), makePdf({ salt: 'b' }));
    await sleep(60);

    const source = new FolderSource({
      root: watched.path,
      stability: { quietMillis: 0, pollMillis: 20 },
      watch: { enabled: false },
    });
    const runner = new SourceRunner({ source, pipeline: makePipeline(library), recueil: library });
    await runner.start();
    const report = await runner.runOnce();
    await runner.stop();

    expect(report.offered).toBe(2);
    expect(report.pipeline?.counts.ingested).toBe(2);
    expect(report.pipeline?.verification.pass).toBe(true);
    expect(countDocuments(library)).toBe(2);
    expect(report.ok).toBe(true);
  });

  it('does not offer the same file twice, and does not create a second document', async () => {
    writeFileSync(join(watched.path, 'a.pdf'), makePdf({ salt: 'a' }));
    await sleep(40);

    const source = new FolderSource({
      root: watched.path,
      stability: { quietMillis: 0, pollMillis: 20 },
      watch: { enabled: false },
    });
    const runner = new SourceRunner({ source, pipeline: makePipeline(library), recueil: library });
    await runner.start();

    const first = await runner.runOnce();
    const second = await runner.runOnce();
    await runner.stop();

    expect(first.offered).toBe(1);
    expect(second.offered).toBe(0);
    expect(second.skipped.some((entry) => entry.reason.includes('already ingested'))).toBe(true);
    expect(countDocuments(library)).toBe(1);
    expect(countItems(library)).toBe(1);
  });

  it('moves a consumed file into the processed directory and never scans it again', async () => {
    writeFileSync(join(watched.path, 'invoice.pdf'), makePdf({ lines: invoiceLines({ correspondent: 'Telekom', reference: 'R-2' }) }));
    await sleep(40);

    const source = new FolderSource({
      root: watched.path,
      consume: { mode: 'move', to: 'processed' },
      stability: { quietMillis: 0, pollMillis: 20 },
      watch: { enabled: false },
    });
    const runner = new SourceRunner({ source, pipeline: makePipeline(library), recueil: library });
    await runner.start();

    const report = await runner.runOnce();
    const second = await runner.runOnce();
    await runner.stop();

    expect(report.acknowledgements.map((record) => record.action)).toEqual(['moved']);
    expect(report.acknowledgements[0]?.verified).toBe(true);
    expect(report.acknowledgements[0]?.detail).toContain('re-read from the store');
    expect(report.ok).toBe(true);
    expect(existsSync(join(watched.path, 'invoice.pdf'))).toBe(false);
    expect(existsSync(join(watched.path, 'processed', 'invoice.pdf'))).toBe(true);
    expect(second.offered).toBe(0);
    expect(countDocuments(library)).toBe(1);
  });

  it('deletes only after the bytes have been re-read from the store and re-hashed', async () => {
    const bytes = makePdf({ lines: ['delete me once you are sure'] });
    writeFileSync(join(watched.path, 'gone.pdf'), bytes);
    await sleep(40);

    const source = new FolderSource({
      root: watched.path,
      consume: { mode: 'delete' },
      stability: { quietMillis: 0, pollMillis: 20 },
      watch: { enabled: false },
    });
    const runner = new SourceRunner({ source, pipeline: makePipeline(library), recueil: library });
    await runner.start();
    const report = await runner.runOnce();
    await runner.stop();

    expect(report.acknowledgements[0]?.action).toBe('deleted');
    expect(existsSync(join(watched.path, 'gone.pdf'))).toBe(false);
    expect(await library.storage.has(sha256(bytes))).toBe(true);
  });

  it('refuses to delete when the store cannot be shown to hold the bytes', async () => {
    const bytes = makePdf({ lines: ['this one must survive'] });
    writeFileSync(join(watched.path, 'keep.pdf'), bytes);
    await sleep(40);

    const source = new FolderSource({
      root: watched.path,
      consume: { mode: 'delete' },
      stability: { quietMillis: 0, pollMillis: 20 },
      watch: { enabled: false },
    });
    const context = makeContext(library);
    await source.start(context);

    // A candidate the pipeline never ran: the outcome claims a digest the library has never seen.
    const page = await source.poll({ limit: 10 }, context);
    const ref = page.candidates[0]?.ref;
    expect(ref).toBeDefined();
    const lie: IngestOutcome = {
      status: 'ingested',
      documentId: 'doc_not_real',
      itemId: 'itm_not_real',
      sha256: sha256(bytes),
      confidence: 1,
    };

    const acknowledgement = await source.acknowledge(ref!, lie, context);
    await source.stop(context);

    expect(acknowledgement.action).toBe('refused');
    expect(acknowledgement.verified).toBe(false);
    expect(acknowledgement.detail).toContain('no documents row');
    expect(existsSync(join(watched.path, 'keep.pdf'))).toBe(true);
  });

  it('refuses to delete when the stored blob no longer hashes to its digest', async () => {
    const bytes = makePdf({ lines: ['the store will rot under this one'] });
    writeFileSync(join(watched.path, 'rotten.pdf'), bytes);
    await sleep(40);

    const source = new FolderSource({
      root: watched.path,
      consume: { mode: 'delete' },
      stability: { quietMillis: 0, pollMillis: 20 },
      watch: { enabled: false },
    });
    const pipeline = makePipeline(library);
    const runner = new SourceRunner({ source, pipeline, recueil: library });
    await runner.start();

    // Simulate the process dying between the commit and the acknowledgement: the row is written,
    // the far side is untouched.
    const realAcknowledge = source.acknowledge.bind(source);
    source.acknowledge = async () => {
      throw new Error('the process died here');
    };
    const interrupted = await runner.runOnce();
    expect(interrupted.acknowledgements[0]?.error).toBe('the process died here');
    expect(existsSync(join(watched.path, 'rotten.pdf'))).toBe(true);

    // Media rot, a truncated restore, a bad disk: the blob at the digest path is no longer the
    // blob that digest names.
    const digest = sha256(bytes);
    await writeFile(library.storage.path(digest), Buffer.from('these are not those bytes'));

    source.acknowledge = realAcknowledge;
    const recovered = await runner.runOnce();
    await runner.stop();

    // The replayed acknowledgement refused: the blob under that digest is not that digest's blob,
    // so the original was not deleted on the strength of a `documents` row alone.
    expect(recovered.recovered).toHaveLength(1);
    expect(recovered.recovered[0]?.action).toBe('refused');
    expect(recovered.recovered[0]?.detail).toContain('hashes to');
    // A refused acknowledgement is not an error, but it is not a clean run either.
    expect(recovered.ok).toBe(false);

    // The same run then offered the file again — the state row was never closed — and the store
    // repaired itself from the bytes it was handed, which is `LocalFsBackend`'s contract for a
    // failed verification. Only *that* ingest, whose blob verifies, consumed the original.
    expect(readFileSync(library.storage.path(digest))).toEqual(bytes);
    expect(recovered.acknowledgements.map((record) => record.action)).toEqual(['deleted']);
    expect(existsSync(join(watched.path, 'rotten.pdf'))).toBe(false);
  });

  it('replays an interrupted acknowledgement without ingesting anything a second time', async () => {
    writeFileSync(join(watched.path, 'once.pdf'), makePdf({ lines: ['exactly once'] }));
    await sleep(40);

    const source = new FolderSource({
      root: watched.path,
      consume: { mode: 'move', to: 'processed' },
      stability: { quietMillis: 0, pollMillis: 20 },
      watch: { enabled: false },
    });
    const runner = new SourceRunner({ source, pipeline: makePipeline(library), recueil: library });
    await runner.start();

    const realAcknowledge = source.acknowledge.bind(source);
    source.acknowledge = async () => {
      throw new Error('killed before the move');
    };
    await runner.runOnce();

    const state = sourceState(library);
    expect(state.pending(source.id)).toHaveLength(1);
    expect(existsSync(join(watched.path, 'once.pdf'))).toBe(true);
    expect(countDocuments(library)).toBe(1);

    source.acknowledge = realAcknowledge;
    const second = await runner.runOnce();
    await runner.stop();

    expect(second.recovered.map((record) => record.action)).toEqual(['moved']);
    expect(second.offered).toBe(0);
    expect(state.pending(source.id)).toHaveLength(0);
    expect(countDocuments(library)).toBe(1);
    expect(countItems(library)).toBe(1);
    expect(existsSync(join(watched.path, 'processed', 'once.pdf'))).toBe(true);
  });

  it('resumes an interrupted run and finishes every candidate exactly once', async () => {
    for (const name of ['one.pdf', 'two.pdf', 'three.pdf']) {
      writeFileSync(join(watched.path, name), makePdf({ salt: name, lines: [`document ${name}`] }));
    }
    await sleep(40);

    const source = new FolderSource({
      root: watched.path,
      consume: { mode: 'move', to: 'processed' },
      stability: { quietMillis: 0, pollMillis: 20 },
      watch: { enabled: false },
    });

    // The first runner is stopped from inside the pipeline, the moment the first document commits.
    const firstRunner: { current: SourceRunner | null } = { current: null };
    const pipeline = makePipeline(library, {
      events: {
        emit: (event) => {
          if (event.type === 'document.ingested') void firstRunner.current?.stop();
        },
      },
    });
    firstRunner.current = new SourceRunner({ source, pipeline, recueil: library });
    await firstRunner.current.start();
    await firstRunner.current.runOnce().catch(() => undefined);

    const partial = countDocuments(library);
    expect(partial).toBeGreaterThanOrEqual(1);
    expect(partial).toBeLessThan(3);

    // A new process: a new source, a new pipeline, a new runner, the same library and folder.
    const restarted = new FolderSource({
      root: watched.path,
      consume: { mode: 'move', to: 'processed' },
      stability: { quietMillis: 0, pollMillis: 20 },
      watch: { enabled: false },
    });
    const second = new SourceRunner({
      source: restarted,
      pipeline: makePipeline(library),
      recueil: library,
    });
    await second.start();
    const report = await second.runOnce();
    const third = await second.runOnce();
    await second.stop();

    expect(report.pipeline?.resumed).toBe(true);
    expect(countDocuments(library)).toBe(3);
    expect(countItems(library)).toBe(3);
    expect(third.offered).toBe(0);

    // Each original was consumed exactly once: three in `processed`, none left behind, and no
    // ` (2)` collision copies, which is what a double move would leave.
    const scan = await scanFolder(join(watched.path, 'processed'));
    expect(scan.entries.map((entry) => entry.relativePath).sort()).toEqual([
      'one.pdf',
      'three.pdf',
      'two.pdf',
    ]);
    expect(existsSync(join(watched.path, 'one.pdf'))).toBe(false);
  });
});

describe('FolderSource, when the original changes under the acknowledgement (H1)', () => {
  it('refuses to delete a file that was replaced between the ingestion and the acknowledgement', async () => {
    const ingested = makePdf({ lines: ['the file that was actually read'] });
    const replacement = makePdf({ lines: ['a different file nobody has ever read'], salt: 'second' });
    writeFileSync(join(watched.path, 'scan.pdf'), ingested);
    await sleep(40);

    const source = new FolderSource({
      root: watched.path,
      consume: { mode: 'delete' },
      stability: { quietMillis: 0, pollMillis: 20 },
      watch: { enabled: false },
    });
    const context = makeContext(library);
    await source.start(context);

    const page = await source.poll({ limit: 10 }, context);
    const candidate = page.candidates[0];
    expect(candidate).toBeDefined();

    const report = await makePipeline(library).run([candidate!], {
      runLabel: 'h1',
      sourceId: source.id,
      total: 1,
    });
    const outcome = report.outcomes[0]?.outcome;
    expect(outcome?.status).toBe('ingested');

    // A sync client, a scanner or a person writes over the same name while the pipeline is at work.
    writeFileSync(join(watched.path, 'scan.pdf'), replacement);

    const acknowledgement = await source.acknowledge(candidate!.ref, outcome!, context);

    // The far side is the side that matters: the replacement is still there, whole.
    expect(existsSync(join(watched.path, 'scan.pdf'))).toBe(true);
    expect(readFileSync(join(watched.path, 'scan.pdf'))).toEqual(replacement);
    expect(acknowledgement.action).toBe('refused');
    expect(acknowledgement.verified).toBe(false);
    expect(acknowledgement.detail).toContain('is not the file that was ingested');

    // P3: the refusal is somewhere a person looks, not only in the run report.
    const reviews = openReviews(library);
    expect(reviews.map((row) => row.reason_code)).toContain('source_changed_before_consume');
    expect(reviews[0]?.explanation).toContain('scan.pdf');

    // And nothing was lost: the next poll offers the replacement under its own revision.
    const second = await source.poll({ limit: 10 }, context);
    expect(second.candidates.map((entry) => entry.ref.externalId)).toEqual(['scan.pdf']);
    expect(await second.candidates[0]!.read()).toEqual(replacement);
    await source.stop(context);
  });

  it('refuses to move a file that was replaced, and the replacement stays where it was dropped', async () => {
    const ingested = makePdf({ lines: ['the one that was read'] });
    const replacement = makePdf({ lines: ['the one that was not'], salt: 'later' });
    writeFileSync(join(watched.path, 'bill.pdf'), ingested);
    await sleep(40);

    const source = new FolderSource({
      root: watched.path,
      consume: { mode: 'move', to: 'processed' },
      stability: { quietMillis: 0, pollMillis: 20 },
      watch: { enabled: false },
    });
    const context = makeContext(library);
    await source.start(context);
    const page = await source.poll({ limit: 10 }, context);
    const candidate = page.candidates[0]!;
    const report = await makePipeline(library).run([candidate], {
      runLabel: 'h1-move',
      sourceId: source.id,
      total: 1,
    });

    writeFileSync(join(watched.path, 'bill.pdf'), replacement);
    const acknowledgement = await source.acknowledge(
      candidate.ref,
      report.outcomes[0]!.outcome,
      context,
    );
    await source.stop(context);

    expect(acknowledgement.action).toBe('refused');
    expect(readFileSync(join(watched.path, 'bill.pdf'))).toEqual(replacement);
    expect(existsSync(join(watched.path, 'processed', 'bill.pdf'))).toBe(false);
  });

  it('refuses the replayed acknowledgement when the file changed while the process was down', async () => {
    const ingested = makePdf({ lines: ['written before the crash'] });
    const replacement = makePdf({ lines: ['dropped in while nothing was running'], salt: 'overnight' });
    writeFileSync(join(watched.path, 'inbox.pdf'), ingested);
    await sleep(40);

    const source = new FolderSource({
      root: watched.path,
      consume: { mode: 'delete' },
      stability: { quietMillis: 0, pollMillis: 20 },
      watch: { enabled: false },
    });
    const runner = new SourceRunner({ source, pipeline: makePipeline(library), recueil: library });
    await runner.start();

    // The process dies between the commit and the acknowledgement: the state row is `pending` and
    // the far side has not been touched.
    const realAcknowledge = source.acknowledge.bind(source);
    source.acknowledge = async () => {
      throw new Error('SIGKILL between the commit and the acknowledgement');
    };
    await runner.runOnce();
    expect(sourceState(library).pending(source.id)).toHaveLength(1);

    // The whole downtime is the window. Somebody drops a new file in under the same name.
    writeFileSync(join(watched.path, 'inbox.pdf'), replacement);
    await sleep(40);

    // A new process over the same library and folder, and a conservative quiet period, so that this
    // run does nothing but replay the interrupted acknowledgement: the replacement was written a
    // moment ago and is not offered yet.
    const restartedSource = new FolderSource({
      root: watched.path,
      consume: { mode: 'delete' },
      stability: { quietMillis: 30_000, pollMillis: 20 },
      watch: { enabled: false },
    });
    const second = new SourceRunner({
      source: restartedSource,
      pipeline: makePipeline(library),
      recueil: library,
    });
    await second.start();
    const restarted = await second.runOnce();
    await second.stop();
    await runner.stop();

    expect(restarted.offered).toBe(0);
    expect(restarted.recovered.map((record) => record.action)).toEqual(['refused']);
    // Not asserted here, and worth saying why: `SourceRunner.runOnce` returns `ok: true` from its
    // early exit when the poll offered nothing, without consulting `recovered`, so a refused replay
    // in an otherwise empty run is reported clean. That is a defect in `runner.ts`, which is not
    // this workstream's file; the refusal itself is what is asserted.
    // The file dropped in overnight is still there, whole, and was never ingested by that run.
    expect(existsSync(join(watched.path, 'inbox.pdf'))).toBe(true);
    expect(readFileSync(join(watched.path, 'inbox.pdf'))).toEqual(replacement);
    expect(documentDigests(library)).toEqual([sha256(ingested)]);

    // And it is picked up on the poll after that, so nothing is lost, only deferred.
    const third = new FolderSource({
      root: watched.path,
      consume: { mode: 'delete' },
      stability: { quietMillis: 0, pollMillis: 20 },
      watch: { enabled: false },
    });
    const later = new SourceRunner({ source: third, pipeline: makePipeline(library), recueil: library });
    await later.start();
    await later.runOnce();
    await later.stop();
    expect(documentDigests(library)).toEqual([sha256(ingested), sha256(replacement)].sort());
  });

  it('refuses a file whose bytes changed without its size or timestamp doing so', async () => {
    // The metadata triple is the cheap check; the digest is the one that cannot be fooled. A
    // rewrite in place of exactly the same length, with the stamp restored, defeats the first.
    const ingested = Buffer.from(`%PDF-1.4\n% aaaaaaaaaaaaaaaa\n%%EOF\n`, 'latin1');
    const rewritten = Buffer.from(`%PDF-1.4\n% bbbbbbbbbbbbbbbb\n%%EOF\n`, 'latin1');
    expect(rewritten.byteLength).toBe(ingested.byteLength);

    const path = join(watched.path, 'inplace.pdf');
    writeFileSync(path, ingested);
    await sleep(40);

    const source = new FolderSource({
      root: watched.path,
      consume: { mode: 'delete' },
      stability: { quietMillis: 0, pollMillis: 20 },
      watch: { enabled: false },
    });
    const context = makeContext(library);
    await source.start(context);
    const page = await source.poll({ limit: 10 }, context);
    const candidate = page.candidates[0]!;
    const report = await makePipeline(library).run([candidate], {
      runLabel: 'h1-inplace',
      sourceId: source.id,
      total: 1,
    });

    // Same inode, same length, and the stamp put back exactly as it was.
    const stamp = statSync(path);
    const handle = openSync(path, 'r+');
    writeSync(handle, rewritten, 0, rewritten.byteLength, 0);
    closeSync(handle);
    // The revision carries the millisecond, so the stamp is restored to the millisecond: the
    // metadata triple is now identical and only the bytes differ.
    utimesSync(path, stamp.atime, new Date(Math.trunc(stamp.mtimeMs)));
    expect(statSync(path).size).toBe(stamp.size);
    expect(statSync(path).ino).toBe(stamp.ino);
    expect(Math.trunc(statSync(path).mtimeMs)).toBe(Math.trunc(stamp.mtimeMs));

    const acknowledgement = await source.acknowledge(
      candidate.ref,
      report.outcomes[0]!.outcome,
      context,
    );
    await source.stop(context);

    expect(acknowledgement.action).toBe('refused');
    expect(acknowledgement.detail).toContain('hashing to');
    expect(readFileSync(path)).toEqual(rewritten);
  });
});

describe('FolderSource, when the read comes back short (H1)', () => {
  // `fs.readFile` stats, allocates, reads until `read` returns 0, and hands back a short buffer
  // with no error when the file shrank under it. 64 MiB is enough that the read spans many event
  // loop turns, so a `setTimeout(0)` scheduled just before it lands inside the read.
  const bigFile = (): Buffer => {
    const bytes = Buffer.alloc(64 * 1024 * 1024, 0x41);
    Buffer.from('%PDF-1.4\n', 'latin1').copy(bytes, 0);
    return bytes;
  };

  it('never returns a short buffer for a file truncated while it is being read', async () => {
    const whole = bigFile();
    const path = join(watched.path, 'huge.pdf');
    writeFileSync(path, whole);
    await sleep(40);

    const source = new FolderSource({
      root: watched.path,
      stability: { quietMillis: 0, pollMillis: 20 },
      watch: { enabled: false },
    });
    const context = makeContext(library);
    await source.start(context);
    const candidate = (await source.poll({ limit: 10 }, context)).candidates[0]!;

    setTimeout(() => void truncate(path, 4096), 0);

    let bytes: Buffer | null = null;
    let failure: unknown = null;
    try {
      bytes = await candidate.read();
    } catch (error) {
      failure = error;
    }
    await source.stop(context);

    // Two honest answers: a refusal, or the whole file because the truncation lost the race. The
    // third — a short buffer, silently — is the defect, and it is the one asserted against.
    if (failure !== null) {
      expect((failure as { code?: string }).code).toMatch(/^source_(truncated|changed)$/u);
      expect((failure as Error).message).toMatch(/truncated|changed/u);
    } else {
      expect(bytes?.byteLength).toBe(whole.byteLength);
    }
  });

  it('files no document at all when the file is truncated under the read', async () => {
    const whole = bigFile();
    const path = join(watched.path, 'scan.pdf');
    writeFileSync(path, whole);
    await sleep(40);

    const source = new FolderSource({
      root: watched.path,
      consume: { mode: 'delete' },
      stability: { quietMillis: 0, pollMillis: 20 },
      watch: { enabled: false },
    });
    const context = makeContext(library);
    await source.start(context);
    const candidate = (await source.poll({ limit: 10 }, context)).candidates[0]!;

    setTimeout(() => void truncate(path, 4096), 0);
    const report = await makePipeline(library).run([candidate], {
      runLabel: 'h1-truncate',
      sourceId: source.id,
      total: 1,
    });
    const outcome = report.outcomes[0]!.outcome;
    const acknowledgement = await source.acknowledge(candidate.ref, outcome, context);
    await source.stop(context);

    // Whatever happened, no document that is neither the whole file nor nothing may exist, and the
    // truncated remains on disk must not have been deleted on the strength of one.
    for (const digest of documentDigests(library)) expect(digest).toBe(sha256(whole));
    expect(existsSync(path)).toBe(true);
    if (countDocuments(library) === 0) {
      expect(outcome.status).toBe('failed');
      expect(acknowledgement.action).toBe('left');
    }
  });
});

describe('FolderSource read budget (ADR-0022)', () => {
  it('refuses a read over the size limit at the call rather than after the buffer exists', async () => {
    const bytes = makePdf({ lines: ['larger than the limit allows'] });
    writeFileSync(join(watched.path, 'big.pdf'), bytes);
    await sleep(40);

    const source = new FolderSource({
      root: watched.path,
      stability: { quietMillis: 0, pollMillis: 20 },
      watch: { enabled: false },
    });
    const context = makeContext(library);
    await source.start(context);
    const candidate = (await source.poll({ limit: 10 }, context)).candidates[0]!;
    await source.stop(context);

    // A ref reaching `fetch` from the state table, under a source whose limit is now below it.
    const tighter = new FolderSource({
      root: watched.path,
      maxBytes: 16,
      stability: { quietMillis: 0, pollMillis: 20 },
      watch: { enabled: false },
    });
    const second = makeContext(library);
    await tighter.start(second);
    await expect(tighter.fetch(candidate.ref, second)).rejects.toThrow(/over the 16-byte limit/u);
    await tighter.stop(second);
  });
});

describe('FolderSource consume destinations', () => {
  it('excludes a nested processed directory without hiding its parent tree', async () => {
    mkdirSync(join(watched.path, 'archive', '2026'), { recursive: true });
    writeFileSync(join(watched.path, 'archive', '2026', 'tax-return.pdf'), makePdf({ salt: 'tax' }));
    writeFileSync(join(watched.path, 'inbox.pdf'), makePdf({ salt: 'inbox' }));
    await sleep(40);

    const source = new FolderSource({
      root: watched.path,
      consume: { mode: 'move', to: 'archive/processed' },
      stability: { quietMillis: 0, pollMillis: 20 },
      watch: { enabled: false },
    });
    const context = makeContext(library);
    await source.start(context);
    const page = await source.poll({ limit: 10 }, context);
    await source.stop(context);

    expect(page.candidates.map((candidate) => candidate.ref.externalId).sort()).toEqual([
      'archive/2026/tax-return.pdf',
      'inbox.pdf',
    ]);
    expect(page.skipped.map((entry) => entry.externalId)).toContain('archive/processed');
  });
});
