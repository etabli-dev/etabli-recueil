/**
 * `/api/v1/documents` and `/api/v1/attachments`.
 *
 * The two things worth proving here are the two ADR-0004 promises the API makes visible: that the
 * server computes the digest itself, and that a second upload of the same bytes links rather than
 * copies. Both are asserted against a real store on disk, so "no second copy" means no second file.
 */
import { createHash } from 'node:crypto';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { body, createItem, harness, multipart } from './helpers.js';

const PDF = Buffer.concat([
  Buffer.from('%PDF-1.4\n', 'ascii'),
  Buffer.from('1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n', 'ascii'),
]);

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

/** Every blob in the content-addressed store, so "was a second copy written" is answerable. */
const storedBlobs = (root: string): string[] => {
  const out: string[] = [];
  const walk = (path: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const full = join(path, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (statSync(full).isFile()) out.push(entry.name);
    }
  };
  try {
    walk(root);
  } catch {
    /* the store has not been created yet */
  }
  return out;
};

describe('POST /api/v1/documents', () => {
  it('hashes the upload itself and stores it once', async () => {
    const h = await harness();
    try {
      const upload = multipart({ name: 'file', filename: 'paper.pdf', contentType: 'application/pdf', bytes: PDF });
      const response = await h.app.inject({
        method: 'POST',
        url: '/api/v1/documents',
        headers: upload.headers,
        payload: upload.payload,
      });

      expect(response.statusCode).toBe(201);
      const result = body(response);
      expect(result.created).toBe(true);
      expect(result.blobWritten).toBe(true);
      expect(result.attachmentId).toBeNull();

      const document = result.document as Record<string, unknown>;
      expect(document.sha256).toBe(sha256(PDF));
      expect(document.byteSize).toBe(PDF.byteLength);
      // Sniffed, not taken from the uploader's word (§3.3).
      expect(document.mimeType).toBe('application/pdf');
      expect(document.mimeSource).toBe('sniffed');
      expect(document.originalFilename).toBe('paper.pdf');
      expect(response.headers.etag).toBe(`"${sha256(PDF)}"`);

      expect(storedBlobs(h.config.storagePath)).toEqual([sha256(PDF)]);
    } finally {
      await h.close();
    }
  });

  it('tells the client the bytes were already here, and writes no second copy (D1)', async () => {
    const h = await harness();
    try {
      const send = async (filename: string) => {
        const upload = multipart({ name: 'file', filename, contentType: 'application/pdf', bytes: PDF });
        return h.app.inject({
          method: 'POST',
          url: '/api/v1/documents',
          headers: upload.headers,
          payload: upload.payload,
        });
      };

      const first = await send('paper.pdf');
      const second = await send('the-same-paper-again.pdf');

      expect(first.statusCode).toBe(201);
      expect(second.statusCode).toBe(200);
      expect(body(second).created).toBe(false);
      expect(body(second).blobWritten).toBe(false);
      expect((body(second).document as { id: string }).id).toBe(
        (body(first).document as { id: string }).id,
      );

      expect(storedBlobs(h.config.storagePath)).toEqual([sha256(PDF)]);
    } finally {
      await h.close();
    }
  });

  it('attaches to an item when the upload names one', async () => {
    const h = await harness();
    try {
      const item = await createItem(h);
      const upload = multipart(
        { name: 'file', filename: 'paper.pdf', contentType: 'application/pdf', bytes: PDF },
        { itemId: item.id as string, role: 'primary' },
      );

      const response = await h.app.inject({
        method: 'POST',
        url: '/api/v1/documents',
        headers: upload.headers,
        payload: upload.payload,
      });

      expect(response.statusCode).toBe(201);
      expect(body(response).attachmentId).toBeTypeOf('string');

      const attachments = body(
        await h.app.inject({ method: 'GET', url: `/api/v1/items/${item.id as string}/attachments` }),
      );
      expect((attachments.data as { role: string }[]).map((row) => row.role)).toEqual(['primary']);
    } finally {
      await h.close();
    }
  });

  it('refuses a body that is not multipart', async () => {
    const h = await harness();
    try {
      const response = await h.app.inject({
        method: 'POST',
        url: '/api/v1/documents',
        payload: { file: 'not really' },
      });
      expect(response.statusCode).toBe(415);
      expect(body(response).type).toBe('https://recueil.org/problems/validation');
    } finally {
      await h.close();
    }
  });

  it('refuses an unknown field in the multipart form', async () => {
    const h = await harness();
    try {
      const upload = multipart(
        { name: 'file', filename: 'paper.pdf', contentType: 'application/pdf', bytes: PDF },
        { itemid: 'lowercase typo' },
      );
      const response = await h.app.inject({
        method: 'POST',
        url: '/api/v1/documents',
        headers: upload.headers,
        payload: upload.payload,
      });
      expect(response.statusCode).toBe(422);
      expect(body(response).errors).toContainEqual(
        expect.objectContaining({ path: 'body.itemid' }),
      );
    } finally {
      await h.close();
    }
  });
});

describe('GET /api/v1/documents/{id}/content', () => {
  const upload = async (h: Awaited<ReturnType<typeof harness>>): Promise<string> => {
    const form = multipart({ name: 'file', filename: 'paper.pdf', contentType: 'application/pdf', bytes: PDF });
    const response = await h.app.inject({
      method: 'POST',
      url: '/api/v1/documents',
      headers: form.headers,
      payload: form.payload,
    });
    return (body(response).document as { id: string }).id;
  };

  it('serves the whole file with the digest as its ETag', async () => {
    const h = await harness();
    try {
      const id = await upload(h);
      const response = await h.app.inject({ method: 'GET', url: `/api/v1/documents/${id}/content` });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toBe('application/pdf');
      expect(response.headers['accept-ranges']).toBe('bytes');
      expect(response.headers.etag).toBe(`"${sha256(PDF)}"`);
      expect(response.rawPayload.equals(PDF)).toBe(true);
    } finally {
      await h.close();
    }
  });

  it('answers 304 when the client already holds it', async () => {
    const h = await harness();
    try {
      const id = await upload(h);
      const response = await h.app.inject({
        method: 'GET',
        url: `/api/v1/documents/${id}/content`,
        headers: { 'if-none-match': `"${sha256(PDF)}"` },
      });
      expect(response.statusCode).toBe(304);
      expect(response.rawPayload.byteLength).toBe(0);
    } finally {
      await h.close();
    }
  });

  it('serves a byte range', async () => {
    const h = await harness();
    try {
      const id = await upload(h);
      const response = await h.app.inject({
        method: 'GET',
        url: `/api/v1/documents/${id}/content`,
        headers: { range: 'bytes=0-7' },
      });

      expect(response.statusCode).toBe(206);
      expect(response.headers['content-range']).toBe(`bytes 0-7/${PDF.byteLength}`);
      expect(response.headers['content-length']).toBe('8');
      expect(response.rawPayload.toString('ascii')).toBe('%PDF-1.4');
    } finally {
      await h.close();
    }
  });

  it('serves a suffix range', async () => {
    const h = await harness();
    try {
      const id = await upload(h);
      const response = await h.app.inject({
        method: 'GET',
        url: `/api/v1/documents/${id}/content`,
        headers: { range: 'bytes=-6' },
      });
      expect(response.statusCode).toBe(206);
      expect(response.rawPayload.equals(PDF.subarray(PDF.byteLength - 6))).toBe(true);
    } finally {
      await h.close();
    }
  });

  it('refuses a range past the end of the document', async () => {
    const h = await harness();
    try {
      const id = await upload(h);
      const response = await h.app.inject({
        method: 'GET',
        url: `/api/v1/documents/${id}/content`,
        headers: { range: `bytes=${PDF.byteLength + 10}-` },
      });
      expect(response.statusCode).toBe(416);
      expect(response.headers['content-range']).toBe(`bytes */${PDF.byteLength}`);
    } finally {
      await h.close();
    }
  });

  it('finds a document by its digest', async () => {
    const h = await harness();
    try {
      const id = await upload(h);
      const response = await h.app.inject({
        method: 'GET',
        url: `/api/v1/documents/by-sha256/${sha256(PDF)}`,
      });
      expect(response.statusCode).toBe(200);
      expect(body(response).id).toBe(id);

      const missing = await h.app.inject({
        method: 'GET',
        url: `/api/v1/documents/by-sha256/${'0'.repeat(64)}`,
      });
      expect(missing.statusCode).toBe(404);
    } finally {
      await h.close();
    }
  });
});

describe('attachments', () => {
  const uploadTo = async (
    h: Awaited<ReturnType<typeof harness>>,
    itemId: string,
    bytes: Buffer,
    role = 'primary',
  ): Promise<{ documentId: string; attachmentId: string }> => {
    const form = multipart(
      { name: 'file', filename: 'f.pdf', contentType: 'application/pdf', bytes },
      { itemId, role },
    );
    const response = await h.app.inject({
      method: 'POST',
      url: '/api/v1/documents',
      headers: form.headers,
      payload: form.payload,
    });
    const result = body(response);
    return {
      documentId: (result.document as { id: string }).id,
      attachmentId: result.attachmentId as string,
    };
  };

  it('attaches an existing document to a second item without copying it (AT1)', async () => {
    const h = await harness();
    try {
      const first = await createItem(h);
      const second = await createItem(h, { title: 'Another', bibliographic: { title: 'Another' } });
      const { documentId } = await uploadTo(h, first.id as string, PDF);

      const response = await h.app.inject({
        method: 'POST',
        url: `/api/v1/items/${second.id as string}/attachments`,
        payload: { documentId, role: 'supplement', title: 'Shared dataset' },
      });

      expect(response.statusCode).toBe(201);
      expect(body(response).documentId).toBe(documentId);
      expect(storedBlobs(h.config.storagePath)).toEqual([sha256(PDF)]);
    } finally {
      await h.close();
    }
  });

  it('detaches without touching the document, and restores (AT2)', async () => {
    const h = await harness();
    try {
      const item = await createItem(h);
      const { documentId, attachmentId } = await uploadTo(h, item.id as string, PDF);

      const detached = await h.app.inject({ method: 'DELETE', url: `/api/v1/attachments/${attachmentId}` });
      expect(detached.statusCode).toBe(200);
      expect(body(detached).trashedAt).toBeTypeOf('string');

      // The document is untouched.
      expect(
        (await h.app.inject({ method: 'GET', url: `/api/v1/documents/${documentId}` })).statusCode,
      ).toBe(200);

      const restored = await h.app.inject({
        method: 'POST',
        url: `/api/v1/attachments/${attachmentId}/restore`,
      });
      expect(restored.statusCode).toBe(200);
      expect(body(restored).trashedAt).toBeNull();
    } finally {
      await h.close();
    }
  });

  it('refuses to trash a document a live attachment still references (D4)', async () => {
    const h = await harness();
    try {
      const item = await createItem(h);
      const { documentId } = await uploadTo(h, item.id as string, PDF);

      const response = await h.app.inject({
        method: 'POST',
        url: `/api/v1/documents/${documentId}/trash`,
      });
      expect(response.statusCode).toBe(409);
      expect(body(response).type).toBe('https://recueil.org/problems/integrity');
      expect(body(response).detail).toContain('D4');
    } finally {
      await h.close();
    }
  });

  it('reorders the attachments of an item', async () => {
    const h = await harness();
    try {
      const item = await createItem(h);
      const one = await uploadTo(h, item.id as string, Buffer.from('%PDF-1.4 one'), 'primary');
      const two = await uploadTo(h, item.id as string, Buffer.from('%PDF-1.4 two'), 'supplement');
      const three = await uploadTo(h, item.id as string, Buffer.from('%PDF-1.4 three'), 'data');

      const response = await h.app.inject({
        method: 'PUT',
        url: `/api/v1/items/${item.id as string}/attachments/order`,
        payload: { attachmentIds: [three.attachmentId, one.attachmentId] },
      });

      expect(response.statusCode).toBe(200);
      const order = (body(response).data as { id: string; position: number }[]).map((row) => row.id);
      // The named ones first, in the order given; anything left out keeps its relative place after.
      expect(order).toEqual([three.attachmentId, one.attachmentId, two.attachmentId]);
      expect((body(response).data as { position: number }[]).map((row) => row.position)).toEqual([0, 1, 2]);
    } finally {
      await h.close();
    }
  });

  it('refuses to reorder using an attachment from another item', async () => {
    const h = await harness();
    try {
      const first = await createItem(h);
      const second = await createItem(h, { title: 'Other', bibliographic: { title: 'Other' } });
      await uploadTo(h, first.id as string, PDF);
      const other = await uploadTo(h, second.id as string, Buffer.from('%PDF-1.4 other'));

      const response = await h.app.inject({
        method: 'PUT',
        url: `/api/v1/items/${first.id as string}/attachments/order`,
        payload: { attachmentIds: [other.attachmentId] },
      });
      expect(response.statusCode).toBe(404);
    } finally {
      await h.close();
    }
  });
});
