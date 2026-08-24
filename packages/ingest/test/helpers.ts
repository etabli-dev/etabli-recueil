/**
 * Test scaffolding.
 *
 * Every test runs against a real Recueil library — a real SQLite file, a real content-addressed
 * store, real migrations — in a temporary directory that cleans itself up. Nothing here is a mock.
 * The things worth testing are a partial unique index, a SHA-256 over bytes that are really on
 * disk, an FTS5 query, a resumed job and a scratch directory that really was deleted, and none of
 * those exist in a mock.
 *
 * The two builders — `makePdf` and `makeZip` — produce real files rather than fixtures on disk, so
 * a test can say exactly what it needs: a PDF with a text layer, a PDF that is a picture of a page,
 * an archive with a traversal entry. `makeZip` computes its CRCs with `node:zlib`'s `crc32`, which
 * is a different implementation from the one in `src/archive/zip.ts`; a bug in either is therefore
 * visible as a disagreement rather than hidden by both being wrong the same way.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';

import { createRecueil } from '@recueil/core';
import type { CreateRecueilOptions, Recueil } from '@recueil/core';

export interface TestLibrary extends Recueil {
  root: string;
  databaseFile: string;
  storageRoot: string;
  scratchRoot: string;
  dispose(): void;
}

/** A Recueil library on disk, in a directory that cleans itself up. */
export const makeLibrary = (
  options: Partial<Omit<CreateRecueilOptions, 'databaseUrl' | 'storagePath'>> = {},
): TestLibrary => {
  const root = mkdtempSync(join(tmpdir(), 'recueil-ingest-test-'));
  const databaseFile = join(root, 'library.sqlite');
  const storageRoot = join(root, 'store');
  const scratchRoot = join(root, 'scratch');
  const recueil = createRecueil({ ...options, databaseUrl: databaseFile, storagePath: storageRoot });

  return {
    ...recueil,
    root,
    databaseFile,
    storageRoot,
    scratchRoot,
    dispose: () => {
      recueil.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
};

/** A temporary directory for a test that needs one without a library. */
export const makeTempDir = (prefix = 'recueil-ingest-'): { path: string; dispose(): void } => {
  const path = mkdtempSync(join(tmpdir(), prefix));
  return { path, dispose: () => rmSync(path, { recursive: true, force: true }) };
};

/* ------------------------------------------------------------------------------------------ */
/* PDFs                                                                                         */
/* ------------------------------------------------------------------------------------------ */

export interface MakePdfOptions {
  /** Lines of text to put in the content stream. Omit for a PDF with no text layer at all. */
  lines?: readonly string[];
  /** Pages declared in the page tree. Only the count is honest; the pages are not drawn. */
  pages?: number;
  /** Bytes appended as a comment, so two PDFs with the same text can still differ. */
  salt?: string;
}

/**
 * A small but structurally valid PDF.
 *
 * Real enough for the pipeline: `%PDF-` magic so the sniffer types it, a page tree with a `/Count`
 * so the page counter reads it, and an uncompressed content stream whose text-showing operators
 * `extractPdfText` can find. With no `lines` it draws a filled rectangle instead, which is what a
 * scanned page looks like to a text-layer probe: no `Tj`, no text.
 */
export const makePdf = (options: MakePdfOptions = {}): Buffer => {
  const pages = options.pages ?? 1;
  const content =
    options.lines === undefined || options.lines.length === 0
      ? '0.2 0.2 0.2 rg\n10 10 500 700 re\nf\n'
      : ['BT', '/F1 12 Tf', '72 720 Td', ...options.lines.map(pdfLine), 'ET', ''].join('\n');

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [3 0 R] /Count ${String(pages)} >>`,
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R ' +
      '/Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${String(Buffer.byteLength(content, 'latin1'))} >>\nstream\n${content}endstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];

  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body, 'latin1'));
    body += `${String(index + 1)} 0 obj\n${object}\nendobj\n`;
  });

  const xrefOffset = Buffer.byteLength(body, 'latin1');
  body += `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${offset.toString().padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R >>\nstartxref\n${String(xrefOffset)}\n%%EOF\n`;
  if (options.salt !== undefined) body += `% ${options.salt}\n`;

  return Buffer.from(body, 'latin1');
};

const pdfLine = (line: string): string =>
  `(${line.replace(/\\/gu, '\\\\').replace(/\(/gu, '\\(').replace(/\)/gu, '\\)')}) Tj 0 -16 Td`;

/** The text of a plausible journal article, so stage 4 has something to recognise. */
export const scholarlyLines = (options: { title: string; doi: string; year?: number }): string[] => [
  options.title,
  'Ada Lovelace, Grace Hopper',
  `Journal of Reproducible Findings, ${String(options.year ?? 2026)}`,
  `doi:${options.doi}`,
  'Abstract',
  'We report a finding and then report it again, with the same result both times.',
  'Keywords: reproducibility, ingestion, provenance',
  'References',
  '1. Hopper G. On compilers. Journal of Machines 1952.',
];

/** The text of a plausible invoice, for the Office facet of CONCEPT 5.2. */
export const invoiceLines = (options: { correspondent: string; reference: string }): string[] => [
  options.correspondent,
  'Invoice',
  'Invoice date: 2026-03-14',
  `Invoice number: ${options.reference}`,
  'Customer number: KD-99213',
  'Total due 1.234,56 EUR',
];

/* ------------------------------------------------------------------------------------------ */
/* Archives                                                                                     */
/* ------------------------------------------------------------------------------------------ */

export interface ZipMember {
  name: string;
  bytes: Buffer;
}

/** A stored (uncompressed) ZIP. Enough for the reader; deliberately not a general zip writer. */
export const makeZip = (members: readonly ZipMember[]): Buffer => {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const member of members) {
    const name = Buffer.from(member.name, 'utf8');
    const digest = crc32(member.bytes);

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(digest, 14);
    local.writeUInt32LE(member.bytes.length, 18);
    local.writeUInt32LE(member.bytes.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(digest, 16);
    central.writeUInt32LE(member.bytes.length, 20);
    central.writeUInt32LE(member.bytes.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);

    locals.push(local, member.bytes);
    centrals.push(central);
    offset += local.length + member.bytes.length;
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

export interface MakeEmailOptions {
  from: string;
  to?: string;
  subject: string;
  date?: string;
  body: string;
  attachments?: ReadonlyArray<{ filename: string; mediaType: string; bytes: Buffer }>;
}

/** A multipart RFC 5322 message with base64 attachments. */
export const makeEmail = (options: MakeEmailOptions): Buffer => {
  const boundary = 'recueil-test-boundary';
  const parts: string[] = [
    `From: ${options.from}`,
    `To: ${options.to ?? 'library@example.org'}`,
    `Subject: ${options.subject}`,
    `Date: ${options.date ?? 'Sat, 14 Mar 2026 09:00:00 +0000'}`,
    `Message-ID: <${options.subject.replace(/\W+/gu, '-')}@example.org>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    options.body,
  ];

  for (const attachment of options.attachments ?? []) {
    parts.push(
      `--${boundary}`,
      `Content-Type: ${attachment.mediaType}; name="${attachment.filename}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${attachment.filename}"`,
      '',
      attachment.bytes.toString('base64').replace(/(.{76})/gu, '$1\r\n'),
    );
  }

  parts.push(`--${boundary}--`, '');
  return Buffer.from(parts.join('\r\n'), 'utf8');
};
