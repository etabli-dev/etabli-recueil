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
