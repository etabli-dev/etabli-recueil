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
 */
import { inflateSync } from 'node:zlib';

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

/** Pull whatever text this reader can reach out of a PDF held in memory. */
export const extractPdfText = (bytes: Buffer): PdfTextResult => {
  const chunks: string[] = [];
  let streamsFound = 0;
  let streamsRead = 0;
  let sawFlate = false;
  let sawOtherFilter = false;

  for (const stream of findStreams(bytes)) {
    streamsFound += 1;
    const { dictionary, data } = stream;
    const filter = readFilter(dictionary);
    let payload: Buffer;
    if (filter === null) {
      payload = data;
    } else if (filter === 'FlateDecode') {
      sawFlate = true;
      try {
        payload = inflateSync(data);
      } catch {
        continue;
      }
    } else {
      sawOtherFilter = true;
      continue;
    }
    streamsRead += 1;
    const text = readShownText(payload.toString('latin1'));
    if (text.length > 0) chunks.push(text);
  }

  const text = normaliseWhitespace(chunks.join('\n'));
  const pageCount = countPages(bytes);

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

interface RawStream {
  dictionary: string;
  data: Buffer;
}

function* findStreams(bytes: Buffer): Generator<RawStream> {
  const latin = bytes.toString('latin1');
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

    const dictionaryStart = latin.lastIndexOf('<<', match.index);
    const dictionary = dictionaryStart === -1 ? '' : latin.slice(dictionaryStart, match.index);

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

const countPages = (bytes: Buffer): number | null => {
  const latin = bytes.toString('latin1');
  const counts = [...latin.matchAll(/\/Type\s*\/Pages[^>]*?\/Count\s+(\d+)/gu)]
    .map((match) => Number.parseInt(match[1] ?? '', 10))
    .filter((value) => Number.isInteger(value));
  if (counts.length > 0) return Math.max(...counts);
  const pages = [...latin.matchAll(/\/Type\s*\/Page[^s]/gu)].length;
  return pages > 0 ? pages : null;
};

const normaliseWhitespace = (text: string): string =>
  text
    .replace(/\r\n?/gu, '\n')
    .replace(/[ \t]+/gu, ' ')
    .replace(/ *\n */gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
