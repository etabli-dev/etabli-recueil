/**
 * Reading the text layer of a PDF, and being honest about how far that goes.
 *
 * Stage 5 needs one question answered before it can decide anything: does this PDF already carry
 * text, or is it a picture of a page? Answering it properly — glyph by glyph, through the font's
 * encoding, its `ToUnicode` CMap and its widths — is what PDF.js is for, and PDF.js is a Phase 4
 * dependency of the reader, not of the ingester.
 *
 * So this module does the narrow thing it can do correctly: it walks the file's stream objects,
 * inflates the `FlateDecode` ones, and pulls the operands of the text-showing operators (`Tj`,
 * `TJ`, `'`, `"`) out of the content streams. For a PDF whose fonts use a standard single-byte
 * encoding — which is what LaTeX, Word, Quarto and every browser's "print to PDF" produce for Latin
 * text — that is the text. For a PDF using a CID font, a subset font with a custom encoding, or a
 * `ToUnicode` map, it returns fewer characters than the page shows, and it can return mojibake.
 *
 * That limitation is stated rather than hidden, and it is the reason the return value carries
 * `confidence` alongside the text. The pipeline uses the character count for the OCR gate, where
 * "did anything come out at all" is the question and a conservative under-read costs one
 * unnecessary OCR pass; it does not present this text as an authoritative extraction. When a
 * `TextExtractor` with PDF.js behind it is registered, that one wins.
 *
 * ## The budget
 *
 * This function runs synchronously on whatever loop calls it, over a file that arrived from a
 * stranger's mailbox, and `FlateDecode` is an unbounded amplifier: the Phase 2 review built a
 * 299 KB PDF that added 914 MB of resident memory here and a 1.94 MB one that held the event loop
 * for forty seconds. Neither needed a malformed file — that is what a well-formed PDF is allowed
 * to contain.
 *
 * So every inflate carries `maxOutputLength`, the streams share an accumulated ceiling, the stream
 * count and the input size are capped, and there is a wall clock across the whole call
 * (ADR-0022 §2, §3, §5). The defaults are `DEFAULT_PDF_BUDGET`; exceeding one raises a
 * `ResourceBudgetError`, which is an `IngestError`, which the pipeline routes to the review queue
 * with the reason rather than crashing or silently returning no text (P3).
 *
 * **Across the whole call means across the whole call.** The hardening re-attack found the clock
 * covering only the stream loop while `countPages` ran after it, outside every budget, on a lazy
 * `[^>]*?` that re-scanned to the end of the file for every `/Type /Pages` marker that was not
 * followed by a `>`. A PDF with no streams at all skipped the loop, so no deadline check ran at
 * all, and the function *returned normally*: 8 MiB cost 42 s and reported `ok`. Three things
 * answer it, and all three are needed. The deadline is read again after the loop and inside the
 * page scan, so the clock is a property of the call rather than of one loop. Every span this
 * module matches lazily is written with an explicit repetition ceiling, so no single match attempt
 * can walk the rest of the file. And the `latin1` copy is made once and handed to both readers,
 * rather than each making its own — two full-length copies of a permitted 128 MiB input is a
 * budget being spent twice for one file.
 */
import { inflateSync } from 'node:zlib';

import { DEFAULT_PDF_BUDGET, BudgetLedger, ResourceBudgetError } from '../budgets.js';
import type { PdfBudget } from '../budgets.js';

export interface PdfTextResult {
  text: string;
  /** How many content streams were readable, over how many were found. */
  streamsRead: number;
  streamsFound: number;
  /** Pages counted from the page tree, when the count could be read. */
  pageCount: number | null;
  /** 0..1: this extractor's own belief that what it returned is what the page says. */
  confidence: number;
}

const STREAM_START = /stream\r?\n/gu;

/**
 * Pull whatever text this reader can reach out of a PDF held in memory.
 *
 * `budget` defaults to the conservative one rather than to "no limit", because a caller that
 * forgets to pass one is precisely the failure this parameter exists to prevent.
 *
 * @throws {ResourceBudgetError} when the file, a stream, the accumulated output, the stream count
 *   or the elapsed time passes its ceiling. The message names the limit.
 */
export const extractPdfText = (bytes: Buffer, budget: PdfBudget = DEFAULT_PDF_BUDGET): PdfTextResult => {
  // The declared `/Length` of each stream is not consulted for any of this: it is the file's own
  // claim about itself. What is consulted is the size of the file actually in hand, which is the
  // one number here that no one can lie about.
  if (bytes.length > budget.maxInputBytes) {
    throw new ResourceBudgetError(
      'pdf.maxInputBytes',
      budget.maxInputBytes,
      `The PDF is ${bytes.length} bytes, over the pdf.maxInputBytes budget of ` +
        `${budget.maxInputBytes}. It was refused before any stream was inflated.`,
      { byteSize: bytes.length },
    );
  }

  const deadline = Date.now() + budget.maxMillis;
  const ledger = new BudgetLedger(budget.maxTotalOutputBytes, 'pdf.maxTotalOutputBytes');
  // One `latin1` copy for the whole call. `findStreams` and the page scan both need the file as a
  // string; making it twice doubled the peak for every PDF the reader accepted.
  const latin = bytes.toString('latin1');
  const chunks: string[] = [];
  let streamsFound = 0;
  let streamsRead = 0;
  let sawFlate = false;
  let sawOtherFilter = false;

  for (const stream of findStreams(bytes, latin)) {
    streamsFound += 1;
    if (streamsFound > budget.maxStreams) {
      throw new ResourceBudgetError(
        'pdf.maxStreams',
        budget.maxStreams,
        `The PDF holds more than ${budget.maxStreams} streams, which is the pdf.maxStreams budget.`,
        { streamsFound },
      );
    }
    if (Date.now() > deadline) {
      throw new ResourceBudgetError(
        'pdf.maxMillis',
        budget.maxMillis,
        `Reading the PDF passed the pdf.maxMillis budget of ${budget.maxMillis} ms after ` +
          `${streamsRead} of ${streamsFound} streams.`,
        { streamsRead, streamsFound },
      );
    }

    const { dictionary, data } = stream;
    const filter = readFilter(dictionary);
    let payload: Buffer;
    if (filter === null) {
      // An unfiltered stream cannot expand, so its own length is its output length; it still
      // spends from the accumulated ledger, because a thousand of them add up.
      if (data.length > ledger.allowance(budget.maxStreamOutputBytes)) {
        throw streamTooBig(streamsFound, data.length, ledger, budget);
      }
      payload = data;
    } else if (filter === 'FlateDecode') {
      sawFlate = true;
      // The allowance, not the per-stream limit: one stream may never produce more than the file
      // as a whole still has left to spend (ADR-0022 §3).
      const allowance = ledger.allowance(budget.maxStreamOutputBytes);
      try {
        payload = inflateSync(data, { maxOutputLength: allowance });
      } catch (error) {
        // A stream that will not inflate is a stream this reader skips, exactly as before. A
        // stream that inflates *past its allowance* is the bomb, and that is a refusal, not a skip:
        // a silent skip here would let a hostile file spend the budget and look like a scan.
        if (isOutputTooLarge(error)) throw streamTooBig(streamsFound, null, ledger, budget);
        continue;
      }
    } else {
      sawOtherFilter = true;
      continue;
    }
    if (!ledger.spend(payload.length)) {
      throw new ResourceBudgetError(
        'pdf.maxTotalOutputBytes',
        budget.maxTotalOutputBytes,
        `The PDF's streams have produced ${ledger.spent} bytes, over the ` +
          `pdf.maxTotalOutputBytes budget of ${budget.maxTotalOutputBytes}.`,
        { streamsRead, streamsFound },
      );
    }
    streamsRead += 1;
    const text = readShownText(payload.toString('latin1'));
    if (text.length > 0) chunks.push(text);
  }

  const text = normaliseWhitespace(chunks.join('\n'));

  // Read the clock again here rather than only at the top of the loop. A PDF with zero streams
  // never entered the loop, so without this line a file that costs nothing to inflate and
  // everything to scan is a file no deadline was ever checked against.
  //
  // `>=` rather than `>`: a deadline that has been reached has been spent, and the difference
  // makes a budget of zero milliseconds mean what it says instead of meaning "one tick".
  if (Date.now() >= deadline) {
    throw new ResourceBudgetError(
      'pdf.maxMillis',
      budget.maxMillis,
      `Reading the PDF passed the pdf.maxMillis budget of ${budget.maxMillis} ms after ` +
        `${streamsRead} of ${streamsFound} streams, before the page count was read.`,
      { streamsRead, streamsFound },
    );
  }
  const pageCount = countPages(latin, deadline, budget);

  // A file whose streams all inflated and produced text is one this reader probably read; a file
  // with filters it does not implement is one it certainly did not.
  const confidence =
    streamsFound === 0
      ? 0
      : sawOtherFilter
        ? 0.3
        : text.length === 0
          ? 0.4
          : sawFlate
            ? 0.7
            : 0.75;

  return { text, streamsRead, streamsFound, pageCount, confidence };
};

/**
 * The refusal for a stream that produced, or would have produced, more than it was allowed.
 *
 * It names whichever of the two ceilings actually bit — the per-stream one, or what was left of
 * the accumulated one — because "over budget" without the number is not something an operator can
 * raise.
 */
const streamTooBig = (
  streamIndex: number,
  produced: number | null,
  ledger: BudgetLedger,
  budget: PdfBudget,
): ResourceBudgetError => {
  const allowance = ledger.allowance(budget.maxStreamOutputBytes);
  const hitAccumulated = allowance < budget.maxStreamOutputBytes;
  const limitName = hitAccumulated ? 'pdf.maxTotalOutputBytes' : 'pdf.maxStreamOutputBytes';
  const limit = hitAccumulated ? budget.maxTotalOutputBytes : budget.maxStreamOutputBytes;
  return new ResourceBudgetError(
    limitName,
    limit,
    `Stream ${streamIndex} of the PDF ` +
      (produced === null ? 'inflates past' : `holds ${produced} bytes, past`) +
      ` its allowance of ${allowance} bytes (${limitName} is ${limit}). The inflate was stopped ` +
      'at the budget rather than measured after it.',
    { streamIndex, allowance, spent: ledger.spent },
  );
};

/**
 * Did `node:zlib` stop because the output ran past `maxOutputLength`?
 *
 * It reports that as `ERR_BUFFER_TOO_LARGE`, which is also what an unbounded inflate throws on a
 * payload past `buffer.kMaxLength`. Both mean the stream produced more than it was allowed.
 */
const isOutputTooLarge = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  (error as { code?: unknown }).code === 'ERR_BUFFER_TOO_LARGE';

interface RawStream {
  dictionary: string;
  data: Buffer;
}

/**
 * How far back of a `stream` keyword the reader will look for its dictionary.
 *
 * `lastIndexOf('<<', here)` with no floor walks to byte 0 when the file holds no `<<` at all, and
 * it does that once per stream: 500 streams behind an 8 MiB prefix cost 4.65 s, and the only thing
 * that stopped 2 000 streams behind 32 MiB was the wall clock firing at 15 s. The dictionary of a
 * stream object sits immediately before it by construction — `<< … >>\nstream` — so a window is
 * not a heuristic here, it is the format. Sixty-four kilobytes is far more than any real stream
 * dictionary and turns a quadratic into a constant per stream.
 */
const DICTIONARY_LOOKBEHIND = 64 * 1024;

function* findStreams(bytes: Buffer, latin: string): Generator<RawStream> {
  STREAM_START.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = STREAM_START.exec(latin)) !== null) {
    const dataStart = match.index + match[0].length;
    const endIndex = latin.indexOf('endstream', dataStart);
    if (endIndex === -1) return;
    // Back up over the EOL that precedes `endstream`, which is not part of the data.
    let dataEnd = endIndex;
    if (latin[dataEnd - 1] === '\n') dataEnd -= 1;
    if (latin[dataEnd - 1] === '\r') dataEnd -= 1;

    const floor = Math.max(0, match.index - DICTIONARY_LOOKBEHIND);
    const window = latin.slice(floor, match.index);
    const relative = window.lastIndexOf('<<');
    const dictionary = relative === -1 ? '' : window.slice(relative);

    yield { dictionary, data: bytes.subarray(dataStart, dataEnd) };
    STREAM_START.lastIndex = endIndex + 'endstream'.length;
  }
}

const readFilter = (dictionary: string): string | null => {
  const match = /\/Filter\s*\/?\s*([A-Za-z0-9]+)/u.exec(dictionary);
  if (match === null) return null;
  return match[1] ?? null;
};

/**
 * Pull the operands of the text-showing operators out of one content stream.
 *
 * A small state machine rather than a regular expression, because PDF string literals nest
 * parentheses and use backslash escapes, and a regular expression that gets that right is a
 * regular expression nobody can read.
 */
const readShownText = (content: string): string => {
  const out: string[] = [];
  let index = 0;
  let pending: string[] = [];

  const flush = (separator: string): void => {
    if (pending.length === 0) return;
    out.push(pending.join('') + separator);
    pending = [];
  };

  while (index < content.length) {
    const char = content[index] as string;

    if (char === '(') {
      const { value, next } = readLiteralString(content, index);
      pending.push(value);
      index = next;
      continue;
    }
    if (char === '<' && content[index + 1] !== '<') {
      const close = content.indexOf('>', index);
      if (close === -1) break;
      pending.push(decodeHexString(content.slice(index + 1, close)));
      index = close + 1;
      continue;
    }
    // `T*`, `Td`, `TD` and `'`/`"` all move to a new line; `ET` ends a text object.
    if (
      content.startsWith('T*', index) ||
      content.startsWith('Td', index) ||
      content.startsWith('TD', index) ||
      content.startsWith('ET', index)
    ) {
      flush('\n');
      index += 2;
      continue;
    }
    if (char === "'" || char === '"') {
      flush('\n');
      index += 1;
      continue;
    }
    index += 1;
  }
  flush('\n');
  return out.join('');
};

const readLiteralString = (content: string, start: number): { value: string; next: number } => {
  let depth = 0;
  let index = start;
  const out: string[] = [];

  while (index < content.length) {
    const char = content[index] as string;
    if (char === '\\') {
      const escaped = content[index + 1];
      index += 2;
      switch (escaped) {
        case 'n':
          out.push('\n');
          break;
        case 'r':
          out.push('\r');
          break;
        case 't':
          out.push('\t');
          break;
        case 'b':
        case 'f':
          out.push(' ');
          break;
        case '(':
        case ')':
        case '\\':
          out.push(escaped);
          break;
        case '\n':
          break;
        case '\r':
          if (content[index] === '\n') index += 1;
          break;
        default: {
          if (escaped !== undefined && escaped >= '0' && escaped <= '7') {
            let digits = escaped;
            while (digits.length < 3) {
              const next = content[index];
              if (next === undefined || next < '0' || next > '7') break;
              digits += next;
              index += 1;
            }
            out.push(String.fromCharCode(Number.parseInt(digits, 8)));
          } else if (escaped !== undefined) {
            out.push(escaped);
          }
        }
      }
      continue;
    }
    if (char === '(') {
      depth += 1;
      if (depth > 1) out.push(char);
      index += 1;
      continue;
    }
    if (char === ')') {
      depth -= 1;
      index += 1;
      if (depth === 0) break;
      out.push(char);
      continue;
    }
    out.push(char);
    index += 1;
  }

  return { value: out.join(''), next: index };
};

const decodeHexString = (hex: string): string => {
  const digits = hex.replace(/[^0-9a-fA-F]/gu, '');
  const padded = digits.length % 2 === 0 ? digits : digits + '0';
  let out = '';
  for (let index = 0; index < padded.length; index += 2) {
    out += String.fromCharCode(Number.parseInt(padded.slice(index, index + 2), 16));
  }
  return out;
};

/**
 * How far past `/Type /Pages` the `/Count` may sit before this reader stops looking.
 *
 * The unbounded `[^>]*?` this replaces is the whole of the re-attack's CRITICAL: with no `>` after
 * the marker, one lazy span re-scans to the end of the file, once per marker, quadratically, and
 * the caller gets `pageCount: null` and no refusal for it. A page-tree node is a dictionary of a
 * handful of keys, so a ceiling in the low hundreds is the format speaking rather than a guess,
 * and it makes the worst case per starting position a constant instead of the file length.
 */
const PAGES_DICTIONARY_SPAN = 512;

/** Markers examined before the scan gives up on counting rather than keeps paying for it. */
const MAX_PAGE_MARKERS = 65_536;

const PAGES_COUNT = new RegExp(
  String.raw`/Type\s{0,16}/Pages[^>]{0,${String(PAGES_DICTIONARY_SPAN)}}?/Count\s{1,16}(\d{1,10})`,
  'gu',
);

const PAGE_MARKER = /\/Type\s{0,16}\/Page[^s]/gu;

/**
 * The page count, read under the same deadline as everything else in this call.
 *
 * Three bounds rather than one, because each covers a different way the scan can be made
 * expensive: `PAGES_DICTIONARY_SPAN` bounds one match attempt, `MAX_PAGE_MARKERS` bounds how many
 * attempts succeed, and the deadline bounds the wall clock over all of them. The deadline is
 * consulted every `DEADLINE_EVERY` matches rather than every match, because `Date.now()` in the
 * inner loop of a scan over 128 MiB is itself a cost.
 *
 * A page count is a nicety — it feeds the OCR gate's reporting, not a decision — so running out of
 * markers returns what has been seen so far rather than refusing the file. Running out of *time*
 * does refuse, because the clock is the budget the whole call is answerable to and a caller that
 * silently absorbed it would be back where the re-attack found this function.
 */
const countPages = (latin: string, deadline: number, budget: PdfBudget): number | null => {
  const DEADLINE_EVERY = 256;

  const tick = (seen: number, phase: string): void => {
    if (seen % DEADLINE_EVERY !== 0 || Date.now() < deadline) return;
    throw new ResourceBudgetError(
      'pdf.maxMillis',
      budget.maxMillis,
      `Reading the PDF passed the pdf.maxMillis budget of ${budget.maxMillis} ms while ` +
        `${phase} (${seen} marker(s) examined).`,
      { phase, markers: seen },
    );
  };

  let best: number | null = null;
  let seen = 0;
  PAGES_COUNT.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PAGES_COUNT.exec(latin)) !== null) {
    seen += 1;
    const value = Number.parseInt(match[1] ?? '', 10);
    if (Number.isInteger(value) && (best === null || value > best)) best = value;
    if (seen >= MAX_PAGE_MARKERS) break;
    tick(seen, 'counting pages from the page tree');
  }
  if (best !== null) return best;

  let pages = 0;
  PAGE_MARKER.lastIndex = 0;
  while (PAGE_MARKER.exec(latin) !== null) {
    pages += 1;
    if (pages >= MAX_PAGE_MARKERS) break;
    tick(pages, 'counting /Type /Page markers');
  }
  return pages > 0 ? pages : null;
};

const normaliseWhitespace = (text: string): string =>
  text
    .replace(/\r\n?/gu, '\n')
    .replace(/[ \t]+/gu, ' ')
    .replace(/ *\n */gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
