import { describe, expect, it } from 'vitest';

import { body, createItem, harness } from './helpers.js';

describe('/api/v1/annotations', () => {
  it('annotates, lists in reading order, and makes a citing note', async () => {
    const h = await harness();
    try {
      const item = await createItem(h, { title: 'Hip fractures', bibliographic: { title: 'Hip fractures', citationKey: 'lovelace2020' } });
      const itemId = String(item['id']);
      const { document } = await h.recueil.documents.ingestBuffer(Buffer.from('%PDF-1.4 annotated'), {
        sourceKind: 'upload',
        attachTo: { itemId },
      });

      const created = await h.app.inject({
        method: 'POST',
        url: '/api/v1/annotations',
        payload: {
          documentId: document.id,
          itemId,
          annotationType: 'highlight',
          motivation: 'highlighting',
          selector: [
            { type: 'TextQuoteSelector', exact: 'Bones heal.' },
            { type: 'RectangleSelector', pageIndex: 4, rectangles: [{ x: 70, y: 600, width: 100, height: 10 }] },
          ],
          pageLabel: '12',
        },
      });
      expect(created.statusCode).toBe(201);
      const annotation = body(created);
      expect(annotation['quotedText']).toBe('Bones heal.');

      const listed = body<{ data: unknown[] }>(await h.app.inject({ method: 'GET', url: `/api/v1/annotations?itemId=${itemId}` }));
      expect(listed.data).toHaveLength(1);

      const note = await h.app.inject({ method: 'POST', url: `/api/v1/annotations/${String(annotation['id'])}/note`, payload: {} });
      expect(note.statusCode).toBe(201);
      expect(body(note)['contentMarkdown']).toBe('> Bones heal.\n\n[@lovelace2020, p. 12]');
    } finally {
      await h.close();
    }
  });

  it('refuses a selector set that depends on the text layer alone (AN4)', async () => {
    const h = await harness();
    try {
      const response = await h.app.inject({
        method: 'POST',
        url: '/api/v1/annotations',
        payload: {
          documentId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
          annotationType: 'highlight',
          motivation: 'highlighting',
          selector: [{ type: 'TextQuoteSelector', exact: 'x' }],
        },
      });
      expect(response.statusCode).toBe(422);
    } finally {
      await h.close();
    }
  });
});

describe('GET /api/v1/documents/{id}/annotated.pdf', () => {
  it('embeds the annotations in a new PDF and leaves the stored one alone', async () => {
    const { PDFDocument, PDFName, PDFArray } = await import('pdf-lib');
    const source = await PDFDocument.create();
    source.addPage([595, 842]);
    source.addPage([595, 842]);
    const original = Buffer.from(await source.save());

    const h = await harness();
    try {
      const item = await createItem(h, { title: 'Annotated' });
      const itemId = String(item['id']);
      const { document } = await h.recueil.documents.ingestBuffer(original, { sourceKind: 'upload', declaredMimeType: 'application/pdf', attachTo: { itemId } });
      const rect = { type: 'RectangleSelector' as const, pageIndex: 1, rectangles: [{ x: 72, y: 700, width: 200, height: 12 }] };
      h.recueil.annotations.create({ documentId: document.id, itemId, annotationType: 'highlight', motivation: 'highlighting', selector: [rect], bodyText: 'Important', colour: '#ffcc00' }, h.recueil.actor);
      h.recueil.annotations.create({ documentId: document.id, itemId, annotationType: 'ink', motivation: 'highlighting', selector: [{ type: 'InkSelector', pageIndex: 0, paths: [[{ x: 1, y: 1 }, { x: 50, y: 60 }]] }] }, h.recueil.actor);

      const response = await h.app.inject({ method: 'GET', url: `/api/v1/documents/${document.id}/annotated.pdf` });
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toBe('application/pdf');
      expect(response.headers['x-recueil-embedded']).toBe('2');

      const out = await PDFDocument.load(response.rawPayload);
      const subtypes = out.getPages().map((page) => {
        const annots = page.node.lookup(PDFName.of('Annots'));
        return annots instanceof PDFArray ? annots.asArray().map((ref) => String(out.context.lookup(ref))) : [];
      });
      expect(subtypes[0]?.[0]).toContain('/Ink');
      expect(subtypes[1]?.[0]).toContain('/Highlight');
      expect(subtypes[1]?.[0]).toContain('Important');

      const stored = await h.recueil.documents.readBuffer(document.id);
      expect(Buffer.compare(stored, original)).toBe(0);
    } finally {
      await h.close();
    }
  });
});

describe('GET /api/v1/annotations on a document without any', () => {
  it('answers an empty page, not an error', async () => {
    const h = await harness();
    try {
      const response = await h.app.inject({ method: 'GET', url: '/api/v1/annotations?documentId=01ARZ3NDEKTSV4RRFFQ69G5FAV' });
      expect(response.statusCode).toBe(200);
      expect(body<{ data: unknown[] }>(response).data).toEqual([]);
    } finally {
      await h.close();
    }
  });
});
