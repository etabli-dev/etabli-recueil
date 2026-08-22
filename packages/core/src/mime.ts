/**
 * MIME sniffing.
 *
 * `spec/data-model.md` §3.3 says `documents.mime_type` is "sniffed, not trusted from the uploader",
 * and `documents.mime_source` records which of the four routes produced it. A browser's
 * `Content-Type`, a scanner's guess and a mail client's `application/octet-stream` are all wrong
 * often enough that trusting them silently mistypes part of the library.
 *
 * This is a magic-number sniffer for the handful of types Phase 1 ingests, not a libmagic port. It
 * recognises what it recognises and says `declared` or `extension` when it cannot, which is exactly
 * what `mime_source` exists to record. Richer detection is a Phase 2 concern, alongside the type
 * detection of CONCEPT §5.3 stage 4.
 */

export type MimeSource = 'sniffed' | 'declared' | 'extension' | 'manual';

export interface SniffResult {
  mimeType: string;
  mimeSource: MimeSource;
}

const startsWith = (bytes: Uint8Array, signature: readonly number[], offset = 0): boolean =>
  signature.every((byte, index) => bytes[offset + index] === byte);

const EXTENSION_TYPES: Readonly<Record<string, string>> = {
  bib: 'application/x-bibtex',
  csv: 'text/csv',
  eml: 'message/rfc822',
  htm: 'text/html',
  html: 'text/html',
  json: 'application/json',
  md: 'text/markdown',
  ris: 'application/x-research-info-systems',
  txt: 'text/plain',
  xml: 'application/xml',
  yaml: 'application/yaml',
  yml: 'application/yaml',
};

/** Sniff the leading bytes; fall back to the declared type, then the filename, then octet-stream. */
export const sniffMimeType = (
  bytes: Uint8Array,
  options: { declared?: string | null; filename?: string | null } = {},
): SniffResult => {
  const sniffed = sniffMagic(bytes);
  if (sniffed !== null) return { mimeType: sniffed, mimeSource: 'sniffed' };

  const declared = options.declared?.trim();
  if (declared !== undefined && declared !== '' && declared !== 'application/octet-stream') {
    return { mimeType: declared, mimeSource: 'declared' };
  }

  const extension = options.filename?.toLowerCase().split('.').pop();
  if (extension !== undefined && extension in EXTENSION_TYPES) {
    return { mimeType: EXTENSION_TYPES[extension] as string, mimeSource: 'extension' };
  }

  return { mimeType: 'application/octet-stream', mimeSource: 'sniffed' };
};

const sniffMagic = (bytes: Uint8Array): string | null => {
  if (bytes.length === 0) return 'application/octet-stream';
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'application/pdf';
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return 'image/gif';
  if (startsWith(bytes, [0x49, 0x49, 0x2a, 0x00]) || startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2a])) {
    return 'image/tiff';
  }
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) {
    return 'image/webp';
  }
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) return 'application/zip';
  if (startsWith(bytes, [0x1f, 0x8b])) return 'application/gzip';
  if (startsWith(bytes, [0x7b, 0x5c, 0x72, 0x74, 0x66])) return 'application/rtf';
  if (isProbablyUtf8Text(bytes)) return 'text/plain';
  return null;
};

/**
 * A conservative "is this text" test over the first few kilobytes: no NUL bytes, no stray control
 * characters, and valid UTF-8. Conservative on purpose — mislabelling a binary as text is worse
 * than falling through to `application/octet-stream`.
 */
const isProbablyUtf8Text = (bytes: Uint8Array): boolean => {
  const sample = bytes.subarray(0, 4096);
  for (const byte of sample) {
    if (byte === 0) return false;
    if (byte < 0x09) return false;
    if (byte > 0x0d && byte < 0x20 && byte !== 0x1b) return false;
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(sample.subarray(0, sample.length - 3));
    return true;
  } catch {
    return false;
  }
};
