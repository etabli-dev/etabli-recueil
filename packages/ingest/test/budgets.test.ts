/**
 * Resource budgets on untrusted input (ADR-0022), and the two Phase 2 reproductions they close.
 *
 * These are not unit tests of a limit constant. They are the review's proofs of concept, rebuilt:
 * a zip whose central directory lies about a member's size, and a well-formed PDF one stream of
 * which inflates to three hundred megabytes. Both were run against the shipped code first and both
 * worked — the zip bought 1.6 GB of resident memory from 815 KB of input, the PDF added 914 MB and
 * held the event loop for 5.7 seconds — so each test asserts three things: that the refusal
 * happens, that it *names the limit it hit* so an operator can raise it knowingly, and that the
 * memory it cost stayed under a ceiling. The last of those is the one that fails if somebody
 * reintroduces a check made after the buffer has been materialised.
 *
 * Both payloads are built by streaming, so the test process never itself allocates the hundreds of
 * megabytes it is asserting the parser will not allocate. That matters: a resident-memory
 * assertion taken after the test has already peaked is an assertion about nothing.
 */
import { Buffer } from 'node:buffer';
import { createDeflate, createDeflateRaw, crc32 } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { extractArchive } from '../src/archive/extract.js';
import { readZipDirectory, readZipEntry } from '../src/archive/zip.js';
import { BudgetLedger, DEFAULT_PDF_BUDGET, ResourceBudgetError } from '../src/budgets.js';
import { DEFAULT_INGEST_CONFIG } from '../src/config.js';
import type { IngestConfig } from '../src/config.js';
import { ArchiveLimitError } from '../src/errors.js';
import { ScratchManager } from '../src/scratch.js';
import { extractPdfText } from '../src/text/pdf-text.js';
import { makeTempDir } from './helpers.js';

const MIB = 1024 * 1024;

/* -- Building a bomb without becoming one -------------------------------------------------- */

/**
 * The deflate stream for `size` bytes of `fill`, and its CRC-32, produced a megabyte at a time.
 *
 * Never holds more than a megabyte of the payload, so a test that asks for 300 MB of output costs
 * a megabyte of input and about a kilobyte of output.
 */
const deflateFill = async (
  size: number,
  fill: number,
  raw: boolean,
): Promise<{ compressed: Buffer; crc: number }> => {
  const stream = raw ? createDeflateRaw({ level: 9 }) : createDeflate({ level: 9 });
  const out: Buffer[] = [];
  stream.on('data', (chunk: Buffer) => out.push(chunk));
  const done = new Promise<void>((resolve, reject) => {
    stream.on('end', () => {
      resolve();
    });
    stream.on('error', reject);
  });
  stream.resume();

  const block = Buffer.alloc(MIB, fill);
  let crc = 0;
  let written = 0;
  while (written < size) {
    const take = Math.min(MIB, size - written);
    const chunk = take === MIB ? block : block.subarray(0, take);
    crc = crc32(chunk, crc);
    if (!stream.write(chunk)) await new Promise<void>((resolve) => stream.once('drain', resolve));
    written += take;
  }
  stream.end();
  await done;
  return { compressed: Buffer.concat(out), crc };
};

/** A one-member zip whose local header and central directory both understate the member's size. */
const lyingZip = (name: string, compressed: Buffer, crc: number, declaredSize: number): Buffer => {
  const nameBuf = Buffer.from(name, 'utf8');

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8); // deflate
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(declaredSize, 22); // the lie
  local.writeUInt16LE(nameBuf.length, 26);
  const body = Buffer.concat([local, nameBuf, compressed]);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(declaredSize, 24); // the same lie
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt32LE(0, 42);
  const directory = Buffer.concat([central, nameBuf]);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(body.length, 16);

  return Buffer.concat([body, directory, end]);
};

/** A PDF with `count` FlateDecode streams, each inflating to `bytesEach`. Well-formed throughout. */
const bombPdf = async (count: number, bytesEach: number): Promise<Buffer> => {
  const { compressed } = await deflateFill(bytesEach, 0x20, false);
  const parts: Buffer[] = [Buffer.from('%PDF-1.4\n', 'latin1')];
  for (let index = 0; index < count; index += 1) {
    parts.push(
      Buffer.from(
        `${index + 1} 0 obj\n<< /Length ${compressed.length} /Filter /FlateDecode >>\nstream\n`,
        'latin1',
      ),
      compressed,
      Buffer.from('\nendstream\nendobj\n', 'latin1'),
    );
  }
  parts.push(Buffer.from('trailer\n<< /Root 1 0 R >>\n%%EOF\n', 'latin1'));
  return Buffer.concat(parts);
};

/**
 * Peak resident memory across a synchronous call, sampled from a timer.
 *
 * `process.memoryUsage.rss()` is the cheap variant, so sampling every few milliseconds costs
 * nothing. The call under test is synchronous and blocks the loop, which is the defect — so the
 * timer cannot fire during it, and the reading immediately afterwards is what carries the evidence.
 * Both are taken and the larger is used.
 */
const peakRssDuring = <T>(work: () => T): { result: T; error: unknown; grew: number } => {
  const before = process.memoryUsage.rss();
  let peak = before;
  const timer = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage.rss());
  }, 2);
  let result: T | undefined;
  let error: unknown = null;
  try {
    result = work();
  } catch (thrown) {
    error = thrown;
  }
  clearInterval(timer);
  peak = Math.max(peak, process.memoryUsage.rss());
  return { result: result as T, error, grew: peak - before };
};

/* -- The zip reproduction ------------------------------------------------------------------- */

describe('zip member budgets (H2, ADR-0022)', () => {
  it('refuses a member that inflates past its allowance, and names the limit', async () => {
    // The review's archive: a member whose central directory and local header both say 1024 bytes
    // and which really holds 64 MiB. Every limit the old code checked was computed from the 1024.
    const { compressed, crc } = await deflateFill(64 * MIB, 0x41, true);
    const zip = lyingZip('a.bin', compressed, crc, 1024);
    expect(zip.length).toBeLessThan(128 * 1024);

    const config: IngestConfig = { ...DEFAULT_INGEST_CONFIG, maxArchiveEntryBytes: 8 * MIB };
    const temporary = makeTempDir('recueil-budget-zip-');
    const scratch = new ScratchManager(temporary.path);

    try {
      const { error, grew } = peakRssDuring(() => {
        const entries = readZipDirectory(zip);
        return readZipEntry(zip, entries[0]!, {
          maxOutputBytes: config.maxArchiveEntryBytes,
          limitName: 'maxArchiveEntryBytes',
        });
      });

      // The memory ceiling, asserted before anything else so that it is this line that fails if
      // the bound ever moves back to after the buffer. With the length compared after
      // `inflateRawSync` returned, this grew by the full 64 MiB and more; with `maxOutputLength`
      // on the call it cannot pass the allowance by more than zlib's own chunking.
      expect(grew).toBeLessThan(32 * MIB);

      expect(error).toBeInstanceOf(ArchiveLimitError);
      const limitError = error as ArchiveLimitError;
      expect(limitError.code).toBe('archive_limit_exceeded');
      // Naming the limit is the acceptance criterion: a refusal an operator cannot act on is not
      // a refusal, it is a mystery.
      expect(limitError.message).toContain('maxArchiveEntryBytes');
      expect(limitError.message).toContain(String(8 * MIB));

      // And the same refusal through the real extraction path, with the real config.
      await expect(
        scratch.with('budget-', (space) =>
          extractArchive({ bytes: zip, kind: 'zip', scratch: space, config }),
        ),
      ).rejects.toThrow(/maxArchiveEntryBytes/u);
    } finally {
      await scratch.dispose();
      temporary.dispose();
    }
  });

  it('never lets the declared size raise the ceiling', async () => {
    // The mirror image of the lie: a member that declares more than the budget is refused before a
    // byte is inflated. The declared size may make a refusal earlier; it may never make one later.
    const { compressed, crc } = await deflateFill(2 * MIB, 0x41, true);
    const zip = lyingZip('big.bin', compressed, crc, 900 * MIB);
    const entries = readZipDirectory(zip);

    expect(() => readZipEntry(zip, entries[0]!, { maxOutputBytes: MIB })).toThrow(ArchiveLimitError);
    expect(() => readZipEntry(zip, entries[0]!, { maxOutputBytes: MIB })).toThrow(/declares 943718400/u);
  });

  it('spends a nested container’s inherited remainder, not a fresh ceiling', async () => {
    // An archive found inside another archive is handed the outer ledger's remainder. Both members
    // are honest about their sizes and both are well inside `maxArchiveEntryBytes`; what refuses
    // the second is that the container it is in has 2 MiB left, which is the composition rule of
    // ADR-0022 §3 — "a nested container inherits the remaining budget rather than getting a fresh
    // one".
    const { makeZip } = await import('./helpers.js');
    const zip = makeZip([
      { name: 'first.bin', bytes: Buffer.alloc(1024, 0x41) },
      { name: 'second.bin', bytes: Buffer.alloc(4 * MIB, 0x42) },
    ]);
    const outer = new BudgetLedger(6 * MIB, 'maxArchiveTotalBytes');
    outer.spend(4 * MIB); // the outer archive already produced 4 MiB
    const inherited = outer.child('maxArchiveTotalBytes');
    expect(inherited.ceiling).toBe(2 * MIB);

    const temporary = makeTempDir('recueil-budget-nested-');
    const scratch = new ScratchManager(temporary.path);
    try {
      await expect(
        scratch.with('nested-', (space) =>
          extractArchive({
            bytes: zip,
            kind: 'zip',
            scratch: space,
            config: DEFAULT_INGEST_CONFIG,
            budget: inherited,
          }),
        ),
      ).rejects.toThrow(/maxArchiveTotalBytes \(remaining\)/u);
    } finally {
      await scratch.dispose();
      temporary.dispose();
    }
  });
});

describe('BudgetLedger', () => {
  it('hands out the smaller of the per-operation limit and the remainder', () => {
    const ledger = new BudgetLedger(100, 'total');
    expect(ledger.allowance(60)).toBe(60);
    expect(ledger.spend(70)).toBe(true);
    // 30 left, so a 60-byte operation is now allowed 30 — the composition rule of ADR-0022 §3.
    expect(ledger.allowance(60)).toBe(30);
    expect(ledger.spend(31)).toBe(false);
    expect(ledger.allowance(60)).toBe(0);
  });

  it('gives a nested container the remainder, not a fresh ceiling', () => {
    const outer = new BudgetLedger(100, 'outer');
    outer.spend(80);
    const inner = outer.child('inner');
    expect(inner.ceiling).toBe(20);
    expect(inner.allowance(1000)).toBe(20);
  });
});

/* -- The PDF reproduction ------------------------------------------------------------------- */

describe('PDF stream budgets (H2, ADR-0022)', () => {
  it('refuses a 300 MB stream from a 300 KB file, names the limit, and stays under a ceiling', async () => {
    // The review's file, exactly: one FlateDecode stream over 300 MB of spaces. Nothing about it
    // is malformed — this is what a PDF is allowed to contain, which is why no "is this a valid
    // PDF" check could ever have caught it.
    const pdf = await bombPdf(1, 300 * MIB);
    expect(pdf.length).toBeLessThan(512 * 1024);

    const started = Date.now();
    const { error, grew } = peakRssDuring(() => extractPdfText(pdf));
    const elapsed = Date.now() - started;

    // The memory ceiling the acceptance criterion asks for, asserted first so that it is this line
    // that fails if the bound ever moves back to after the buffer. Unfixed, this call added 642 MB
    // of RSS on this machine and 914 MB on the reviewer's; the per-stream budget is 32 MiB, and the
    // latin1 copy of a refused stream is never made because the inflate never returns one.
    expect(grew).toBeLessThan(128 * MIB);

    expect(error).toBeInstanceOf(ResourceBudgetError);
    const budgetError = error as ResourceBudgetError;
    expect(budgetError.code).toBe('resource_budget_exceeded');
    expect(budgetError.limitName).toBe('pdf.maxStreamOutputBytes');
    expect(budgetError.message).toContain('pdf.maxStreamOutputBytes');
    expect(budgetError.message).toContain(String(DEFAULT_PDF_BUDGET.maxStreamOutputBytes));

    // It is synchronous, so its duration is the event loop's duration. Unfixed: 5.7 seconds for
    // this file, 40.7 for the ten-stream variant below.
    expect(elapsed).toBeLessThan(3_000);
  });

  it('refuses ten 200 MB streams as fast as one', async () => {
    const pdf = await bombPdf(10, 200 * MIB);
    const started = Date.now();
    const { error, grew } = peakRssDuring(() => extractPdfText(pdf));
    expect(error).toBeInstanceOf(ResourceBudgetError);
    expect(grew).toBeLessThan(128 * MIB);
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it('refuses a file too large to look inside at all, before inflating anything', () => {
    const budget = { ...DEFAULT_PDF_BUDGET, maxInputBytes: 1024 };
    const { error } = peakRssDuring(() => extractPdfText(Buffer.alloc(4096, 0x20), budget));
    expect(error).toBeInstanceOf(ResourceBudgetError);
    expect((error as ResourceBudgetError).limitName).toBe('pdf.maxInputBytes');
    expect((error as ResourceBudgetError).message).toContain('pdf.maxInputBytes');
  });

  it('refuses on the accumulated total when no single stream is over its own limit', async () => {
    // Four streams of 8 MiB each: none of them trips a per-stream ceiling of 8 MiB, and together
    // they trip a 20 MiB total. A per-member budget without a per-container budget permits a
    // thousand small members (ADR-0022 §3).
    const pdf = await bombPdf(4, 8 * MIB);
    const budget = {
      ...DEFAULT_PDF_BUDGET,
      maxStreamOutputBytes: 8 * MIB,
      maxTotalOutputBytes: 20 * MIB,
    };
    const { error } = peakRssDuring(() => extractPdfText(pdf, budget));
    expect(error).toBeInstanceOf(ResourceBudgetError);
    expect((error as ResourceBudgetError).limitName).toBe('pdf.maxTotalOutputBytes');
    expect((error as ResourceBudgetError).message).toContain('pdf.maxTotalOutputBytes');
  });

  it('still reads an ordinary PDF, which is the thing the budget must not break', async () => {
    const { makePdf } = await import('./helpers.js');
    const result = extractPdfText(makePdf({ lines: ['Rechnung R-77', 'Stadtwerke Ulm'] }));
    expect(result.text).toContain('Rechnung R-77');
    expect(result.streamsRead).toBeGreaterThan(0);
  });
});
