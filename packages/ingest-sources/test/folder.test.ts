/**
 * The watched folder, end to end.
 *
 * The two tests that carry the most weight are the slow copy and the sabotaged store. The first is
 * the failure that content-addressed identity makes permanent: ingest a file mid-copy and the half
 * file is filed for ever as a different document from the whole one, because its hash is different.
 * The second is the one that loses data: a `delete` consume policy that fires on the pipeline's own
 * say-so rather than on what the store actually holds.
 */
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
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
