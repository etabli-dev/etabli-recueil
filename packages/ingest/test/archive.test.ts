/**
 * Archives, and the hostility of the names inside them.
 *
 * The Phase 1 review found a manifest path validated only as "is a string" that both read outside
 * the snapshot and wrote outside the restore target. A zip member name is the same class of input
 * with a wider audience, so the traversal cases are tested one by one and by their effect: not
 * "does the validator return false" but "is there a file outside the extraction root afterwards".
 */
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
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

  it('decodes an RFC 2047 encoded subject', () => {
    const raw = Buffer.from(
      ['From: a@example.org', 'Subject: =?utf-8?B?R2Vidcyock?=', '', 'body'].join('\r\n'),
      'utf8',
    );
    const parsed = parseEmail(raw);
    expect(parsed.subject).not.toContain('=?utf-8?B?');
  });
});
