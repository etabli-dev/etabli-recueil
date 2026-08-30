/**
 * Test scaffolding.
 *
 * Every test runs against a real Recueil library — a real SQLite file, a real content-addressed
 * store, real migrations — in a temporary directory that cleans itself up, and against a real
 * server on a loopback port for the two sources that speak a protocol. Nothing here is a mock of
 * the thing under test: the things worth testing are a hash over bytes that really went to disk, a
 * file that really was moved, a `\Seen` flag that really was or was not set, and a state row that
 * really survived a simulated crash. None of those exist in a mock.
 *
 * `makePdf` and `makeEmail` are adapted from `@recueil/ingest`'s test helpers. They are copied
 * rather than imported because a package's `test/` directory is not part of its published surface,
 * and reaching across into another package's tests would couple two suites that should be able to
 * change independently.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';

import { createRecueil } from '@recueil/core';
import type { CreateRecueilOptions, Recueil } from '@recueil/core';
import { IngestPipeline } from '@recueil/ingest';
import type { IngestPipelineOptions } from '@recueil/ingest';

import type { SourceContext, SourceLogEntry } from '../src/index.js';

export interface TestLibrary extends Recueil {
  root: string;
  databaseFile: string;
  storageRoot: string;
  scratchRoot: string;
  dispose(): void;
}

export const makeLibrary = (
  options: Partial<Omit<CreateRecueilOptions, 'databaseUrl' | 'storagePath'>> = {},
): TestLibrary => {
  const root = mkdtempSync(join(tmpdir(), 'recueil-sources-test-'));
  const databaseFile = join(root, 'library.sqlite');
  const storageRoot = join(root, 'store');
  const scratchRoot = join(root, 'scratch');
  // The pipeline's `ScratchManager` makes a directory *inside* this root for each run, so the root
  // itself has to exist before the first archive is expanded.
  mkdirSync(scratchRoot, { recursive: true });
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

export const makeTempDir = (prefix = 'recueil-sources-'): { path: string; dispose(): void } => {
  const path = mkdtempSync(join(tmpdir(), prefix));
  return { path, dispose: () => rmSync(path, { recursive: true, force: true }) };
};

/**
 * A pipeline over the test library, with no sidecars.
 *
 * `confidenceThreshold: 0` is a deliberate choice and it needs saying, because it turns off the
 * only thing in the pipeline these tests are not about. Without GROBID or OCR — neither of which
 * may run here — a plain PDF scores below the default 0.75 and stage 9 files it for review instead
 * of creating an Item, which is correct pipeline behaviour (P3) and tested where it belongs, in
 * `@recueil/ingest`. What a *source* test needs on the other side of the pipeline is the ordinary
 * path: a Document, an Item, and an outcome of `ingested`. Two tests below deliberately leave the
 * default in place to check that a `review` outcome is consumed as well, since it is in
 * `DEFAULT_CONSUME_ON`.
 */
export const makePipeline = (
  library: TestLibrary,
  options: Partial<Omit<IngestPipelineOptions, 'recueil'>> = {},
): IngestPipeline =>
  new IngestPipeline({
    recueil: library,
    ...options,
    config: {
      scratchRoot: library.scratchRoot,
      concurrency: 1,
      confidenceThreshold: 0,
      ...(options.config ?? {}),
    },
  });

/** A `SourceContext` for a test that drives a source directly, without a runner. */
export const makeContext = (
  library: TestLibrary,
  options: { signal?: AbortSignal; log?: (entry: SourceLogEntry) => void } = {},
): SourceContext => ({
  recueil: library,
  signal: options.signal ?? new AbortController().signal,
  log: options.log ?? (() => undefined),
  now: () => new Date().toISOString(),
});

export const sleep = (millis: number): Promise<void> =>
  new Promise((resolvePromise) => setTimeout(resolvePromise, millis));

/* ------------------------------------------------------------------------------------------ */
/* Files                                                                                        */
/* ------------------------------------------------------------------------------------------ */

export interface MakePdfOptions {
  lines?: readonly string[];
  pages?: number;
  salt?: string;
}

/** A small but structurally valid PDF, with a text layer unless `lines` is omitted. */
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

export const invoiceLines = (options: { correspondent: string; reference: string }): string[] => [
  options.correspondent,
  'Invoice',
  'Invoice date: 2026-03-14',
  `Invoice number: ${options.reference}`,
  'Total due 1.234,56 EUR',
];

/** A one-pixel PNG, for the inline-image test. Real bytes, so the sniffer types it as an image. */
export const onePixelPng = (): Buffer =>
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );

/* ------------------------------------------------------------------------------------------ */
/* Mail                                                                                         */
/* ------------------------------------------------------------------------------------------ */

export interface MailAttachment {
  filename: string;
  mediaType: string;
  bytes: Buffer;
  /** `inline` with a `Content-ID`, as a mail client writes an embedded image. */
  inline?: boolean;
  contentId?: string;
}

export interface MakeEmailOptions {
  from: string;
  to?: string;
  /** Written verbatim into the header, so a test can supply an encoded word or raw 8-bit bytes. */
  subject: string;
  date?: string;
  body: string;
  attachments?: readonly MailAttachment[];
  /** Extra headers, verbatim. */
  headers?: readonly string[];
  /** Encode the header block in this charset rather than UTF-8. */
  headerCharset?: 'utf8' | 'latin1';
}

/**
 * A `multipart/mixed` message whose first part is `multipart/related` when there is an inline
 * image, which is the shape Outlook, Thunderbird and Apple Mail all produce for "text with an
 * embedded picture and two files attached".
 */
export const makeEmail = (options: MakeEmailOptions): Buffer => {
  const outer = 'recueil-outer-boundary';
  const related = 'recueil-related-boundary';
  const attachments = options.attachments ?? [];
  const inline = attachments.filter((attachment) => attachment.inline === true);
  const attached = attachments.filter((attachment) => attachment.inline !== true);

  const headerLines = [
    `From: ${options.from}`,
    `To: ${options.to ?? 'library@example.org'}`,
    `Subject: ${options.subject}`,
    `Date: ${options.date ?? 'Sat, 14 Mar 2026 09:00:00 +0000'}`,
    `Message-ID: <${Math.random().toString(36).slice(2)}@example.org>`,
    'MIME-Version: 1.0',
    ...(options.headers ?? []),
    `Content-Type: multipart/mixed; boundary="${outer}"`,
    '',
  ];

  const bodyLines: string[] = [];
  bodyLines.push(`--${outer}`);
  if (inline.length > 0) {
    bodyLines.push(`Content-Type: multipart/related; boundary="${related}"`, '');
    bodyLines.push(
      `--${related}`,
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      options.body,
    );
    for (const image of inline) {
      bodyLines.push(
        `--${related}`,
        `Content-Type: ${image.mediaType}; name="${image.filename}"`,
        'Content-Transfer-Encoding: base64',
        `Content-ID: <${image.contentId ?? image.filename}>`,
        `Content-Disposition: inline; filename="${image.filename}"`,
        '',
        wrap(image.bytes.toString('base64')),
      );
    }
    bodyLines.push(`--${related}--`);
  } else {
    bodyLines.push(
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      options.body,
    );
  }

  for (const attachment of attached) {
    bodyLines.push(
      `--${outer}`,
      `Content-Type: ${attachment.mediaType}; name="${attachment.filename}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${attachment.filename}"`,
      '',
      wrap(attachment.bytes.toString('base64')),
    );
  }
  bodyLines.push(`--${outer}--`, '');

  // The header block is encoded on its own, so a test can hand over raw 8-bit bytes in a subject;
  // the trailing CRLF closes the last header and the second one is the blank line RFC 5322 requires
  // between the headers and the body.
  return Buffer.concat([
    Buffer.from(`${headerLines.join('\r\n')}\r\n`, options.headerCharset ?? 'utf8'),
    Buffer.from(bodyLines.join('\r\n'), 'utf8'),
  ]);
};

const wrap = (base64: string): string => (base64.match(/.{1,76}/gu) ?? []).join('\r\n');

/* ------------------------------------------------------------------------------------------ */
/* Queries the tests assert on                                                                  */
/* ------------------------------------------------------------------------------------------ */

/** How many live documents the library holds. Queried, never inferred from a run report. */
export const countDocuments = (library: TestLibrary): number =>
  (
    library.connection
      .prepare('select count(*) as n from documents where trashed_at is null')
      .get() as { n: number }
  ).n;

export const countItems = (library: TestLibrary): number =>
  (
    library.connection.prepare('select count(*) as n from items where trashed_at is null').get() as {
      n: number;
    }
  ).n;

export const countNotes = (library: TestLibrary): number =>
  (
    library.connection.prepare('select count(*) as n from notes where trashed_at is null').get() as {
      n: number;
    }
  ).n;

export const documentDigests = (library: TestLibrary): string[] =>
  (
    library.connection
      .prepare('select sha256 from documents where trashed_at is null order by sha256')
      .all() as Array<{ sha256: string }>
  ).map((row) => row.sha256);

export const documentFilenames = (library: TestLibrary): string[] =>
  (
    library.connection
      .prepare(
        'select original_filename as name from documents where trashed_at is null order by name',
      )
      .all() as Array<{ name: string | null }>
  ).map((row) => row.name ?? '');

export const noteBodies = (library: TestLibrary): string[] =>
  (
    library.connection
      .prepare('select content_markdown as body from notes where trashed_at is null')
      .all() as Array<{ body: string }>
  ).map((row) => row.body);

/* ------------------------------------------------------------------------------------------ */
/* Archives                                                                                     */
/* ------------------------------------------------------------------------------------------ */

/**
 * A minimal, structurally valid zip, built here rather than shelled out to.
 *
 * Deflate members with a real CRC and a real central directory, which is all `@recueil/ingest`'s
 * reader looks at. It exists because the consume policy has to be tested against a *container*
 * outcome, and a container is the one outcome whose own bytes the deployment may deliberately not
 * store — the case that made every zip permanently unconsumable.
 */
export const makeZip = (members: ReadonlyArray<{ name: string; bytes: Buffer }>): Buffer => {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const member of members) {
    const compressed = deflateRawSync(member.bytes);
    const name = Buffer.from(member.name, 'utf8');
    const crc = crc32(member.bytes);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x0403_4b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(member.bytes.length, 22);
    local.writeUInt16LE(name.length, 26);
    const block = Buffer.concat([local, name, compressed]);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x0201_4b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(compressed.length, 20);
    entry.writeUInt32LE(member.bytes.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);

    locals.push(block);
    central.push(Buffer.concat([entry, name]));
    offset += block.length;
  }

  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x0605_4b50, 0);
  end.writeUInt16LE(members.length, 8);
  end.writeUInt16LE(members.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, directory, end]);
};
