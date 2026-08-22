/**
 * Ingestion: CONCEPT §5.3 stages 1 and 2, and invariant D1.
 *
 * The property that matters is the one P2 is for: the same bytes are one document however often
 * they arrive, and every arrival is still recorded. A test that only checked the first half would
 * pass on an implementation that silently loses the second sender.
 */
import { createHash } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { count, eq } from 'drizzle-orm';

import { schema } from '../src/index.js';
import { makeLibrary } from './helpers.js';
import type { TestLibrary } from './helpers.js';

let library: TestLibrary;

beforeEach(() => {
  library = makeLibrary();
});

afterEach(() => {
  library.dispose();
});

const PDF = Buffer.concat([
  Buffer.from('%PDF-1.7\n', 'utf8'),
  Buffer.from('1 0 obj << /Type /Catalog >> endobj\n', 'utf8'),
  Buffer.from('%%EOF\n', 'utf8'),
]);

describe('DocumentService.ingestBuffer', () => {
  it('hashes, stores and records a new document', async () => {
    const result = await library.documents.ingestBuffer(PDF, {
      sourceKind: 'upload',
      sourceRef: 'POST /documents',
      originalFilename: 'paper.pdf',
      actor: library.actor,
    });

    expect(result.created).toBe(true);
    expect(result.blobWritten).toBe(true);
    expect(result.document.sha256).toBe(createHash('sha256').update(PDF).digest('hex'));
    expect(result.document.byteSize).toBe(PDF.byteLength);
    // Sniffed from the magic number, not taken from the filename or from a caller's claim (§3.3).
    expect(result.document.mimeType).toBe('application/pdf');
    expect(result.document.mimeSource).toBe('sniffed');
    expect(result.document.storageKey).toBe(
      `${result.document.sha256.slice(0, 2)}/${result.document.sha256.slice(2, 4)}/${result.document.sha256}`,
    );
    expect(await library.storage.has(result.document.sha256)).toBe(true);
    expect(await library.documents.readBuffer(result.document.id)).toEqual(PDF);
  });

  it('ingesting the same bytes twice yields one document and two provenance records', async () => {
    const first = await library.documents.ingestBuffer(PDF, {
      sourceKind: 'upload',
      sourceRef: 'POST /documents',
      originalFilename: 'downloaded.pdf',
      actor: library.actor,
    });

    const second = await library.documents.ingestBuffer(PDF, {
      sourceKind: 'imap',
      sourceRef: '<CAF=2026@example.org>',
      sourceDetail: { from: 'colleague@example.org', subject: 'the paper we discussed' },
      originalFilename: 'attachment.pdf',
      actor: library.actor,
    });

    expect(second.created).toBe(false);
    expect(second.blobWritten).toBe(false);
    expect(second.document.id).toBe(first.document.id);

    const documentRows = library.db.select({ n: count() }).from(schema.documents).get();
    expect(documentRows?.n).toBe(1);

    const provenance = library.documents.provenanceFor(first.document.id);
    expect(provenance).toHaveLength(2);
    expect(provenance.map((row) => row.sourceKind).sort()).toEqual(['imap', 'upload']);
    // Exactly one arrival created the document row; ux_document_provenance_first enforces it.
    expect(provenance.filter((row) => row.isFirst)).toHaveLength(1);
    expect(provenance.find((row) => row.sourceKind === 'imap')?.sourceDetail).toContain(
      'colleague@example.org',
    );
  });

  it('writes an audit row for both the new document and the duplicate (P5)', async () => {
    const first = await library.documents.ingestBuffer(PDF, {
      sourceKind: 'upload',
      actor: library.actor,
    });
    await library.documents.ingestBuffer(PDF, { sourceKind: 'scanner', actor: library.actor });

    const rows = library.audit.forEntity('document', first.document.id);
    const actions = rows.map((row) => row.action).sort();

    expect(actions).toEqual(['document.duplicate_ingested', 'document.ingested']);
    for (const row of rows) {
      expect(row.actorType).toBe('user');
      expect(row.actorUserId).toBe(library.user.id);
    }
    expect(rows.find((row) => row.action === 'document.duplicate_ingested')?.reason).toMatch(
      /already in the library/u,
    );
  });

  it('attaches to an item on the way in, and shares one blob between two items (AT1)', async () => {
    const one = library.library.createItem({ itemType: 'article', title: 'First' }, library.actor);
    const two = library.library.createItem({ itemType: 'article', title: 'Second' }, library.actor);

    const ingest = await library.documents.ingestBuffer(PDF, {
      sourceKind: 'upload',
      originalFilename: 'shared.pdf',
      actor: library.actor,
      attachTo: { itemId: one.item.id },
    });
    expect(ingest.attachmentId).not.toBeNull();

    const again = await library.documents.ingestBuffer(PDF, {
      sourceKind: 'connector',
      actor: library.actor,
      attachTo: { itemId: two.item.id },
    });

    expect(again.document.id).toBe(ingest.document.id);

    const documentRows = library.db.select({ n: count() }).from(schema.documents).get();
    expect(documentRows?.n).toBe(1);

    const attachmentRows = library.db
      .select()
      .from(schema.attachments)
      .where(eq(schema.attachments.documentId, ingest.document.id))
      .all();
    expect(attachmentRows).toHaveLength(2);
    expect(attachmentRows.map((row) => row.itemId).sort()).toEqual([one.item.id, two.item.id].sort());
  });

  it('does not attach the same document to the same item twice', async () => {
    const item = library.library.createItem({ itemType: 'report' }, library.actor);

    const first = await library.documents.ingestBuffer(PDF, {
      sourceKind: 'upload',
      actor: library.actor,
      attachTo: { itemId: item.item.id },
    });
    const second = await library.documents.ingestBuffer(PDF, {
      sourceKind: 'folder',
      actor: library.actor,
      attachTo: { itemId: item.item.id },
    });

    expect(second.attachmentId).toBe(first.attachmentId);
    const attachmentRows = library.db
      .select({ n: count() })
      .from(schema.attachments)
      .where(eq(schema.attachments.itemId, item.item.id))
      .get();
    expect(attachmentRows?.n).toBe(1);
  });

  it('finds a document by its identity and reports an unknown hash as unknown', () => {
    expect(library.documents.findBySha256('0'.repeat(64))).toBeNull();
  });
});
