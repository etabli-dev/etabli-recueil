/**
 * The WebDAV feed, against an in-process server on a loopback port.
 *
 * The user's two Nextcloud servers are live and are not test targets; nothing here resolves a name
 * or opens a socket that is not 127.0.0.1. What the fake buys, beyond not needing a container, is
 * the three cases a real server will not perform on request: a listing that names a path outside
 * its own collection, an ETag that changes between the poll and the read, and a share that answers
 * `MOVE` with 501.
 */
import { createHash } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SourceRunner, WebDavClient, WebDavSource, normaliseEtag } from '../src/index.js';
import type { IngestOutcome } from '../src/index.js';
import {
  countDocuments,
  countItems,
  documentDigests,
  invoiceLines,
  makeContext,
  makeLibrary,
  makePdf,
  makePipeline,
} from './helpers.js';
import type { TestLibrary } from './helpers.js';
import { startFakeWebDav } from './fakes/webdav-server.js';
import type { FakeWebDavServer } from './fakes/webdav-server.js';

let library: TestLibrary;
let server: FakeWebDavServer;

beforeEach(async () => {
  library = makeLibrary();
  server = await startFakeWebDav({ auth: { username: 'rh', password: 'secret' } });
});

afterEach(async () => {
  await server.close();
  library.dispose();
});

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

const auth = { kind: 'basic' as const, username: 'rh', password: 'secret' };

describe('WebDavSource', () => {
  it('polls a share, ingests what is there, and does not offer it again', async () => {
    const first = makePdf({ lines: invoiceLines({ correspondent: 'Stadtwerke', reference: 'R-1' }) });
    const second = makePdf({ lines: ['a second document'] });
    await server.put('invoice.pdf', first);
    await server.put('nested/report.pdf', second);

    const source = new WebDavSource({ url: server.url, auth });
    const runner = new SourceRunner({ source, pipeline: makePipeline(library), recueil: library });
    await runner.start();

    const report = await runner.runOnce();
    const again = await runner.runOnce();
    await runner.stop();

    expect(report.offered).toBe(2);
    expect(report.pipeline?.counts.ingested).toBe(2);
    expect(documentDigests(library)).toEqual([sha256(first), sha256(second)].sort());
    expect(again.offered).toBe(0);
    expect(again.skipped.some((entry) => entry.reason.includes('already ingested'))).toBe(true);
    expect(countItems(library)).toBe(2);
  });

  it('tracks what it has seen by path, etag and size, so a rewritten file is a new arrival', async () => {
    await server.put('note.pdf', makePdf({ lines: ['version one'] }));

    const source = new WebDavSource({ url: server.url, auth });
    const runner = new SourceRunner({ source, pipeline: makePipeline(library), recueil: library });
    await runner.start();
    await runner.runOnce();

    const rewritten = makePdf({ lines: ['version two, same name'] });
    await server.put('note.pdf', rewritten);

    const report = await runner.runOnce();
    await runner.stop();

    expect(report.offered).toBe(1);
    expect(countDocuments(library)).toBe(2);
    expect(documentDigests(library)).toContain(sha256(rewritten));
  });

  it('refuses a listing that names a path outside the collection', async () => {
    const hostile = await startFakeWebDav({
      injectResponse:
        '<d:response><d:href>/dav/../../etc/passwd</d:href><d:propstat><d:prop>' +
        '<d:resourcetype/><d:getcontentlength>1</d:getcontentlength>' +
        '</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>',
    });
    try {
      await hostile.put('honest.pdf', makePdf({ salt: 'honest' }));
      const source = new WebDavSource({ url: hostile.url });
      const context = makeContext(library);
      await source.start(context);

      await expect(source.poll({ limit: 10 }, context)).rejects.toThrow(/outside the collection/u);
      await source.stop(context);
    } finally {
      await hostile.close();
    }
  });

  it('refuses to read a file whose ETag changed between the poll and the read', async () => {
    await server.put('moving.pdf', makePdf({ lines: ['as offered'] }));

    const source = new WebDavSource({ url: server.url, auth });
    const context = makeContext(library);
    await source.start(context);
    const page = await source.poll({ limit: 10 }, context);
    expect(page.candidates).toHaveLength(1);

    // Somebody re-uploads over the same name while the pipeline is working through its queue.
    await server.put('moving.pdf', makePdf({ lines: ['not as offered at all'] }));

    await expect(page.candidates[0]?.read()).rejects.toThrow(/changed between the poll and the read/u);
    await source.stop(context);
  });

  it('moves a consumed file into the processed collection, once the store is verified', async () => {
    const bytes = makePdf({ lines: invoiceLines({ correspondent: 'Telekom', reference: 'R-9' }) });
    await server.put('bill.pdf', bytes);

    const source = new WebDavSource({
      url: server.url,
      auth,
      consume: { mode: 'move', to: 'filed' },
    });
    const runner = new SourceRunner({ source, pipeline: makePipeline(library), recueil: library });
    await runner.start();
    const report = await runner.runOnce();
    const again = await runner.runOnce();
    await runner.stop();

    expect(report.acknowledgements.map((record) => record.action)).toEqual(['moved']);
    expect(await server.list()).toEqual(['filed/bill.pdf']);
    expect(await server.exists('bill.pdf')).toBe(false);
    expect(again.offered).toBe(0);
    expect(countDocuments(library)).toBe(1);
  });

  it('deletes a consumed file only after the blob has been re-read and re-hashed', async () => {
    const bytes = makePdf({ lines: ['delete me from the share'] });
    await server.put('temp.pdf', bytes);

    const source = new WebDavSource({ url: server.url, auth, consume: { mode: 'delete' } });
    const runner = new SourceRunner({ source, pipeline: makePipeline(library), recueil: library });
    await runner.start();
    const report = await runner.runOnce();
    await runner.stop();

    expect(report.acknowledgements[0]?.action).toBe('deleted');
    expect(report.acknowledgements[0]?.detail).toContain('re-read from the store');
    expect(await server.list()).toEqual([]);
    expect(await library.storage.has(sha256(bytes))).toBe(true);
  });

  it('keeps the remote file when the outcome names bytes the library does not hold', async () => {
    const bytes = makePdf({ lines: ['nothing ingested this'] });
    await server.put('survivor.pdf', bytes);

    const source = new WebDavSource({ url: server.url, auth, consume: { mode: 'delete' } });
    const context = makeContext(library);
    await source.start(context);
    const page = await source.poll({ limit: 10 }, context);
    const ref = page.candidates[0]?.ref;
    expect(ref).toBeDefined();

    const lie: IngestOutcome = {
      status: 'ingested',
      documentId: 'doc_nope',
      itemId: 'itm_nope',
      sha256: sha256(bytes),
      confidence: 1,
    };
    const acknowledgement = await source.acknowledge(ref!, lie, context);
    await source.stop(context);

    expect(acknowledgement.action).toBe('refused');
    expect(await server.exists('survivor.pdf')).toBe(true);
  });

  it('reports a share that does not allow what the consume policy needs', async () => {
    const limited = await startFakeWebDav({ disableMove: true });
    try {
      const source = new WebDavSource({ url: limited.url, consume: { mode: 'move', to: 'filed' } });
      const context = makeContext(library);
      await source.start(context);
      const health = await source.health(context);
      await source.stop(context);

      expect(health.status).toBe('degraded');
      expect(health.message).toContain('MOVE');
    } finally {
      await limited.close();
    }
  });

  it('reports bad credentials as unavailable rather than as an empty share', async () => {
    const source = new WebDavSource({
      url: server.url,
      auth: { kind: 'basic', username: 'rh', password: 'wrong' },
    });
    const context = makeContext(library);
    const health = await source.health(context);

    expect(health.status).toBe('unavailable');
    expect(health.message).toContain('401');
  });

  it('falls back to size and modification time when the server sends no ETag', async () => {
    const plain = await startFakeWebDav({ omitEtags: true });
    try {
      await plain.put('scan.pdf', makePdf({ lines: ['no etag here'] }));
      const source = new WebDavSource({ url: plain.url });
      const runner = new SourceRunner({ source, pipeline: makePipeline(library), recueil: library });
      await runner.start();
      const report = await runner.runOnce();
      const again = await runner.runOnce();
      await runner.stop();

      expect(report.offered).toBe(1);
      expect(report.acknowledgements[0]?.ref.revision).toMatch(/^mtime:/u);
      expect(again.offered).toBe(0);
    } finally {
      await plain.close();
    }
  });
});

describe('WebDavClient', () => {
  it('encodes each path segment exactly once', () => {
    const client = new WebDavClient({ url: 'http://127.0.0.1:1/dav' });
    expect(client.urlFor('Rechnungen/März 2026/a b.pdf').pathname).toBe(
      '/dav/Rechnungen/M%C3%A4rz%202026/a%20b.pdf',
    );
    // A name with a `#` in it is a name, not a fragment.
    expect(client.urlFor('note #3.pdf').pathname).toBe('/dav/note%20%233.pdf');
  });

  it('reads size, ETag, modification time and collection-ness out of a listing', async () => {
    await server.put('folder/inner.pdf', makePdf({ salt: 'inner' }));
    await server.put('top.pdf', Buffer.from('twelve bytes'));

    const client = new WebDavClient({ url: server.url, auth });
    const entries = await client.list('');

    const top = entries.find((entry) => entry.path === 'top.pdf');
    expect(top?.isCollection).toBe(false);
    expect(top?.byteSize).toBe(12);
    expect(top?.etag).not.toBeNull();
    expect(top?.lastModified).not.toBeNull();
    expect(entries.find((entry) => entry.path === 'folder')?.isCollection).toBe(true);
  });

  it('refuses a listing entry that is on another host', async () => {
    const hostile = await startFakeWebDav({
      injectResponse:
        '<d:response><d:href>http://elsewhere.example/dav/x.pdf</d:href><d:propstat><d:prop>' +
        '<d:resourcetype/><d:getcontentlength>3</d:getcontentlength>' +
        '</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>',
    });
    try {
      const client = new WebDavClient({ url: hostile.url });
      await expect(client.list('')).rejects.toThrow(/another host/u);
    } finally {
      await hostile.close();
    }
  });

  it('treats a weak ETag and a quoted one as the same version', () => {
    expect(normaliseEtag('W/"abc123"')).toBe('abc123');
    expect(normaliseEtag('"abc123"')).toBe('abc123');
    expect(normaliseEtag('abc123')).toBe('abc123');
    expect(normaliseEtag('')).toBeNull();
    expect(normaliseEtag(null)).toBeNull();
  });
});
