/*
 * Recueil — fixtures
 * Copyright (C) 2026 the Recueil authors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Enough of RFC 5322 and RFC 2045 to write the mail corpus by hand, and no more.
 *
 * A mail fixture generator has to be able to emit what mail clients actually emit, which includes
 * things no library will produce for you: a `Subject` in ISO-8859-15 rather than UTF-8, a raw 8-bit
 * display name in a header, an attachment filename that is a path traversal, and a multipart whose
 * boundary is never closed. So the encoders are here, small and explicit, and the malformed message
 * is written as literal bytes.
 *
 * Everything is CRLF. A `.eml` with bare LF line endings is not a `.eml`, and half the bugs worth
 * fixturing live in the difference.
 */

export const CRLF = '\r\n';

/**
 * Single-byte charsets the corpus needs, as a Unicode → byte map layered over Latin-1.
 *
 * ISO-8859-15 is Latin-1 with eight substitutions (it is where the euro sign lives), and
 * windows-1252 fills Latin-1's unused C1 range with punctuation. Getting either wrong produces a
 * file that decodes to the wrong characters rather than one that fails to decode, which is exactly
 * the class of bug the non-UTF-8 fixture is for — so the tables are written out.
 */
const OVERRIDES = {
  'iso-8859-15': {
    '€': 0xa4,
    Š: 0xa6,
    š: 0xa8,
    Ž: 0xb4,
    ž: 0xb8,
    Œ: 0xbc,
    œ: 0xbd,
    Ÿ: 0xbe,
    /* The eight code points Latin-1 has here are not reachable in ISO-8859-15. */
    '¤': null,
    '¦': null,
    '¨': null,
    '´': null,
    '¸': null,
    '¼': null,
    '½': null,
    '¾': null,
  },
  'windows-1252': {
    '€': 0x80,
    '‚': 0x82,
    ƒ: 0x83,
    '„': 0x84,
    '…': 0x85,
    '†': 0x86,
    '‡': 0x87,
    ˆ: 0x88,
    '‰': 0x89,
    Š: 0x8a,
    '‹': 0x8b,
    Œ: 0x8c,
    Ž: 0x8e,
    '‘': 0x91,
    '’': 0x92,
    '“': 0x93,
    '”': 0x94,
    '•': 0x95,
    '–': 0x96,
    '—': 0x97,
    '˜': 0x98,
    '™': 0x99,
    š: 0x9a,
    '›': 0x9b,
    œ: 0x9c,
    ž: 0x9e,
    Ÿ: 0x9f,
  },
  'iso-8859-1': {},
};

/**
 * Encode text into one of the charsets the corpus uses, refusing anything that does not fit.
 *
 * @param {string} text
 * @param {'utf-8'|'iso-8859-1'|'iso-8859-15'|'windows-1252'} charset
 * @returns {Buffer}
 */
export function encodeCharset(text, charset) {
  if (charset === 'utf-8') return Buffer.from(text, 'utf8');
  const overrides = OVERRIDES[charset];
  if (!overrides) throw new Error(`unsupported fixture charset ${charset}`);
  const bytes = [];
  for (const char of text) {
    if (Object.hasOwn(overrides, char)) {
      const byte = overrides[char];
      if (byte === null) throw new Error(`${JSON.stringify(char)} is not in ${charset}`);
      bytes.push(byte);
      continue;
    }
    const code = char.codePointAt(0);
    if (code > 0xff) throw new Error(`${JSON.stringify(char)} is not in ${charset}`);
    bytes.push(code);
  }
  return Buffer.from(bytes);
}

/**
 * An RFC 2047 encoded-word. `Q` for text that is mostly ASCII (so the fixture is readable in a
 * hex dump), `B` where a client would have chosen base64.
 *
 * @param {string} text
 * @param {string} charset
 * @param {'Q'|'B'} [encoding]
 * @returns {string}
 */
export function encodedWord(text, charset, encoding = 'Q') {
  const bytes = encodeCharset(text, charset);
  if (encoding === 'B') {
    return `=?${charset.toUpperCase()}?B?${bytes.toString('base64')}?=`;
  }
  let out = '';
  for (const byte of bytes) {
    const char = String.fromCharCode(byte);
    if (char === ' ') out += '_';
    else if (/[A-Za-z0-9!*+\-/]/.test(char)) out += char;
    else out += `=${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return `=?${charset.toUpperCase()}?${encoding}?${out}?=`;
}

/**
 * Base64, wrapped at 76 characters, CRLF-terminated — what every mail client writes for an
 * attachment.
 *
 * @param {Buffer} buffer
 * @returns {string}
 */
export function base64Lines(buffer) {
  const encoded = buffer.toString('base64');
  const lines = [];
  for (let at = 0; at < encoded.length; at += 76) lines.push(encoded.slice(at, at + 76));
  return lines.join(CRLF);
}

/**
 * Quoted-printable, with soft line breaks at 76 columns.
 *
 * @param {Buffer} buffer  already in the part's charset
 * @returns {string}
 */
export function quotedPrintable(buffer) {
  /** @type {string[]} */
  const lines = [];
  let line = '';
  const flush = (soft) => {
    lines.push(soft ? `${line}=` : line);
    line = '';
  };
  for (const byte of buffer) {
    if (byte === 0x0a) {
      flush(false);
      continue;
    }
    if (byte === 0x0d) continue;
    const printable =
      (byte >= 0x21 && byte <= 0x3c) || (byte >= 0x3e && byte <= 0x7e) || byte === 0x20;
    const token = printable
      ? String.fromCharCode(byte)
      : `=${byte.toString(16).toUpperCase().padStart(2, '0')}`;
    if (line.length + token.length > 75) flush(true);
    line += token;
  }
  lines.push(line);
  return lines.join(CRLF);
}

/**
 * Fold a header field at 78 columns on the spaces between its tokens, the way a client does.
 *
 * @param {string} name
 * @param {string} value
 * @returns {string}
 */
export function header(name, value) {
  const words = String(value).split(' ');
  let line = `${name}:`;
  const out = [];
  for (const word of words) {
    if (line.length + 1 + word.length > 78 && line !== `${name}:`) {
      out.push(line);
      line = ` ${word}`;
    } else {
      line += ` ${word}`;
    }
  }
  out.push(line);
  return out.join(CRLF);
}

/**
 * Assemble a message from header pairs and a body that is already encoded.
 *
 * The headers are written in the order given — order is data in a mail file, and a fixture that
 * sorted them would stop being a capture of what a client writes.
 *
 * Header values are written byte for byte through Latin-1, so a value above U+00FF is a mistake
 * (an unencoded UTF-8 header would silently become mojibake) and is refused. Deliberate raw 8-bit
 * headers — one message has one — are passed in as Latin-1 strings of the bytes wanted.
 *
 * @param {Array<[string, string]>} headers
 * @param {Buffer|string} body
 * @returns {Buffer}
 */
export function message(headers, body) {
  for (const [name, value] of headers) {
    for (const char of String(value)) {
      if (char.codePointAt(0) > 0xff) {
        throw new Error(
          `header ${name} carries ${JSON.stringify(char)}, which has no single-byte form; ` +
            'wrap it in an RFC 2047 encoded word',
        );
      }
    }
  }
  const head = headers.map(([name, value]) => header(name, value)).join(CRLF);
  return Buffer.concat([
    Buffer.from(`${head}${CRLF}${CRLF}`, 'binary'),
    Buffer.isBuffer(body) ? body : Buffer.from(body, 'binary'),
  ]);
}

/**
 * One part of a multipart body: its own headers, then its own body.
 *
 * @param {Array<[string, string]>} headers
 * @param {Buffer|string} body
 * @returns {Buffer}
 */
export function part(headers, body) {
  return message(headers, body);
}

/**
 * Join parts with a boundary. `closed: false` writes the archive-hostile case: no terminating
 * `--boundary--`, which is what a truncated download or a broken sender produces.
 *
 * @param {string} boundary
 * @param {Array<Buffer|string>} parts
 * @param {object} [options]
 * @param {string} [options.preamble]
 * @param {boolean} [options.closed]
 * @returns {Buffer}
 */
export function multipart(boundary, parts, { preamble = '', closed = true } = {}) {
  const chunks = [];
  if (preamble) chunks.push(Buffer.from(`${preamble}${CRLF}`, 'binary'));
  for (const body of parts) {
    chunks.push(Buffer.from(`--${boundary}${CRLF}`, 'binary'));
    chunks.push(Buffer.isBuffer(body) ? body : Buffer.from(body, 'binary'));
    chunks.push(Buffer.from(CRLF, 'binary'));
  }
  if (closed) chunks.push(Buffer.from(`--${boundary}--${CRLF}`, 'binary'));
  return Buffer.concat(chunks);
}

/** Text lines as a CRLF body. */
export function textBody(lines) {
  return Buffer.from(`${lines.join(CRLF)}${CRLF}`, 'utf8');
}
