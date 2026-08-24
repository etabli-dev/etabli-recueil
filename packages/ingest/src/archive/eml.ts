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
 * from a watched folder is something a stranger composed. Nothing here writes a file, nothing here
 * trusts a filename, and every part is bounded by the caller's limits before it is decoded.
 *
 * Deliberately absent: S/MIME and PGP (encrypted or signed payloads are passed through as the
 * attachments they are, unverified and marked so) and `message/partial` reassembly. RFC 2231
 * continued and extended parameters *are* assembled — see `assembleParameters`.
 */
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

export const parseEmail = (raw: Buffer): ParsedEmail => {
  const { headers, body } = splitHeaders(raw);
  const contentType = parseContentType(firstHeader(headers, 'content-type') ?? 'text/plain');

  const parts: EmailPart[] = [];
  collectParts(body, headers, contentType, parts, 0);

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

const splitHeaders = (raw: Buffer): { headers: Record<string, string[]>; body: Buffer } => {
  const separator = findHeaderEnd(raw);
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

const collectParts = (
  body: Buffer,
  headers: Record<string, string[]>,
  contentType: ContentType,
  into: EmailPart[],
  depth: number,
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
      const { headers: partHeaders, body: partBody } = splitHeaders(section);
      const partType = parseContentType(firstHeader(partHeaders, 'content-type') ?? 'text/plain');
      collectParts(partBody, partHeaders, partType, into, depth + 1);
    }
    return;
  }

  const encoding = (firstHeader(headers, 'content-transfer-encoding') ?? '7bit').trim().toLowerCase();
  const disposition = parseContentType(firstHeader(headers, 'content-disposition') ?? '');
  const filename =
    disposition.parameters['filename'] ??
    contentType.parameters['name'] ??
    null;

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
    bytes: decodeBody(body, encoding, contentType),
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

const decodeBody = (body: Buffer, encoding: string, contentType: ContentType): Buffer => {
  if (encoding === 'base64') {
    return Buffer.from(body.toString('latin1').replace(/[^A-Za-z0-9+/=]/gu, ''), 'base64');
  }
  if (encoding === 'quoted-printable') {
    return decodeQuotedPrintable(body);
  }
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

const decodeQuotedPrintable = (body: Buffer): Buffer => {
  const text = body.toString('latin1');
  const out: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] as string;
    if (char !== '=') {
      out.push(char.charCodeAt(0));
      continue;
    }
    const next = text.slice(index + 1, index + 3);
    if (next === '\r\n' || next.startsWith('\n')) {
      index += next.startsWith('\r') ? 2 : 1;
      continue;
    }
    if (/^[0-9a-f]{2}$/iu.test(next)) {
      out.push(Number.parseInt(next, 16));
      index += 2;
      continue;
    }
    out.push(char.charCodeAt(0));
  }
  return Buffer.from(out);
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
          : decodeQuotedPrintable(Buffer.from(payload.replace(/_/gu, ' '), 'latin1'));
      return new TextDecoder(charset.toLowerCase()).decode(bytes);
    } catch {
      return match;
    }
  });
};

const splitAddressList = (value: string | null): string[] => {
  if (value === null) return [];
  return value
    .split(',')
    .map((address) => (decodeWords(address.trim()) ?? '').trim())
    .filter((address) => address.length > 0);
};
