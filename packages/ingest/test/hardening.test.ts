/**
 * The hardening re-attack's findings, rebuilt as tests (ADR-0021, ADR-0022).
 *
 * Round one of the hardening fixed twenty defects and missed five, and the misses shared one cause:
 * each fix was scoped to the *file* a workstream table named rather than to the *defect* a finding
 * described. So the tests here are written against the shapes rather than against the lines — the
 * unbounded lazy span, the budget that does not compose, the check that counts where it claims to
 * compare, the decode that happens before the limit is consulted — and each one was watched failing
 * against the unfixed code before the fix was written.
 *
 * Every payload is built rather than fixtured, so that the numbers in the comments can be checked
 * by re-running with the fix reverted.
 */
import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';

import { schema } from '@recueil/core';
import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { extractArchive } from '../src/archive/extract.js';
import { parseEmail } from '../src/archive/eml.js';
import {
  BudgetLedger,
  DEFAULT_EMAIL_BUDGET,
  DEFAULT_PDF_BUDGET,
  ResourceBudgetError,
} from '../src/budgets.js';
import { DEFAULT_INGEST_CONFIG } from '../src/config.js';
import {
  SCRATCH_ROOT_PREFIX,
  ScratchManager,
  sweepAbandonedScratch,
} from '../src/scratch.js';
import { reviewQueue } from '../src/db/schema.js';
import { RULE_HEADER_LIMITS, RuleEngine } from '../src/rules/engine.js';
import type { RuleSubject } from '../src/rules/engine.js';
import { GrobidExtractor, parseTeiHeader } from '../src/metadata/grobid.js';
import type { MetadataExtractor } from '../src/metadata/extractor.js';
import { OfficeHeuristicExtractor } from '../src/metadata/office.js';
import { simhash } from '../src/text/simhash.js';
import { SourceFileChangedError } from '../src/sources/local.js';
import { IngestPipeline, bufferCandidate, folderCandidates } from '../src/index.js';
import { extractPdfText } from '../src/text/pdf-text.js';
import { invoiceLines, makeEmail, makeLibrary, makePdf, makeTempDir } from './helpers.js';
import type { TestLibrary } from './helpers.js';

const MIB = 1024 * 1024;

/* -- P-REGEX: the page count, outside every budget ------------------------------------------- */

/**
 * A PDF-shaped file carrying `/Type /Pages` markers that are never followed by a `>`.
 *
 * Nothing about it is a bomb in the ADR-0022 §2 sense: it has no streams at all, so it inflates
 * nothing and allocates nothing. The cost is entirely in the page-count scan, which is precisely
 * why the wall clock at the top of the stream loop never saw it — the loop was never entered.
 */
const unterminatedPagesPdf = (targetBytes: number): { bytes: Buffer; markers: number } => {
  const marker = '/Type /Pages';
  const filler = 'A'.repeat(1600);
  const parts = ['%PDF-1.4\n'];
  let size = 0;
  let markers = 0;
  while (size < targetBytes) {
    parts.push(marker + filler + '\n');
    markers += 1;
    size += marker.length + filler.length + 1;
  }
  return { bytes: Buffer.from(parts.join(''), 'latin1'), markers };
};

describe('the PDF page count runs inside the budget (re-attack CRITICAL, pdf-text.ts)', () => {
  it('does not re-scan the file once per unterminated /Type /Pages marker', () => {
    // The finding's own measurements against the unfixed reader, on the reviewer's machine:
    // 2 MiB / 1260 markers -> 1.91 s, 4 MiB -> 9.50 s, 8 MiB / 5041 markers -> 42.52 s, and every
    // one of them returned `ok` with `pageCount: null` against a 15 000 ms budget. Reproduced here
    // at 0.61 s / 2.23 s / 9.01 s / 30.00 s for 1/2/4/8 MiB before the fix.
    //
    // The assertion is deliberately on the *shape* rather than on a stopwatch alone: quadratic
    // means quadrupling the input costs sixteen times as much, so a growth factor well under four
    // between 2 MiB and 8 MiB is the property that fails the moment an unbounded lazy span comes
    // back. A single elapsed-time bound would pass on a fast enough machine with the defect intact.
    const small = unterminatedPagesPdf(2 * MIB);
    const large = unterminatedPagesPdf(8 * MIB);
    expect(large.markers).toBeGreaterThan(4_000);

    const time = (bytes: Buffer): number => {
      const started = process.hrtime.bigint();
      extractPdfText(bytes, DEFAULT_PDF_BUDGET);
      return Number(process.hrtime.bigint() - started) / 1e6;
    };

    // Warm the reader so the first call does not carry the JIT's cost into the ratio.
    extractPdfText(small.bytes, DEFAULT_PDF_BUDGET);

    const smallMs = time(small.bytes);
    const largeMs = time(large.bytes);

    // Four times the input for at most eight times the work: linear, with generous slack for a
    // loaded machine. Unfixed this ratio is ~16.
    expect(largeMs).toBeLessThan(Math.max(smallMs, 1) * 8);
    // And an absolute ceiling, because a ratio alone cannot notice both sides being slow.
    expect(largeMs).toBeLessThan(2_000);
  });

  it('refuses on the clock rather than returning ok when the page scan runs long', () => {
    // A budget of zero milliseconds means the deadline has already passed when the stream loop
    // ends. Before the fix, `countPages` ran after the loop and outside every budget, so a file
    // with no streams returned normally however long it had taken; now the clock is read again
    // after the loop, so the call refuses and names the limit (ADR-0022 §6: a refusal, not a
    // crash and not a silent skip).
    const { bytes } = unterminatedPagesPdf(64 * 1024);
    const budget = { ...DEFAULT_PDF_BUDGET, maxMillis: 0 };
    let thrown: unknown = null;
    try {
      extractPdfText(bytes, budget);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ResourceBudgetError);
    expect((thrown as ResourceBudgetError).limitName).toBe('pdf.maxMillis');
    expect((thrown as ResourceBudgetError).message).toContain('pdf.maxMillis');
  });

  it('does not re-scan the whole file looking for each stream’s dictionary', () => {
    // Unnamed by any reviewer, found by sweeping the same pattern through the same file:
    // `lastIndexOf('<<', here)` with no floor walks back to byte 0 for every stream when the file
    // holds no `<<` at all. Measured against the unfixed reader: 8 MiB / 500 streams -> 4.65 s,
    // 16 MiB / 1000 -> the 15 s wall clock, 32 MiB / 2000 -> the wall clock again. Bounded, but
    // bounded only by the clock, which is ADR-0022 §5's "nothing unbounded runs synchronously".
    const prefix = 'B'.repeat(8 * MIB);
    const one = 'stream\n()Tj\nendstream\n';
    const bytes = Buffer.from(`%PDF-1.4\n${prefix}${one.repeat(500)}`, 'latin1');

    const started = Date.now();
    const result = extractPdfText(bytes, DEFAULT_PDF_BUDGET);
    const elapsed = Date.now() - started;

    expect(result.streamsFound).toBe(500);
    expect(elapsed).toBeLessThan(1_500);
  });

  it('still reads the page count of an ordinary PDF', () => {
    // The bound must not cost the feature. A real page tree has its `/Count` a few characters
    // after the marker, well inside the span the reader now allows.
    expect(extractPdfText(makePdf({ pages: 7, lines: ['Seite eins'] })).pageCount).toBe(7);
    expect(extractPdfText(makePdf({ pages: 1, lines: ['Seite eins'] })).pageCount).toBe(1);
  });
});

/* -- P-BUDGET: the ledger that nothing called ------------------------------------------------ */

/**
 * A ZIP whose members are deflated, so an inner archive can be small enough to be a member of an
 * outer one.
 *
 * `helpers.ts`'s `makeZip` writes stored members, which is right for every other test and useless
 * here: a stored inner archive is bigger than its own contents, so it trips the per-member ceiling
 * before it can demonstrate anything about composition.
 */
const deflatedZip = (members: ReadonlyArray<{ name: string; bytes: Buffer }>): Buffer => {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const member of members) {
    const name = Buffer.from(member.name, 'utf8');
    const digest = crc32(member.bytes);
    const compressed = deflateRawSync(member.bytes, { level: 9 });

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(digest, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(member.bytes.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(digest, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(member.bytes.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);

    locals.push(local, compressed);
    centrals.push(central);
    offset += local.length + compressed.length;
  }

  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(members.length, 8);
  end.writeUInt16LE(members.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
};

/**
 * A megabyte that compresses about 128 times: an 8 KiB random block repeated.
 *
 * The ratio matters. All-`A` payloads compress a thousandfold and are refused by
 * `maxArchiveExpansionRatio` long before the budget question arises, which is what made the first
 * attempt at this reproduction fail to reproduce anything.
 */
const compressibleMebibyte = (): Buffer => {
  const block = randomBytes(8 * 1024);
  return Buffer.concat(Array.from({ length: 128 }, () => block));
};

describe('one budget spans an archive tree (re-attack MAJOR, pipeline.ts + budgets.ts)', () => {
  let library: TestLibrary;

  beforeEach(() => {
    library = makeLibrary();
  });

  afterEach(() => {
    library.dispose();
  });

  it('charges a child ledger to its parent', () => {
    // The unit of the defect. `child()` used to return `new BudgetLedger(this.remaining, label)` —
    // an unconnected ledger seeded with the remainder — so N siblings each spent the remainder in
    // full. Two siblings are enough to show it: the first takes everything, and the second must
    // then be allowed nothing.
    const parent = new BudgetLedger(1_000, 'total');
    const first = parent.child('total');
    expect(first.ceiling).toBe(1_000);
    expect(first.spend(1_000)).toBe(true);

    const second = parent.child('total');
    expect(second.remaining).toBe(0);
    expect(second.allowance(500)).toBe(0);
    expect(second.spend(1)).toBe(false);
    // And the depth direction: a grandchild is bounded by the whole chain, not by its own ceiling.
    const grandchild = first.child('total');
    expect(grandchild.remaining).toBe(0);
  });

  it('refuses forty inner archives that together pass the container ceiling', async () => {
    // The re-attack's construction, through the real pipeline. Case A — forty 1 MiB members in one
    // container — was already refused before this round, by the declared-total check. Case B is
    // the same forty megabytes one level down, and it was ALLOWED: measured at 40.6 MiB filed
    // against a 4 MiB `maxArchiveTotalBytes` from a 357 KB file, because every container minted a
    // fresh ledger.
    // Each inner archive carries *different* bytes. Forty identical ones would be one document and
    // thirty-nine stage-2 duplicates, and the construction would appear bounded for a reason that
    // has nothing to do with budgets — which is exactly what the first draft of this test measured.
    const inners = Array.from({ length: 40 }, (_, index) =>
      deflatedZip([{ name: `p${String(index)}.bin`, bytes: compressibleMebibyte() }]),
    );
    const outer = deflatedZip(
      inners.map((bytes, index) => ({ name: `i${String(index)}.zip`, bytes })),
    );
    // The construction is only interesting if it is inside every *other* limit, so assert that
    // rather than trust it: each level expands well under the 200x ratio ceiling, and no single
    // member is over `maxArchiveEntryBytes`.
    expect(MIB / (inners[0] as Buffer).length).toBeLessThan(200);
    expect(outer.length).toBeLessThan(MIB);

    const pipeline = new IngestPipeline({
      recueil: library,
      config: {
        maxArchiveEntryBytes: MIB,
        maxArchiveTotalBytes: 4 * MIB,
        maxArchiveDepth: 3,
        scratchRoot: library.root,
        ocrEnabled: false,
      },
    });

    await pipeline.ingestOne(
      bufferCandidate(outer, { filename: 'outer.zip', mediaType: 'application/zip' }),
      { runLabel: 'nested-budget' },
    );

    // The evidence is the library, not the report: what did the run actually put on disk?
    const stored =
      library.db
        .select({ total: sql<number>`coalesce(sum(${schema.documents.byteSize}), 0)` })
        .from(schema.documents)
        .get()?.total ?? 0;

    // Unfixed: 40 inner archives each minting a fresh 4 MiB ledger, so all forty mebibytes are
    // filed. Fixed: one ledger for the tree, so the run stops once 4 MiB have been produced.
    // The slack is the inner archives themselves, which are members of the outer one and are
    // therefore also bytes the budget paid for.
    expect(stored).toBeLessThanOrEqual(4 * MIB + outer.length);
    expect(stored).toBeLessThan(40 * MIB);
  });
});

/* -- P-REGEX: the second path of the Phase 2 ReDoS finding ----------------------------------- */

const ruleSubject = (over: Partial<RuleSubject> = {}): RuleSubject => ({
  sourceKind: 'imap',
  sourceId: 'mailbox-1',
  path: 'INBOX/42',
  filename: 'scan.pdf',
  mediaType: 'application/pdf',
  detectedType: 'office_document',
  text: null,
  identifiers: [],
  resolvedBy: [],
  sourceMetadata: {},
  confidence: 0.5,
  ...over,
});

describe('stage 8 matches under a budget (Phase 2 CRITICAL, rules/engine.ts)', () => {
  // The ADR's own example rule, and the one the re-attack compiled through the shipped
  // `toIngestRules`: "the subject is just plain words". Nothing about it is hostile.
  const plainWords = { pattern: String.raw`^(\w+\s?)*$`, flags: 'i' };

  it('answers in milliseconds on the subject length that took a minute', () => {
    const engine = new RuleEngine([
      { id: 'r1', match: { subject: plainWords }, actions: { addTags: ['post'] } },
    ]);

    // Measured against the unfixed engine on this machine: 23 characters 0.69 s, 27 characters
    // 1.21 s, 31 characters 16.82 s, 33 characters 69.31 s, and 35 characters did not return
    // inside a two-minute timeout. The length is chosen by whoever sends the mail.
    for (const length of [23, 27, 31, 33, 35, 45]) {
      const subject = 'a'.repeat(length - 1) + '!';
      const started = Date.now();
      const evaluation = engine.evaluate(ruleSubject({ sourceMetadata: { subject } }));
      const elapsed = Date.now() - started;

      expect(elapsed).toBeLessThan(1_000);
      // The rule genuinely does not match this subject, and the engine says so rather than
      // refusing: a bounded engine that answered "I gave up" here would have replaced one defect
      // with another.
      expect(evaluation.matched).toEqual([]);
      expect(evaluation.refusals ?? []).toEqual([]);
    }
  });

  it('still matches what the rule is for', () => {
    // The bound must not cost the feature: the same pattern, on a subject that is plain words.
    const engine = new RuleEngine([
      { id: 'r1', match: { subject: plainWords }, actions: { addTags: ['post'] } },
    ]);
    const evaluation = engine.evaluate(
      ruleSubject({ sourceMetadata: { subject: 'Rechnung Stadtwerke Ulm' } }),
    );
    expect(evaluation.matched).toEqual(['r1']);
    expect(evaluation.addTags).toEqual(['post']);
  });

  it('reports a clause it cannot decide rather than calling it a non-match', () => {
    // A haystack past the clause's own input ceiling. "Could not be evaluated" and "did not match"
    // mean different things, and collapsing them is how a denial of service becomes a silent
    // mis-filing — so the rule does not match, and the reason travels with the evaluation.
    const engine = new RuleEngine([
      { id: 'r-big', match: { subject: { pattern: 'Rechnung' } }, actions: { addTags: ['post'] } },
    ]);
    const huge = 'x'.repeat(RULE_HEADER_LIMITS.maxInputLength + 1);
    const evaluation = engine.evaluate(ruleSubject({ sourceMetadata: { subject: huge } }));

    // `refusals` is optional on the interface — see the field's comment — and always set by this
    // engine, which is exactly what the first assertion here is for.
    const refusals = evaluation.refusals ?? [];
    expect(evaluation.matched).toEqual([]);
    expect(refusals).toHaveLength(1);
    expect(refusals[0]?.ruleId).toBe('r-big');
    expect(refusals[0]?.clause).toBe('subject');
    expect(refusals[0]?.reason).toContain(String(RULE_HEADER_LIMITS.maxInputLength));
  });

  it('sends a document whose rules could not be evaluated to a person', async () => {
    // ADR-0022 §6 end to end: a budget that is spent is a review-queue outcome naming the reason,
    // not a crash and not a document filed as though the rule had been checked.
    const library = makeLibrary();
    try {
      const pipeline = new IngestPipeline({
        recueil: library,
        config: { scratchRoot: library.root, ocrEnabled: false },
        rules: [
          {
            id: 'r-big',
            match: { subject: { pattern: 'Rechnung' } },
            actions: { addTags: ['post'] },
          },
        ],
      });

      const outcome = await pipeline.ingestOne(
        bufferCandidate(makePdf({ lines: ['Rechnung R-1'] }), {
          filename: 'scan.pdf',
          sourceMetadata: { subject: 'y'.repeat(RULE_HEADER_LIMITS.maxInputLength + 1) },
        }),
        { runLabel: 'unevaluable-rule' },
      );

      expect(outcome.status).toBe('review');
      const row = library.db
        .select()
        .from(reviewQueue)
        .where(eq(reviewQueue.reasonCode, 'rule_unevaluable'))
        .get();
      expect(row).toBeDefined();
      expect(row?.explanation).toContain('r-big');
    } finally {
      library.dispose();
    }
  });
});

/* -- P-BUDGET: the last ingestion path outside ADR-0022 --------------------------------------- */

/** A message with one quoted-printable part decoding to `decodedBytes`. */
const quotedPrintableMessage = (decodedBytes: number): Buffer => {
  const line = '=41'.repeat(24) + '\r\n'; // 24 decoded bytes per 74 encoded characters
  const repeats = Math.ceil(decodedBytes / 24);
  return Buffer.from(
    [
      'From: stranger@example.org',
      'Subject: bomb',
      'MIME-Version: 1.0',
      'Content-Type: application/octet-stream; name="x.bin"',
      'Content-Transfer-Encoding: quoted-printable',
      'Content-Disposition: attachment; filename="x.bin"',
      '',
      line.repeat(repeats),
    ].join('\r\n'),
    'latin1',
  );
};

describe('a message is parsed under a budget (Phase 2 MINOR, archive/eml.ts)', () => {
  it('refuses a part that decodes past its allowance, at the decode', () => {
    // Unfixed, `parseEmail(raw)` took no limits argument at all, so the first size comparison of
    // any kind happened in `extract.ts` after the whole tree had been decoded. Measured: a 24.0 MB
    // message decoded 8.8 MB and moved RSS by 166 MB — 6.9x the payload — because the decoder
    // accumulated into a `number[]`.
    const message = quotedPrintableMessage(4 * MIB);
    const budget = { ...DEFAULT_EMAIL_BUDGET, maxPartBytes: MIB, maxTotalBytes: 8 * MIB };

    let thrown: unknown = null;
    try {
      parseEmail(message, budget);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ResourceBudgetError);
    expect((thrown as ResourceBudgetError).limitName).toBe('eml.maxPartBytes');
    expect((thrown as ResourceBudgetError).message).toContain('eml.maxPartBytes');
    expect((thrown as ResourceBudgetError).message).toContain(String(MIB));
  });

  it('refuses a base64 part from the bytes in hand, before decoding it', () => {
    const payload = Buffer.alloc(4 * MIB, 0x41).toString('base64');
    const message = Buffer.from(
      [
        'From: stranger@example.org',
        'Subject: b64',
        'MIME-Version: 1.0',
        'Content-Type: application/octet-stream; name="x.bin"',
        'Content-Transfer-Encoding: base64',
        'Content-Disposition: attachment; filename="x.bin"',
        '',
        payload,
      ].join('\r\n'),
      'latin1',
    );
    expect(() => parseEmail(message, { ...DEFAULT_EMAIL_BUDGET, maxPartBytes: MIB })).toThrow(
      /eml\.maxPartBytes/u,
    );
  });

  it('counts parts as it builds them rather than after', () => {
    // The re-attack built 199 999 `EmailPart` objects — each with its own Buffer — before the
    // 2 048-entry check downstream was reached. The refusal now happens on the 2 049th part, so
    // the two-hundred-thousandth is never allocated.
    const boundary = 'b';
    const part =
      `--${boundary}\r\nContent-Type: text/plain\r\n` +
      'Content-Disposition: attachment; filename="p.txt"\r\n\r\nx\r\n';
    const message = Buffer.from(
      [
        'From: stranger@example.org',
        'Subject: breadth',
        'MIME-Version: 1.0',
        `Content-Type: multipart/mixed; boundary="${boundary}"`,
        '',
        part.repeat(5_000),
        `--${boundary}--`,
        '',
      ].join('\r\n'),
      'latin1',
    );

    let thrown: unknown = null;
    try {
      parseEmail(message, { ...DEFAULT_EMAIL_BUDGET, maxParts: 2_048 });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ResourceBudgetError);
    expect((thrown as ResourceBudgetError).limitName).toBe('eml.maxParts');
  });

  it('refuses a message whose header block never ends', () => {
    // `findHeaderEnd` returns the whole buffer when there is no blank line, so the entire file
    // became one `latin1` string and one `split`.
    const message = Buffer.from(`From: a@b\r\n${'X-Padding: y\r\n'.repeat(200_000)}`, 'latin1');
    expect(() => parseEmail(message, { ...DEFAULT_EMAIL_BUDGET, maxHeaderBytes: 64 * 1024 })).toThrow(
      /eml\.maxHeaderBytes/u,
    );
  });

  it('still parses an ordinary message with its attachments', () => {
    // The bound must not cost the feature.
    const email = parseEmail(
      makeEmail({
        from: 'Stadtwerke <post@stadtwerke.example>',
        subject: 'Rechnung Maerz',
        body: 'Ihre Rechnung im Anhang.',
        attachments: [
          { filename: 'rechnung.pdf', mediaType: 'application/pdf', bytes: makePdf({ lines: ['R-1'] }) },
        ],
      }),
    );
    expect(email.subject).toBe('Rechnung Maerz');
    expect(email.attachments).toHaveLength(1);
    expect(email.attachments[0]?.filename).toBe('rechnung.pdf');
    expect(email.bodyText).toContain('Ihre Rechnung im Anhang.');
  });

  it('spends the containing archive’s remainder, not a budget of its own', async () => {
    // A message that is a member of a zip decodes out of the zip's ledger. Before the ledger was
    // wired through, `extractArchive` opened a fresh `maxArchiveTotalBytes` for it.
    const message = quotedPrintableMessage(3 * MIB);
    const library = makeLibrary();
    const scratch = new ScratchManager(library.root);
    try {
      const ledger = new BudgetLedger(4 * MIB, 'maxArchiveTotalBytes');
      ledger.spend(3.5 * MIB); // the containing archive has already produced this much

      await expect(
        scratch.with('eml-', (space) =>
          extractArchive({
            bytes: message,
            kind: 'eml',
            scratch: space,
            config: DEFAULT_INGEST_CONFIG,
            budget: ledger,
          }),
        ),
      ).rejects.toThrow(/eml\.maxTotalBytes/u);
    } finally {
      await scratch.dispose();
      library.dispose();
    }
  });
});

/* -- Scratch: a root that is never created, and roots nothing ever reclaims -------------------- */

describe('scratch roots (Phase 2 MINOR, still open at the re-attack)', () => {
  it('creates a configured root that does not exist yet', async () => {
    // `mkdtemp` does not create its parent, so an operator who pointed `scratchRoot` at a path that
    // did not exist got ENOENT on the first archive and on every archive after it, surfacing as an
    // `archive_unreadable` review entry proposing a retry that could never succeed. Zip and .eml
    // ingestion was silently dead for that deployment.
    const base = makeTempDir('recueil-scratch-missing-');
    try {
      const root = join(base.path, 'nested', 'scratch');
      expect(existsSync(root)).toBe(false);
      const manager = new ScratchManager(root);
      const seen = await manager.with('probe-', async (space) => space.path);
      expect(seen.startsWith(root)).toBe(true);
      await manager.dispose();
    } finally {
      base.dispose();
    }
  });

  it('reclaims a root whose owning process is gone, and keeps one whose is not', async () => {
    // The sweep decides by identity — which process made this directory, and is it still there —
    // rather than by age or emptiness, because a sweep that cannot tell a crashed run from a
    // concurrent one deletes members while another run is hashing them.
    const base = makeTempDir('recueil-scratch-sweep-');
    try {
      const dead = join(base.path, `${SCRATCH_ROOT_PREFIX}dead00`);
      const live = join(base.path, `${SCRATCH_ROOT_PREFIX}live00`);
      const stranger = join(base.path, `${SCRATCH_ROOT_PREFIX}other0`);
      const unrelated = join(base.path, 'not-ours');
      for (const path of [dead, live, stranger, unrelated]) mkdirSync(path, { recursive: true });
      writeFileSync(join(dead, 'archive-deadbeef'), 'leftover');

      // A pid that cannot be running: `kill -0` on it answers ESRCH.
      const deadPid = 0x7fff_fffe;
      writeFileSync(
        join(dead, '.recueil-run.json'),
        JSON.stringify({ pid: deadPid, hostname: hostname(), startedAt: '2026-08-01T00:00:00Z' }),
      );
      writeFileSync(
        join(live, '.recueil-run.json'),
        JSON.stringify({ pid: process.pid, hostname: hostname(), startedAt: '2026-08-01T00:00:00Z' }),
      );
      writeFileSync(
        join(stranger, '.recueil-run.json'),
        JSON.stringify({ pid: deadPid, hostname: 'some-other-host', startedAt: '2026-08-01T00:00:00Z' }),
      );

      const report = await sweepAbandonedScratch(base.path);

      expect(report.removed).toEqual([dead]);
      expect(existsSync(dead)).toBe(false);
      // Everything the sweep could not attribute with certainty is kept, and says why.
      expect(existsSync(live)).toBe(true);
      expect(existsSync(stranger)).toBe(true);
      expect(existsSync(unrelated)).toBe(true);
      expect(report.kept.map((entry) => entry.path).sort()).toEqual([live, stranger].sort());
      expect(report.kept.find((entry) => entry.path === live)?.reason).toContain('still running');
      expect(report.kept.find((entry) => entry.path === stranger)?.reason).toContain('this host');
    } finally {
      base.dispose();
    }
  });

  it('keeps an unattributable root until it is older than the grace period', async () => {
    // The window between `mkdtemp` and the owner file being written is real, if short. A directory
    // inside it is kept; the same directory once it is plainly stale is not.
    const base = makeTempDir('recueil-scratch-grace-');
    try {
      const orphan = join(base.path, `${SCRATCH_ROOT_PREFIX}orphan`);
      mkdirSync(orphan, { recursive: true });

      const kept = await sweepAbandonedScratch(base.path);
      expect(kept.removed).toEqual([]);
      expect(kept.kept[0]?.reason).toContain('grace period');

      const swept = await sweepAbandonedScratch(base.path, { graceMs: -1 });
      expect(swept.removed).toEqual([orphan]);
      expect(existsSync(orphan)).toBe(false);
    } finally {
      base.dispose();
    }
  });

  it('a run sweeps what a crashed run left behind', async () => {
    // The finding was not "there is no sweep" but "no sweep exists and no start-up caller exists".
    // A sweep nothing calls is the same defect as no sweep, so the caller is asserted too.
    const library = makeLibrary();
    try {
      const scratchRoot = join(library.root, 'scratch');
      mkdirSync(scratchRoot, { recursive: true });
      const leaked = join(scratchRoot, `${SCRATCH_ROOT_PREFIX}crashed`);
      mkdirSync(leaked, { recursive: true });
      writeFileSync(
        join(leaked, '.recueil-run.json'),
        JSON.stringify({
          pid: 0x7fff_fffe,
          hostname: hostname(),
          startedAt: '2026-08-01T00:00:00Z',
        }),
      );

      const pipeline = new IngestPipeline({
        recueil: library,
        config: { scratchRoot, ocrEnabled: false },
      });
      await pipeline.ingestOne(
        bufferCandidate(makePdf({ lines: ['Rechnung R-2'] }), { filename: 'scan.pdf' }),
        { runLabel: 'sweeps-on-start' },
      );

      expect(existsSync(leaked)).toBe(false);
    } finally {
      library.dispose();
    }
  });
});

/* -- P-REGEX and P-BUDGET over a third party's XML -------------------------------------------- */

describe('the TEI reader is bounded (grobid.ts)', () => {
  it('does not re-scan the gap once per unclosed opener', () => {
    // Nobody named this one. `scanTag` re-ran `indexOf('</idno>', cursor)` from each nested opener,
    // so a document with N openers of one name before its first closer read the same characters N
    // times: 0.43 MB cost 0.23 s, 0.85 MB 0.91 s, 1.71 MB 3.66 s, 3.42 MB 15.86 s — clean
    // quadratic, synchronous, on the ingest worker, from a response the sidecar chose.
    const nest = (count: number): string => {
      const filler = 'z'.repeat(200);
      return (
        `<teiHeader>${`<idno type="doi">${filler}`.repeat(count)}${'</idno>'.repeat(count)}</teiHeader>`
      );
    };

    const time = (tei: string): number => {
      const started = process.hrtime.bigint();
      parseTeiHeader(tei, { extractor: 'grobid', confidence: 0.7 });
      return Number(process.hrtime.bigint() - started) / 1e6;
    };

    parseTeiHeader(nest(500), { extractor: 'grobid', confidence: 0.7 }); // warm
    const small = time(nest(4_000));
    const large = time(nest(16_000));

    // Four times the input for at most eight times the work. Unfixed the ratio is ~16.
    expect(large).toBeLessThan(Math.max(small, 1) * 8);
    expect(large).toBeLessThan(2_000);
  });

  it('refuses a TEI document past its ceiling before scanning it', () => {
    let thrown: unknown = null;
    try {
      parseTeiHeader('<teiHeader>' + 'x'.repeat(4096) + '</teiHeader>', {
        extractor: 'grobid',
        confidence: 0.7,
        maxBytes: 1024,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ResourceBudgetError);
    expect((thrown as ResourceBudgetError).limitName).toBe('grobid.maxTeiBytes');
  });

  it('stops reading a response body at the ceiling instead of after it', async () => {
    // `await response.text()` materialised whatever the far side chose to send. A sidecar is
    // reached at an address an operator configured and can be swapped for something else, so the
    // body is bounded by the read rather than by trust.
    const chunk = new TextEncoder().encode('<idno>'.repeat(1024));
    const extractor = new GrobidExtractor({
      baseUrl: 'http://grobid.invalid',
      maxResponseBytes: 64 * 1024,
      fetchImpl: (async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.enqueue(chunk);
            },
          }),
          { status: 200, headers: { 'content-type': 'application/xml' } },
        )) as unknown as typeof fetch,
    });

    await expect(
      extractor.extract({
        bytes: Buffer.from('%PDF-1.4\n'),
        mediaType: 'application/pdf',
        sha256: 'a'.repeat(64),
        detectedType: 'scholarly_pdf',
        text: null,
        filename: 'x.pdf',
      }),
    ).rejects.toThrow(/grobid\.maxResponseBytes/u);
  });

  it('still reads an ordinary TEI header', () => {
    const tei = [
      '<TEI><teiHeader><fileDesc><titleStmt>',
      '<title>On reproducible ingestion</title>',
      '</titleStmt><sourceDesc><biblStruct><analytic>',
      '<title>On reproducible ingestion</title>',
      '<author><persName><surname>Lovelace</surname><forename>Ada</forename></persName></author>',
      '<idno type="DOI">10.1234/abcd</idno>',
      '</analytic><monogr><title>Journal of Machines</title><imprint>',
      '<date when="1952-01-01"/></imprint></monogr></biblStruct></sourceDesc>',
      '</fileDesc></teiHeader></TEI>',
    ].join('');
    const parsed = parseTeiHeader(tei, { extractor: 'grobid', confidence: 0.7 });
    expect(parsed.fields['bibliographic.title']?.value).toBe('On reproducible ingestion');
    expect(parsed.creators[0]?.family).toBe('Lovelace');
    expect(parsed.identifiers).toContainEqual({ scheme: 'doi', value: '10.1234/abcd' });
  });
});

/* -- P-CORRESPONDENCE: a check that compares which, not how many ------------------------------ */

describe('verifyRun compares correspondence (ADR-0021, pipeline.ts)', () => {
  let library: TestLibrary;

  beforeEach(() => {
    library = makeLibrary();
  });

  afterEach(() => {
    library.dispose();
  });

  /** Two ordinary documents, filed. Returns the run's own report and the ids it touched. */
  const twoDocuments = async (): Promise<{
    report: Awaited<ReturnType<IngestPipeline['run']>>;
    pipeline: IngestPipeline;
  }> => {
    const pipeline = new IngestPipeline({
      recueil: library,
      config: { scratchRoot: library.root, ocrEnabled: false, confidenceThreshold: 0 },
    });
    const report = await pipeline.run(
      [
        bufferCandidate(makePdf({ lines: invoiceLines({ correspondent: 'Stadtwerke', reference: 'R-1' }) }), {
          filename: 'one.pdf',
          externalId: 'one.pdf',
        }),
        bufferCandidate(makePdf({ lines: invoiceLines({ correspondent: 'Finanzamt', reference: 'R-2' }) }), {
          filename: 'two.pdf',
          externalId: 'two.pdf',
        }),
      ],
      { runLabel: 'correspondence' },
    );
    return { report, pipeline };
  };

  /** Re-derive the verdict over the library as it now stands, with the run's own claims. */
  const reverify = (
    pipeline: IngestPipeline,
    report: Awaited<ReturnType<IngestPipeline['run']>>,
  ): ReturnType<IngestPipeline['verifyRun']> => {
    const ids = new Set<string>();
    const collect = (outcome: (typeof report.outcomes)[number]['outcome']): void => {
      if ('documentId' in outcome && typeof outcome.documentId === 'string' && outcome.documentId) {
        ids.add(outcome.documentId);
      }
      if ('members' in outcome && outcome.members !== undefined) outcome.members.forEach(collect);
    };
    for (const entry of report.outcomes) collect(entry.outcome);
    return pipeline.verifyRun(
      report.runId,
      report.counts,
      ids,
      report.outcomes.map((entry) => entry.outcome),
    );
  };

  it('passes on the library the run actually produced', async () => {
    const { report, pipeline } = await twoDocuments();
    expect(report.counts.ingested).toBe(2);
    expect(reverify(pipeline, report).pass).toBe(true);
  });

  it('fails when two items are given each other’s documents', async () => {
    // The mutation every count survives. After the swap there are still two items, two live
    // attachments, two distinct documents underneath them and two documents present — so
    // `documents_filed_once`, `items_created_exist` and `documents_present` are all unchanged.
    // What is not unchanged is which document is on which item, and that is what the run claimed.
    const { report, pipeline } = await twoDocuments();
    const rows = library.db
      .select({ id: schema.attachments.id, documentId: schema.attachments.documentId })
      .from(schema.attachments)
      .all();
    expect(rows).toHaveLength(2);

    library.db
      .update(schema.attachments)
      .set({ documentId: rows[1]!.documentId })
      .where(eq(schema.attachments.id, rows[0]!.id))
      .run();
    library.db
      .update(schema.attachments)
      .set({ documentId: rows[0]!.documentId })
      .where(eq(schema.attachments.id, rows[1]!.id))
      .run();

    const verification = reverify(pipeline, report);
    const cardinality = verification.checks.filter((check) =>
      ['documents_filed_once', 'items_created_exist', 'documents_present'].includes(check.id),
    );
    // The point of the test: every count-based check is still green.
    expect(cardinality.every((check) => check.ok)).toBe(true);
    // And the correspondence check is not.
    expect(verification.pass).toBe(false);
    expect(verification.checks.find((c) => c.id === 'items_hold_the_documents_named')?.ok).toBe(false);
    expect(verification.queried.filedPairsHeld).toBe(0);
  });

  it('fails when two documents are given each other’s digests', async () => {
    const { report, pipeline } = await twoDocuments();
    const rows = library.db
      .select({ id: schema.documents.id, sha256: schema.documents.sha256 })
      .from(schema.documents)
      .all();
    expect(rows).toHaveLength(2);

    library.db
      .update(schema.documents)
      .set({ sha256: 'f'.repeat(64) })
      .where(eq(schema.documents.id, rows[0]!.id))
      .run();
    library.db
      .update(schema.documents)
      .set({ sha256: rows[0]!.sha256 })
      .where(eq(schema.documents.id, rows[1]!.id))
      .run();

    const verification = reverify(pipeline, report);
    expect(verification.checks.find((c) => c.id === 'documents_present')?.ok).toBe(true);
    expect(verification.pass).toBe(false);
    expect(verification.checks.find((c) => c.id === 'documents_hold_the_bytes_named')?.ok).toBe(false);
  });

  it('cannot be made to compare zero with zero by narrating an empty document set', async () => {
    // The floor, isolated.
    //
    // Nine of `verifyRun`'s queries are addressed by `documentIds` — the set the *run* hands in —
    // and every one of them short-circuits to a literal 0 when that set is empty. So a run whose
    // outcomes name two documents, handed in with an empty set and with the documents themselves
    // gone from the library, makes every count-based check compare zero with zero. That is
    // ADR-0021 §2 one level up: a filter on the target side redefining the source side, and it is
    // the shape the re-attack found passing a Paperless report over a library holding nothing.
    //
    // The digest check reads its source side from the outcomes instead, so it is the one that
    // still has something to compare.
    const { report, pipeline } = await twoDocuments();
    library.db.delete(schema.attachments).run();
    library.db.delete(schema.documentProvenance).run();
    library.db.delete(schema.documents).run();

    const verification = pipeline.verifyRun(
      report.runId,
      { ingested: 0, duplicates: 0, review: 0, containers: 0, stopped: 0, failed: 0 },
      new Set<string>(),
      report.outcomes.map((entry) => entry.outcome),
    );

    // Every check addressed by the empty set is green, which is the point.
    for (const id of ['documents_present', 'arrivals_recorded', 'documents_filed_once']) {
      expect(verification.checks.find((check) => check.id === id)?.ok).toBe(true);
    }
    // And the verdict is still a failure, because two documents were named and none of them holds
    // the bytes the run said it filed.
    expect(verification.pass).toBe(false);
    const floor = verification.checks.find((c) => c.id === 'documents_hold_the_bytes_named');
    expect(floor?.ok).toBe(false);
    expect(floor?.detail).toContain('name 2 document(s)');
    expect(verification.queried.digestsAgreeing).toBe(0);
  });

  it('does not fail a run that legitimately named nothing', async () => {
    // The other half of a floor: it must not turn an empty run into a failure. A run over no
    // candidates has nothing to show and says so.
    const pipeline = new IngestPipeline({
      recueil: library,
      config: { scratchRoot: library.root, ocrEnabled: false },
    });
    const report = await pipeline.run([], { runLabel: 'empty', sourceId: 'none' });
    expect(report.verification.pass).toBe(true);
  });
});

/* -- P-TOCTOU: the gap between the scan's check and the pipeline's read ----------------------- */

describe('a folder candidate reads the file it checked (sources/local.ts)', () => {
  it('refuses a name that has become a symbolic link since the scan', async () => {
    // Unnamed by any reviewer. `folderCandidates` resolves every entry with `realpath` and checks
    // containment — at scan time. `read()` happens later, by which time the name can mean
    // something else, and it did: the read returned a file outside the watched root verbatim.
    const watched = makeTempDir('recueil-toctou-watched-');
    const outside = makeTempDir('recueil-toctou-outside-');
    try {
      const secret = join(outside.path, 'secret.txt');
      writeFileSync(secret, 'SECRET-OUTSIDE-THE-WATCHED-ROOT\n');
      const watchedFile = join(watched.path, 'scan.pdf');
      writeFileSync(watchedFile, '%PDF-1.4 the file the scan checked\n');

      const scan = await folderCandidates(watched.path);
      expect(scan.candidates).toHaveLength(1);

      // The gap.
      unlinkSync(watchedFile);
      symlinkSync(secret, watchedFile);

      await expect(scan.candidates[0]!.read()).rejects.toThrow(SourceFileChangedError);
      await expect(scan.candidates[0]!.read()).rejects.toThrow(/symbolic link/u);
    } finally {
      watched.dispose();
      outside.dispose();
    }
  });

  it('refuses a different file put at the same name since the scan', async () => {
    // The other spelling: not a link, just a different file. Metadata can be made to agree — the
    // replacement below is the same length — so the check is over the inode.
    const watched = makeTempDir('recueil-toctou-swap-');
    try {
      const path = join(watched.path, 'scan.pdf');
      writeFileSync(path, 'AAAAAAAAAA');
      const scan = await folderCandidates(watched.path);

      unlinkSync(path);
      writeFileSync(path, 'BBBBBBBBBB');

      await expect(scan.candidates[0]!.read()).rejects.toThrow(/different file/u);
    } finally {
      watched.dispose();
    }
  });

  it('bounds the read by the descriptor’s size, not by the scan’s', async () => {
    // `maxBytes` was compared against `stat().size` at scan time and the read was an unbounded
    // `readFile`, so a 100-byte file that grew to 4 MiB in between was read whole. Measured before
    // the fix: `maxBytes 1024, read() returned 4194304 bytes`.
    const watched = makeTempDir('recueil-toctou-size-');
    try {
      const path = join(watched.path, 'small.pdf');
      writeFileSync(path, 'x'.repeat(100));
      const scan = await folderCandidates(watched.path, { maxBytes: 1024 });
      expect(scan.candidates).toHaveLength(1);

      // Grown in place: same inode, so the identity check passes and the size check is the one
      // that has to bite.
      writeFileSync(path, 'y'.repeat(4 * MIB));

      await expect(scan.candidates[0]!.read()).rejects.toThrow(/folder\.maxBytes/u);
    } finally {
      watched.dispose();
    }
  });

  it('still reads an ordinary file that nobody touched', async () => {
    const watched = makeTempDir('recueil-toctou-plain-');
    try {
      writeFileSync(join(watched.path, 'scan.pdf'), '%PDF-1.4 quiet\n');
      const scan = await folderCandidates(watched.path, { maxBytes: MIB });
      const bytes = await scan.candidates[0]!.read();
      expect(bytes.toString()).toBe('%PDF-1.4 quiet\n');
    } finally {
      watched.dispose();
    }
  });
});

/* -- P-REGEX and P-BUDGET on the extracted-text path ------------------------------------------ */

describe('the office heuristics are bounded (metadata/office.ts, text/simhash.ts)', () => {
  it('reads an envelope sender in linear time', async () => {
    // Unnamed by any reviewer. `readSender` matched `/^\s*"?([^"<]+?)"?\s*<[^>]+>\s*$/u` against the
    // `From:` header: the lazy group followed by `\s*<` backtracks quadratically on a value that has
    // no `<` in it, once per starting length, and the whitespace run is what pays for each attempt.
    // The run has to be *internal*, because `pickString` trims — measured through the extractor at
    // 0.10 s for 8 000, 0.39 s for 16 000 and 1.57 s for 32 000, from a header a stranger wrote,
    // against an `eml.maxHeaderBytes` ceiling of a mebibyte.
    const extractor = new OfficeHeuristicExtractor();
    const time = async (spaces: number): Promise<number> => {
      const started = process.hrtime.bigint();
      await extractor.extract({
        bytes: Buffer.alloc(0),
        mediaType: 'application/pdf',
        sha256: 'b'.repeat(64),
        detectedType: 'office_document',
        text: 'Invoice\nTotal due 10,00 EUR\n',
        sourceMetadata: { from: `a${' '.repeat(spaces)}b` },
      });
      return Number(process.hrtime.bigint() - started) / 1e6;
    };

    await time(1_000); // warm
    const small = await time(8_000);
    const large = await time(32_000);
    expect(large).toBeLessThan(Math.max(small, 1) * 8);
    expect(large).toBeLessThan(500);
  });

  it('still splits a display name from its address', async () => {
    // The bound must not cost the feature; this is the case the pattern existed for.
    const extractor = new OfficeHeuristicExtractor();
    const result = await extractor.extract({
      bytes: Buffer.alloc(0),
      mediaType: 'application/pdf',
      sha256: 'b'.repeat(64),
      detectedType: 'office_document',
      text: 'Invoice\n',
      sourceMetadata: { from: 'Stadtwerke Ulm <billing@swu.example>' },
    });
    expect(result.fields['office.correspondent']?.value).toBe('Stadtwerke Ulm');

    const quoted = await extractor.extract({
      bytes: Buffer.alloc(0),
      mediaType: 'application/pdf',
      sha256: 'b'.repeat(64),
      detectedType: 'office_document',
      text: 'Invoice\n',
      sourceMetadata: { from: '"Finanzamt, Ulm" <post@fa.example>' },
    });
    expect(quoted.fields['office.correspondent']?.value).toBe('Finanzamt, Ulm');

    const bare = await extractor.extract({
      bytes: Buffer.alloc(0),
      mediaType: 'application/pdf',
      sha256: 'b'.repeat(64),
      detectedType: 'office_document',
      text: 'Invoice\n',
      sourceMetadata: { from: 'billing@swu.example' },
    });
    expect(bare.fields['office.correspondent']?.value).toBe('billing@swu.example');
  });

  it('computes the blocking key over a bounded prefix', () => {
    // One SHA-1 per three-word shingle, plus a map of every distinct shingle, over however much
    // text the extractor produced: 4 MB cost 2.76 s, 16 MB 11.33 s and 64 MB 52.92 s with +260 MB
    // of resident memory, synchronously, with no bound at all. `pdf.maxTotalOutputBytes` permits
    // 128 MiB of inflated stream text, so the input is reachable.
    const word = (index: number): string => `w${index.toString(36)}`;
    const build = (chars: number): string => {
      const parts: string[] = [];
      let length = 0;
      for (let index = 0; length < chars; index += 1) {
        parts.push(word(index));
        length += 8;
      }
      return parts.join(' ');
    };

    const time = (text: string): number => {
      const started = process.hrtime.bigint();
      simhash(text);
      return Number(process.hrtime.bigint() - started) / 1e6;
    };

    simhash(build(1 * MIB)); // warm
    const atLimit = time(build(4 * MIB));
    const wellPast = time(build(16 * MIB));

    // Four times the input for no more than twice the work: the prefix is the bound, and the
    // remainder is only the cost of slicing it. Unbounded, this ratio is four.
    expect(wellPast).toBeLessThan(Math.max(atLimit, 1) * 2);

    // And it is still a usable key: two documents sharing a prefix that long are near-duplicates,
    // which is what a blocking key is for.
    expect(simhash('Rechnung Stadtwerke Ulm Betrag 10 EUR')).toHaveLength(16);
    expect(simhash('x', 4)).toBeNull();
  });
});

/* -- P-BUDGET: the third budget with no caller ------------------------------------------------ */

/**
 * An extractor that always throws.
 *
 * The point is not the failure: it is that `CandidateJournal.compact()` deletes every intermediate
 * checkpoint the moment a candidate commits, so a checkpoint's contents can only be inspected for a
 * candidate that did not get that far. A stage-6 throw is the least invasive way to arrange it.
 */
class ThrowingExtractor implements MetadataExtractor {
  readonly id = 'throws';

  supports(): boolean {
    return true;
  }

  async extract(): Promise<never> {
    throw new Error('this extractor exists to fail');
  }
}

const checkpointRow = (library: TestLibrary, stage: string): { text: string | null; textOmitted?: number; raw: string } | null => {
  const row = library.connection
    .prepare('select payload from ingest_checkpoints where stage = ?')
    .get(stage) as { payload: string } | undefined;
  if (row === undefined) return null;
  return { ...(JSON.parse(row.payload) as { text: string | null; textOmitted?: number }), raw: row.payload };
};

describe('maxCheckpointTextBytes is enforced (config.ts, pipeline.ts)', () => {
  it('summarises the checkpoint instead of storing the whole text', async () => {
    // `maxCheckpointTextBytes` was documented — "above this, extracted text is summarised in the
    // checkpoint rather than stored whole" — and had no reader anywhere in the tree. Meanwhile the
    // extracted text was JSON-encoded into a `checkpoints` row at whatever size the extractor
    // produced. This is the `BudgetLedger.child()` shape again: a budget nothing calls.
    const library = makeLibrary();
    try {
      const long = Array.from({ length: 4_000 }, (_, index) => `Rechnung Zeile ${String(index)}`);
      const pdf = makePdf({ lines: long });

      const pipeline = new IngestPipeline({
        recueil: library,
        config: {
          scratchRoot: library.root,
          ocrEnabled: false,
          maxCheckpointTextBytes: 512,
          maxAttemptsPerCandidate: 1,
        },
        extractors: [new ThrowingExtractor()],
      });
      await pipeline.ingestOne(bufferCandidate(pdf, { filename: 'long.pdf' }), {
        runLabel: 'checkpoint-budget',
      });

      const payload = checkpointRow(library, 'type_detection');
      expect(payload).not.toBeNull();

      // Summarised: the row records how much text there was and does not carry it.
      expect(payload?.text).toBeNull();
      expect(payload?.textOmitted).toBeGreaterThan(512);
      // And the row itself is small, which is the property the budget exists for.
      expect(payload?.raw.length).toBeLessThan(2_048);
    } finally {
      library.dispose();
    }
  });

  it('stores the text whole when it is inside the ceiling', async () => {
    const library = makeLibrary();
    try {
      const pipeline = new IngestPipeline({
        recueil: library,
        config: { scratchRoot: library.root, ocrEnabled: false, maxAttemptsPerCandidate: 1 },
        extractors: [new ThrowingExtractor()],
      });
      await pipeline.ingestOne(
        bufferCandidate(makePdf({ lines: ['Rechnung Stadtwerke Ulm'] }), { filename: 'short.pdf' }),
        { runLabel: 'checkpoint-budget-ok' },
      );

      const payload = checkpointRow(library, 'type_detection');
      expect(payload?.textOmitted).toBeUndefined();
      expect(payload?.text).toContain('Rechnung Stadtwerke Ulm');
    } finally {
      library.dispose();
    }
  });
});
