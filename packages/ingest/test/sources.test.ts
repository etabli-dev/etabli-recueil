/**
 * Where candidates come from, and the office path end to end.
 *
 * The watched folder is a place a person drops files, so a name inside it is untrusted in exactly
 * the way an archive member name is; the symlink test is the filesystem's version of `../..`.
 *
 * The mail test is the CONCEPT §5.3 sentence taken literally — "attachments as Documents, body as
 * Note, rules by sender/subject" — and the Office facet of §5.2 filled from the envelope.
 */
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { schema } from '@recueil/core';
import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { IngestPipeline, bufferCandidate, folderCandidates } from '../src/index.js';
import type { IngestRule } from '../src/index.js';
import { invoiceLines, makeEmail, makeLibrary, makePdf, makeTempDir } from './helpers.js';
import type { TestLibrary } from './helpers.js';

let library: TestLibrary;

beforeEach(() => {
  library = makeLibrary();
});

afterEach(() => {
  library.dispose();
});

describe('folderCandidates', () => {
  it('offers regular files and reports what it refused', async () => {
    const watched = makeTempDir('recueil-watched-');
    const outside = makeTempDir('recueil-outside-');
    try {
      mkdirSync(join(watched.path, 'sub'));
      writeFileSync(join(watched.path, 'a.pdf'), makePdf({ salt: 'a' }));
      writeFileSync(join(watched.path, 'sub', 'b.pdf'), makePdf({ salt: 'b' }));
      writeFileSync(join(watched.path, '.hidden.pdf'), 'x');
      writeFileSync(join(watched.path, 'download.pdf.part'), 'x');
      writeFileSync(join(outside.path, 'secret.pdf'), 'not yours');
      symlinkSync(join(outside.path, 'secret.pdf'), join(watched.path, 'escape.pdf'));

      const scan = await folderCandidates(watched.path);

      expect(scan.candidates.map((candidate) => candidate.ref.externalId).sort()).toEqual([
        'a.pdf',
        'sub/b.pdf',
      ]);

      const reasons = Object.fromEntries(
        scan.skipped.map((entry) => [entry.path.split('/').pop(), entry.reason]),
      );
      expect(reasons['.hidden.pdf']).toContain('dot');
      expect(reasons['download.pdf.part']).toContain('partial download');
      expect(reasons['escape.pdf']).toContain('outside the watched folder');
    } finally {
      watched.dispose();
      outside.dispose();
    }
  });

  it('gives a file a revision that changes when the file does', async () => {
    const watched = makeTempDir('recueil-watched-');
    try {
      const path = join(watched.path, 'a.txt');
      writeFileSync(path, 'one');
      const first = (await folderCandidates(watched.path)).candidates[0]!;
      writeFileSync(path, 'a much longer second version');
      const second = (await folderCandidates(watched.path)).candidates[0]!;
      expect(second.ref.revision).not.toBe(first.ref.revision);
      expect(second.ref.externalId).toBe(first.ref.externalId);
    } finally {
      watched.dispose();
    }
  });

  it('refuses a file over the size limit rather than reading it', async () => {
    const watched = makeTempDir('recueil-watched-');
    try {
      writeFileSync(join(watched.path, 'big.bin'), Buffer.alloc(4096));
      const scan = await folderCandidates(watched.path, { maxBytes: 1024 });
      expect(scan.candidates).toEqual([]);
      expect(scan.skipped[0]!.reason).toContain('over the');
    } finally {
      watched.dispose();
    }
  });
});

describe('a mail with an attachment', () => {
  it('files the message with the Office facet, the body as a Note, and the attachment as its own document', async () => {
    const invoice = makePdf({
      lines: invoiceLines({ correspondent: 'Stadtwerke Ulm GmbH', reference: 'SW-2026-0042' }),
    });
    const message = makeEmail({
      from: 'Stadtwerke Ulm <billing@swu.example>',
      subject: 'Ihre Rechnung SW-2026-0042',
      date: 'Sat, 14 Mar 2026 09:00:00 +0000',
      body: 'Sehr geehrte Damen und Herren,\n\nanbei erhalten Sie Ihre Rechnung.\n\nMit freundlichen Grüßen',
      attachments: [{ filename: 'rechnung.pdf', mediaType: 'application/pdf', bytes: invoice }],
    });

    const rules: IngestRule[] = [
      {
        id: 'swu',
        priority: 10,
        match: { sender: { pattern: '@swu\\.example', flags: 'i' } },
        actions: { addTags: ['utilities'], confidenceDelta: 0.4 },
      },
    ];

    const pipeline = new IngestPipeline({
      recueil: library,
      config: { scratchRoot: library.root },
      rules,
    });

    const report = await pipeline.run(
      [
        bufferCandidate(message, {
          filename: 'rechnung.eml',
          mediaType: 'message/rfc822',
          sourceKind: 'imap',
          sourceId: 'inbox',
          externalId: 'INBOX/4711',
        }),
      ],
      { runLabel: 'mail' },
    );

    // The message and its attachment are two documents; the message is content, not just a lorry.
    expect(library.db.select({ n: sql<number>`count(*)` }).from(schema.documents).get()?.n).toBe(2);
    expect(report.counts.ingested).toBe(2);

    const items = library.db.select().from(schema.items).all();
    expect(items).toHaveLength(2);

    // Both carry the correspondent read from the envelope, and both are tagged by the rule.
    const office = library.db.select().from(schema.itemOffice).all();
    expect(office).toHaveLength(2);
    for (const facet of office) expect(facet.correspondent).toBe('Stadtwerke Ulm');
    for (const item of items) {
      expect(library.tags.forItem(item.id).map((tag) => tag.name)).toContain('utilities');
    }

    // The body became a Note on the message's item.
    const notes = library.db.select().from(schema.notes).all();
    expect(notes).toHaveLength(1);
    expect(notes[0]!.contentMarkdown).toContain('anbei erhalten Sie Ihre Rechnung');

    // The attachment's document records the message it arrived in.
    const attachmentDocument = library.db
      .select()
      .from(schema.documents)
      .where(eq(schema.documents.originalFilename, 'rechnung.pdf'))
      .get()!;
    const detail = JSON.parse(attachmentDocument.sourceDetail) as {
      archive?: { entry?: string; documentId?: string };
      subject?: string;
    };
    expect(detail.archive?.entry).toBe('rechnung.pdf');
    expect(detail.archive?.documentId).toBeDefined();
    expect(detail.subject).toBe('Ihre Rechnung SW-2026-0042');
    expect(attachmentDocument.parentDocumentId).toBe(detail.archive?.documentId);
  });
});
