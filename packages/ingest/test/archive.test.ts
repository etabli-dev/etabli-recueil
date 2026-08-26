/**
 * Archives, and the hostility of the names inside them.
 *
 * The Phase 1 review found a manifest path validated only as "is a string" that both read outside
 * the snapshot and wrote outside the restore target. A zip member name is the same class of input
 * with a wider audience, so the traversal cases are tested one by one and by their effect: not
 * "does the validator return false" but "is there a file outside the extraction root afterwards".
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_INGEST_CONFIG } from '../src/config.js';
import {
  ArchiveFormatError,
  ArchiveLimitError,
  UnsafeArchivePathError,
} from '../src/errors.js';
import { archiveKind, extractArchive } from '../src/archive/extract.js';
import { looksLikeEmail, parseEmail } from '../src/archive/eml.js';
import { isInside, resolveMemberPath } from '../src/archive/safe-path.js';
import { crc32, readZipDirectory, readZipEntry } from '../src/archive/zip.js';
import { ScratchManager } from '../src/scratch.js';
import { makeEmail, makePdf, makeZip } from './helpers.js';

let root: string;
let scratch: ScratchManager;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'recueil-archive-test-'));
  scratch = new ScratchManager(root);
});

afterEach(async () => {
  await scratch.dispose();
  rmSync(root, { recursive: true, force: true });
});

describe('resolveMemberPath', () => {
  const cases: Array<[string, string]> = [
    ['../escape.txt', "the name contains a '..' segment"],
    ['a/../../escape.txt', "the name contains a '..' segment"],
    ['/etc/passwd', 'the name is absolute'],
    ['//host/share/x', 'the name is a UNC path'],
    ['C:\\Windows\\system32', 'the name carries a drive letter'],
    ['..\\..\\escape.txt', "the name contains a '..' segment"],
    ['', 'the name is empty'],
    ['./', 'the name resolves to the root itself'],
  ];

  for (const [name, reason] of cases) {
    it(`refuses ${JSON.stringify(name)}`, () => {
      expect(() => resolveMemberPath('/tmp/root', name)).toThrowError(UnsafeArchivePathError);
      try {
        resolveMemberPath('/tmp/root', name);
      } catch (error) {
        expect((error as UnsafeArchivePathError).message).toContain(reason);
      }
    });
  }

  it('refuses a name containing a NUL byte', () => {
    expect(() => resolveMemberPath('/tmp/root', 'ok.pdf\0.png')).toThrowError(UnsafeArchivePathError);
  });

  it('accepts an ordinary nested name and resolves it under the root', () => {
    const resolved = resolveMemberPath('/tmp/root', 'papers/2026/one.pdf');
    expect(resolved.relativePath).toBe('papers/2026/one.pdf');
    expect(resolved.absolutePath).toBe(resolve('/tmp/root/papers/2026/one.pdf'));
  });

  it('does not treat a sibling directory with a shared prefix as inside', () => {
    expect(isInside('/tmp/root', '/tmp/root-elsewhere/x')).toBe(false);
    expect(isInside('/tmp/root', '/tmp/root/x')).toBe(true);
    expect(isInside('/tmp/root', '/tmp/root')).toBe(true);
  });
});

describe('extracting a zip', () => {
  it('refuses the whole archive when one member would escape the root', async () => {
    const archive = makeZip([
      { name: 'good.pdf', bytes: makePdf({ salt: 'good' }) },
      { name: '../evil.pdf', bytes: makePdf({ salt: 'evil' }) },
    ]);

    await expect(
      scratch.with('t-', async (space) =>
        extractArchive({ bytes: archive, kind: 'zip', scratch: space, config: DEFAULT_INGEST_CONFIG }),
      ),
    ).rejects.toThrowError(UnsafeArchivePathError);

    // Nothing was written, not even the member that was fine: an archive that contains a traversal
    // entry is refused whole.
    expect(existsSync(join(root, '..', 'evil.pdf'))).toBe(false);
    expect(await scratch.isEmpty()).toBe(true);
  });

  it('extracts members and CRC-checks them', async () => {
    const one = makePdf({ salt: '1' });
    const two = Buffer.from('plain text member');
    const archive = makeZip([
      { name: 'nested/one.pdf', bytes: one },
      { name: 'two.txt', bytes: two },
    ]);

    const result = await scratch.with('t-', async (space) => {
      const extraction = await extractArchive({
        bytes: archive,
        kind: 'zip',
        scratch: space,
        config: DEFAULT_INGEST_CONFIG,
      });
      expect(readdirSync(space.path).sort()).toEqual(['nested', 'two.txt']);
      return extraction;
    });

    expect(result.members.map((member) => member.relativePath).sort()).toEqual([
      'nested/one.pdf',
      'two.txt',
    ]);
    expect(result.members.find((member) => member.entryName === 'two.txt')?.byteSize).toBe(two.length);
  });

  /**
   * The Phase 2 review's `zip-collide.mjs`, rebuilt.
   *
   * `./invoice.pdf` and `invoice.pdf` are two distinct entries whose names normalise to one
   * relative path, and the shipped code wrote both to the same scratch file with no `wx` flag.
   * `pipeline.ts` reads every member's bytes back *after* the extraction loop, so both members read
   * the last writer's bytes: the archive reported two ingested members carrying one digest, one
   * document, an empty `skipped`, and a satisfied verification, while the first member's bytes were
   * gone. The bytes are read back here the same way — after the loop — because reading them inside
   * it would not reproduce anything.
   */
  it('keeps two members whose names normalise to the same path, rather than overwriting one', async () => {
    const first = makePdf({ salt: 'member-A' });
    const second = makePdf({ salt: 'member-B' });
    const archive = makeZip([
      { name: './invoice.pdf', bytes: first },
      { name: 'invoice.pdf', bytes: second },
    ]);

    const read = await scratch.with('t-', async (space) => {
      const extraction = await extractArchive({
        bytes: archive,
        kind: 'zip',
        scratch: space,
        config: DEFAULT_INGEST_CONFIG,
      });
      expect(extraction.skipped).toEqual([]);
      expect(extraction.members).toHaveLength(2);
      return extraction.members.map((member) => ({
        entryName: member.entryName,
        relativePath: member.relativePath,
        bytes: readFileSync(member.absolutePath),
      }));
    });

    // Two members, two files on disk, and each one holds the bytes its own entry carried.
    expect(new Set(read.map((member) => member.relativePath)).size).toBe(2);
    expect(read.find((member) => member.entryName === './invoice.pdf')?.bytes.equals(first)).toBe(true);
    expect(read.find((member) => member.entryName === 'invoice.pdf')?.bytes.equals(second)).toBe(true);

    // And the member that did not collide keeps the plain name, so the `<container>!/<member>`
    // external id of an ordinary archive is not disturbed by this.
    expect(read.map((member) => member.relativePath)).toContain('invoice.pdf');
  });

  it('rejects a member whose bytes do not match the CRC the directory claims', () => {
    const archive = makeZip([{ name: 'a.txt', bytes: Buffer.from('hello') }]);
    // Flip a byte in the stored data, which is right after the 30-byte local header plus the name.
    const corrupt = Buffer.from(archive);
    corrupt[30 + 'a.txt'.length] = 0x00;

    const entries = readZipDirectory(corrupt);
    expect(() => readZipEntry(corrupt, entries[0]!)).toThrowError(ArchiveFormatError);
  });

  it('refuses an archive that declares more members than the limit', async () => {
    const members = Array.from({ length: 5 }, (_, index) => ({
      name: `f${String(index)}.txt`,
      bytes: Buffer.from(`x${String(index)}`),
    }));
    const archive = makeZip(members);

    await expect(
      scratch.with('t-', async (space) =>
        extractArchive({
          bytes: archive,
          kind: 'zip',
          scratch: space,
          config: { ...DEFAULT_INGEST_CONFIG, maxArchiveEntries: 2 },
        }),
      ),
    ).rejects.toThrowError(ArchiveLimitError);
  });

  it('refuses an archive whose declared expansion exceeds the ratio limit', async () => {
    const archive = makeZip([{ name: 'a.txt', bytes: Buffer.alloc(4096, 0x41) }]);
    await expect(
      scratch.with('t-', async (space) =>
        extractArchive({
          bytes: archive,
          kind: 'zip',
          scratch: space,
          config: { ...DEFAULT_INGEST_CONFIG, maxArchiveTotalBytes: 1024 },
        }),
      ),
    ).rejects.toThrowError(ArchiveLimitError);
  });

  it('agrees with node:zlib about CRC-32', () => {
    // The reader's own table-driven implementation against the one the test helper used to build
    // the archive. Two implementations that agree are evidence; one that agrees with itself is not.
    const bytes = Buffer.from('The quick brown fox jumps over the lazy dog');
    expect(crc32(bytes)).toBe(0x414fa339);
  });
});

describe('recognising an archive', () => {
  it('reads the magic number rather than trusting the media type', () => {
    const zip = makeZip([{ name: 'a.txt', bytes: Buffer.from('a') }]);
    expect(archiveKind('application/pdf', zip)).toBe('zip');
    expect(archiveKind('application/zip', makePdf({ salt: 'not-a-zip' }))).toBe(null);
  });

  it('recognises a message saved as text/plain', () => {
    const message = makeEmail({ from: 'a@example.org', subject: 'Hello', body: 'Body' });
    expect(looksLikeEmail(message)).toBe(true);
    expect(archiveKind('text/plain', message)).toBe('eml');
    expect(looksLikeEmail(Buffer.from('just a text file\nwith two lines'))).toBe(false);
  });
});

describe('parsing a message', () => {
  it('separates the body from the attachments and decodes both', () => {
    const pdf = makePdf({ salt: 'attached' });
    const message = makeEmail({
      from: 'Stadtwerke Ulm <billing@swu.example>',
      subject: 'Ihre Rechnung',
      body: 'Sehr geehrte Damen und Herren,\n\nanbei Ihre Rechnung.',
      attachments: [{ filename: 'rechnung.pdf', mediaType: 'application/pdf', bytes: pdf }],
    });

    const parsed = parseEmail(message);
    expect(parsed.from).toBe('Stadtwerke Ulm <billing@swu.example>');
    expect(parsed.subject).toBe('Ihre Rechnung');
    expect(parsed.bodyText).toContain('anbei Ihre Rechnung');
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0]!.filename).toBe('rechnung.pdf');
    expect(parsed.attachments[0]!.bytes.equals(pdf)).toBe(true);
  });

  it('gives an attachment with a traversal filename a safe path', async () => {
    const message = makeEmail({
      from: 'a@example.org',
      subject: 'nasty',
      body: 'hello',
      attachments: [
        { filename: '../../escape.pdf', mediaType: 'application/pdf', bytes: Buffer.from('x') },
      ],
    });

    await expect(
      scratch.with('t-', async (space) =>
        extractArchive({ bytes: message, kind: 'eml', scratch: space, config: DEFAULT_INGEST_CONFIG }),
      ),
    ).rejects.toThrowError(UnsafeArchivePathError);
    expect(existsSync(join(root, '..', 'escape.pdf'))).toBe(false);
  });

  it('assembles an RFC 2231 continued filename, so the attachment keeps its name', () => {
    // The spelling Thunderbird and Outlook both produce for a non-ASCII filename that is long
    // enough to fold: numbered continuations, percent-encoded, with the charset only on segment 0.
    // Losing it does not fail loudly — the part is simply called `part-2.bin` and is gone.
    const raw = Buffer.from(
      [
        'From: a@example.org',
        'Subject: two parts',
        'MIME-Version: 1.0',
        'Content-Type: multipart/mixed; boundary="b"',
        '',
        '--b',
        'Content-Type: text/plain; charset=utf-8',
        '',
        'body',
        '--b',
        'Content-Type: application/pdf',
        "Content-Disposition: attachment; filename*0*=utf-8''Protokoll%20Sitzung%20;",
        ' filename*1*=13.%20M%C3%A4rz%202023; filename*2*=.pdf',
        '',
        '%PDF-1.4',
        '--b--',
        '',
      ].join('\r\n'),
      'utf8',
    );

    const parsed = parseEmail(raw);
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0]!.filename).toBe('Protokoll Sitzung 13. März 2023.pdf');
  });

  it('assembles the single extended RFC 2231 form as well', () => {
    const raw = Buffer.from(
      [
        'From: a@example.org',
        'Subject: one part',
        'MIME-Version: 1.0',
        'Content-Type: multipart/mixed; boundary="b"',
        '',
        '--b',
        'Content-Type: application/pdf',
        "Content-Disposition: attachment; filename*=iso-8859-1''Gr%FC%DFe.pdf",
        '',
        '%PDF-1.4',
        '--b--',
        '',
      ].join('\r\n'),
      'utf8',
    );

    expect(parseEmail(raw).attachments[0]!.filename).toBe('Grüße.pdf');
  });

  it('leaves an ordinary quoted parameter exactly as it was', () => {
    const raw = Buffer.from(
      [
        'From: a@example.org',
        'MIME-Version: 1.0',
        'Content-Type: multipart/mixed; boundary="=_9c1f4d2e"',
        '',
        '--=_9c1f4d2e',
        'Content-Type: application/pdf; name="Rechnung_2023-004417.pdf"',
        'Content-Disposition: attachment; filename="Rechnung_2023-004417.pdf"',
        '',
        '%PDF-1.4',
        '--=_9c1f4d2e--',
        '',
      ].join('\r\n'),
      'utf8',
    );

    expect(parseEmail(raw).attachments[0]!.filename).toBe('Rechnung_2023-004417.pdf');
  });

  it('decodes an RFC 2047 encoded subject', () => {
    const raw = Buffer.from(
      ['From: a@example.org', 'Subject: =?utf-8?B?R2Vidcyock?=', '', 'body'].join('\r\n'),
      'utf8',
    );
    const parsed = parseEmail(raw);
    expect(parsed.subject).not.toContain('=?utf-8?B?');
  });
});
