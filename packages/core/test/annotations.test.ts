import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ConflictError, ValidationError, noteFromAnnotation, pandocCitation, positionSortKey } from '../src/index.js';
import { makeLibrary } from './helpers.js';
import type { TestLibrary } from './helpers.js';

let lib: TestLibrary;
beforeEach(() => {
  lib = makeLibrary();
});
afterEach(() => {
  lib.dispose();
});

const setup = async () => {
  const item = lib.library.createItem(
    { itemType: 'article', title: 'Hip fractures', bibliographic: { title: 'Hip fractures', citationKey: 'lovelace2020', issuedYear: 2020 } },
    lib.actor,
  ).item.id;
  const { document } = await lib.documents.ingestBuffer(Buffer.from('%PDF-1.4 annotated'), { sourceKind: 'upload', attachTo: { itemId: item } });
  return { item, documentId: document.id };
};

const highlight = (documentId: string, itemId: string, page = 3, y = 700) =>
  lib.annotations.create(
    {
      documentId,
      itemId,
      annotationType: 'highlight',
      motivation: 'highlighting',
      selector: [
        { type: 'TextQuoteSelector', exact: 'Bones heal faster in the young.' },
        { type: 'RectangleSelector', pageIndex: page, rectangles: [{ x: 72, y, width: 200, height: 12 }] },
      ],
      bodyText: 'Compare with the 2019 cohort.',
      pageLabel: String(page + 9),
    },
    lib.actor,
  );

describe('AnnotationService', () => {
  it('stores the derived fields and keeps the attachment count', async () => {
    const { item, documentId } = await setup();
    const row = highlight(documentId, item);
    expect(row.quotedText).toBe('Bones heal faster in the young.');
    expect(row.pageIndex).toBe(3);
    expect(row.positionSortKey).toBe(positionSortKey(JSON.parse(row.selector), 3));
    const attachment = lib.connection.prepare('select annotation_count as n, has_annotations as has from attachments where item_id = ?').get(item) as { n: number; has: number };
    expect(attachment).toEqual({ n: 1, has: 1 });
  });

  it('lists in reading order: page, then top to bottom', async () => {
    const { item, documentId } = await setup();
    const lower = highlight(documentId, item, 3, 100);
    const upper = highlight(documentId, item, 3, 700);
    const earlier = highlight(documentId, item, 1, 50);
    expect(lib.annotations.list({ itemId: item }).map((row) => row.id)).toEqual([earlier.id, upper.id, lower.id]);
  });

  it('refuses an annotation through an item that does not carry the document (AN2), and one with only a text selector (AN4)', async () => {
    const { documentId } = await setup();
    const other = lib.library.createItem({ itemType: 'article', title: 'Other' }, lib.actor).item.id;
    expect(() => highlight(documentId, other)).toThrow(ConflictError);
    expect(() =>
      lib.annotations.create(
        { documentId, annotationType: 'highlight', motivation: 'highlighting', selector: [{ type: 'TextQuoteSelector', exact: 'x' }] },
        lib.actor,
      ),
    ).toThrow(ValidationError);
  });

  it('trashes and restores one annotation on its own', async () => {
    const { item, documentId } = await setup();
    const row = highlight(documentId, item);
    lib.annotations.trash(row.id, lib.actor);
    expect(lib.annotations.list({ documentId })).toHaveLength(0);
    lib.trash.restore('annotation', row.id, lib.actor);
    expect(lib.annotations.list({ documentId })).toHaveLength(1);
  });

  it('turns an annotation into a quoting note with a Pandoc citation', async () => {
    const { item, documentId } = await setup();
    const note = noteFromAnnotation(lib, highlight(documentId, item).id, lib.actor);
    expect(note.contentMarkdown).toBe('> Bones heal faster in the young.\n\nCompare with the 2019 cohort.\n\n[@lovelace2020, p. 12]');
    expect(note.parentAnnotationId).not.toBeNull();
    expect(note.noteKind).toBe('quote');
  });

  it('cites without a key by title and year', () => {
    expect(pandocCitation({ citationKey: null, fallback: 'Hip fractures 2020', page: '4' })).toBe('(Hip fractures 2020, p. 4)');
    expect(pandocCitation({ citationKey: 'bad key', fallback: 'X', page: null })).toBe('(X)');
  });
});
