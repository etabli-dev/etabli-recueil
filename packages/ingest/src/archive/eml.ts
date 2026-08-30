/**
 * Enough RFC 5322 and MIME for the mail path of CONCEPT §5.3.
 *
 * The concept sentence is "IMAP mailbox (attachments as Documents, body as Note, rules by
 * sender/subject)", and it fixes what this parser has to produce: the envelope fields the rule
 * engine matches on, the body the commit turns into a Note, and each attachment as a member that
 * re-enters the pipeline at stage 1 with its own hash and its own provenance.
 *
 * Written by hand rather than taken from a mail library because the surface needed is small and
 * because a mail parser is a parser of hostile input in the most literal sense: a `.eml` arriving
 * from a watched folder is something a stranger composed. Nothing here writes a file and nothing
 * here trusts a filename.
 *
 * ## The budget
 *
 * The sentence that used to sit here — "every part is bounded by the caller's limits before it is
 * decoded" — was the reverse of what happened, and both the Phase 2 review and the re-attack said
 * so: `parseEmail(raw)` took no limits argument, had no access to `IngestConfig`, and decoded the
 * whole MIME tree before `extract.ts` made its first size comparison. A 24 MB quoted-printable
 * message decoded 8.8 MB and moved resident memory by 166 MB; a 16.6 MB message built two hundred
 * thousand `EmailPart`s before the entry limit was consulted.
 *
 * So `parseEmail` now takes an `EmailBudget` and the sentence is true (ADR-0022 §2):
 *
 *   - The raw message and the header block are refused by size before anything is read.
 *   - Parts are counted **as they are built**, so the two-hundred-thousandth is never allocated.
 *   - Each decode is handed an allowance — the smaller of the per-part ceiling and what the whole
 *     message has left — and *the decode enforces it*, rather than the length being compared after
 *     the buffer exists. Quoted-printable writes into a `Buffer` sized to that allowance instead of
 *     accumulating into a `number[]` at eight bytes a byte, which is where the 6.9x came from.
 *   - Base64 and the identity encodings are refused from the length of the bytes in hand, which is
 *     the one number about the input that nobody can lie about.
 *
 * Exceeding one raises a `ResourceBudgetError`, which the pipeline routes to the review queue with
 * the reason rather than crashing or silently truncating (P3, ADR-0022 §6).
 *
 * Deliberately absent: S/MIME and PGP (encrypted or signed payloads are passed through as the
 * attachments they are, unverified and marked so) and `message/partial` reassembly. RFC 2231
 * continued and extended parameters *are* assembled — see `assembleParameters`.
 */
import { BudgetLedger, DEFAULT_EMAIL_BUDGET, ResourceBudgetError } from '../budgets.js';
import type { EmailBudget } from '../budgets.js';
import { ArchiveFormatError } from '../errors.js';

export interface EmailPart {
  /** As declared in `Content-Disposition` or `Content-Type`. Informational; never used as a path. */
  filename: string | null;
  mediaType: string;
  disposition: 'attachment' | 'inline' | null;
  contentId: string | null;
  bytes: Buffer;
}

export interface ParsedEmail {
  headers: Record<string, string[]>;
  from: string | null;
  to: string[];
  subject: string | null;
  date: string | null;
  messageId: string | null;
  /** The best plain-text rendering of the message body, or null when there is none. */
  bodyText: string | null;
  /** The HTML body, when the message had one. */
  bodyHtml: string | null;
  /** Everything that is not the body: the Documents of the concept sentence. */
  attachments: EmailPart[];
}

const CRLF = /\r?\n/u;

export const looksLikeEmail = (bytes: Buffer): boolean => {
  const head = bytes.subarray(0, 2048).toString('latin1');
  const firstLine = head.split(CRLF, 1)[0] ?? '';
  if (/^From /u.test(firstLine)) return true;
  // A header block is at least one `Name: value` line before the first blank line.
  const blank = head.search(/\r?\n\r?\n/u);
  const block = blank === -1 ? head : head.slice(0, blank);
  const lines = block.split(CRLF).filter((line) => line.length > 0);
  if (lines.length === 0) return false;
  const named = lines.filter((line) => /^[!-9;-~]+:/u.test(line) || /^[ \t]/u.test(line));
  if (named.length !== lines.length) return false;
  const names = new Set(lines.map((line) => line.split(':', 1)[0]?.toLowerCase() ?? ''));
  return names.has('from') || names.has('subject') || names.has('message-id') || names.has('received');
};

/**
 * Parse a message under an explicit budget.
 *
 * `budget` defaults to the conservative one rather than to "no limit", because a caller that
 * forgets to pass one is precisely the failure this parameter exists to prevent — and for two
 * years there was no parameter to forget.
 *
 * @throws {ResourceBudgetError} when the message, its header block, its part count, one part's
 *   decoded size or the decoded size of all its parts passes a ceiling. The message names the
 *   limit.
 */
export const parseEmail = (raw: Buffer, budget: EmailBudget = DEFAULT_EMAIL_BUDGET): ParsedEmail => {
  if (raw.length > budget.maxInputBytes) {
    throw new ResourceBudgetError(
      'eml.maxInputBytes',
      budget.maxInputBytes,
      `The message is ${raw.length} bytes, over the eml.maxInputBytes budget of ` +
        `${budget.maxInputBytes}. It was refused before any part was decoded.`,
      { byteSize: raw.length },
    );
  }

  const walk: Walk = {
    budget,
    ledger: new BudgetLedger(budget.maxTotalBytes, 'eml.maxTotalBytes'),
    parts: 0,
  };

  const { headers, body } = splitHeaders(raw, budget);
  const contentType = parseContentType(firstHeader(headers, 'content-type') ?? 'text/plain');

  const parts: EmailPart[] = [];
  collectParts(body, headers, contentType, parts, 0, walk);

  let bodyText: string | null = null;
  let bodyHtml: string | null = null;
  const attachments: EmailPart[] = [];

  for (const part of parts) {
    const isBody = part.disposition !== 'attachment' && part.filename === null;
    if (isBody && part.mediaType === 'text/plain' && bodyText === null) {
      bodyText = part.bytes.toString('utf8');
      continue;
    }
    if (isBody && part.mediaType === 'text/html' && bodyHtml === null) {
      bodyHtml = part.bytes.toString('utf8');
      continue;
    }
    attachments.push(part);
  }

  return {
    headers,
    from: firstHeader(headers, 'from'),
    to: splitAddressList(firstHeader(headers, 'to')),
    subject: decodeWords(firstHeader(headers, 'subject')),
    date: firstHeader(headers, 'date'),
    messageId: firstHeader(headers, 'message-id'),
    bodyText,
    bodyHtml,
    attachments,
  };
};

/* ------------------------------------------------------------------------------------------ */
/* Header parsing                                                                               */
/* ------------------------------------------------------------------------------------------ */

const splitHeaders = (
  raw: Buffer,
  budget: EmailBudget,
): { headers: Record<string, string[]>; body: Buffer } => {
  const separator = findHeaderEnd(raw);
  // A message with no blank line anywhere makes `separator.end` the whole buffer, so without this
  // the `latin1` copy and the `split` below are over the entire file. A header block past the
  // ceiling is not a header block.
  if (separator.end > budget.maxHeaderBytes) {
    throw new ResourceBudgetError(
      'eml.maxHeaderBytes',
      budget.maxHeaderBytes,
      `The message's header block is ${separator.end} bytes, over the eml.maxHeaderBytes budget ` +
        `of ${budget.maxHeaderBytes}. A message with no blank line after its headers is the whole ` +
        'file being read as one header.',
      { headerBytes: separator.end },
    );
  }
  const headerText = raw.subarray(0, separator.end).toString('latin1');
  const body = raw.subarray(separator.bodyStart);

  const headers: Record<string, string[]> = {};
  let current: { name: string; value: string } | null = null;

  for (const line of headerText.split(CRLF)) {
    if (line.length === 0) continue;
    if (/^[ \t]/u.test(line) && current !== null) {
      current.value += ' ' + line.trim();
      continue;
    }
    if (current !== null) push(headers, current.name, current.value);
    const colon = line.indexOf(':');
    if (colon === -1) {
      // A `From ` mbox separator, or junk. Neither is a header; skip it rather than guess.
      current = null;
      continue;
    }
    current = { name: line.slice(0, colon).trim().toLowerCase(), value: line.slice(colon + 1).trim() };
  }
  if (current !== null) push(headers, current.name, current.value);

  return { headers, body };
};

const findHeaderEnd = (raw: Buffer): { end: number; bodyStart: number } => {
  for (let index = 0; index + 1 < raw.length; index += 1) {
    if (raw[index] === 0x0a && raw[index + 1] === 0x0a) return { end: index, bodyStart: index + 2 };
    if (
      raw[index] === 0x0d &&
      raw[index + 1] === 0x0a &&
      raw[index + 2] === 0x0d &&
      raw[index + 3] === 0x0a
    ) {
      return { end: index, bodyStart: index + 4 };
    }
  }
  return { end: raw.length, bodyStart: raw.length };
};

const push = (headers: Record<string, string[]>, name: string, value: string): void => {
  const existing = headers[name];
  if (existing === undefined) headers[name] = [value];
  else existing.push(value);
};

const firstHeader = (headers: Record<string, string[]>, name: string): string | null =>
  headers[name]?.[0] ?? null;

interface ContentType {
  mediaType: string;
  parameters: Record<string, string>;
}

/** One `key=value` as it was written, before RFC 2231 assembly. */
interface RawParameter {
  /** The name with any `*n` / `*` suffix still on it, lower-cased. */
  key: string;
  value: string;
}

/** `%C3%A4` and the like, over an octet string that is otherwise ASCII. */
const percentDecode = (value: string): Buffer => {
  const bytes: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (character === '%' && index + 2 < value.length) {
      const hex = value.slice(index + 1, index + 3);
      if (/^[0-9a-f]{2}$/iu.test(hex)) {
        bytes.push(Number.parseInt(hex, 16));
        index += 2;
        continue;
      }
    }
    bytes.push(...Buffer.from(character, 'utf8'));
  }
  return Buffer.from(bytes);
};

/** Decode with the charset the parameter named, falling back to Latin-1 rather than throwing. */
const decodeCharset = (bytes: Buffer, charset: string | null): string => {
  try {
    return new TextDecoder((charset ?? 'utf-8').toLowerCase()).decode(bytes);
  } catch {
    return bytes.toString('latin1');
  }
};

/**
 * Assemble RFC 2231 parameters: `name*`, `name*0`, `name*1*`, …
 *
 * A client that has to write a non-ASCII filename has three spellings to choose from — the single
 * extended form, a numbered continuation, and a numbered continuation where only some segments are
 * extended — and which one it emits depends on which paragraph its author read. All three are in
 * the wild, `fixtures/mail/two-attachments.eml` carries the third, and a parser that handles only
 * the first turns a real filename into `part-2.bin`, which is a document nobody will find again.
 *
 * A plain `name=` is left exactly as it was; only names that were actually split or extended are
 * reassembled, and an extended spelling wins over a plain one for the same name, as RFC 2231 §4
 * requires.
 */
const assembleParameters = (raw: readonly RawParameter[]): Record<string, string> => {
  const parameters: Record<string, string> = {};
  const continued = new Map<string, Array<{ index: number; value: string; extended: boolean }>>();

  for (const { key, value } of raw) {
    const parsed = /^([^*]+)(?:\*(\d+))?(\*)?$/u.exec(key);
    if (parsed === null) {
      parameters[key] = value;
      continue;
    }
    const name = parsed[1]!;
    const extended = parsed[3] === '*';
    if (parsed[2] === undefined && !extended) {
      parameters[name] = value;
      continue;
    }
    const segments = continued.get(name) ?? [];
    segments.push({
      index: parsed[2] === undefined ? 0 : Number.parseInt(parsed[2], 10),
      value,
      extended,
    });
    continued.set(name, segments);
  }

  for (const [name, segments] of continued) {
    segments.sort((left, right) => left.index - right.index);
    let charset: string | null = null;
    let text = '';
    for (const segment of segments) {
      if (!segment.extended) {
        text += segment.value;
        continue;
      }
      let payload = segment.value;
      // Only the first segment carries `charset'language'`; the rest are bare percent-encoding.
      if (charset === null) {
        const parts = payload.split("'");
        if (parts.length >= 3) {
          charset = parts[0]!.length > 0 ? parts[0]! : null;
          payload = parts.slice(2).join("'");
        }
      }
      text += decodeCharset(percentDecode(payload), charset);
    }
    parameters[name] = text;
  }

  return parameters;
};

const parseContentType = (raw: string): ContentType => {
  const [head, ...rest] = raw.split(';');
  const mediaType = (head ?? '').trim().toLowerCase() || 'text/plain';
  const raws: RawParameter[] = [];
  for (const chunk of rest) {
    const equals = chunk.indexOf('=');
    if (equals === -1) continue;
    const key = chunk.slice(0, equals).trim().toLowerCase();
    let value = chunk.slice(equals + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) value = value.slice(1, -1);
    raws.push({ key, value });
  }
  return { mediaType, parameters: assembleParameters(raws) };
};

/* ------------------------------------------------------------------------------------------ */
/* Body walking                                                                                 */
/* ------------------------------------------------------------------------------------------ */

const MAX_MIME_DEPTH = 12;

/** The budget state one `parseEmail` call carries down its MIME tree. */
interface Walk {
  budget: EmailBudget;
  /** Decoded bytes across every part of this message. */
  ledger: BudgetLedger;
  /** Parts built so far, counted before the next one is allocated. */
  parts: number;
}

const collectParts = (
  body: Buffer,
  headers: Record<string, string[]>,
  contentType: ContentType,
  into: EmailPart[],
  depth: number,
  walk: Walk,
): void => {
  if (depth > MAX_MIME_DEPTH) {
    throw new ArchiveFormatError(`The message nests MIME parts more than ${MAX_MIME_DEPTH} deep.`);
  }

  if (contentType.mediaType.startsWith('multipart/')) {
    const boundary = contentType.parameters['boundary'];
    if (boundary === undefined || boundary === '') {
      throw new ArchiveFormatError(`A ${contentType.mediaType} part declares no boundary.`);
    }
    for (const section of splitMultipart(body, boundary)) {
      const { headers: partHeaders, body: partBody } = splitHeaders(section, walk.budget);
      const partType = parseContentType(firstHeader(partHeaders, 'content-type') ?? 'text/plain');
      collectParts(partBody, partHeaders, partType, into, depth + 1, walk);
    }
    return;
  }

  // Counted here, before the part is built, rather than by measuring `attachments.length`
  // afterwards. Two hundred thousand `EmailPart`s cost two hundred thousand buffers whether or not
  // a later check disapproves of them.
  walk.parts += 1;
  if (walk.parts > walk.budget.maxParts) {
    throw new ResourceBudgetError(
      'eml.maxParts',
      walk.budget.maxParts,
      `The message holds more than ${walk.budget.maxParts} MIME parts, which is the eml.maxParts ` +
        'budget. The count was reached while walking the tree, not after building it.',
      { parts: walk.parts },
    );
  }

  const encoding = (firstHeader(headers, 'content-transfer-encoding') ?? '7bit').trim().toLowerCase();
  const disposition = parseContentType(firstHeader(headers, 'content-disposition') ?? '');
  const filename =
    disposition.parameters['filename'] ??
    contentType.parameters['name'] ??
    null;

  const bytes = decodeBody(body, encoding, contentType, walk);
  if (!walk.ledger.spend(bytes.length)) {
    throw new ResourceBudgetError(
      'eml.maxTotalBytes',
      walk.budget.maxTotalBytes,
      `The message's parts have decoded to ${walk.ledger.spent} bytes, over the ` +
        `eml.maxTotalBytes budget of ${walk.budget.maxTotalBytes}.`,
      { parts: walk.parts, decoded: walk.ledger.spent },
    );
  }

  into.push({
    filename: decodeWords(filename),
    mediaType: contentType.mediaType,
    disposition:
      disposition.mediaType === 'attachment'
        ? 'attachment'
        : disposition.mediaType === 'inline'
          ? 'inline'
          : null,
    contentId: firstHeader(headers, 'content-id'),
    bytes,
  });
};

const splitMultipart = (body: Buffer, boundary: string): Buffer[] => {
  const delimiter = Buffer.from(`--${boundary}`, 'latin1');
  const sections: Buffer[] = [];
  let cursor = body.indexOf(delimiter);
  if (cursor === -1) return sections;

  while (cursor !== -1) {
    const afterDelimiter = cursor + delimiter.length;
    if (body.subarray(afterDelimiter, afterDelimiter + 2).toString('latin1') === '--') break;
    const start = skipEol(body, afterDelimiter);
    const next = body.indexOf(delimiter, start);
    const end = next === -1 ? body.length : trimEol(body, next);
    sections.push(body.subarray(start, end));
    cursor = next;
  }
  return sections;
};

const skipEol = (body: Buffer, index: number): number => {
  if (body[index] === 0x0d && body[index + 1] === 0x0a) return index + 2;
  if (body[index] === 0x0a) return index + 1;
  return index;
};

const trimEol = (body: Buffer, index: number): number => {
  let end = index;
  if (end >= 1 && body[end - 1] === 0x0a) end -= 1;
  if (end >= 1 && body[end - 1] === 0x0d) end -= 1;
  return end;
};

/**
 * The refusal for a part that produced, or would have produced, more than it was allowed.
 *
 * It names whichever of the two ceilings actually bit — the per-part one, or what was left of the
 * whole-message one — because "over budget" without the number is not something an operator can
 * raise.
 */
const partTooBig = (
  produced: number,
  allowance: number,
  walk: Walk,
  how: string,
): ResourceBudgetError => {
  const hitTotal = allowance < walk.budget.maxPartBytes;
  const limitName = hitTotal ? 'eml.maxTotalBytes' : 'eml.maxPartBytes';
  const limit = hitTotal ? walk.budget.maxTotalBytes : walk.budget.maxPartBytes;
  return new ResourceBudgetError(
    limitName,
    limit,
    `Part ${walk.parts} of the message ${how} ${produced} bytes, past its allowance of ` +
      `${allowance} (${limitName} is ${limit}). The decode was stopped at the budget rather than ` +
      'measured after it.',
    { part: walk.parts, allowance, spent: walk.ledger.spent },
  );
};

const decodeBody = (
  body: Buffer,
  encoding: string,
  contentType: ContentType,
  walk: Walk,
): Buffer => {
  // The allowance is the composition rule: a part may produce at most its own ceiling, and at most
  // what the message as a whole still has left (ADR-0022 §3).
  const allowance = walk.ledger.allowance(walk.budget.maxPartBytes);

  if (encoding === 'base64') {
    // Three bytes out per four characters in, so the length of the bytes in hand is an upper bound
    // on the output — and unlike a declared size it is a number nobody can lie about. Checking it
    // first means the full-length `latin1` copy and the `replace` are never made for a part that
    // could not be kept anyway.
    const ceiling = Math.ceil((body.length * 3) / 4);
    if (ceiling > allowance) throw partTooBig(ceiling, allowance, walk, 'would decode to up to');
    return Buffer.from(body.toString('latin1').replace(/[^A-Za-z0-9+/=]/gu, ''), 'base64');
  }
  if (encoding === 'quoted-printable') {
    return decodeQuotedPrintable(body, allowance, walk);
  }
  if (body.length > allowance) throw partTooBig(body.length, allowance, walk, 'holds');
  if (contentType.mediaType.startsWith('text/')) {
    const charset = (contentType.parameters['charset'] ?? 'utf-8').toLowerCase();
    if (charset === 'utf-8' || charset === 'utf8' || charset === 'us-ascii' || charset === 'ascii') {
      return Buffer.from(body);
    }
    try {
      return Buffer.from(new TextDecoder(charset).decode(body), 'utf8');
    } catch {
      return Buffer.from(body);
    }
  }
  return Buffer.from(body);
};

/**
 * Decode quoted-printable into a buffer the allowance sizes, one byte at a time.
 *
 * The version this replaces accumulated into a JS `number[]`, which V8 stores at roughly eight
 * bytes per decoded byte: that is where a 24 MB message's 166 MB of resident growth came from, and
 * it happened before any limit was consulted. Quoted-printable never expands — every output byte
 * costs at least one input byte — so `min(body.length, allowance + 1)` is a sound size for the
 * destination, and writing past the allowance is what raises the refusal.
 */
const decodeQuotedPrintable = (body: Buffer, allowance: number, walk: Walk): Buffer => {
  const text = body.toString('latin1');
  const out = Buffer.allocUnsafe(Math.min(text.length, allowance + 1));
  let length = 0;

  const emit = (byte: number): void => {
    if (length >= allowance) throw partTooBig(length + 1, allowance, walk, 'decodes to at least');
    out[length] = byte;
    length += 1;
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] as string;
    if (char !== '=') {
      emit(char.charCodeAt(0));
      continue;
    }
    const next = text.slice(index + 1, index + 3);
    if (next === '\r\n' || next.startsWith('\n')) {
      index += next.startsWith('\r') ? 2 : 1;
      continue;
    }
    if (/^[0-9a-f]{2}$/iu.test(next)) {
      emit(Number.parseInt(next, 16));
      index += 2;
      continue;
    }
    emit(char.charCodeAt(0));
  }
  return Buffer.from(out.subarray(0, length));
};

/* ------------------------------------------------------------------------------------------ */
/* RFC 2047 encoded words                                                                       */
/* ------------------------------------------------------------------------------------------ */

const ENCODED_WORD = /=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/gu;

/** Decode `=?utf-8?B?…?=` runs in a header value. Anything undecodable is left as it stands. */
export const decodeWords = (value: string | null): string | null => {
  if (value === null) return null;
  return value.replace(ENCODED_WORD, (match, charset: string, encoding: string, payload: string) => {
    try {
      const bytes =
        encoding.toLowerCase() === 'b'
          ? Buffer.from(payload, 'base64')
          : decodeEncodedWordQ(payload);
      return new TextDecoder(charset.toLowerCase()).decode(bytes);
    } catch {
      return match;
    }
  });
};

/**
 * The `Q` half of an encoded word, which is quoted-printable over a single header token.
 *
 * It gets its own allowance rather than the part budget: the payload is already in hand and is
 * bounded by `eml.maxHeaderBytes`, so the ceiling here only has to be a real number rather than
 * `Infinity`. `payload.length` is exactly that — quoted-printable cannot expand.
 */
const decodeEncodedWordQ = (payload: string): Buffer => {
  const source = Buffer.from(payload.replace(/_/gu, ' '), 'latin1');
  return decodeQuotedPrintable(source, source.length, {
    budget: DEFAULT_EMAIL_BUDGET,
    ledger: new BudgetLedger(source.length, 'eml.maxPartBytes'),
    parts: 0,
  });
};

const splitAddressList = (value: string | null): string[] => {
  if (value === null) return [];
  return value
    .split(',')
    .map((address) => (decodeWords(address.trim()) ?? '').trim())
    .filter((address) => address.length > 0);
};
