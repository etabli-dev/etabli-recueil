/**
 * Reading a header block that was not written in the charset it claims — or in any charset at all.
 *
 * `@recueil/ingest` already parses a whole message, and the pipeline uses it at stage 3. This is
 * the smaller job that has to happen *earlier*: the source fetches only the header block first, so
 * that the sender and the subject are known before a forty-megabyte body is pulled down and before
 * the mail rules decide whether it is wanted at all.
 *
 * Two decoding problems, and the order they are dealt with matters:
 *
 *   1. **The block is bytes, not text.** RFC 5322 says a header is ASCII; a great deal of real mail
 *      says otherwise. A German mail client sending `Betreff: Rückfrage` as raw UTF-8, and an older
 *      one sending the same word as raw ISO-8859-1, produce different bytes and neither is legal.
 *      The rule here is the pragmatic one every mail reader ends up with: if the block is valid
 *      UTF-8, it is UTF-8; if it is not, it is ISO-8859-1, which cannot fail because every byte
 *      sequence is valid in it. Latin-1 is the right fallback rather than a replacement character,
 *      because a mojibake subject can still be matched and read, and `U+FFFD` cannot.
 *   2. **Then the encoded words.** `=?ISO-8859-1?Q?R=FCckfrage?=` is the legal way to do it, and
 *      `decodeWords` from `@recueil/ingest` handles it, including the base64 form and a charset
 *      label `TextDecoder` recognises.
 */
import { decodeWords } from '@recueil/ingest';

export type HeaderMap = Record<string, string[]>;

/** Decode a header block, UTF-8 if it is valid UTF-8 and ISO-8859-1 if it is not. */
export const decodeHeaderBytes = (bytes: Buffer): string => {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return bytes.toString('latin1');
  }
};

/** Header names lower-cased, continuation lines unfolded, encoded words decoded. */
export const parseHeaderBlock = (bytes: Buffer): HeaderMap => {
  const headers: HeaderMap = {};
  let current: { name: string; value: string } | null = null;

  const push = (): void => {
    if (current === null) return;
    const decoded = decodeWords(current.value) ?? current.value;
    const existing = headers[current.name];
    if (existing === undefined) headers[current.name] = [decoded];
    else existing.push(decoded);
    current = null;
  };

  for (const line of decodeHeaderBytes(bytes).split(/\r?\n/u)) {
    if (line === '') continue;
    if (/^[ \t]/u.test(line)) {
      if (current !== null) current.value += ` ${line.trim()}`;
      continue;
    }
    push();
    const colon = line.indexOf(':');
    if (colon === -1) continue; // An mbox `From ` separator, or junk. Neither is a header.
    current = { name: line.slice(0, colon).trim().toLowerCase(), value: line.slice(colon + 1).trim() };
  }
  push();

  return headers;
};

export const headerValue = (headers: HeaderMap, name: string): string | null =>
  headers[name.toLowerCase()]?.[0] ?? null;

/** `"Dr Ada Lovelace" <ada@example.org>` → `ada@example.org`. Falls back to the whole string. */
export const addressOf = (value: string | null): string | null => {
  if (value === null) return null;
  const angled = /<([^>]+)>/u.exec(value);
  if (angled !== null) return (angled[1] ?? '').trim().toLowerCase();
  const bare = value.trim();
  return bare === '' ? null : bare.toLowerCase();
};

/** Every address in a list header, for `to`, `cc` and the delivered-to rules. */
export const addressList = (value: string | null): string[] => {
  if (value === null) return [];
  return value
    .split(',')
    .map((part) => addressOf(part))
    .filter((address): address is string => address !== null);
};
